'use strict';
// 通用工具函数
const crypto = require('crypto');

function id() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

// 本地时区的 YYYY-MM-DD
function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return todayStr(dt);
}

function daysBetween(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  return Math.round((new Date(ty, tm - 1, td) - new Date(fy, fm - 1, fd)) / 86400000);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function truncate(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 模型输出的 JSON 数值/布尔容错处理
function toBool(v, fallback = null) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '对', '正确', '是', 't', 'yes', '√'].includes(s)) return true;
    if (['false', '错', '错误', '否', 'f', 'no', '×', 'x'].includes(s)) return false;
  }
  return fallback;
}

module.exports = { id, nowIso, todayStr, addDays, daysBetween, sha256, truncate, clampInt, isPlainObject, toBool };
