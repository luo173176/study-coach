'use strict';
// 8) 9) AI 客户端：密钥缺失、超时、重试、缓存、用量日志、JSON 提取
const { test } = require('node:test');
const { startApp, startMockAi, assert } = require('./helpers');

async function freshApp(t) {
  const app = await startApp();
  t.after(() => app.server.close());
  return app;
}

test('未配置 API Key 时给出明确错误（不是崩溃）', async (t) => {
  const app = await freshApp(t);
  app.config.ai.apiKey = '';
  app.config.ai.baseUrl = 'https://example.invalid/v1';
  const { chat, AiConfigError } = require('../server/ai/client');
  await assert.rejects(() => chat([{ role: 'user', content: 'hi' }], { useCache: false }), AiConfigError);
});

test('模型超时：抛出可识别的超时错误并记录日志', async (t) => {
  const app = await freshApp(t);
  const mock = await startMockAi(async () => {
    await new Promise((r) => setTimeout(r, 800));
    return '太慢了';
  });
  app.config.ai.baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1';
  app.config.ai.apiKey = 'test-key';
  app.config.ai.timeoutMs = 150;
  app.config.ai.maxRetries = 0;
  const { chat, AiTimeoutError } = require('../server/ai/client');
  await assert.rejects(() => chat([{ role: 'user', content: 'hi' }], { useCache: false }), AiTimeoutError);
  const log = app.db().prepare("SELECT * FROM ai_logs WHERE status = 'error'").get();
  assert.ok(log, '失败调用应记录日志');
  assert.ok(log.error.includes('超时'));
  mock.close();
});

test('5xx 自动重试后成功', async (t) => {
  const app = await freshApp(t);
  let calls = 0;
  const mock = await startMockAi((payload, req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return undefined;
    }
    return '重试成功';
  });
  app.config.ai.baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1';
  app.config.ai.apiKey = 'test-key';
  app.config.ai.timeoutMs = 5000;
  app.config.ai.maxRetries = 1;
  const { chat } = require('../server/ai/client');
  const r = await chat([{ role: 'user', content: 'hi' }], { useCache: false });
  assert.strictEqual(r.text, '重试成功');
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.usage.prompt_tokens, 10);
  assert.strictEqual(r.usage.unknown, false);
  mock.close();
});

test('400 等不可重试错误不重试', async (t) => {
  const app = await freshApp(t);
  let calls = 0;
  const mock = await startMockAi((payload, req, res) => {
    calls++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    return undefined;
  });
  app.config.ai.baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1';
  app.config.ai.apiKey = 'wrong';
  app.config.ai.maxRetries = 3;
  const { chat } = require('../server/ai/client');
  await assert.rejects(() => chat([{ role: 'user', content: 'hi' }], { useCache: false }), /401/);
  assert.strictEqual(calls, 1);
  mock.close();
});

test('相同输入命中缓存（第二次不请求模型）', async (t) => {
  const app = await freshApp(t);
  let calls = 0;
  const mock = await startMockAi(() => {
    calls++;
    return '缓存结果';
  });
  app.config.ai.baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1';
  app.config.ai.apiKey = 'test-key';
  app.config.ai.cacheHours = 1;
  const { chat } = require('../server/ai/client');
  const msgs = [{ role: 'user', content: '缓存测试' }];
  const r1 = await chat(msgs, { useCache: true });
  const r2 = await chat(msgs, { useCache: true });
  assert.strictEqual(r1.cached, false);
  assert.strictEqual(r2.cached, true);
  assert.strictEqual(r2.text, '缓存结果');
  assert.strictEqual(calls, 1);
  mock.close();
});

test('成功的调用记录 Token 用量与耗时；平台未返回用量时标记未知', async (t) => {
  const app = await freshApp(t);
  // 用没有 usage 字段的响应验证"未知"标记
  const mock2 = require('node:http').createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '无用量' } }] }));
  });
  await new Promise((r) => mock2.listen(0, '127.0.0.1', r));
  app.config.ai.baseUrl = 'http://127.0.0.1:' + mock2.address().port + '/v1';
  app.config.ai.apiKey = 'test-key';
  const { chat } = require('../server/ai/client');
  const r = await chat([{ role: 'user', content: '用量测试' }], { useCache: false });
  assert.strictEqual(r.usage.unknown, true);
  assert.strictEqual(r.usage.prompt_tokens, null);
  const log = app.db().prepare("SELECT * FROM ai_logs WHERE status = 'ok' ORDER BY created_at DESC").get();
  assert.ok(log);
  assert.strictEqual(log.prompt_tokens, null);
  assert.ok(log.duration_ms >= 0);
  mock2.close();
});

test('extractJson：兼容代码块、前后缀文本和非法输出', async (t) => {
  const { extractJson } = require('../server/ai/client');
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('好的，以下是结果：{"a":[1,2]} 以上'), { a: [1, 2] });
  assert.deepStrictEqual(extractJson('[{"x":1}]'), [{ x: 1 }]);
  assert.strictEqual(extractJson('完全不是 JSON'), null);
  assert.strictEqual(extractJson('{"a": "未闭合'), null);
});

test('jsonChat：模型第一次输出非法 JSON 时自动纠正一轮', async (t) => {
  const app = await freshApp(t);
  let calls = 0;
  const mock = await startMockAi(() => {
    calls++;
    return calls === 1 ? '抱歉，这是普通文本' : '{"ok":true}';
  });
  app.config.ai.baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1';
  app.config.ai.apiKey = 'test-key';
  const { jsonChat } = require('../server/ai/client');
  const r = await jsonChat([{ role: 'user', content: 'hi' }], { useCache: false });
  assert.deepStrictEqual(r.data, { ok: true });
  assert.strictEqual(calls, 2);
  mock.close();
});
