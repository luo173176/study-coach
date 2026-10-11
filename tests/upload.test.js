'use strict';
// 1) 文件上传与非法文件拒绝；2) PDF 提取与页码保留
// 本文件关闭 OCR：验证"扫描版报错"的旧约定；OCR 行为见 ocr.test.js
const { test } = require('node:test');
process.env.UPLOAD_MAX_MB = '1'; // 本文件统一用 1MB 上限，验证超大文件拒绝
process.env.OCR_ENABLED = '0';
const { startApp, uploadFile, makePdf, assert } = require('./helpers');

test('上传 TXT：成功解析并生成检索片段', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const res = await uploadFile(app.base, '笔记.txt', Buffer.from('# 第一章\n\n光合作用的内容', 'utf8'));
  const body = await res.json();
  assert.strictEqual(res.status, 201);
  assert.strictEqual(body.material.status, 'ready');
  assert.ok(body.chunk_count >= 1);
  const chunks = app.db().prepare('SELECT * FROM chunks WHERE material_id = ?').all(body.material.id);
  assert.ok(chunks.length >= 1);
  assert.strictEqual(chunks[0].page, null); // TXT 没有页码
});

test('上传 Markdown：保留章节标题', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const md = '# 光合作用\n\n叶绿体吸收光能。\n\n## 呼吸作用\n\n线粒体分解有机物。';
  const res = await uploadFile(app.base, '笔记.md', Buffer.from(md, 'utf8'));
  const body = await res.json();
  assert.strictEqual(body.material.status, 'ready');
  const chunks = app.db().prepare('SELECT * FROM chunks WHERE material_id = ? ORDER BY idx').all(body.material.id);
  assert.ok(chunks.some((c) => c.section && c.section.includes('光合作用')));
});

test('上传 PDF：提取文本并保留页码', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const pdf = makePdf([
    'Photosynthesis converts light energy into chemical energy.',
    'Respiration releases energy from organic molecules.',
  ]);
  const res = await uploadFile(app.base, '讲义.pdf', pdf);
  const body = await res.json();
  assert.strictEqual(body.material.status, 'ready', 'PDF 应解析成功: ' + (body.material.error || ''));
  assert.strictEqual(body.material.page_count, 2);
  const chunks = app.db().prepare('SELECT * FROM chunks WHERE material_id = ?').all(body.material.id);
  assert.ok(chunks.length >= 2);
  const pages = new Set(chunks.map((c) => c.page));
  assert.ok(pages.has(1) && pages.has(2), '片段应带有页码 1 和 2');
  // 详情接口返回每页文本
  const detail = await (await fetch(app.base + '/api/materials/' + body.material.id)).json();
  assert.strictEqual(detail.material.pages.length, 2);
  assert.ok(detail.material.pages[0].text.includes('Photosynthesis'));
});

test('拒绝不支持的文件类型', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const res = await uploadFile(app.base, '恶意程序.exe', Buffer.from('MZ...'));
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.ok(body.error.includes('不支持的文件类型'));
});

test('拒绝空文件', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const res = await uploadFile(app.base, '空文件.txt', Buffer.from(''));
  assert.strictEqual(res.status, 400);
});

test('拒绝超过大小限制的文件（413）', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const big = Buffer.alloc(2 * 1024 * 1024, 'a'); // 上限 1MB
  const res = await uploadFile(app.base, '超大.txt', big);
  assert.strictEqual(res.status, 413);
  const body = await res.json();
  assert.ok(body.error.includes('大小限制'));
});

test('伪装成 PDF 的损坏文件：明确报错而不是假装成功', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const res = await uploadFile(app.base, '假.pdf', Buffer.from('这不是一个 PDF 文件'));
  const body = await res.json();
  assert.strictEqual(res.status, 201);
  assert.strictEqual(body.material.status, 'failed');
  assert.ok(body.material.error && body.material.error.length > 0);
});

test('无文字的扫描版 PDF：明确提示不支持，而不是假装解析成功', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const res = await uploadFile(app.base, '扫描版.pdf', makePdf(['', '']));
  const body = await res.json();
  assert.strictEqual(body.material.status, 'failed');
  assert.ok(body.material.error.includes('扫描版'));
});

test('文件名包含路径分隔符时被清理（防路径穿越）', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const res = await uploadFile(app.base, '..\\..\\evil.txt', Buffer.from('内容', 'utf8'));
  const body = await res.json();
  assert.strictEqual(res.status, 201);
  assert.ok(!body.material.filename.includes('..'));
  assert.ok(!body.material.filename.includes('\\'));
});
