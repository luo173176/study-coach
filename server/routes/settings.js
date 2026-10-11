'use strict';
// 设置：模型连通性测试、用量统计（token 未提供时明确标记未知）、缓存与数据管理
const express = require('express');
const config = require('../config');
const { getDb, resetAllTables } = require('../db');
const { chat } = require('../ai/client');
const { getIntervalTable } = require('../services/kp');
const { rateLimit } = require('../middleware/rateLimit');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const testLimiter = rateLimit(6);

router.get('/', (req, res) => {
  res.json({
    version: config.version,
    ai: {
      base_url: config.ai.baseUrl,
      model: config.ai.model,
      api_key_set: !!config.ai.apiKey,
      timeout_ms: config.ai.timeoutMs,
      max_retries: config.ai.maxRetries,
      cache_hours: config.ai.cacheHours,
    },
    upload_max_mb: config.upload.maxMb,
    rag_top_k: config.rag.topK,
    password_enabled: !!config.appPassword,
    data_dir: config.dataDir,
    intervals_days: getIntervalTable(),
  });
});

// 连通性测试：真实调用一次模型（不缓存）
router.post('/test', testLimiter, async (req, res, next) => {
  try {
    const r = await chat(
      [{ role: 'user', content: '连通性测试。请只回复两个字：正常' }],
      { kind: 'test', maxTokens: 32, useCache: false, temperature: 0 }
    );
    res.json({
      ok: true,
      model: config.ai.model,
      reply: r.text.trim().slice(0, 50),
      duration_ms: r.durationMs,
      usage: r.usage,
      cached: r.cached,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/usage', (req, res) => {
  const db = getDb();
  const total = db.prepare(
    `SELECT COUNT(*) AS calls,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
            SUM(prompt_tokens) AS prompt_tokens,
            SUM(completion_tokens) AS completion_tokens,
            SUM(CASE WHEN prompt_tokens IS NULL AND completion_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_usage,
            AVG(duration_ms) AS avg_duration_ms
     FROM ai_logs`
  ).get();
  const byKind = db.prepare(
    `SELECT kind, COUNT(*) AS calls, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
            SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens, AVG(duration_ms) AS avg_duration_ms
     FROM ai_logs GROUP BY kind ORDER BY calls DESC`
  ).all();
  const recent = db.prepare(
    'SELECT kind, model, prompt_tokens, completion_tokens, duration_ms, status, error, created_at FROM ai_logs ORDER BY created_at DESC LIMIT 20'
  ).all();
  res.json({
    total: {
      calls: total.calls || 0,
      errors: total.errors || 0,
      prompt_tokens: total.prompt_tokens ?? null,
      completion_tokens: total.completion_tokens ?? null,
      unknown_usage: total.unknown_usage || 0,
      avg_duration_ms: total.avg_duration_ms != null ? Math.round(total.avg_duration_ms) : null,
      note: '供应商未返回用量信息时标记为未知，不伪造数据。',
    },
    by_kind: byKind,
    recent,
  });
});

router.post('/clear-cache', (req, res) => {
  getDb().exec('DELETE FROM ai_cache;');
  res.json({ ok: true });
});

// 危险操作：清空全部数据（需要 confirm=DELETE）
router.post('/clear-data', (req, res) => {
  if (!req.body || req.body.confirm !== 'DELETE') {
    return res.status(400).json({ error: '请输入确认信息 confirm=DELETE 才能清空数据。' });
  }
  resetAllTables();
  let removedFiles = 0;
  try {
    for (const f of fs.readdirSync(config.uploadsDir)) {
      fs.rmSync(path.join(config.uploadsDir, f), { force: true });
      removedFiles++;
    }
  } catch { /* 目录异常时忽略 */ }
  res.json({ ok: true, removed_files: removedFiles });
});

module.exports = router;
