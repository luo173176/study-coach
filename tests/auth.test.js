'use strict';
// 访问密码（数据访问控制）
const { test } = require('node:test');
process.env.APP_PASSWORD = '测试密码123';
const { startApp, uploadFile, assert } = require('./helpers');

async function freshApp(t) {
  const app = await startApp();
  t.after(() => app.server.close());
  return app;
}

async function login(base, password) {
  return fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

test('设置密码后：未登录访问 API 被 401 拒绝', async (t) => {
  const app = await freshApp(t);
  const res = await fetch(app.base + '/api/materials');
  assert.strictEqual(res.status, 401);
  // 状态接口可以匿名访问（前端需要它判断是否要显示登录框）
  const state = await (await fetch(app.base + '/api/auth/state')).json();
  assert.strictEqual(state.passwordEnabled, true);
  assert.strictEqual(state.authed, false);
});

test('错误密码 401；正确密码获得令牌后可正常使用', async (t) => {
  const app = await freshApp(t);
  const bad = await login(app.base, '错误密码');
  assert.strictEqual(bad.status, 401);

  const good = await login(app.base, '测试密码123');
  assert.strictEqual(good.status, 200);
  const { token } = await good.json();
  assert.ok(token);

  const authed = await fetch(app.base + '/api/materials', { headers: { Authorization: 'Bearer ' + token } });
  assert.strictEqual(authed.status, 200);

  // 带令牌上传也正常
  const up = await uploadFile(app.base, '私有笔记.txt', Buffer.from('私有内容', 'utf8'), { Authorization: 'Bearer ' + token });
  assert.strictEqual(up.status, 201);
});

test('令牌过期/伪造被拒绝', async (t) => {
  const app = await freshApp(t);
  const fake = await fetch(app.base + '/api/materials', { headers: { Authorization: 'Bearer fake-token' } });
  assert.strictEqual(fake.status, 401);
  // 造一个已过期的会话
  const db = app.db();
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?,?)').run('expired', '2000-01-01T00:00:00.000Z');
  const expired = await fetch(app.base + '/api/materials', { headers: { Authorization: 'Bearer expired' } });
  assert.strictEqual(expired.status, 401);
});
