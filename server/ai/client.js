'use strict';
// AI 模型调用客户端：OpenAI 兼容 /chat/completions
// 特性：超时控制、自动重试、Token 用量与耗时记录、相同输入缓存
const crypto = require('crypto');
const config = require('../config');
const { getDb } = require('../db');

class AiConfigError extends Error {
  constructor(msg) { super(msg); this.name = 'AiConfigError'; this.code = 'AI_CONFIG'; }
}
class AiResponseError extends Error {
  constructor(msg) { super(msg); this.name = 'AiResponseError'; this.code = 'AI_RESPONSE'; }
}
class AiTimeoutError extends Error {
  constructor(msg) { super(msg); this.name = 'AiTimeoutError'; this.code = 'AI_TIMEOUT'; }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// 只记录调用类型/耗时/token，不记录提示词内容（隐私要求）
function logAi(kind, model, usage, durationMs, status, error) {
  try {
    getDb().prepare(
      'INSERT INTO ai_logs (id, kind, model, prompt_tokens, completion_tokens, duration_ms, status, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(
      crypto.randomUUID(), kind, model,
      usage ? (Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null) : null,
      usage ? (Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null) : null,
      Math.round(durationMs), status,
      error ? String(error).slice(0, 300) : null,
      new Date().toISOString()
    );
  } catch { /* 日志失败不影响主流程 */ }
}

function cacheGet(key) {
  const hours = config.ai.cacheHours;
  if (hours <= 0) return null;
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const row = getDb().prepare('SELECT response FROM ai_cache WHERE key = ? AND created_at > ?').get(key, since);
  if (!row) return null;
  try { return JSON.parse(row.response); } catch { return null; }
}

function cachePut(key, value) {
  const hours = config.ai.cacheHours;
  if (hours <= 0) return;
  try {
    getDb().prepare(
      'INSERT OR REPLACE INTO ai_cache (key, response, created_at) VALUES (?,?,?)'
    ).run(key, JSON.stringify(value), new Date().toISOString());
  } catch { /* 缓存失败不影响主流程 */ }
}

async function chatOnce(messages, { temperature, maxTokens }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  try {
    const res = await fetch(config.ai.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.ai.apiKey,
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const err = new Error('模型服务返回 HTTP ' + res.status + (bodyText ? '：' + bodyText.slice(0, 200) : ''));
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== 'string') {
      throw new Error('模型返回格式异常：缺少 choices[0].message.content');
    }
    return { text, usage: data.usage || null };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUsage(usage) {
  if (!usage) return { prompt_tokens: null, completion_tokens: null, total_tokens: null, unknown: true };
  const prompt = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null;
  const completion = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : (prompt != null || completion != null ? (prompt || 0) + (completion || 0) : null),
    unknown: prompt == null && completion == null,
  };
}

// 主入口：对话补全
async function chat(messages, opts = {}) {
  const {
    kind = 'other',
    temperature = 0.3,
    maxTokens = config.ai.maxTokens,
    useCache = true,
  } = opts;

  if (!config.ai.apiKey || !config.ai.baseUrl || !config.ai.model) {
    throw new AiConfigError('尚未配置 AI 模型服务：请在项目根目录 .env 中填写 AI_API_KEY、AI_BASE_URL、AI_MODEL，然后重启应用（可参考 .env.example）。');
  }

  const cacheKey = sha256(JSON.stringify({
    m: config.ai.model, b: config.ai.baseUrl, t: temperature, x: maxTokens, msgs: messages,
  }));
  if (useCache) {
    const hit = cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  const started = Date.now();
  const attempts = config.ai.maxRetries + 1;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const { text, usage } = await chatOnce(messages, { temperature, maxTokens });
      const durationMs = Date.now() - started;
      const normUsage = normalizeUsage(usage);
      logAi(kind, config.ai.model, normUsage, durationMs, 'ok', null);
      const result = { text, usage: normUsage, durationMs, cached: false };
      if (useCache) cachePut(cacheKey, result);
      return result;
    } catch (e) {
      lastErr = e;
      const isTimeout = e.name === 'AbortError';
      const status = e.status || 0;
      const retriable = isTimeout || status === 429 || status >= 500 || /fetch failed|ECONNRESET|EAI_AGAIN|ETIMEDOUT/i.test(String((e.cause && e.cause.code) || e.message));
      if (!retriable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }

  const durationMs = Date.now() - started;
  const isTimeout = lastErr && lastErr.name === 'AbortError';
  const msg = isTimeout
    ? `模型请求超时（${config.ai.timeoutMs} 毫秒）。可以稍后重试，或在 .env 中调大 AI_TIMEOUT_MS。`
    : '模型服务调用失败：' + (lastErr ? lastErr.message : '未知错误');
  logAi(kind, config.ai.model, null, durationMs, 'error', msg);
  const err = isTimeout ? new AiTimeoutError(msg) : new AiResponseError(msg);
  throw err;
}

// 从模型输出中尽力提取 JSON（兼容 ```json 代码块与前后缀文本）
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 继续尝试截取 */ }
  let start = -1;
  let openCh = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' || s[i] === '[') { start = i; openCh = s[i]; break; }
  }
  if (start < 0) return null;
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// 需要结构化 JSON 输出的对话；解析失败时自动补一轮纠正
async function jsonChat(messages, opts = {}) {
  const first = await chat(messages, opts);
  const parsed = extractJson(first.text);
  if (parsed !== null) return { ...first, data: parsed };

  const retryMsgs = [
    ...messages,
    { role: 'assistant', content: first.text },
    { role: 'user', content: '你上一条输出不是合法的 JSON。请重新输出：只输出 JSON 本体，不要使用 Markdown 代码块，不要附加任何解释文字。' },
  ];
  const second = await chat(retryMsgs, { ...opts, useCache: false });
  const parsed2 = extractJson(second.text);
  if (parsed2 === null) {
    throw new AiResponseError('模型未能输出有效的 JSON 内容（已自动重试一次），请稍后重试或更换模型。');
  }
  return { ...second, data: parsed2 };
}

module.exports = { chat, jsonChat, extractJson, AiConfigError, AiResponseError, AiTimeoutError };
