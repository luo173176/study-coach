'use strict';
// 仪表盘：全部统计来自真实保存的数据，不使用演示数据
const express = require('express');
const { getDb } = require('../db');
const { todayStr, truncate } = require('../util');
const { getDueKps } = require('../services/kp');

const router = express.Router();

router.get('/', (req, res) => {
  const db = getDb();
  const materialsReady = db.prepare("SELECT COUNT(*) AS c FROM materials WHERE status = 'ready'").get().c;
  const materialsFailed = db.prepare("SELECT COUNT(*) AS c FROM materials WHERE status = 'failed'").get().c;
  const kpCount = db.prepare('SELECT COUNT(*) AS c FROM knowledge_points').get().c;
  const questionCount = db.prepare('SELECT COUNT(*) AS c FROM questions').get().c;

  const attemptRows = db.prepare(
    'SELECT is_correct FROM attempts WHERE is_correct IS NOT NULL ORDER BY created_at DESC LIMIT 30'
  ).all();
  const recentAccuracy = attemptRows.length
    ? Math.round((attemptRows.filter((r) => r.is_correct === 1).length / attemptRows.length) * 100)
    : null;

  const attemptCount = db.prepare('SELECT COUNT(*) AS c FROM attempts').get().c;

  const topWrong = db.prepare(
    `SELECT kp.name, COUNT(*) AS wrong_count, kp.id AS kp_id
     FROM attempts a JOIN questions q ON q.id = a.question_id
     JOIN knowledge_points kp ON kp.id = q.knowledge_point_id
     WHERE a.is_correct = 0 AND kp.id IS NOT NULL
     GROUP BY kp.id ORDER BY wrong_count DESC LIMIT 5`
  ).all();

  const due = getDueKps(todayStr());
  const todayTasks = due.slice(0, 5).map((kp) => ({
    kp_id: kp.id,
    name: kp.name,
    material_filename: kp.material_filename,
    last_result: kp.last_result,
    next_review_at: kp.next_review_at,
  }));

  // 最近学习记录：合并上传/整理/问答/练习/复习
  const acts = [];
  for (const r of db.prepare('SELECT filename, uploaded_at AS at FROM materials ORDER BY uploaded_at DESC LIMIT 6').all()) {
    acts.push({ type: 'upload', text: `导入了资料「${truncate(r.filename, 40)}」`, at: r.at });
  }
  for (const r of db.prepare('SELECT n.created_at AS at, m.filename FROM notes n JOIN materials m ON m.id = n.material_id ORDER BY n.created_at DESC LIMIT 6').all()) {
    acts.push({ type: 'note', text: `整理了「${truncate(r.filename, 40)}」的知识点笔记`, at: r.at });
  }
  for (const r of db.prepare('SELECT created_at AS at, question FROM qa_logs ORDER BY created_at DESC LIMIT 6').all()) {
    acts.push({ type: 'qa', text: `提问：${truncate(r.question, 40)}`, at: r.at });
  }
  for (const r of db.prepare(
    `SELECT a.created_at AS at, a.is_correct, q.question FROM attempts a JOIN questions q ON q.id = a.question_id
     WHERE a.is_correct IS NOT NULL ORDER BY a.created_at DESC LIMIT 6`
  ).all()) {
    acts.push({ type: 'attempt', text: `${r.is_correct === 1 ? '答对' : '答错'}：${truncate(r.question, 36)}`, at: r.at });
  }
  for (const r of db.prepare(
    `SELECT rl.reviewed_at AS at, rl.action, kp.name FROM review_logs rl JOIN knowledge_points kp ON kp.id = rl.knowledge_point_id
     ORDER BY rl.reviewed_at DESC LIMIT 6`
  ).all()) {
    const label = { got: '记住了', fuzzy: '仍不熟悉', mastered: '已掌握', auto_correct: '答对', auto_wrong: '答错', manual_mastery: '手动调整' }[r.action] || r.action;
    acts.push({ type: 'review', text: `复习「${truncate(r.name, 24)}」：${label}`, at: r.at });
  }
  acts.sort((a, b) => (a.at < b.at ? 1 : -1));

  res.json({
    stats: {
      materials_ready: materialsReady,
      materials_failed: materialsFailed,
      knowledge_points: kpCount,
      questions: questionCount,
      attempts: attemptCount,
      recent_accuracy: recentAccuracy,
      today_tasks: due.length,
    },
    top_wrong_kps: topWrong,
    today_tasks: todayTasks,
    recent_activity: acts.slice(0, 12),
  });
});

module.exports = router;
