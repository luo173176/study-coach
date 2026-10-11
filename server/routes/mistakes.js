'use strict';
// 错题本：按知识点/日期筛选错题；知识点掌握程度可手动调整
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const db = getDb();
  const conds = ["a.is_correct = 0"];
  const params = [];
  if (req.query.knowledge_point_id) { conds.push('q.knowledge_point_id = ?'); params.push(req.query.knowledge_point_id); }
  if (req.query.date_from) { conds.push('date(a.created_at) >= ?'); params.push(req.query.date_from); }
  if (req.query.date_to) { conds.push('date(a.created_at) <= ?'); params.push(req.query.date_to); }
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  const rows = db.prepare(
    `SELECT a.id AS attempt_id, a.created_at, a.user_answer_json, a.score, a.ai_comment, a.time_ms,
            q.id AS question_id, q.type, q.question, q.options_json, q.answer_json, q.explanation, q.difficulty,
            m.filename, q.source_page,
            kp.id AS kp_id, kp.name AS kp_name, kp.mastery
     FROM attempts a
     JOIN questions q ON q.id = a.question_id
     JOIN materials m ON m.id = q.material_id
     LEFT JOIN knowledge_points kp ON kp.id = q.knowledge_point_id
     WHERE ${conds.join(' AND ')}
     ORDER BY a.created_at DESC LIMIT ?`
  ).all(...params, limit);

  res.json({
    items: rows.map((r) => ({
      attempt_id: r.attempt_id,
      created_at: r.created_at,
      user_answer: JSON.parse(r.user_answer_json),
      score: r.score,
      ai_comment: r.ai_comment,
      time_ms: r.time_ms,
      question_id: r.question_id,
      type: r.type,
      question: r.question,
      options: (() => { try { const v = JSON.parse(r.options_json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
      correct_answer: JSON.parse(r.answer_json),
      explanation: r.explanation,
      difficulty: r.difficulty,
      filename: r.filename,
      source_page: r.source_page,
      kp_id: r.kp_id,
      kp_name: r.kp_name,
      mastery: r.mastery,
    })),
  });
});

module.exports = router;
