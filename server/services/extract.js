'use strict';
// 文本提取：PDF / TXT / Markdown，保留页码或章节信息
const fs = require('fs');
const config = require('../config');

function normalizeText(t) {
  return String(t || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// UTF-8 解码失败（出现替换符）时尝试 GBK，兼容国内常见编码
function decodeText(buf) {
  const utf8 = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    if (!gbk.includes('\uFFFD')) return gbk;
  } catch { /* 当前 Node 构建不支持 GBK 时忽略 */ }
  return utf8;
}

async function extractPdf(filePath) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const buf = fs.readFileSync(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const arr = Array.isArray(text) ? text : [String(text || '')];
  return arr.map((t, i) => ({ page: i + 1, section: null, text: normalizeText(t) }));
}

// Markdown：按标题拆分章节
function extractMarkdown(text) {
  const sections = text.split(/(?=^#{1,6}\s)/m).filter((s) => s.trim());
  if (sections.length === 0) sections.push(text);
  return sections.map((s, i) => {
    const m = s.match(/^#{1,6}\s+(.+)/);
    const title = m ? m[1].trim().slice(0, 60) : null;
    return { page: null, section: title || (i > 0 ? null : null), text: normalizeText(s) };
  });
}

function extractPlainText(text) {
  return [{ page: null, section: null, text: normalizeText(text) }];
}

// 返回 { pages, page_count, char_count, truncated } 或 throw Error(中文原因)
async function extractMaterial(filePath, ext) {
  let pages;
  if (ext === '.pdf') {
    pages = await extractPdf(filePath);
  } else {
    const raw = decodeText(fs.readFileSync(filePath));
    pages = ext === '.md' || ext === '.markdown' ? extractMarkdown(raw) : extractPlainText(raw);
  }
  pages = pages.filter((p) => p && typeof p.text === 'string');

  if (ext === '.pdf' && pages.length > 0 && pages.every((p) => p.text.length === 0)) {
    throw new Error('该 PDF 中没有提取到任何文本，很可能是扫描版/图片型 PDF。当前版本不支持 OCR，请换用文字版资料。');
  }

  // 超长资料截断保护
  let truncated = false;
  let total = 0;
  for (const p of pages) {
    if (total + p.text.length > config.rag.maxCharsPerMaterial) {
      p.text = p.text.slice(0, Math.max(0, config.rag.maxCharsPerMaterial - total));
      truncated = true;
    }
    total += p.text.length;
    if (truncated) break;
  }
  if (truncated) pages = pages.filter((p) => p.text.length > 0);
  if (total === 0) {
    throw new Error('文件内容为空，无法导入。');
  }
  return { pages, page_count: ext === '.pdf' ? pages.length : null, char_count: total, truncated };
}

module.exports = { extractMaterial, decodeText, normalizeText };
