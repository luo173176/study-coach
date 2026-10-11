'use strict';
// 6) 题目保存、答题和自动评分（含简答题 AI 评分与人工确认）
const { test } = require('node:test');
const { startApp, startMockAi, uploadSampleMaterial, assert } = require('./helpers');

async function freshApp(t) {
  const app = await startApp();
  t.after(() => app.server.close());
  return app;
}

const QUIZ_JSON = JSON.stringify({
  questions: [
    { type: 'single', question: '光合作用的主要场所是什么？', options: ['线粒体', '叶绿体', '细胞核', '核糖体'], answer: 1, explanation: '叶绿体是光合作用的场所。', knowledge_point: '光合作用场所', difficulty: '简单', source: 1 },
    { type: 'single', question: '这是一道答案越界的坏题', options: ['甲', '乙'], answer: 99, explanation: '无效', knowledge_point: '坏题', difficulty: '简单', source: 1 },
    { type: 'judge', question: '光合作用需要光照才能进行。', options: [], answer: true, explanation: '光合作用需要光作为动力。', knowledge_point: '光照条件', difficulty: '简单', source: 1 },
    { type: 'short', question: '简述呼吸作用释放的能量的去向。', options: [], answer: '一部分以热能形式散失，另一部分储存在ATP中', explanation: '见资料第三段。', knowledge_point: '呼吸作用能量', difficulty: '中等' },
  ],
});

async function withMockAi(app, handler) {
  const mock = await startMockAi(handler);
  app.config.ai.baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1';
  app.config.ai.apiKey = 'test-key';
  app.config.ai.cacheHours = 0;
  return mock;
}

async function generateQuestions(app) {
  const app2 = app;
  await withMockAi(app2, () => QUIZ_JSON);
  const { materials } = await (await fetch(app2.base + '/api/materials')).json();
  const res = await fetch(app2.base + '/api/questions/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ material_id: materials[0].id, types: ['single', 'judge', 'short'], count: 5 }),
  });
  const body = await res.json();
  return { status: res.status, body, materialId: materials[0].id };
}

test('生成题目：结构校验通过的入库，坏题被跳过并给出原因', async (t) => {
  const app = await freshApp(t);
  await uploadSampleMaterial(app.base);
  const { status, body } = await generateQuestions(app);
  assert.strictEqual(status, 201);
  assert.strictEqual(body.saved_count, 3, '3 道有效题入库');
  assert.strictEqual(body.skipped_count, 1, '1 道坏题被跳过');
  assert.ok(body.skipped_reasons.some((r) => r.includes('下标')));

  const rows = app.db().prepare('SELECT * FROM questions').all();
  assert.strictEqual(rows.length, 3);
  // 每道题都必须有原文依据
  for (const row of rows) assert.ok(row.source_chunk_id, '题目必须关联来源片段');
  // 知识点已登记
  const kps = app.db().prepare('SELECT * FROM knowledge_points').all();
  assert.strictEqual(kps.length, 3);
});

test('题库列表默认隐藏答案与解析；include_answer=1 才返回', async (t) => {
  const app = await freshApp(t);
  await uploadSampleMaterial(app.base);
  const { body } = await generateQuestions(app);
  assert.strictEqual(body.saved_count, 3);

  const list = await (await fetch(app.base + '/api/questions')).json();
  assert.ok(list.items.length === 3);
  for (const q of list.items) {
    assert.strictEqual(q.answer, undefined, '列表不应包含答案');
    assert.strictEqual(q.explanation, undefined, '列表不应包含解析');
    assert.ok(Array.isArray(q.options), '选项应始终是数组');
  }
  const first = list.items[0];
  const detail = await (await fetch(app.base + `/api/questions/${first.id}?include_answer=1`)).json();
  assert.notStrictEqual(detail.answer, undefined);
  assert.ok(detail.explanation);
});

