'use strict';
// 测试公共工具：每个测试文件是独立进程，require 时各自初始化临时数据目录
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ---- 环境初始化（在 require server 模块之前执行）----
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'study-coach-test-'));
process.env.DATA_DIR = DATA_DIR;
if (process.env.UPLOAD_MAX_MB === undefined) process.env.UPLOAD_MAX_MB = '20';
if (process.env.AI_CACHE_HOURS === undefined) process.env.AI_CACHE_HOURS = '0';

function startApp() {
  const { createApp } = require('../server/app');
  const { resetAllTables } = require('../server/db');
  const app = createApp();
  resetAllTables(); // 每个测试用例独享干净数据库
  const server = app.listen(0, '127.0.0.1');
  // 关闭时同时断开 keep-alive 连接，避免测试进程挂起
  const origClose = server.close.bind(server);
  server.close = (cb) => { try { server.closeAllConnections(); } catch { /* 兼容 */ } return origClose(cb); };
  return new Promise((resolve) => {
    server.once('listening', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      resolve({
        server,
        base,
        config: require('../server/config'),
        db: () => require('../server/db').getDb(),
      });
    });
  });
}

async function uploadFile(base, filename, buffer, headers = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), filename);
  return fetch(base + '/api/materials', { method: 'POST', body: fd, headers });
}

// 生成最小合法 PDF（含正确 xref 偏移），每页一段 ASCII 文本
function makePdf(pageTexts) {
  const objects = [];
  const n = pageTexts.length;
  const fontId = 3 + n * 2;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`;
  pageTexts.forEach((text, i) => {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    const escaped = String(text).replace(/([()\\])/g, '\\$1');
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let body = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = body.length;
  const maxId = objects.length - 1;
  body += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) body += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  body += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// 模拟 OpenAI 兼容模型服务；handler 返回字符串内容（或抛错）
function startMockAi(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const out = await handler(payload, req, res);
        if (out === undefined) return; // handler 已自行响应
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: out } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
  });
  const origClose = server.close.bind(server);
  server.close = (cb) => { try { server.closeAllConnections(); } catch { /* 兼容 */ } return origClose(cb); };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function setMockAi(config, url) {
  config.ai.baseUrl = url + '/v1';
  config.ai.apiKey = config.ai.apiKey || 'test-key';
}

const SAMPLE_TEXT = `光合作用是绿色植物利用光能，把二氧化碳和水转化为有机物（主要是淀粉），并释放氧气的过程。

光合作用的场所是叶绿体。叶绿体中含有叶绿素，叶绿素能够吸收光能。光合作用的原料是二氧化碳和水，产物是有机物和氧气，动力是光照。

呼吸作用是细胞利用氧气，把有机物分解成二氧化碳和水，同时释放能量的过程。呼吸作用释放的能量，一部分以热能形式散失，另一部分储存在ATP中，供生命活动利用。呼吸作用主要在线粒体中进行，有光无光都能进行。

光合作用与呼吸作用的区别：光合作用储存能量，呼吸作用释放能量；光合作用需要光，呼吸作用有光无光都可以进行；光合作用吸收二氧化碳放出氧气，呼吸作用吸收氧气放出二氧化碳。二者相互依存，共同维持自然界中的碳氧平衡。`;

async function uploadSampleMaterial(base, filename = '生物笔记.txt', text = SAMPLE_TEXT) {
  const res = await uploadFile(base, filename, Buffer.from(text, 'utf8'));
  const body = await res.json();
  assert.strictEqual(res.status, 201, '上传样例资料应成功');
  assert.strictEqual(body.material.status, 'ready');
  return body.material;
}

const assert = require('node:assert');

module.exports = { DATA_DIR, startApp, uploadFile, makePdf, startMockAi, setMockAi, SAMPLE_TEXT, uploadSampleMaterial, assert };
