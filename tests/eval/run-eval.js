'use strict';
// AI 准确率评测（独立于程序测试）：需要真实 API Key 才能运行
// 用法：npm run eval
// 说明：评测结果取决于所配置的模型，指标只反映本次运行，不代表程序正确性。
process.env.AI_CACHE_HOURS = '0';
const fs = require('fs');
const path = require('path');

// 在加载配置前把数据目录指向临时目录，避免污染用户数据
const helpers = require('../helpers');
const { startApp, uploadFile, assert } = helpers;

async function main() {
  const config = require('../../server/config');
  if (!config.ai.apiKey) {
    console.log('❌ 尚未配置 AI_API_KEY。请在 .env 中配置后运行 npm run eval。');
    console.log('   （评测需要真实调用模型，与单元测试不同，无法用假服务替代。）');
    process.exit(0);
  }
  console.log(`评测模型：${config.ai.model} @ ${config.ai.baseUrl}\n`);

  const evalset = JSON.parse(fs.readFileSync(path.join(__dirname, 'evalset.json'), 'utf8'));
  const sampleText = fs.readFileSync(path.join(__dirname, 'sample-material.md'), 'utf8');

  const app = await startApp();
  const res = await uploadFile(app.base, '评测样例资料.md', Buffer.from(sampleText, 'utf8'));
  const body = await res.json();
  assert.strictEqual(body.material.status, 'ready');
  console.log(`样例资料已导入（${body.chunk_count} 个片段）\n`);

  const qaCases = evalset.filter((c) => c.type === 'qa');
  const results = [];

  for (const c of qaCases) {
    process.stdout.write(`运行 ${c.id}: ${c.question} … `);
    const r = await fetch(app.base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: c.question, material_ids: [body.material.id] }),
    }).then((x) => x.json());

    const insufficient = !!r.insufficient;
    let pass;
    if (c.insufficient_expected) {
      pass = insufficient;
    } else {
      const answerText = (r.answer || '').toLowerCase();
      const missing = (c.must_include || []).filter((k) => !answerText.includes(k.toLowerCase()));
      const cited = (r.sources || []).some((s) => s.cited);
      pass = !insufficient && missing.length === 0 && cited;
      if (missing.length) {
        console.log(`\n    缺少关键词: ${missing.join('、')}`);
      } else if (!cited) {
        console.log('\n    未标注任何有效引用');
      }
    }
    if (pass) console.log('通过');
    results.push({ id: c.id, question: c.question, pass, insufficient, answer: r.answer, sources: (r.sources || []).filter((s) => s.cited).length });
  }

  // 出题真实性评测：生成的每道题都应能定位到原文依据（服务端已强制，此处验证端到端）
  process.stdout.write('\n运行 quiz-01: 生成 3 道单选题并验证原文依据 … ');
  const gen = await fetch(app.base + '/api/questions/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ material_id: body.material.id, types: ['single'], count: 3, nocache: true }),
  }).then((x) => x.json());
  const grounded = gen.saved_count;
  const quizPass = grounded >= 2; // 至少 2/3 成功落库即认为可用
  console.log(quizPass ? `通过（${grounded}/3 入库且带来源）` : `未通过（仅 ${grounded}/3 入库）`);
  results.push({ id: 'quiz-01', question: '生成3道单选题', pass: quizPass, insufficient: false, answer: gen.skipped_reasons || [], sources: grounded });

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log('\n========== 评测结果 ==========');
  console.log(`通过 ${passed} / ${total}（${Math.round((passed / total) * 100)}%）`);
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.id} ${r.pass ? '' : '—— ' + (r.insufficient ? '被判定证据不足' : '答案不完整')}`);
  }
  console.log('\n注意：本评测衡量的是"所配置模型 + 提示词"的实际效果，换模型或换资料需要重新运行。');
  console.log('详细结果：');
  console.log(JSON.stringify(results, null, 2));

  app.server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('评测运行失败：', e);
  process.exit(1);
});
