'use strict';
// 复习计划：今日到期任务、复习动作、历史记录
const express = require('express');
const { getDb } = require('../db');
const { todayStr, daysBetween } = require('../util');
const { getDueKps, applyReviewAction, getSnippet, getIntervalTable } = require('../services/kp');

const router = express.Router();

function taskView(kp) {
  const today = todayStr();
  return {
    kp_id: kp.id,
    name: kp.name,
    material_filename: kp.material_filename,
    mastery: kp.mastery,
    last_result: kp.last_result,
    attempts: kp.attempts,
    correct: kp.correct,
    interval_step: kp.interval_step,
    next_review_at: kp.next_review_at,
    overdue_days: kp.next_review_at ? Math.max(0, daysBetween(kp.next_review_at, today)) : 0,
    snippet: getSnippet(kp),
  };
}

router.get('/today', (req, res) => {
  const due = getDueKps(todayStr());
  res.json({ date: todayStr(), total: due.length, tasks: due.slice(0, 50).map(taskView) });
});

router.get('/knowledge-points', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT kp.*, m.filename FROM knowledge_points kp JOIN materials m ON m.id = kp.material_id ORDER BY kp.created_at DESC`
  ).all();
  res.json({ items: rows.map(taskView) });
});

// 手动调整掌握程度：0 未掌握 / 1 学习中 / 2 已掌握
router.patch('/knowledge-points/:id/mastery', (req, res) => {
  const db = getDb();
  const kp = db.prepare('SELECT * FROM knowledge_points WHERE id = ?').get(req.params.id);
  if (!kp) return res.status(404).json({ error: '知识点不存在。' });
  const v = parseInt(req.body && req.body.mastery, 10);
  if (![0, 1, 2].includes(v)) return res.status(400).json({ error: 'mastery 取值只能是 0、1、2。' });
  const nextReview = v === 2 ? null : (kp.next_review_at || (kp.last_result === 'wrong' ? todayStr() : null));
  db.prepare('UPDATE knowledge_points SET mastery = ?, next_review_at = ? WHERE id = ?').run(v, nextReview, kp.id);
  db.prepare('INSERT INTO review_logs (id, knowledge_point_id, action, reviewed_at) VALUES (?,?,?,?)')
    .run(require('../util').id(), kp.id, 'manual_mastery', new Date().toISOString());
  const updated = db.prepare('SELECT * FROM knowledge_points WHERE id = ?').get(kp.id);
  res.json({ ok: true, knowledge_point: taskView({ ...updated, material_filename: kp.material_filename || (db.prepare('SELECT filename FROM materials WHERE id=?').get(kp.material_id) || {}).filename }) });
});

router.post('/knowledge-points/:id/action', (req, res) => {
  const { action } = req.body || {};
  const updated = applyReviewAction(req.params.id, String(action || ''));
  if (!updated) return res.status(400).json({ error: '无效的复习动作，只支持 got / fuzzy / mastered。' });
  const withName = { ...updated, material_filename: (getDb().prepare('SELECT filename FROM materials WHERE id = ?').get(updated.material_id) || {}).filename };
  res.json({ ok: true, knowledge_point: taskView(withName) });
});

router.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = getDb().prepare(
    `SELECT rl.id, rl.action, rl.reviewed_at, kp.name, m.filename
     FROM review_logs rl JOIN knowledge_points kp ON kp.id = rl.knowledge_point_id
     JOIN materials m ON m.id = kp.material_id
     ORDER BY rl.reviewed_at DESC LIMIT ?`
  ).all(limit);
  const actionText = {
    got: '记住了', fuzzy: '仍不熟悉', mastered: '已掌握',
    auto_correct: '答对（自动安排）', auto_wrong: '答错（自动安排）', manual_mastery: '手动调整掌握程度',
  };
  res.json({ items: rows.map((r) => ({ ...r, action_text: actionText[r.action] || r.action })) });
});

router.get('/rules', (req, res) => {
  res.json({
    intervals_days: getIntervalTable(),
    description: [
      '答对或标记"记住了"：按间隔表逐步拉长下次复习间隔（1 → 2 → 4 → 7 → 15 → 30 天）。',
      '答错或标记"仍不熟悉"：明天（1 天后）再次安排复习。',
      '标记"已掌握"：移出每日复习计划；之后若答错会自动退回"学习中"。',
      '优先顺序：最近答错 > 掌握程度低 > 拖延最久的知识点。',
      '以上只是固定规则，不保证记忆效果；所有记录均来自你的真实答题与复习操作。',
    ],
  });
});

module.exports = router;
