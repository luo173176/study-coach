'use strict';
// 7) 错题记录与复习任务更新；10) 数据删除行为
const { test } = require('node:test');
const { startApp, uploadSampleMaterial, assert } = require('./helpers');
const { upsertKnowledgePoint, getDueKps } = require('../server/services/kp');
const { id, todayStr, addDays } = require('../server/util');

async function freshApp(t) {
  const app = await startApp();
  t.after(() => app.server.close());
  return app;
}

// 造一道理论上"光合作用"的单选题并作答
async function makeQuestion(app, materialId, kpName) {
  const kpId = upsertKnowledgePoint(kpName, materialId, null);
  const chunk = app.db().prepare('SELECT id, page FROM chunks WHERE material_id = ? LIMIT 1').get(materialId);
  const qid = id();
  app.db().prepare(
    'INSERT INTO questions (id, material_id, knowledge_point_id, type, question, options_json, answer_json, explanation, difficulty, source_chunk_id, source_page, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(qid, materialId, kpId, 'single', '光合作用的场所是？', JSON.stringify(['线粒体', '叶绿体']), JSON.stringify(1), '叶绿体是场所。', '简单', chunk.id, chunk.page, new Date().toISOString());
  return { qid, kpId };
}

const answer = (base, qid, ans) => fetch(base + '/api/attempts', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ question_id: qid, answer: ans }),
}).then((r) => r.json());

test('答错后：错题本出现记录，知识点明天安排复习', async (t) => {
  const app = await freshApp(t);
  const m = await uploadSampleMaterial(app.base);
  const { qid, kpId } = await makeQuestion(app, m.id, '光合作用场所');

  await answer(app.base, qid, 0); // 答"线粒体"，错误

  const mistakes = await (await fetch(app.base + '/api/mistakes')).json();
  assert.strictEqual(mistakes.items.length, 1);
  assert.strictEqual(mistakes.items[0].kp_name, '光合作用场所');
  assert.strictEqual(mistakes.items[0].correct_answer, 1);
  assert.ok(mistakes.items[0].explanation);

  const kp = app.db().prepare('SELECT * FROM knowledge_points WHERE id = ?').get(kpId);
  assert.strictEqual(kp.attempts, 1);
  assert.strictEqual(kp.correct, 0);
  assert.strictEqual(kp.last_result, 'wrong');
  assert.strictEqual(kp.next_review_at, addDays(todayStr(), 1));

  // 出现在今日任务列表（明天到期，今天查时 overdue=0 但已到期日<=明天？——今日任务只含 <=今天）
  const today = await (await fetch(app.base + '/api/review/today')).json();
  assert.strictEqual(today.total, 0, '明天到期的任务今天不显示');

  // 手动把到期日改成今天 → 出现在任务里且优先级最高
  app.db().prepare('UPDATE knowledge_points SET next_review_at = ? WHERE id = ?').run(todayStr(), kpId);
  const today2 = await (await fetch(app.base + '/api/review/today')).json();
  assert.strictEqual(today2.total, 1);
  assert.strictEqual(today2.tasks[0].kp_id, kpId);
});

test('答对后：复习间隔按规则拉长', async (t) => {
  const app = await freshApp(t);
  const m = await uploadSampleMaterial(app.base);
  const { qid, kpId } = await makeQuestion(app, m.id, '间隔规则');
  await answer(app.base, qid, 1); // 答对
  const kp = app.db().prepare('SELECT * FROM knowledge_points WHERE id = ?').get(kpId);
  assert.strictEqual(kp.last_result, 'correct');
  assert.strictEqual(kp.next_review_at, addDays(todayStr(), 1), '第一次答对明天复习');
  assert.strictEqual(kp.interval_step, 1);
  await answer(app.base, qid, 1);
  const kp2 = app.db().prepare('SELECT * FROM knowledge_points WHERE id = ?').get(kpId);
  assert.strictEqual(kp2.next_review_at, addDays(todayStr(), 2), '第二次连续答对 2 天后');
});

