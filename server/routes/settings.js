'use strict';
// 设置：AI 配置（网页自定义，立即生效）、连通性测试、用量统计、缓存与数据管理
// 注意：完整 API Key 绝不出现在任何接口响应或日志中
const express = require('express');
const config = require('../config');
const { getDb, resetAllTables } = require('../db');
const { chat } = require('../ai/client');
const { getIntervalTable } = require('../services/kp');
const { getEffectiveAiConfig, setAiOverride, clearAiOverrides, maskKey } = require('../services/runtimeConfig');
const { rateLimit } = require('../middleware/rateLimit');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const testLimiter = rateLimit(6);
const cfgLimiter = rateLimit(10);

function aiConfigView() {
  const ai = getEffectiveAiConfig();
  return {
    base_url: ai.baseUrl,
    model: ai.model,
    api_key_set: !!ai.apiKey,
    api_key_masked: maskKey(ai.apiKey),
    source: ai.source,
    timeout_ms: config.ai.timeoutMs,
    max_retries: config.ai.maxRetries,
    cache_hours: config.ai.cacheHours,
  };
}

router.get('/', (req, res) => {
  res.json({
    version: config.version,
    ai: aiConfigView(),
    upload_max_mb: config.upload.maxMb,
    rag_top_k: config.rag.topK,
    ocr: {
      enabled: config.ocr.enabled,
      lang: config.ocr.lang,
      max_pages: config.ocr.maxPages,
    },
    password_enabled: !!config.appPassword,
    data_dir: config.dataDir,
    intervals_days: getIntervalTable(),
  });
});

// 网页保存 AI 配置（立即生效，优先于 .env）。字段留空/缺省 = 不修改该项
router.post('/ai', cfgLimiter, (req, res) => {
  const b = req.body || {};
  const updates = {};

  if (b.api_key !== undefined && String(b.api_key).trim() !== '') {
    const k = String(b.api_key).trim();
    if (k.length < 8 || k.length > 256 || /\s/.test(k)) {
      return res.status(400).json({ error: 'API Key 格式不正确：长度需在 8-256 之间，且不能包含空格。' });
    }
    updates.ai_api_key = k;
  }
  if (b.base_url !== undefined) {
    const u = String(b.base_url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(u) || u.length > 200) {
      return res.status(400).json({ error: '接口地址必须以 http:// 或 https:// 开头（例如 https://open.bigmodel.cn/api/paas/v4）。' });
    }
    updates.ai_base_url = u;
  }
  if (b.model !== undefined) {
    const m = String(b.model).trim();
    if (!/^[\w.\/:-]{1,100}$/.test(m)) {
      return res.status(400).json({ error: '模型名称只能包含字母、数字和 - _ . / : 字符，长度不超过 100。' });
    }
    updates.ai_model = m;
  }

  for (const [k, v] of Object.entries(updates)) setAiOverride(k, v);
  res.json({ ok: true, ai: aiConfigView() });
});

// 清除网页设置，恢复为 .env / 默认值
router.post('/ai/reset', cfgLimiter, (req, res) => {
  clearAiOverrides();
  res.json({ ok: true, ai: aiConfigView() });
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
