'use strict';
// 知识点整理笔记：生成（可重新生成）、查看、删除；同时登记知识点
const express = require('express');
const { getDb } = require('../db');
const { id, nowIso, truncate } = require('../util');
const { jsonChat, AiConfigError } = require('../ai/client');
const { noteMessages } = require('../ai/prompts');
const { getChunksForMaterials, sampleChunks } = require('../services/rag');
const { upsertKnowledgePoint } = require('../services/kp');
const { rateLimit } = require('../middleware/rateLimit');
const config = require('../config');

const router = express.Router();
const aiLimiter = rateLimit(20);

// 容错整理模型输出的数组字段
function cleanArray(v, maxItems, pick) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, maxItems).map(pick).filter(Boolean);
}

function cleanSource(v, maxIdx) {
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= maxIdx);
}

router.post('/generate', aiLimiter, async (req, res, next) => {
  try {
    const { material_id: materialId, nocache } = req.body || {};
    const db = getDb();
    const m = materialId ? db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId) : null;
    if (!m) return res.status(404).json({ error: '资料不存在或已被删除。' });
    if (m.status !== 'ready') return res.status(400).json({ error: `该资料当前状态为「${m.status === 'failed' ? '处理失败' : m.status}」，无法整理。` });

    const allChunks = getChunksForMaterials([m.id]);
    if (!allChunks.length) return res.status(400).json({ error: '该资料没有可用的文本内容。' });

    const ctx = sampleChunks(allChunks, config.rag.maxContextChunks);
    const sampled = ctx.length < allChunks.length;
    const r = await jsonChat(noteMessages(ctx, sampled), { kind: 'note', useCache: !nocache, maxTokens: 3000 });
    const d = r.data || {};

    const maxIdx = ctx.length;
    const content = {
      material_filename: m.filename,
      coverage: sampled ? `节选（资料较长，基于均匀抽样的 ${ctx.length}/${allChunks.length} 个片段）` : '全文',
      core_concepts: cleanArray(d.core_concepts, 20, (x) => {
        if (!x || typeof x !== 'object') return null;
        const name = String(x.name || '').trim();
        const explain = String(x.explain || '').trim();
        if (!name) return null;
        return { name: truncate(name, 60), explain: truncate(explain, 300), source: cleanSource(x.source, maxIdx) };
      }),
      key_definitions: cleanArray(d.key_definitions, 20, (x) => {
        if (!x || typeof x !== 'object') return null;
        const term = String(x.term || '').trim();
        const definition = String(x.definition || '').trim();
        if (!term || !definition) return null;
        return { term: truncate(term, 60), definition: truncate(definition, 400), source: cleanSource(x.source, maxIdx) };
      }),
      relations: cleanArray(d.relations, 15, (x) => {
        if (!x || typeof x !== 'object') return null;
        const desc = String(x.desc || '').trim();
        if (!desc) return null;
        return { desc: truncate(desc, 400), source: cleanSource(x.source, maxIdx) };
      }),
      examples: cleanArray(d.examples, 15, (x) => {
        if (!x || typeof x !== 'object') return null;
        const desc = String(x.desc || '').trim();
        if (!desc) return null;
        return { desc: truncate(desc, 400), source: cleanSource(x.source, maxIdx) };
      }),
      pitfalls: cleanArray(d.pitfalls, 15, (x) => {
        if (!x || typeof x !== 'object') return null;
        const desc = String(x.desc || '').trim();
        if (!desc) return null;
        return { desc: truncate(desc, 400), source: cleanSource(x.source, maxIdx) };
      }),
      open_questions: cleanArray(d.open_questions, 15, (x) => truncate(String(x || '').trim(), 300)).filter(Boolean),
      sources: ctx.map((c, i) => ({
        idx: i + 1,
        filename: m.filename,
        page: c.page ?? null,
        section: c.section ?? null,
        snippet: truncate(c.text, 200),
      })),
    };

    const noteId = id();
    const tokens = r.usage && r.usage.total_tokens;
    db.prepare('INSERT INTO notes (id, material_id, content, model, tokens, duration_ms, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(noteId, m.id, JSON.stringify(content), r.model || null, Number.isFinite(tokens) ? tokens : null, r.durationMs || null, nowIso());

    // 登记知识点（去重），关联其首个引用片段
    const kpNames = cleanArray(d.knowledge_points, 20, (x) => {
      if (!x || typeof x !== 'object') return null;
      const name = String(x.name || '').trim();
      return name ? truncate(name, 30) : null;
    }).filter(Boolean);
    for (const name of [...new Set(kpNames)]) {
      const entry = content.core_concepts.find((c) => c.name === name);
      const src = entry && entry.source && entry.source.length ? ctx[entry.source[0] - 1] : null;
      upsertKnowledgePoint(name, m.id, src ? src.id : null);
    }

    res.status(201).json({ id: noteId, kp_created: kpNames.length, usage: r.usage, duration_ms: r.durationMs, cached: !!r.cached });
  } catch (e) {
    if (e instanceof AiConfigError) return next(e);
    next(e);
  }
});

router.get('/', (req, res) => {
  const db = getDb();
  const materialId = req.query.material_id;
  const rows = materialId
    ? db.prepare('SELECT n.id, n.material_id, n.model, n.tokens, n.duration_ms, n.created_at, m.filename FROM notes n JOIN materials m ON m.id = n.material_id WHERE n.material_id = ? ORDER BY n.created_at DESC').all(materialId)
    : db.prepare('SELECT n.id, n.material_id, n.model, n.tokens, n.duration_ms, n.created_at, m.filename FROM notes n JOIN materials m ON m.id = n.material_id ORDER BY n.created_at DESC').all();
  res.json({ items: rows });
});

router.get('/:id', (req, res) => {
  const row = getDb().prepare(
    'SELECT n.*, m.filename FROM notes n JOIN materials m ON m.id = n.material_id WHERE n.id = ?'
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: '笔记不存在或已被删除。' });
  let content;
  try { content = JSON.parse(row.content); } catch { content = null; }
  res.json({ id: row.id, material_id: row.material_id, filename: row.filename, model: row.model, tokens: row.tokens, duration_ms: row.duration_ms, created_at: row.created_at, content });
});

router.delete('/:id', (req, res) => {
  const r = getDb().prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: '笔记不存在或已被删除。' });
  res.json({ ok: true });
});

module.exports = router;
