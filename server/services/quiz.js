'use strict';
// 练习题校验与归一化：模型输出必须通过结构校验才能进入题库
const { toBool, truncate } = require('../util');
const { retrieveContext } = require('./rag');

const TYPES = ['single', 'multi', 'judge', 'short'];
const DIFFICULTIES = ['简单', '中等', '困难'];

function cleanText(v, maxLen) {
  const s = String(v ?? '').trim();
  return s ? truncate(s, maxLen) : null;
}

// raw: 模型给的对象；chunks: 提供给模型的片段（编号 1..n）；materialChunks: 用于兜底定位来源
// 返回 { ok: true, question } 或 { ok: false, reason }
function normalizeQuestion(raw, chunks, materialId, materialChunks) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '题目结构不是对象' };
  const type = String(raw.type || '').trim().toLowerCase();
  if (!TYPES.includes(type)) return { ok: false, reason: `未知题型 ${type}` };

  const question = cleanText(raw.question, 1000);
  if (!question || question.length < 5) return { ok: false, reason: '题干为空或过短' };

  let options = null;
  let answer;

  if (type === 'single' || type === 'multi') {
    if (!Array.isArray(raw.options)) return { ok: false, reason: '缺少选项数组' };
    options = raw.options.map((o) => String(o ?? '').trim()).filter(Boolean).map((o) => truncate(o, 200));
    if (options.length < 2 || options.length > 6) return { ok: false, reason: '选项数量不合法' };

    const toIndex = (v) => {
      if (typeof v === 'number' && Number.isInteger(v)) return v;
      if (typeof v === 'string') {
        const s = v.trim();
        if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
        if (/^[A-Fa-f]$/.test(s)) return s.toUpperCase().charCodeAt(0) - 65;
        const i = options.findIndex((o) => o === s);
        if (i >= 0) return i;
      }
      return -1;
    };

    if (type === 'single') {
      const idx = toIndex(raw.answer);
      if (idx < 0 || idx >= options.length) return { ok: false, reason: '正确答案下标超出选项范围' };
      answer = idx;
    } else {
      let arr = Array.isArray(raw.answer) ? raw.answer : (typeof raw.answer === 'string' && /^[A-Fa-f]{2,}$/.test(raw.answer.trim())
        ? raw.answer.trim().split('') : [raw.answer]);
      const idxs = [...new Set(arr.map(toIndex))].filter((i) => i >= 0 && i < options.length).sort((a, b) => a - b);
      if (idxs.length < 2) return { ok: false, reason: '多选题正确答案少于 2 个' };
      answer = idxs;
    }
  } else if (type === 'judge') {
    const b = toBool(raw.answer, null);
    if (b === null) return { ok: false, reason: '判断题答案不是对/错' };
    answer = b;
  } else {
    answer = cleanText(raw.answer, 800);
    if (!answer) return { ok: false, reason: '简答题缺少参考答案' };
  }

  const explanation = cleanText(raw.explanation, 1200);
  if (!explanation) return { ok: false, reason: '缺少解析' };

  const difficulty = DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : '中等';
  const kpName = cleanText(raw.knowledge_point, 30);

  // 来源片段：优先取模型给的编号（必须在提供的片段范围内），否则用题目+答案在本资料内检索兜底
  let sourceChunk = null;
  const srcIdx = parseInt(raw.source, 10);
  if (Number.isInteger(srcIdx) && srcIdx >= 1 && srcIdx <= chunks.length) {
    sourceChunk = chunks[srcIdx - 1];
  }
  if (!sourceChunk && materialChunks && materialChunks.length) {
    const hits = bm25Top(materialChunks, `${question} ${type === 'short' ? answer : ''}`);
    if (hits.length) sourceChunk = hits[0];
  }
  if (!sourceChunk) return { ok: false, reason: '未能定位到原文依据（资料中没有可支撑的内容）' };

  return {
    ok: true,
    question: {
      type,
      question,
      options,
      answer,
      explanation,
      difficulty,
      kpName,
      source_chunk_id: sourceChunk.id,
      source_page: sourceChunk.page ?? null,
    },
  };
}

function bm25Top(docs, query) {
  const { bm25Search } = require('./retrieve');
  return bm25Search(docs, query, 1);
}

module.exports = { normalizeQuestion, TYPES, DIFFICULTIES };
