'use strict';
// BM25 关键词检索（纯 JS，无外部依赖）
// 中文取连续汉字的二元组（bigram），英文/数字取完整词，避免单字噪声
function tokenize(text) {
  const tokens = [];
  const runs = String(text || '').match(/[\u4e00-\u9fff]+|[a-zA-Z0-9]+/g) || [];
  for (const run of runs) {
    if (/^[a-zA-Z0-9]+$/.test(run)) {
      tokens.push(run.toLowerCase());
    } else if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
  }
  if (tokens.length === 0) {
    // 兜底：没有可用词元时退回小写英文词
    tokens.push(...(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []));
  }
  return tokens;
}

const K1 = 1.5;
const B = 0.75;

// docs: [{...chunk, tokens?}]，返回带 score 的倒序数组
function bm25Search(docs, query, topK) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || docs.length === 0) return [];

  const prepared = docs.map((d) => {
    const tokens = d.tokens || tokenize(d.text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { doc: d, tf, len: tokens.length || 1 };
  });

  const avgdl = prepared.reduce((s, p) => s + p.len, 0) / prepared.length;
  const df = new Map();
  for (const p of prepared) {
    for (const term of p.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const N = prepared.length;

  const scored = [];
  for (const p of prepared) {
    let score = 0;
    for (const qt of queryTokens) {
      const f = p.tf.get(qt);
      if (!f) continue;
      const n = df.get(qt) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * p.len / avgdl));
    }
    if (score > 0) scored.push({ ...p.doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return topK ? scored.slice(0, topK) : scored;
}

module.exports = { tokenize, bm25Search };
