'use strict';
// 扫描版 PDF 的 OCR 后台任务：渲染页面为图片 → tesseract.js 识别 → 入库
// 上传接口立即返回（状态 processing），前端轮询进度；应用重启后会自动续跑
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('../config');
const { getDb } = require('../db');
const { nowIso, truncate } = require('../util');
const { chunkPages } = require('./chunk');
const { extractMaterial, normalizeText } = require('./extract');
const { saveChunksAndFinalize, markFailed } = require('./materialStore');

const running = new Set();

function setNote(mid, note) {
  try {
    getDb().prepare('UPDATE materials SET note = ? WHERE id = ?').run(note, mid);
  } catch { /* 进度更新失败不影响识别 */ }
}

// ---------- 语言包准备：多源下载 + 本地缓存，避免单一 CDN 被墙导致不可用 ----------

const LANG_SOURCES = [
  'https://tessdata.projectnaptha.com/4.0.0',
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/{lang}/4.0.0',
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/{lang}/4.0.0_best_int',
];

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function langCacheFile(lang) {
  return path.join(config.ocr.cachePath, `${lang}.traineddata`);
}

// 确保语言包已在本地缓存（tesseract.js 会优先读 cachePath，命中后不再联网）
async function ensureLangData(lang) {
  const langs = lang.split('+').map((s) => s.trim()).filter(Boolean);
  const missing = langs.filter((l) => {
    const f = langCacheFile(l);
    return !fs.existsSync(f) || fs.statSync(f).size < 100 * 1024;
  });
  if (!missing.length) return { downloaded: 0 };

  fs.mkdirSync(config.ocr.cachePath, { recursive: true });
  let downloaded = 0;
  for (const l of missing) {
    const sources = [];
    if (config.ocr.langPath) sources.push(`${config.ocr.langPath.replace(/\/$/, '')}/${l}.traineddata.gz`);
    for (const base of LANG_SOURCES) sources.push(base.replace('{lang}', l) + `/${l}.traineddata.gz`);

    let lastErr = null;
    let ok = false;
    for (const url of sources) {
      try {
        const resp = await fetchWithTimeout(url, 180000);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 100 * 1024) throw new Error('语言包内容异常（过小）');
        const data = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
        const target = langCacheFile(l);
        const tmp = target + `.tmp-${process.pid}`;
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, target);
        ok = true;
        downloaded++;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!ok) {
      throw new Error(
        `OCR 语言包「${l}」下载失败（已尝试 ${sources.length} 个源）。请检查网络后重试；` +
        `或在 .env 中设置 OCR_LANG_PATH 指向包含 ${l}.traineddata.gz 的本地目录。最后一次错误：${truncate(String(lastErr && lastErr.message), 120)}`
      );
    }
  }
  return { downloaded };
}

// ---------- 页面渲染与识别 ----------

// 把 PDF 每页渲染成 PNG（pdf-to-img 内部使用预编译的 @napi-rs/canvas，无需额外编译）
// 注意：unpdf 的 pdf.js 会在全局挂载旧版 worker，渲染前需临时摘掉，避免版本冲突
async function renderPdfPages(filePath, scale) {
  const { pdf } = await import('pdf-to-img');
  const buf = fs.readFileSync(filePath);
  const savedWorker = globalThis.pdfjsWorker;
  delete globalThis.pdfjsWorker;
  try {
    const doc = await pdf(buf, { scale });
    try {
      const pages = [];
      for (let i = 1; i <= doc.length; i++) {
        pages.push(Buffer.from(await doc.getPage(i)));
      }
      return pages;
    } finally {
      await doc.destroy().catch(() => {});
    }
  } finally {
    if (savedWorker !== undefined) globalThis.pdfjsWorker = savedWorker;
  }
}

// OCR 输出的中文常被插入空格（"光 合 作 用"），既难读也让检索失效；压缩相邻中文字符间的空格
function collapseCjkSpaces(t) {
  const cjk = '[\\u4e00-\\u9fff\\u3400-\\u4dbf，。、；：？！「」『』（）《》〈〉…—·“”]';
  return String(t || '').replace(new RegExp(`(${cjk})\\s+(?=${cjk})`, 'g'), '$1');
}

