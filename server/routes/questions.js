'use strict';
// 练习题：AI 生成入库、题库管理（查看/编辑/删除）
const express = require('express');
const { getDb } = require('../db');
const { id, nowIso, truncate, toBool } = require('../util');
const { jsonChat } = require('../ai/client');
const { quizMessages } = require('../ai/prompts');
const { getChunksForMaterials, sampleChunks } = require('../services/rag');
const { normalizeQuestion, TYPES, DIFFICULTIES } = require('../services/quiz');
const { upsertKnowledgePoint } = require('../services/kp');
const { rateLimit } = require('../middleware/rateLimit');
const config = require('../config');

const router = express.Router();
const aiLimiter = rateLimit(20);

function parseOptions(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

router.post('/generate', aiLimiter, async (req, res, next) => {
  try {
    const { material_id: materialId, types, count, nocache } = req.body || {};
    const db = getDb();
    const m = materialId ? db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId) : null;
    if (!m) return res.status(404).json({ error: '资料不存在或已被删除。' });
    if (m.status !== 'ready') return res.status(400).json({ error: '该资料处理失败或尚未就绪，无法出题。' });

    const wantTypes = Array.isArray(types) && types.length ? types.filter((t) => TYPES.includes(t)) : TYPES.slice();
    if (!wantTypes.length) return res.status(400).json({ error: '请至少选择一种题型。' });
    const n = Math.min(Math.max(parseInt(count, 10) || 5, 1), 10);

    const allChunks = getChunksForMaterials([m.id]);
    if (!allChunks.length) return res.status(400).json({ error: '该资料没有可用的文本内容，无法出题。' });
    const ctx = sampleChunks(allChunks, config.rag.maxContextChunks);

    const r = await jsonChat(quizMessages(wantTypes, n, ctx), { kind: 'quiz', useCache: !nocache, maxTokens: 4000 });
    const list = Array.isArray(r.data && r.data.questions) ? r.data.questions : null;
    if (!list) return res.status(502).json({ error: '模型未能返回题目列表，请重试。' });

    // 与题库中已有题目去重（同一资料下题干前 40 字相同视为重复）
    const existing = new Set(
      db.prepare('SELECT question FROM questions WHERE material_id = ?').all(m.id).map((row) => truncate(row.question, 40))
    );
    const seenInBatch = new Set();

    const saved = [];
    const skipped = [];
    for (const raw of list.slice(0, n * 2)) {
      const norm = normalizeQuestion(raw, ctx, m.id, allChunks);
      if (!norm.ok) {
        skipped.push(truncate(String(raw && raw.question) || '（无题干）', 30) + '：' + norm.reason);
        continue;
      }
      const q = norm.question;
      const dedupeKey = truncate(q.question, 40);
      if (existing.has(dedupeKey) || seenInBatch.has(dedupeKey)) {
        skipped.push(truncate(q.question, 30) + '：与已有题目重复');
        continue;
      }
      seenInBatch.add(dedupeKey);
      const kpId = q.kpName ? upsertKnowledgePoint(q.kpName, m.id, q.source_chunk_id) : null;
      const qid = id();
      db.prepare(
        'INSERT INTO questions (id, material_id, knowledge_point_id, type, question, options_json, answer_json, explanation, difficulty, source_chunk_id, source_page, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(qid, m.id, kpId, q.type, q.question, JSON.stringify(q.options), JSON.stringify(q.answer), q.explanation, q.difficulty, q.source_chunk_id, q.source_page, nowIso());
      saved.push(qid);
      if (saved.length >= n) break;
    }

    res.status(201).json({
      saved_count: saved.length,
      requested: n,
      skipped_count: skipped.length,
      skipped_reasons: [...new Set(skipped)].slice(0, 10),
      hint: saved.length === 0 ? '无法从该资料可靠生成所选题型，请确认资料包含明确的事实性内容后重试。' : null,
      usage: r.usage,
      duration_ms: r.durationMs,
      cached: !!r.cached,
    });
  } catch (e) {
    next(e);
  }
});

// 题库列表：默认隐藏答案与解析（练习提交后才返回）
router.get('/', (req, res) => {
  const db = getDb();
  const includeAnswer = req.query.include_answer === '1';
  const conds = [];
  const params = [];
  if (req.query.material_id) { conds.push('q.material_id = ?'); params.push(req.query.material_id); }
  if (req.query.type && TYPES.includes(req.query.type)) { conds.push('q.type = ?'); params.push(req.query.type); }
  if (req.query.knowledge_point_id) { conds.push('q.knowledge_point_id = ?'); params.push(req.query.knowledge_point_id); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const rows = db.prepare(
    `SELECT q.id, q.material_id, q.type, q.question, q.options_json, q.difficulty, q.source_page, q.created_at,
            m.filename, kp.name AS kp_name, kp.id AS kp_id
     FROM questions q JOIN materials m ON m.id = q.material_id
     LEFT JOIN knowledge_points kp ON kp.id = q.knowledge_point_id
     ${where} ORDER BY q.created_at DESC LIMIT ?`
  ).all(...params, limit);
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      material_id: r.material_id,
      filename: r.filename,
      kp_id: r.kp_id,
      kp_name: r.kp_name,
      type: r.type,
      question: r.question,
      options: parseOptions(r.options_json),
      difficulty: r.difficulty,
      source_page: r.source_page,
      created_at: r.created_at,
    })),
  });
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const r = db.prepare(
    `SELECT q.*, m.filename, kp.name AS kp_name FROM questions q
     JOIN materials m ON m.id = q.material_id
     LEFT JOIN knowledge_points kp ON kp.id = q.knowledge_point_id
     WHERE q.id = ?`
  ).get(req.params.id);
  if (!r) return res.status(404).json({ error: '题目不存在或已被删除。' });
  const includeAnswer = req.query.include_answer === '1';
  const base = {
    id: r.id, material_id: r.material_id, filename: r.filename, kp_name: r.kp_name, type: r.type,
    question: r.question, options: parseOptions(r.options_json), difficulty: r.difficulty,
    source_page: r.source_page, created_at: r.created_at,
  };
  if (includeAnswer) {
    base.answer = JSON.parse(r.answer_json);
    base.explanation = r.explanation;
    if (r.source_chunk_id) {
      const c = db.prepare('SELECT text FROM chunks WHERE id = ?').get(r.source_chunk_id);
      base.source_snippet = c ? truncate(c.text, 300) : null;
    }
  }
  res.json(base);
});

