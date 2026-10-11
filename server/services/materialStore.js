'use strict';
// 资料入库公共逻辑：保存分块并标记就绪 / 标记失败（供上传与 OCR 后台任务共用）
const { getDb } = require('../db');
const { id, nowIso, truncate } = require('../util');

function saveChunksAndFinalize(mid, pages, chunks, { note } = {}) {
  const db = getDb();
  const now = nowIso();
  const charCount = pages.reduce((s, p) => s + (p.text || '').length, 0);
  const insert = db.prepare(
    'INSERT INTO chunks (id, material_id, idx, page, section, text, created_at) VALUES (?,?,?,?,?,?,?)'
  );
  const pageCount = pages.some((p) => p.page) ? pages.length : null;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM chunks WHERE material_id = ?').run(mid);
    for (const c of chunks) insert.run(id(), mid, c.idx, c.page, c.section, c.text, now);
    db.prepare(
      'UPDATE materials SET status=?, error=NULL, note=?, page_count=?, char_count=?, pages_json=?, updated_at=? WHERE id=?'
    ).run('ready', note || null, pageCount, charCount, JSON.stringify(pages), now, mid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function markFailed(mid, error) {
  getDb().prepare('UPDATE materials SET status=?, error=?, note=NULL, updated_at=? WHERE id=?')
    .run('failed', truncate(String(error), 300), nowIso(), mid);
}

module.exports = { saveChunksAndFinalize, markFailed };
