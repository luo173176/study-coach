'use strict';
// 运行时可修改的 AI 配置：网页「设置」页保存的值存入 app_settings 表，
// 优先级高于 .env；完整 Key 永远不会返回给浏览器，也不会写入日志
const config = require('../config');
const { getDb } = require('../db');

const OVERRIDE_KEYS = ['ai_api_key', 'ai_base_url', 'ai_model'];

function getOverrides() {
  const rows = getDb().prepare(
    `SELECT key, value FROM app_settings WHERE key IN ('ai_api_key','ai_base_url','ai_model')`
  ).all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

// 当前生效配置（网页覆盖 > .env）及每项来源
function getEffectiveAiConfig() {
  const o = getOverrides();
  return {
    apiKey: o.ai_api_key !== undefined ? o.ai_api_key : config.ai.apiKey,
    baseUrl: o.ai_base_url !== undefined ? o.ai_base_url : config.ai.baseUrl,
    model: o.ai_model !== undefined ? o.ai_model : config.ai.model,
    source: {
      apiKey: o.ai_api_key !== undefined ? 'web' : 'env',
      baseUrl: o.ai_base_url !== undefined ? 'web' : 'env',
      model: o.ai_model !== undefined ? 'web' : 'env',
    },
  };
}

// value 为空字符串/null 时删除该项覆盖（回到 .env 值）
function setAiOverride(key, value) {
  if (!OVERRIDE_KEYS.includes(key)) throw new Error('未知的配置项：' + key);
  const db = getDb();
  if (value === '' || value === null || value === undefined) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?,?,?)')
      .run(key, String(value), new Date().toISOString());
  }
}

function clearAiOverrides() {
  getDb().prepare(`DELETE FROM app_settings WHERE key IN ('ai_api_key','ai_base_url','ai_model')`).run();
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '***';
  return k.slice(0, 3) + '***' + k.slice(-4);
}

module.exports = { getEffectiveAiConfig, setAiOverride, clearAiOverrides, maskKey };