// 编辑题目（人工把关）
router.patch('/:id', (req, res) => {
  const db = getDb();
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: '题目不存在或已被删除。' });
  const b = req.body || {};
  const updates = {};
  const errors = [];

  if (b.question !== undefined) {
    const s = String(b.question).trim();
    if (s.length < 5) errors.push('题干过短');
    else updates.question = truncate(s, 1000);
  }
  if (b.options !== undefined || b.answer !== undefined) {
    const type = q.type;
    if (type === 'single' || type === 'multi') {
      const options = (b.options !== undefined ? b.options : JSON.parse(q.options_json || '[]')).map((o) => String(o ?? '').trim()).filter(Boolean);
      if (options.length < 2) errors.push('选项至少 2 个');
      let answer = b.answer !== undefined ? b.answer : JSON.parse(q.answer_json);
      const toIndex = (v) => {
        if (typeof v === 'number' && Number.isInteger(v)) return v;
        if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return parseInt(v, 10);
        if (typeof v === 'string' && /^[A-F]$/.test(v.trim().toUpperCase())) return v.trim().toUpperCase().charCodeAt(0) - 65;
        return -1;
      };
      if (type === 'single') {
        const idx = toIndex(answer);
        if (idx < 0 || idx >= options.length) errors.push('正确答案下标不合法');
        else answer = idx;
      } else {
        const arr = (Array.isArray(answer) ? answer : [answer]).map(toIndex).filter((i) => i >= 0 && i < options.length);
        const idxs = [...new Set(arr)].sort((a, b2) => a - b2);
        if (idxs.length < 2) errors.push('多选题答案至少 2 个');
        else answer = idxs;
      }
      if (!errors.length) { updates.options_json = JSON.stringify(options); updates.answer_json = JSON.stringify(answer); }
    } else if (type === 'judge') {
      if (b.answer !== undefined) {
        const v = toBool(b.answer, null);
        if (v === null) errors.push('判断题答案必须是对/错');
        else updates.answer_json = JSON.stringify(v);
      }
    } else {
      const s = String(b.answer ?? '').trim();
      if (!s) errors.push('简答题参考答案不能为空');
      else updates.answer_json = JSON.stringify(truncate(s, 800));
    }
  }
  if (b.explanation !== undefined) {
    const s = String(b.explanation).trim();
    if (!s) errors.push('解析不能为空');
    else updates.explanation = truncate(s, 1200);
  }
  if (b.difficulty !== undefined) {
    if (!DIFFICULTIES.includes(b.difficulty)) errors.push('难度取值不合法');
    else updates.difficulty = b.difficulty;
  }
  if (b.kp_name !== undefined) {
    const m = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
    const s = String(b.kp_name).trim();
    if (!s) {
      updates.knowledge_point_id = null;
    } else {
      updates.knowledge_point_id = upsertKnowledgePoint(s, m.material_id, m.source_chunk_id);
    }
  }

  if (errors.length) return res.status(400).json({ error: errors.join('；') });
  if (!Object.keys(updates).length) return res.json({ ok: true, unchanged: true });
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE questions SET ${sets} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const r = db.prepare('DELETE FROM attempts WHERE question_id = ?').run(req.params.id);
  const r2 = db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
  if (!r2.changes) return res.status(404).json({ error: '题目不存在或已被删除。' });
  res.json({ ok: true, deleted_attempts: r.changes });
});

module.exports = router;
