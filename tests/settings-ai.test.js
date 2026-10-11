'use strict';
// 网页自定义模型配置：保存/生效/掩码/校验/重置
const { test } = require('node:test');
const { startApp, startMockAi, assert } = require('./helpers');

async function freshApp(t) {
  const app = await startApp();
  t.after(() => app.server.close());
  return app;
}

test('GET /api/settings 只返回 Key 掩码，绝不回传完整 Key', async (t) => {
  const app = await freshApp(t);
  app.config.ai.apiKey = 'sk-secret-1234567890abcd';
  const body = await (await fetch(app.base + '/api/settings')).json();
  assert.strictEqual(body.ai.api_key_set, true);
  assert.strictEqual(body.ai.api_key_masked, 'sk-***abcd');
  assert.ok(!JSON.stringify(body).includes('sk-secret-1234567890abcd'), '完整 Key 不能出现在响应中');
});

test('网页保存配置后立即生效：模型调用使用新配置，且无需重启', async (t) => {
  const app = await freshApp(t);
  let seen = null;
  const mock = await startMockAi((payload, req) => {
    seen = { model: payload.model, auth: req.headers.authorization };
    return '正常';
  });
  app.config.ai.baseUrl = 'http://127.0.0.1:1/v1'; // 故意指向无效地址，逼出"必须用网页配置"
  app.config.ai.apiKey = 'env-key-placeholder';

  const save = await fetch(app.base + '/api/settings/ai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'sk-webkey-12345678', base_url: 'http://127.0.0.1:' + mock.address().port + '/v1', model: 'web-model-1' }),
  });
  assert.strictEqual(save.status, 200);

  const testRes = await (await fetch(app.base + '/api/settings/test', { method: 'POST' })).json();
  assert.strictEqual(testRes.ok, true);
  assert.strictEqual(seen.model, 'web-model-1', '应使用网页配置的模型名');
  assert.strictEqual(seen.auth, 'Bearer sk-webkey-12345678', '应使用网页配置的 Key');

  const body = await (await fetch(app.base + '/api/settings')).json();
  assert.strictEqual(body.ai.source.model, 'web');
  assert.strictEqual(body.ai.source.baseUrl, 'web');
  assert.ok(!JSON.stringify(body).includes('sk-webkey-12345678'), '保存后的完整 Key 不能被回传');
  mock.close();
});

test('保存后重启级别失效检查：覆盖值持久保存在数据库中', async (t) => {
  const app = await freshApp(t);
  await fetch(app.base + '/api/settings/ai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'persist-model' }),
  });
  const row = app.db().prepare("SELECT value FROM app_settings WHERE key = 'ai_model'").get();
  assert.strictEqual(row.value, 'persist-model');
});

test('非法输入被拒绝：坏地址 / 坏模型名 / 过短 Key', async (t) => {
  const app = await freshApp(t);
  const post = (b) => fetch(app.base + '/api/settings/ai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  });
  assert.strictEqual((await post({ base_url: 'ftp://x.com' })).status, 400);
  assert.strictEqual((await post({ base_url: '不是地址' })).status, 400);
  assert.strictEqual((await post({ model: '坏模型 名' })).status, 400);
  assert.strictEqual((await post({ api_key: '短' })).status, 400);
  // 合法输入可以带常见字符
  assert.strictEqual((await post({ model: 'Qwen/Qwen2.5-7B-Instruct' })).status, 200);
});

test('恢复 .env 默认：网页覆盖被清除，来源回到 env', async (t) => {
  const app = await freshApp(t);
  app.config.ai.model = 'env-default-model';
  await fetch(app.base + '/api/settings/ai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'web-override' }),
  });
  let body = await (await fetch(app.base + '/api/settings')).json();
  assert.strictEqual(body.ai.model, 'web-override');

  const reset = await fetch(app.base + '/api/settings/ai/reset', { method: 'POST' });
  assert.strictEqual(reset.status, 200);
  body = await (await fetch(app.base + '/api/settings')).json();
  assert.strictEqual(body.ai.model, 'env-default-model');
  assert.strictEqual(body.ai.source.model, 'env');
});

test('Key 留空提交 = 不修改现有 Key', async (t) => {
  const app = await freshApp(t);
  await fetch(app.base + '/api/settings/ai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'sk-first-key-12345678' }),
  });
  await fetch(app.base + '/api/settings/ai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'another-model', api_key: '   ' }),
  });
  const row = app.db().prepare("SELECT value FROM app_settings WHERE key = 'ai_api_key'").get();
  assert.strictEqual(row.value, 'sk-first-key-12345678', '留空不应清除或覆盖 Key');
});
