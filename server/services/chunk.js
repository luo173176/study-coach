'use strict';
// 文本分块：按段落聚合，控制块大小并保留重叠，记录页码/章节
const config = require('../config');

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((s) => s.replace(/\n/g, ' ').trim())
    .filter(Boolean);
}

// pages: [{page, section, text}] -> [{text, page, section}]
function chunkPages(pages, opts = {}) {
  const size = opts.size || config.rag.chunkChars;
  const overlap = Math.min(opts.overlap ?? config.rag.chunkOverlap, Math.floor(size / 2));
  const chunks = [];

  let cur = '';
  let curPage = null;
  let curSection = null;

  const flush = () => {
    const t = cur.trim();
    if (t.length >= 10) chunks.push({ text: t, page: curPage, section: curSection });
    cur = '';
  };

  const hardSlice = (para, page, section) => {
    // 单段超长且无换行时硬切片，带重叠
    let rest = para;
    while (rest.length > size) {
      const piece = rest.slice(0, size);
      if (piece.trim().length >= 10) chunks.push({ text: piece.trim(), page, section });
      rest = rest.slice(size - overlap);
    }
    return rest;
  };

  for (const seg of pages) {
    const paras = splitParagraphs(seg.text);
    for (const para of paras) {
      // 页码或章节变化时不与上一段合并，保留来源边界
      if (cur.length > 0 && (seg.page !== curPage || (seg.section ?? null) !== curSection)) {
        flush();
      }
      const startNew = cur.length === 0;
      if (startNew) {
        curPage = seg.page;
        curSection = seg.section;
      }
      if (para.length > size * 1.5) {
        flush();
        const rest = hardSlice(para, seg.page, seg.section);
        if (rest) {
          curPage = seg.page;
          curSection = seg.section;
          cur = rest;
        }
        continue;
      }
      if (cur.length + para.length + 1 > size && cur.length > 0) {
        flush();
        // 重叠：从上一块尾部带入若干字符，保持上下文连续
        const prevText = chunks.length ? chunks[chunks.length - 1].text : '';
        const tail = prevText.slice(-overlap);
        curPage = seg.page;
        curSection = seg.section;
        cur = tail ? tail + '\n' : '';
      }
      cur += (cur && !cur.endsWith('\n') ? '\n' : '') + para;
    }
  }
  flush();

  // 过小的尾块并入前一块（仅限同页同章节，避免跨来源合并）
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last.text.length < 60 && last.page === prev.page && (last.section ?? null) === (prev.section ?? null)) {
      chunks.pop();
      prev.text += '\n' + last.text;
    }
  }

  return chunks.map((c, i) => ({ ...c, idx: i }));
}

module.exports = { chunkPages, splitParagraphs };
