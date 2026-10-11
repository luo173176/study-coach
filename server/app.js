'use strict';
// Express 应用组装（导出 createApp 供测试复用）
const express = require('express');
const path = require('path');
const { getDb } = require('./db');
const { authMiddleware } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');
const { AiConfigError, AiTimeoutError, AiResponseError } = require('./ai/client');

function createApp() {
  getDb(); // 启动时完成建表

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(authMiddleware);

  const api = express.Router();
  api.use(rateLimit(120)); // 全局兜底限流

  api.use('/auth', require('./routes/auth'));
  api.use('/materials', require('./routes/materials'));
  api.use('/chat', require('./routes/chat'));
  api.use('/notes', require('./routes/notes'));
  api.use('/questions', require('./routes/questions'));
  api.use('/attempts', require('./routes/attempts'));
  api.use('/mistakes', require('./routes/mistakes'));
  api.use('/review', require('./routes/review'));
  api.use('/dashboard', require('./routes/dashboard'));
  api.use('/settings', require('./routes/settings'));
  api.use('/knowledge-points', require('./routes/knowledgePoints'));

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // SPA 入口
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // 统一错误处理：把常见错误映射为清晰的中文提示
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof AiConfigError) return res.status(503).json({ error: err.message, code: err.code });
    if (err instanceof AiTimeoutError) return res.status(504).json({ error: err.message, code: err.code });
    if (err instanceof AiResponseError) return res.status(502).json({ error: err.message, code: err.code });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求体不是合法 JSON。' });
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `文件超过大小限制（${require('./config').upload.maxMb}MB）。` });
    }
    if (err && err.status && err.message) return res.status(err.status).json({ error: err.message });
    console.error('[服务器错误]', err);
    res.status(500).json({ error: '服务器内部错误：' + String(err && err.message ? err.message : err).slice(0, 200) });
  });

  return app;
}

module.exports = { createApp };
