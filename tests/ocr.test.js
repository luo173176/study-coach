'use strict';
// OCR（扫描版 PDF 识别）测试
// - 渲染测试：离线、始终运行
// - 端到端 OCR：需要联网下载语言包（约几 MB，之后缓存），默认跳过；设 RUN_OCR_TEST=1 启用
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
process.env.OCR_LANG = 'eng'; // 端到端用英文小语言包，速度快
const { startApp, uploadFile, makeImagePdf, assert } = require('./helpers');

test('图片型 PDF（扫描版模拟）能被渲染为图片，且文字提取为空', async () => {
  // 1) unpdf 提取不到文字
  const { extractMaterial } = require('../server/services/extract');
  const tmp = path.join(require('./helpers').DATA_DIR, `img-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, await makeImagePdf(['HELLO WORLD 12345', 'SECOND LINE 678']));
  const result = await extractMaterial(tmp, '.pdf');
  assert.strictEqual(result.page_count, 1);
  assert.strictEqual(result.pages[0].text, '');
  assert.deepStrictEqual(result.needsOcr, [0], '应标记该页需要 OCR');

  // 2) 生产渲染路径（含 unpdf 全局 worker 冲突保护）能把它渲染成 PNG
  const { renderPdfPages } = require('../server/services/ocr');
  const pages = await renderPdfPages(tmp, 2);
  assert.strictEqual(pages.length, 1);
  assert.ok(Buffer.isBuffer(pages[0]) && pages[0].length > 1000, '渲染结果应为 PNG Buffer');
});

const canRunOcrE2E = process.env.RUN_OCR_TEST === '1';
test(
  '扫描版 PDF 端到端：后台 OCR → 状态就绪 → 文本入库可检索',
  { skip: canRunOcrE2E ? false : '需联网下载 OCR 语言包；设置环境变量 RUN_OCR_TEST=1 启用' },
  async (t) => {
    const app = await startApp();
    t.after(() => app.server.close());

    const pdfBuf = await makeImagePdf(['Hello World 12345', 'Study Coach OCR Test']);
    const res = await uploadFile(app.base, 'scanned.pdf', pdfBuf);
    const body = await res.json();
    assert.strictEqual(res.status, 201);
    assert.strictEqual(body.material.status, 'processing', '上传应立即返回 processing');
    assert.strictEqual(body.ocr, true);
    assert.strictEqual(body.ocr_pages, 1);

    // 轮询等待后台 OCR 完成（语言包下载 + WASM 识别，最长 4 分钟）
    let m = body.material;
    for (let i = 0; i < 120 && m.status === 'processing'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      m = (await (await fetch(app.base + '/api/materials/' + m.id)).json()).material;
    }
    assert.strictEqual(m.status, 'ready', 'OCR 应完成并就绪：' + (m.error || ''));
    assert.ok(m.note && m.note.includes('OCR'), '应有 OCR 说明: ' + m.note);

    // 文本已入库且带页码
    const chunks = app.db().prepare('SELECT * FROM chunks WHERE material_id = ?').all(m.id);
    assert.ok(chunks.length >= 1);
    const allText = chunks.map((c) => c.text).join('\n');
    assert.ok(/hello/i.test(allText) && /world/i.test(allText), 'OCR 文本应包含识别内容: ' + allText.slice(0, 200));
    assert.ok(chunks.some((c) => c.page === 1), '片段应保留页码');

    // 无需模型即可检索命中（insufficient=false 需要模型调用；这里只验证检索不为空）
    const { retrieveContext } = require('../server/services/rag');
    const hits = retrieveContext([m.id], 'hello world');
    assert.ok(hits.length >= 1, 'OCR 后的文本应可被检索命中');
  }
);
