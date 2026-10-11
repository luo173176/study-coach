'use strict';
const express = require('express');
const config = require('../config');
const { loginLimiter, createSession, safeEqual, isAuthed } = require('../middleware/auth');

const router = express.Router();

router.get('/state', (req, res) => {
  res.json({ passwordEnabled: !!config.appPassword, authed: isAuthed(req) });
});

router.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!config.appPassword) {
    return res.json({ ok: true, token: null, noPassword: true });
  }
  if (typeof password !== 'string' || !safeEqual(password, config.appPassword)) {
    return res.status(401).json({ error: '密码不正确。' });
  }
  res.json({ ok: true, token: createSession() });
});

module.exports = router;