test('复习动作：记住了拉长间隔 / 仍不熟悉明天再来 / 已掌握移出计划', async (t) => {
  const app = await freshApp(t);
  const m = await uploadSampleMaterial(app.base);
  const { qid, kpId } = await makeQuestion(app, m.id, '复习动作');
  await answer(app.base, qid, 0); // 答错 → 明天到期

  // 仍不熟悉 → 明天
  let r = await (await fetch(app.base + `/api/review/knowledge-points/${kpId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'fuzzy' }),
  })).json();
  assert.strictEqual(r.knowledge_point.next_review_at, addDays(todayStr(), 1));

  // 记住了 → 间隔表第 1 档
  r = await (await fetch(app.base + `/api/review/knowledge-points/${kpId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'got' }),
  })).json();
  assert.strictEqual(r.knowledge_point.next_review_at, addDays(todayStr(), 1));

  // 已掌握 → 移出
  r = await (await fetch(app.base + `/api/review/knowledge-points/${kpId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mastered' }),
  })).json();
  assert.strictEqual(r.knowledge_point.mastery, 2);
  assert.strictEqual(r.knowledge_point.next_review_at, null);
  const due = await (await fetch(app.base + '/api/review/today')).json();
  assert.strictEqual(due.total, 0, '已掌握的不出现在任务里');

  // 无效动作被拒绝
  const bad = await fetch(app.base + `/api/review/knowledge-points/${kpId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'hack' }),
  });
  assert.strictEqual(bad.status, 400);

  // 历史已记录
  const hist = await (await fetch(app.base + '/api/review/history')).json();
  assert.ok(hist.items.some((h) => h.action === 'mastered'));
  assert.ok(hist.items.some((h) => h.action === 'auto_wrong'));
});

test('已掌握的知识点答错后自动退回"学习中"（不轻易下永久结论）', async (t) => {
  const app = await freshApp(t);
  const m = await uploadSampleMaterial(app.base);
  const { qid, kpId } = await makeQuestion(app, m.id, '退回规则');
  app.db().prepare('UPDATE knowledge_points SET mastery = 2 WHERE id = ?').run(kpId);
  await answer(app.base, qid, 0);
  const kp = app.db().prepare('SELECT * FROM knowledge_points WHERE id = ?').get(kpId);
  assert.strictEqual(kp.mastery, 1, '答错应从已掌握退回学习中');
  assert.strictEqual(kp.next_review_at, addDays(todayStr(), 1));
});

test('手动调整掌握程度', async (t) => {
  const app = await freshApp(t);
  const m = await uploadSampleMaterial(app.base);
  const { kpId } = await makeQuestion(app, m.id, '手动掌握');
  const r = await fetch(app.base + `/api/review/knowledge-points/${kpId}/mastery`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mastery: 0 }),
  });
  assert.strictEqual(r.status, 200);
  const kp = app.db().prepare('SELECT * FROM knowledge_points WHERE id = ?').get(kpId);
  assert.strictEqual(kp.mastery, 0);
  const bad = await fetch(app.base + `/api/review/knowledge-points/${kpId}/mastery`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mastery: 5 }),
  });
  assert.strictEqual(bad.status, 400);
});

test('删除资料级联删除全部衍生数据；缺失 id 返回 404', async (t) => {
  const app = await freshApp(t);
  const m = await uploadSampleMaterial(app.base);
  const { qid, kpId } = await makeQuestion(app, m.id, '级联删除');
  await answer(app.base, qid, 0);
  // 造一条引用该资料的问答记录
  app.db().prepare('INSERT INTO qa_logs (id, question, answer, material_ids, insufficient, sources_json, created_at) VALUES (?,?,?,?,0,?,?)')
    .run(id(), '问题', '回答', JSON.stringify([m.id]), '[]', new Date().toISOString());

  assert.ok(app.db().prepare('SELECT COUNT(*) c FROM chunks WHERE material_id=?').get(m.id).c > 0);

  const del = await fetch(app.base + '/api/materials/' + m.id, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);

  const counts = (t2) => app.db().prepare(`SELECT COUNT(*) c FROM ${t2}`).get().c;
  assert.strictEqual(counts('materials'), 0);
  assert.strictEqual(counts('chunks'), 0);
  assert.strictEqual(counts('questions'), 0);
  assert.strictEqual(counts('attempts'), 0);
  assert.strictEqual(counts('knowledge_points'), 0);
  assert.strictEqual(counts('review_logs'), 0);
  assert.strictEqual(counts('qa_logs'), 0, '引用该资料的问答记录一并删除');

  const again = await fetch(app.base + '/api/materials/' + m.id, { method: 'DELETE' });
  assert.strictEqual(again.status, 404);
  const missing = await fetch(app.base + '/api/materials/no-such-id');
  assert.strictEqual(missing.status, 404);
});

test('清空全部数据：需要显式确认；确认后库表清空', async (t) => {
  const app = await freshApp(t);
  await uploadSampleMaterial(app.base);
  const noConfirm = await fetch(app.base + '/api/settings/clear-data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.strictEqual(noConfirm.status, 400);

  const ok = await fetch(app.base + '/api/settings/clear-data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }),
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(app.db().prepare('SELECT COUNT(*) c FROM materials').get().c, 0);
  assert.strictEqual(app.db().prepare('SELECT COUNT(*) c FROM chunks').get().c, 0);
});
