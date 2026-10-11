'use strict';
// RAG 上下文构建与引用一致性校验
const { getDb } = require('../db');
const { bm25Search } = require('./retrieve');
const { truncate } = require('../util');
const config = require('../config');

function getChunksForMaterials(materialIds) {
  const db = getDb();
  if (materialIds && materialIds.length) {
    const ph = materialIds.map(() => '?').join(',');
    return db.prepare(
      `SELECT c.*, m.filename FROM chunks c JOIN materials m ON m.id = c.material_id WHERE c.material_id IN (${ph}) ORDER BY c.material_id, c.idx`
    ).all(...materialIds);
  }
  return db.prepare(
    'SELECT c.*, m.filename FROM chunks c JOIN materials m ON m.id = c.material_id ORDER BY c.material_id, c.idx'
  ).all();
}

// 检索：返回带 score 的片段（score>0）
function retrieveContext(materialIds, query, topK) {
  const docs = getChunksForMaterials(materialIds);
  return bm25Search(docs, query, topK || config.rag.topK);
}

// 校验模型输出中的引用编号：只允许 [1..maxIdx]，返回有效引用集合与被剔除的编号
function parseCitations(text, maxIdx) {
  const cited = new Set();
  const stripped = [];
  const re = /\[(\d{1,3})\]/g;
  let m;
  let out = String(text || '');
  while ((m = re.exec(out))) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= maxIdx) cited.add(n);
    else stripped.push(n);
  }
  if (stripped.length) {
    // 剔除无效引用标记，避免误导用户
    out = out.replace(/\[(\d{1,3})\]/g, (s, d) => {
      const n = parseInt(d, 10);
      return n >= 1 && n <= maxIdx ? s : '';
    });
  }
  return { cited, stripped: [...new Set(stripped)], text: out };
}

// 将检索片段转成响应里的来源结构（引用来自服务端检索结果，非模型生成）
function toSources(chunks, citedSet) {
  return chunks.map((c, i) => ({
    idx: i + 1,
    chunk_id: c.id,
    filename: c.filename,
    page: c.page ?? null,
    section: c.section ?? null,
    snippet: truncate(c.text, 220),
    score: Math.round(c.score * 1000) / 1000,
    cited: citedSet ? citedSet.has(i + 1) : false,
  }));
}

// 从一批片段中均匀抽样（长资料整理/出题用）
function sampleChunks(chunks, maxN) {
  if (chunks.length <= maxN) return chunks;
  const step = chunks.length / maxN;
  const out = [];
  for (let i = 0; i < maxN; i++) out.push(chunks[Math.floor(i * step)]);
  return out;
}

module.exports = { getChunksForMaterials, retrieveContext, parseCitations, toSources, sampleChunks };