test('客观题自动判分：答对/答错/多选漏选', async (t) => {
  const app = await freshApp(t);
  await uploadSampleMaterial(app.base);
  await generateQuestions(app);
  const list = (await (await fetch(app.base + '/api/questions')).json()).items;
  const single = list.find((q) => q.type === 'single');
  const judge = list.find((q) => q.type === 'judge');

  const post = (qid, answer) => fetch(app.base + '/api/attempts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question_id: qid, answer, time_ms: 5000 }),
  }).then((r) => r.json());

  const r1 = await post(single.id, 1);
  assert.strictEqual(r1.is_correct, 1);
  assert.strictEqual(r1.correct_answer, 1);
  assert.ok(r1.explanation);
  assert.strictEqual(r1.needs_confirm, false);

  const r2 = await post(single.id, 0);
  assert.strictEqual(r2.is_correct, 0);

  const r3 = await post(judge.id, true);
  assert.strictEqual(r3.is_correct, 1);

  const r4 = await post(judge.id, false);
  assert.strictEqual(r4.is_correct, 0);
});

test('简答题：AI 评分建议 + 用户确认后才计入统计', async (t) => {
  const app = await freshApp(t);
  await uploadSampleMaterial(app.base);
  await generateQuestions(app);
  const list = (await (await fetch(app.base + '/api/questions')).json()).items;
  const short = list.find((q) => q.type === 'short');

  await withMockAi(app, () => JSON.stringify({ score: 70, verdict: 'partial', comment: '答出了热能散失，遗漏 ATP 储存。' }));

  const res = await fetch(app.base + '/api/attempts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question_id: short.id, answer: '以热能形式散失', time_ms: 8000 }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201);
  assert.strictEqual(body.is_correct, null, '简答题不自动判对错');
  assert.strictEqual(body.needs_confirm, true);
  assert.strictEqual(body.ai.score, 70);
  assert.strictEqual(body.ai.verdict, 'partial');

  // 用户确认答错 → 写入错题统计
  await fetch(app.base + `/api/attempts/${body.attempt_id}/confirm`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_correct: 0 }),
  });
  const attempt = app.db().prepare('SELECT * FROM attempts WHERE id = ?').get(body.attempt_id);
  assert.strictEqual(attempt.is_correct, 0);
  assert.strictEqual(attempt.confirmed, 1);
});

test('AI 不可用时简答题：仍记录作答，返回明确错误，用户可自行确认', async (t) => {
  const app = await freshApp(t);
  await uploadSampleMaterial(app.base);
  await generateQuestions(app);
  const list = (await (await fetch(app.base + '/api/questions')).json()).items;
  const short = list.find((q) => q.type === 'short');

  // 清空 key 模拟未配置模型
  app.config.ai.apiKey = '';
  const res = await fetch(app.base + '/api/attempts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question_id: short.id, answer: '我的答案' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, 'AI 失败不影响作答记录');
  assert.strictEqual(body.is_correct, null);
  assert.ok(body.ai_error, '应返回 AI 不可用的说明');
  assert.strictEqual(body.needs_confirm, true);
});

test('编辑题目：可以修改答案与解析（人工把关）', async (t) => {
  const app = await freshApp(t);
  await uploadSampleMaterial(app.base);
  await generateQuestions(app);
  const list = (await (await fetch(app.base + '/api/questions')).json()).items;
  const single = list.find((q) => q.type === 'single');
  const res = await fetch(app.base + '/api/questions/' + single.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '修改后的题干：光合作用场所在哪里？', answer: 0, difficulty: '中等' }),
  });
  assert.strictEqual(res.status, 200);
  const detail = await (await fetch(app.base + `/api/questions/${single.id}?include_answer=1`)).json();
  assert.strictEqual(detail.answer, 0);
  assert.strictEqual(detail.difficulty, '中等');
  assert.ok(detail.question.includes('修改后的题干'));
});

test('删除题目：同时清理答题记录', async (t) => {
  const app = await freshApp(t);
  await uploadSampleMaterial(app.base);
  await generateQuestions(app);
  const list = (await (await fetch(app.base + '/api/questions')).json()).items;
  const single = list.find((q) => q.type === 'single');
  await fetch(app.base + '/api/attempts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question_id: single.id, answer: 1 }),
  });
  const del = await fetch(app.base + '/api/questions/' + single.id, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(app.db().prepare('SELECT COUNT(*) c FROM attempts').get().c, 0);
  assert.strictEqual(app.db().prepare('SELECT COUNT(*) c FROM questions').get().c, 2);
});
