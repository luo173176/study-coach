'use strict';
// 4) 无相关资料时正确提示证据不足；5) 引用与实际检索片段的一致性
const { test } = require('node:test');
const { startApp, startMockAi, uploadSampleMaterial, assert } = require('./helpers');

async function freshApp(t) {
  const app = await startApp();
  t.after(() => app.server.close());
  return app;
}

async function withMockAi(app, handler) {
  const mock = await startMockAi(handler);
  app.config.ai.baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1';
  app.config.ai.apiKey = 'test-key';
  app.config.ai.cacheHours = 0;
  return mock;
}

test('资料库为空时提问：不调用模型，直接提示证据不足', async (t) => {
  const app = await freshApp(t);
  let modelCalls = 0;
  await withMockAi(app, () => { modelCalls++; return '不应被调用'; });
  const res = await fetch(app.base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '光合作用的原料是什么？' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.insufficient, true);
  assert.ok(body.answer.includes('现有资料不足以回答'));
  assert.strictEqual(modelCalls, 0, '没有任何资料时不应调用模型');
  assert.strictEqual(body.sources.length, 0);
});

test('问题与资料完全无关时：不调用模型，提示证据不足', async (t) => {
  const app = await freshApp(t);
  await uploadSampleMaterial(app.base);
  let modelCalls = 0;
  await withMockAi(app, () => { modelCalls++; return '不应被调用'; });
  const res = await fetch(app.base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '量子纠缠的实验步骤有哪些？' }),
  });
  const body = await res.json();
  assert.strictEqual(body.insufficient, true);
  assert.strictEqual(modelCalls, 0, '检索不到相关内容时不应浪费模型调用');
});

test('正常问答：引用编号与实际检索片段一致，无效引用被剔除', async (t) => {
  const app = await freshApp(t);
  const material = await uploadSampleMaterial(app.base);
  await withMockAi(app, (payload) => {
    const ctx = payload.messages[1].content;
    assert.ok(ctx.includes('[1] 来源：生物笔记.txt'), '提示词中应包含带来源的片段编号');
    return '光合作用的原料是二氧化碳和水 [1]。此外（模型推断）光照是动力条件 [9]。';
  });
  const res = await fetch(app.base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '光合作用的原料是什么？' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.insufficient, false);
  assert.ok(body.answer.includes('[1]'), '有效引用保留');
  assert.ok(!body.answer.includes('[9]'), '越界引用被剔除');
  assert.deepStrictEqual(body.stripped, [9]);
  assert.ok(body.sources.length >= 1);
  assert.strictEqual(body.sources[0].idx, 1);
  assert.strictEqual(body.sources[0].filename, '生物笔记.txt');
  assert.strictEqual(body.sources[0].cited, true, '被引用的片段应标记 cited');

  // 引用一致性：来源摘要必须是真实片段文本的子串
  const chunk = app.db().prepare('SELECT text FROM chunks WHERE material_id = ? LIMIT 1').get(material.id);
  assert.ok(chunk.text.includes(body.sources[0].snippet.replace(/…$/, '').slice(0, 80)));

  // 历史记录已保存
  const hist = await (await fetch(app.base + '/api/chat/history')).json();
  assert.ok(hist.items.length >= 1);
});

test('模型自行承认证据不足时：标记 insufficient', async (t) => {
  const app = await freshApp(t);
  await uploadSampleMaterial(app.base);
  await withMockAi(app, () => '现有资料不足以回答这个问题。资料中没有提到相关内容。');
  const res = await fetch(app.base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '光合作用的历史发展是怎样的？' }),
  });
  const body = await res.json();
  assert.strictEqual(body.insufficient, true);
  assert.ok(body.answer.includes('现有资料不足'));
});

test('选择指定资料提问：只在该资料范围内检索', async (t) => {
  const app = await freshApp(t);
  const m1 = await uploadSampleMaterial(app.base, '生物.txt');
  const m2 = await uploadSampleMaterial(app.base, '物理.txt', '牛顿第二定律：加速度与合外力成正比。');
  await withMockAi(app, (payload) => {
    const ctx = payload.messages[1].content;
    assert.ok(!ctx.includes('物理.txt'), '不应包含未选择资料的片段');
    return '依据资料回答 [1]';
  });
  const res = await fetch(app.base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '呼吸作用在哪里进行？', material_ids: [m1.id] }),
  });
  const body = await res.json();
  assert.strictEqual(body.insufficient, false);
  assert.ok(body.sources.every((s) => s.filename === '生物.txt'));
});
