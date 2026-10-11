'use strict';
// 答题与评分：客观题自动判分；简答题给 AI 评分建议，由用户确认
const express = require('express');
const { getDb } = require('../db');
const { id, nowIso, truncate, toBool } = require('../util');
const { jsonChat } = require('../ai/client');
const { gradingMessages } = require('../ai/prompts');
const { applyAttemptToKp } = require('../services/kp');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const aiLimiter = rateLimit(30);

function gradeObjective(q, userAnswer) {
  const correct = JSON.parse(q.answer_json);
  if (q.type === 'single') {
    const idx = Number(userAnswer);
    if (!Number.isInteger(idx) || idx < 0) return { is_correct: 0, user: null };
    return { is_correct: idx === correct ? 1 : 0, user: idx };
  }
  if (q.type === 'multi') {
    const arr = Array.isArray(userAnswer) ? userAnswer.map(Number).filter(Number.isInteger) : [];
    const sorted = [...new Set(arr)].sort((a, b) => a - b);
    return { is_correct: JSON.stringify(sorted) === JSON.stringify([...correct].sort((a, b) => a - b)) ? 1 : 0, user: sorted };
  }
  if (q.type === 'judge') {
    const b = toBool(userAnswer, null);
    if (b === null) return { is_correct: 0, user: null };
    return { is_correct: b === correct ? 1 : 0, user: b };
  }
  return null;
}

router.post('/', aiLimiter, async (req, res, next) => {
  try {
    const { question_id: questionId, answer, time_ms: timeMs } = req.body || {};
    const db = getDb();
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
    if (!q) return res.status(404).json({ error: '题目不存在或已被删除。' });

    const attemptId = id();
    let isCorrect = null;
    let score = null;
    let aiComment = null;
    let aiInfo = null;
    let aiError = null;
    let userJson;

    const graded = gradeObjective(q, answer);
    if (graded) {
      isCorrect = graded.is_correct;
      userJson = JSON.stringify(graded.user);
    } else {
      // 简答题：先记录，再尝试 AI 评分建议；AI 不可用时用户可自行确认
      userJson = JSON.stringify(truncate(String(answer ?? ''), 2000));
      try {
        const chunkRow = q.source_chunk_id ? db.prepare('SELECT * FROM chunks WHERE id = ?').get(q.source_chunk_id) : null;
        const ctx = chunkRow ? [{ ...chunkRow, filename: db.prepare('SELECT filename FROM materials WHERE id = ?').get(q.material_id).filename }] : [];
        const srcIdx = ctx.length ? 1 : null;
        const refAnswer = JSON.parse(q.answer_json);
        const r = await jsonChat(gradingMessages(q.question, refAnswer, String(answer ?? ''), ctx, srcIdx), { kind: 'grade', maxTokens: 800 });
        const d = r.data || {};
        const s = parseInt(d.score, 10);
        score = Number.isFinite(s) ? Math.min(100, Math.max(0, s)) : null;
        aiComment = truncate(String(d.comment || '').trim(), 500) || null;
        const verdict = ['correct', 'partial', 'wrong'].includes(d.verdict) ? d.verdict : (score != null && score >= 80 ? 'correct' : score != null && score >= 50 ? 'partial' : 'wrong');
        aiInfo = { score, verdict, comment: aiComment, cached: !!r.cached };
        aiInfo.usage = r.usage;
      } catch (e) {
        aiError = truncate(e.message, 300);
      }
    }

    const time = Math.min(Math.max(parseInt(timeMs, 10) || 0, 0), 24 * 3600 * 1000);
    db.prepare(
      'INSERT INTO attempts (id, question_id, knowledge_point_id, user_answer_json, is_correct, score, ai_comment, confirmed, time_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(attemptId, q.id, q.knowledge_point_id, userJson, isCorrect, score, aiComment, 0, time, nowIso());

    if (isCorrect !== null && q.knowledge_point_id) {
      applyAttemptToKp(q.knowledge_point_id, isCorrect);
    }

    const kp = q.knowledge_point_id ? db.prepare('SELECT name FROM knowledge_points WHERE id = ?').get(q.knowledge_point_id) : null;
    const sourceChunk = q.source_chunk_id ? db.prepare('SELECT text, page, section FROM chunks WHERE id = ?').get(q.source_chunk_id) : null;

    res.status(201).json({
      attempt_id: attemptId,
      is_correct: isCorrect,
      correct_answer: JSON.parse(q.answer_json),
      explanation: q.explanation,
      source: sourceChunk ? { page: sourceChunk.page, section: sourceChunk.section, snippet: truncate(sourceChunk.text, 300) } : null,
      kp_name: kp ? kp.name : null,
      ai: aiInfo,
      ai_error: aiError,
      needs_confirm: isCorrect === null,
    });
  } catch (e) {
    next(e);
  }
});

// 用户确认简答题评分（可覆盖 AI 建议）
router.patch('/:id/confirm', (req, res) => {
  const db = getDb();
  const a = db.prepare('SELECT * FROM attempts WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '答题记录不存在。' });
  const v = parseInt(req.body && req.body.is_correct, 10);
  if (v !== 0 && v !== 1) return res.status(400).json({ error: 'is_correct 必须是 0 或 1。' });

  db.prepare('UPDATE attempts SET is_correct = ?, confirmed = 1 WHERE id = ?').run(v, a.id);
  const q = db.prepare('SELECT knowledge_point_id FROM questions WHERE id = ?').get(a.question_id);
  if (q && q.knowledge_point_id) {
    applyAttemptToKp(q.knowledge_point_id, v);
  }
  res.json({ ok: true });
});

module.exports = router;
