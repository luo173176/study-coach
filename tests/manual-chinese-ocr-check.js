// 中文 OCR 全链路手动验证脚本（不提交为常规测试：语言包下载慢）
// 用法：node tests/manual-chinese-ocr-check.js
'use strict';
process.env.DATA_DIR = require('os').tmpdir() + '/study-coach-ocr-zh-' + Date.now();
process.env.OCR_LANG = 'chi_sim+eng';
const { startApp, uploadFile, makeImagePdf, assert } = require('./helpers');

(async () => {
  const app = await startApp();
  const t0 = Date.now();
  const pdfBuf = await makeImagePdf([
    '光合作用是绿色植物利用光能，把二氧化碳和水转化为有机物的过程。',
    '呼吸作用主要在线粒体中进行，释放能量。',
  ]);
  const res = await uploadFile(app.base, '中文扫描件.pdf', pdfBuf);
  const body = await res.json();
  console.log('上传返回状态:', body.material.status, '| OCR 页数:', body.ocr_pages);

  let m = body.material;
  while (m.status === 'processing' && Date.now() - t0 < 480000) {
    await new Promise((r) => setTimeout(r, 3000));
    m = (await (await fetch(app.base + '/api/materials/' + m.id)).json()).material;
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] 状态=${m.status} ${m.note || m.error || ''}`);
  }
  console.log('最终状态:', m.status, '| note:', m.note, '| error:', m.error);
  assert.strictEqual(m.status, 'ready', '中文 OCR 应完成');

  const chunks = app.db().prepare('SELECT * FROM chunks WHERE material_id = ?').all(m.id);
  const allText = chunks.map((c) => c.text).join('\n');
  console.log('识别文本预览:', allText.slice(0, 150).replace(/\n/g, ' '));
  const hasZh = allText.includes('光合作用') || allText.includes('呼吸作用');
  console.log('中文关键内容命中:', hasZh ? '✅' : '⚠️ 未见完整关键词（OCR 噪声，检查上方预览）');

  const { retrieveContext } = require('../server/services/rag');
  const hits = retrieveContext([m.id], '光合作用');
  console.log('检索「光合作用」命中片段数:', hits.length);
  app.server.close();
  process.exit(hasZh && hits.length ? 0 : 1);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