// 识别指定页（复用一个 worker，逐页识别）
async function ocrPages(pngBuffers, pageIndices, mid) {
  const { createWorker } = require('tesseract.js');
  let workerError = null;
  const opts = {
    cachePath: config.ocr.cachePath,
    // worker 内部错误（如语言包下载失败）默认会变成未捕获异常炸掉进程，必须接管
    errorHandler: (e) => { workerError = e; },
  };
  if (config.ocr.langPath) opts.langPath = config.ocr.langPath;
  const worker = await createWorker(config.ocr.lang, 1, opts);
  try {
    const out = [];
    for (let i = 0; i < pageIndices.length; i++) {
      const pageIdx = pageIndices[i];
      if (mid) setNote(mid, `OCR 识别中：第 ${pageIdx + 1} 页（${i + 1}/${pageIndices.length}）…`);
      const { data } = await worker.recognize(pngBuffers[pageIdx]);
      out.push({ index: pageIdx, text: collapseCjkSpaces(normalizeText(data.text)) });
    }
    return out;
  } finally {
    await worker.terminate().catch(() => {});
  }
}

function ocrErrorMessage(e) {
  const msg = String((e && e.message) || e);
  if (/语言包/.test(msg)) return msg; // ensureLangData 已给出详细说明
  if (/Network error while fetching|getaddrinfo|ENOTFOUND|fetch failed|ETIMEDOUT|ECONNRESET|EAI_AGAIN|aborted/i.test(msg)) {
    return 'OCR 语言包下载失败（首次使用需要联网一次，之后会缓存到本机 data/ocr-cache 目录）。请检查网络后重新上传，或在 .env 中用 OCR_LANG_PATH 指向本地语言包目录。';
  }
  return 'OCR 识别失败：' + truncate(msg, 200);
}

// 后台处理一个处于 processing 状态的资料
async function processOcrMaterial(mid) {
  if (running.has(mid)) return;
  running.add(mid);
  const db = getDb();
  try {
    const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(mid);
    if (!m || m.status !== 'processing') return;

    const result = await extractMaterial(m.stored_path, m.ext);
    const needsOcr = result.needsOcr || [];
    if (!needsOcr.length) {
      // 文字其实可以直接提取（例如重试时），直接按普通流程入库
      const chunks = chunkPages(result.pages.filter((p) => p.text.length > 0));
      saveChunksAndFinalize(mid, result.pages.filter((p) => p.text.length > 0), chunks, { note: null });
      return;
    }

    const targets = needsOcr.slice(0, config.ocr.maxPages);
    const skipped = needsOcr.length - targets.length;
    setNote(mid, '正在准备 OCR 语言包（首次使用需联网下载，之后走本机缓存）…');
    await ensureLangData(config.ocr.lang);
    setNote(mid, '正在把 PDF 页面渲染为图片…');
    const rendered = await renderPdfPages(m.stored_path, config.ocr.scale);
    if (rendered.length < result.pages.length) {
      throw new Error(`页面渲染数量（${rendered.length}）与文档页数（${result.pages.length}）不一致`);
    }

    const ocrResults = await ocrPages(rendered, targets, mid);
    for (const r of ocrResults) {
      if (result.pages[r.index]) {
        result.pages[r.index].text = r.text;
        result.pages[r.index].ocr = true;
      }
    }

    const withText = result.pages.filter((p) => p.text && p.text.length > 0);
    if (!withText.length) {
      throw new Error('OCR 完成但没有识别出文字：请确认扫描件清晰（建议 200dpi 以上）后重新上传');
    }
    const chunks = chunkPages(withText);
    if (!chunks.length) {
      throw new Error('OCR 结果未能切分出有效内容');
    }
    const note = `已用 OCR 识别 ${targets.length} 页${skipped > 0 ? `；另有 ${skipped} 页超出单文件上限（OCR_MAX_PAGES=${config.ocr.maxPages}）未识别` : ''}`;
    // 超时/中断等场景下资料可能已被标记失败，不再覆盖状态
    const current = db.prepare('SELECT status FROM materials WHERE id = ?').get(mid);
    if (!current || current.status !== 'processing') return;
    saveChunksAndFinalize(mid, withText, chunks, { note });
  } catch (e) {
    markFailed(mid, ocrErrorMessage(e));
  } finally {
    running.delete(mid);
  }
}

// 应用重启后，把遗留的 processing 资料重新排队
function resumePendingOcr() {
  const rows = getDb().prepare("SELECT id FROM materials WHERE status = 'processing'").all();
  for (const r of rows) processOcrMaterial(r.id);
  return rows.length;
}

module.exports = { processOcrMaterial, resumePendingOcr, renderPdfPages, ocrPages };
