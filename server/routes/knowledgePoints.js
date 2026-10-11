'use strict';
// 知识点列表与掌握程度调整（独立路由，避免与复习路由混淆）
const express = require('express');
const { getDb } = require('../db');
const { todayStr } = require('../util');

const router = express.Router();

router.get('/', (req, res) => {
  const db = getDb();
  const conds = [];
  const params = [];
  if (req.query.material_id) { conds.push('kp.material_id = ?'); params.push(req.query.material_id); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT kp.id, kp.name, kp.mastery, kp.attempts, kp.correct, kp.last_result, kp.next_review_at,
            kp.interval_step, kp.created_at, m.filename
     FROM knowledge_points kp JOIN materials m ON m.id = kp.material_id
     ${where} ORDER BY kp.created_at DESC`
  ).all(...params);
  res.json({ items: rows });
});

module.exports = router;
