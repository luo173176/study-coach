'use strict';
// 学习资料：上传、列表、详情、删除（级联删除衍生数据）
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { getDb } = require('../db');
const { id, nowIso, truncate } = require('../util');
const { chunkPages } = require('../services/chunk');
const { extractMaterial } = require('../services/extract');
const { saveChunksAndFinalize, markFailed } = require('../services/materialStore');
const { processOcrMaterial } = require('../services/ocr');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxMb * 1024 * 1024, files: 1 },
});

// multer 默认按 latin1 解析文件名，中文需转回 UTF-8；文件名仅用于展示（磁盘路径用 UUID），
// 清理路径分隔符、控制字符与 ".."，不做字符集白名单，避免误伤正常文件名
function sanitizeFilename(raw) {
  let name = raw || '';
  // 浏览器以 UTF-8 发送文件名，multer 按 latin1 解码后会出现 \x80-\xff 区间的字符
  if (/[\x80-\xff]/.test(name)) {
    try { name = Buffer.from(name, 'latin1').toString('utf8'); } catch { /* 转换失败保留原名 */ }
  }
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\.{2,}/g, '_').trim();
  return name.slice(0, 120) || '未命名文件';
}

function getExt(filename) {
  return path.extname(filename).toLowerCase();
}

function materialRow(m, { withPages = false } = {}) {
  const base = {
    id: m.id,
    filename: m.filename,
    ext: m.ext,
    size: m.size,
    status: m.status,
    error: m.error,
    note: m.note,
    page_count: m.page_count,
    char_count: m.char_count,
    uploaded_at: m.uploaded_at,
  };
  if (withPages) {
    base.pages = JSON.parse(m.pages_json || '[]');
  }
  return base;
}

router.get('/', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM materials ORDER BY uploaded_at DESC').all();
  res.json({ materials: rows.map((m) => materialRow(m)) });
});

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: '请选择要上传的文件。' });
    }
    const filename = sanitizeFilename(req.file.originalname);
    const ext = getExt(filename);
    if (!config.upload.allowedExt.includes(ext)) {
      return res.status(400).json({ error: `不支持的文件类型「${ext || '无扩展名'}」。目前仅支持：PDF、TXT、Markdown。` });
    }

    const mid = id();
    const storedPath = path.join(config.uploadsDir, `${mid}${ext}`);
    fs.writeFileSync(storedPath, req.file.buffer);

    const now = nowIso();
    const db = getDb();
    db.prepare(
      'INSERT INTO materials (id, filename, ext, size, status, stored_path, uploaded_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(mid, filename, ext, req.file.buffer.length, 'processing', storedPath, now, now);

    try {
      const result = await extractMaterial(storedPath, ext);
      const needsOcr = result.needsOcr || [];

      // 扫描版/混合型 PDF：没有文字层的页面交给后台 OCR，上传立即返回
      if (needsOcr.length > 0) {
        if (!config.ocr.enabled) {
          const msg = '该 PDF 含有没有文字层的页面（扫描版/图片型），而 OCR 未启用（在 .env 设置 OCR_ENABLED=1 可开启）。';
          db.prepare('UPDATE materials SET status=?, error=?, updated_at=? WHERE id=?')
            .run('failed', msg, nowIso(), mid);
          const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(mid);
          return res.status(201).json({ material: materialRow(m) });
        }
        db.prepare('UPDATE materials SET status=?, note=?, updated_at=? WHERE id=?')
          .run('processing', '已上传，正在排队进行 OCR 识别…', nowIso(), mid);
        processOcrMaterial(mid); // 后台执行
        const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(mid);
        return res.status(201).json({ material: materialRow(m), ocr: true, ocr_pages: needsOcr.length });
      }

      const chunks = chunkPages(result.pages);
      if (!chunks.length) throw new Error('未能从文件中切分出有效文本内容。');
      saveChunksAndFinalize(mid, result.pages, chunks, { note: null });
      const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(mid);
      return res.status(201).json({ material: materialRow(m), chunk_count: chunks.length, truncated: !!result.truncated });
    } catch (extractErr) {
      markFailed(mid, extractErr.message);
      const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(mid);
      return res.status(201).json({ material: materialRow(m) });
    }
  } catch (e) {
    next(e);
  }
});

router.get('/:id', (req, res) => {
  const m = getDb().prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '资料不存在或已被删除。' });
  res.json({ material: materialRow(m, { withPages: true }) });
});

// 级联删除：片段、笔记、题目、答题记录、知识点、复习记录、相关问答记录与磁盘文件
router.delete('/:id', (req, res) => {
  const db = getDb();
  const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '资料不存在或已被删除。' });

  db.exec('BEGIN');
  try {
    const kps = db.prepare('SELECT id FROM knowledge_points WHERE material_id = ?').all(m.id);
    db.prepare('DELETE FROM review_logs WHERE knowledge_point_id IN (SELECT id FROM knowledge_points WHERE material_id = ?)').run(m.id);
    db.prepare('DELETE FROM attempts WHERE question_id IN (SELECT id FROM questions WHERE material_id = ?)').run(m.id);
    db.prepare('DELETE FROM questions WHERE material_id = ?').run(m.id);
    db.prepare('DELETE FROM knowledge_points WHERE material_id = ?').run(m.id);
    db.prepare('DELETE FROM chunks WHERE material_id = ?').run(m.id);
    db.prepare('DELETE FROM notes WHERE material_id = ?').run(m.id);
    const qaRows = db.prepare('SELECT id, material_ids FROM qa_logs').all();
    for (const qa of qaRows) {
      try {
        const ids = JSON.parse(qa.material_ids || '[]');
        if (Array.isArray(ids) && ids.includes(m.id)) {
          db.prepare('DELETE FROM qa_logs WHERE id = ?').run(qa.id);
        }
      } catch { /* 忽略解析失败的历史记录 */ }
    }
    db.prepare('DELETE FROM materials WHERE id = ?').run(m.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  try { fs.rmSync(m.stored_path, { force: true }); } catch { /* 文件已不存在则忽略 */ }
  res.json({ ok: true });
});

module.exports = router;
