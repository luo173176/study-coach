'use strict';
// 访问控制：设置 APP_PASSWORD 后，所有 /api 接口需携带登录令牌
const crypto = require('crypto');
const config = require('../config');
const { getDb } = require('../db');
const { nowIso, sha256 } = require('../util');

function isAuthed(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  const row = getDb().prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token);
  return !!(row && row.expires_at > nowIso());
}

function authMiddleware(req, res, next) {
  if (!config.appPassword) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/auth/login' || req.path === '/api/auth/state') return next();
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: '需要访问密码，请先登录。' });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

const loginAttempts = new Map();
function loginLimiter(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const arr = (loginAttempts.get(key) || []).filter((t) => now - t < 60000);
  if (arr.length >= 10) {
    return res.status(429).json({ error: '登录尝试过于频繁，请一分钟后再试。' });
  }
  arr.push(now);
  loginAttempts.set(key, arr);
  next();
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  getDb().prepare('INSERT INTO sessions (token, expires_at) VALUES (?,?)').run(token, expires);
  return token;
}

module.exports = { authMiddleware, loginLimiter, createSession, safeEqual, isAuthed, sha256 };
