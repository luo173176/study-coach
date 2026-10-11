'use strict';
// 3) 文本分块与检索
const { test } = require('node:test');
const { assert } = require('./helpers');
const { chunkPages } = require('../server/services/chunk');
const { tokenize, bm25Search } = require('../server/services/retrieve');

test('tokenize：中文产生二元组，英文取完整单词', () => {
  const tokens = tokenize('光合作用 Photosynthesis');
  assert.ok(tokens.includes('光合') && tokens.includes('合作') && tokens.includes('作用'));
  assert.ok(tokens.includes('photosynthesis'));
  // 单字成段时保留单字，保证"力"这类单字查询可检索
  assert.ok(tokenize('力').includes('力'));
});

test('分块：超过目标大小时切分且带重叠，页码正确映射', () => {
  const longText = Array.from({ length: 30 }, (_, i) => `这是第${i}段关于光合作用的详细描述，包含足够多的字符来触发分块逻辑，确保每一段都有实际内容。`).join('\n\n');
  const chunks = chunkPages([{ page: 3, section: '第三章', text: longText }], { size: 300, overlap: 50 });
  assert.ok(chunks.length >= 2, '应切出多块');
  for (const c of chunks) {
    assert.strictEqual(c.page, 3);
    assert.strictEqual(c.section, '第三章');
    assert.ok(c.text.length <= 400, '单块不应明显超过目标大小');
  }
  // 重叠：后一块的开头应包含前一块结尾的内容
  const tail = chunks[0].text.slice(-30);
  assert.ok(chunks[1].text.includes(tail.slice(-20).trim().split('\n').pop()), '相邻块之间应有重叠');
});

test('分块：Markdown 章节被保留', () => {
  const chunks = chunkPages([
    { page: null, section: '第一章', text: '第一部分内容，讲述基本概念。' },
    { page: null, section: '第二章', text: '第二部分内容，讲述进阶应用。' },
  ]);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].section, '第一章');
  assert.strictEqual(chunks[1].section, '第二章');
});

test('检索：相关片段排在前面', () => {
  const docs = [
    { id: 'a', text: '光合作用是植物利用光能把二氧化碳和水转化为有机物的过程，场所是叶绿体。' },
    { id: 'b', text: '牛顿第二定律：物体的加速度与所受合外力成正比，与质量成反比。' },
  ];
  const hits = bm25Search(docs, '光合作用的场所是哪里', 2);
  assert.ok(hits.length >= 1);
  assert.strictEqual(hits[0].id, 'a');
  assert.ok(hits[0].score > 0);
});

test('检索：完全无关的问题得分为零（支撑"证据不足"判断）', () => {
  const docs = [
    { id: 'a', text: '光合作用是植物利用光能，把二氧化碳和水转化为有机物的过程，主要在叶绿体中进行。' },
  ];
  const hits = bm25Search(docs, '量子纠缠的实验步骤有哪些', 6);
  assert.strictEqual(hits.length, 0, '无关问题不应命中任何片段');
});

test('检索：英文查询也能命中', () => {
  const docs = [{ id: 'a', text: 'Photosynthesis converts light energy into chemical energy in chloroplasts.' }];
  const hits = bm25Search(docs, 'photosynthesis chloroplast', 5);
  assert.strictEqual(hits.length, 1);
});

test('检索：空查询返回空结果', () => {
  const hits = bm25Search([{ id: 'a', text: '任意内容' }], '   ', 5);
  assert.strictEqual(hits.length, 0);
});
