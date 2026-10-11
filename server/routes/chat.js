'use strict';
// 基于原文的 RAG 问答
const express = require('express');
const { getDb } = require('../db');
const { id, nowIso, truncate } = require('../util');
const { chat } = require('../ai/client');
const { qaMessages } = require('../ai/prompts');
const { retrieveContext, parseCitations, toSources } = require('../services/rag');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const aiLimiter = rateLimit(20);

router.post('/', aiLimiter, async (req, res, next) => {
  try {
    const { question, material_ids: materialIds } = req.body || {};
    const q = String(question || '').trim();
    if (q.length < 2) return res.status(400).json({ error: '请输入问题（至少 2 个字）。' });
    if (q.length > 2000) return res.status(400).json({ error: '问题过长（最多 2000 字）。' });

    let ids = null;
    if (Array.isArray(materialIds) && materialIds.length) {
      if (materialIds.length > 20) return res.status(400).json({ error: '一次最多选择 20 份资料。' });
      const db = getDb();
      const ph = materialIds.map(() => '?').join(',');
      const found = db.prepare(`SELECT id FROM materials WHERE id IN (${ph})`).all(...materialIds);
      ids = found.map((r) => r.id);
      if (ids.length !== materialIds.length) {
        return res.status(400).json({ error: '部分所选资料不存在或已被删除，请刷新后重试。' });
      }
    }

    // 检索：没有命中任何相关片段时，不调用模型，直接明确说明证据不足
    const hits = retrieveContext(ids, q);
    if (!hits.length) {
      const answer = '现有资料不足以回答这个问题';
      const reason = ids && ids.length
        ? '你选择的资料中没有检索到与问题相关的内容。'
        : '资料库中还没有内容，或没有检索到与问题相关的内容。请先导入学习资料。';
      const qaId = id();
      getDb().prepare('INSERT INTO qa_logs (id, question, answer, material_ids, insufficient, sources_json, created_at) VALUES (?,?,?,?,1,?,?)')
        .run(qaId, q, answer, JSON.stringify(ids || []), '[]', nowIso());
      return res.json({ id: qaId, question: q, answer, insufficient: true, reason, sources: [], stripped: [], usage: null, duration_ms: 0, cached: false });
    }

    const started = Date.now();
    const r = await chat(qaMessages(q, hits), { kind: 'qa' });

    // 引用一致性：只保留指向真实检索片段的引用编号
    const { cited, stripped, text: answerText } = parseCitations(r.text, hits.length);
    const insufficient = /现有资料不足以回答/.test(answerText);
    const sources = toSources(hits, cited);

    const qaId = id();
    getDb().prepare('INSERT INTO qa_logs (id, question, answer, material_ids, insufficient, sources_json, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(qaId, q, answerText, JSON.stringify(ids || []), insufficient ? 1 : 0, JSON.stringify(sources), nowIso());

    res.json({
      id: qaId,
      question: q,
      answer: answerText,
      insufficient,
      reason: insufficient ? '模型判断所提供的资料片段中没有足够的信息来回答。' : null,
      sources,
      stripped,
      usage: r.usage,
      duration_ms: r.durationMs || Date.now() - started,
      cached: !!r.cached,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const rows = getDb().prepare('SELECT * FROM qa_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      question: truncate(r.question, 300),
      answer: truncate(r.answer, 2000),
      insufficient: !!r.insufficient,
      sources: JSON.parse(r.sources_json || '[]'),
      created_at: r.created_at,
    })),
  });
});

module.exports = router;
