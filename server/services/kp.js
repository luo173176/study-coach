'use strict';
// 知识点：登记、答题后更新、复习间隔调度（规则透明，不训练模型）
const { getDb } = require('../db');
const { id, nowIso, todayStr, addDays, truncate } = require('../util');

// 复习间隔（天）：连续答对/记住时逐步拉长
const INTERVALS = [1, 2, 4, 7, 15, 30];

function getIntervalTable() {
  return INTERVALS.slice();
}

function upsertKnowledgePoint(name, materialId, sourceChunkId) {
  const db = getDb();
  const clean = String(name || '').trim().slice(0, 30);
  if (!clean) return null;
  const existing = db.prepare('SELECT id FROM knowledge_points WHERE material_id = ? AND name = ?').get(materialId, clean);
  if (existing) return existing.id;
  const kpId = id();
  db.prepare(
    'INSERT INTO knowledge_points (id, material_id, name, source_chunk_id, mastery, created_at) VALUES (?,?,?,?,1,?)'
  ).run(kpId, materialId, clean, sourceChunkId || null, nowIso());
  return kpId;
}

// 答题后更新知识点统计与下次复习时间
function applyAttemptToKp(kpId, isCorrect) {
  if (isCorrect === null || isCorrect === undefined) return;
  const db = getDb();
  const kp = db.prepare('SELECT * FROM knowledge_points WHERE id = ?').get(kpId);
  if (!kp) return;

  const streak = isCorrect === 1 ? kp.streak_correct + 1 : 0;
  const attempts = kp.attempts + 1;
  const correct = kp.correct + (isCorrect === 1 ? 1 : 0);
  const lastResult = isCorrect === 1 ? 'correct' : 'wrong';
  const today = todayStr();
  let step = kp.interval_step;
  let nextReview = kp.next_review_at;
  let mastery = kp.mastery;

  if (isCorrect === 1) {
    nextReview = addDays(today, INTERVALS[Math.min(step, INTERVALS.length - 1)]);
    step = Math.min(step + 1, INTERVALS.length - 1);
  } else {
    // 答错：明天安排复习；若此前已标记"已掌握"，退回"学习中"（不轻易下永久结论）
    step = 0;
    nextReview = addDays(today, 1);
    if (mastery === 2) mastery = 1;
  }

  db.prepare(
    `UPDATE knowledge_points SET attempts=?, correct=?, last_result=?, streak_correct=?, interval_step=?, next_review_at=?, mastery=?, last_reviewed_at=? WHERE id=?`
  ).run(attempts, correct, lastResult, streak, step, nextReview, mastery, nowIso(), kpId);
  db.prepare('INSERT INTO review_logs (id, knowledge_point_id, action, reviewed_at) VALUES (?,?,?,?)')
    .run(id(), kpId, isCorrect === 1 ? 'auto_correct' : 'auto_wrong', nowIso());
}

// 今日到期任务：next_review_at <= 今天 且未标记"已掌握"
function getDueKps(today) {
  const db = getDb();
  return db.prepare(
    `SELECT kp.*, m.filename AS material_filename FROM knowledge_points kp
     JOIN materials m ON m.id = kp.material_id
     WHERE kp.mastery < 2 AND kp.next_review_at IS NOT NULL AND kp.next_review_at <= ?
     ORDER BY CASE WHEN kp.last_result = 'wrong' THEN 0 ELSE 1 END, kp.mastery ASC, kp.next_review_at ASC`
  ).all(today);
}

// 复习动作：got=记住了（拉长间隔）/ fuzzy=仍不熟悉（明天再来）/ mastered=已掌握（移出计划）
function applyReviewAction(kpId, action) {
  const db = getDb();
  const kp = db.prepare('SELECT * FROM knowledge_points WHERE id = ?').get(kpId);
  if (!kp) return null;
  const today = todayStr();
  let step = kp.interval_step;
  let nextReview = kp.next_review_at;
  let mastery = kp.mastery;

  if (action === 'got') {
    nextReview = addDays(today, INTERVALS[Math.min(step, INTERVALS.length - 1)]);
    step = Math.min(step + 1, INTERVALS.length - 1);
  } else if (action === 'fuzzy') {
    step = 0;
    nextReview = addDays(today, 1);
    if (mastery === 2) mastery = 1;
  } else if (action === 'mastered') {
    mastery = 2;
    nextReview = null;
  } else {
    return null;
  }
  db.prepare(
    'UPDATE knowledge_points SET interval_step=?, next_review_at=?, mastery=?, last_reviewed_at=? WHERE id=?'
  ).run(step, nextReview, mastery, nowIso(), kpId);
  db.prepare('INSERT INTO review_logs (id, knowledge_point_id, action, reviewed_at) VALUES (?,?,?,?)')
    .run(id(), kpId, action, nowIso());
  return db.prepare('SELECT * FROM knowledge_points WHERE id = ?').get(kpId);
}

function getSnippet(kp) {
  if (!kp.source_chunk_id) return null;
  const row = getDb().prepare('SELECT text, page, section FROM chunks WHERE id = ?').get(kp.source_chunk_id);
  if (!row) return null;
  return { text: truncate(row.text, 200), page: row.page, section: row.section };
}

module.exports = { upsertKnowledgePoint, applyAttemptToKp, getDueKps, applyReviewAction, getSnippet, getIntervalTable };
