'use strict';
// 提示词模板（中文）。所有引用编号 [n] 对应传入片段的编号，由服务端校验，模型不得伪造来源。
const { truncate } = require('../util');

function formatSrc(c) {
  const parts = [c.filename];
  if (c.page) parts.push(`第${c.page}页`);
  if (c.section) parts.push(`章节「${truncate(c.section, 40)}」`);
  return parts.join(' · ');
}

function buildContextBlocks(chunks) {
  return chunks
    .map((c, i) => `[${i + 1}] 来源：${formatSrc(c)}\n${c.text}`)
    .join('\n\n---\n\n');
}

// ---------- 问答 ----------
const QA_SYSTEM = `你是一名严谨的中文学习教练。你只能依据用户提供的"资料片段"回答问题，必须遵守：
1. 答案内容必须来自资料片段，在每句关键结论后标注引用编号，例如 [1] 或 [1][3]。引用编号只能是片段自带的编号，禁止编造。
2. 如果资料片段中没有足够信息回答，必须第一句就写："现有资料不足以回答这个问题"，然后用一句话说明缺少什么信息。不要编造。
3. 允许做少量的常识性解释，但必须以"(模型推断)"开头标明，且这种句子不得标注引用编号。
4. 用简体中文，分点简洁，不要大段照抄片段原文。`;

function qaMessages(question, chunks) {
  return [
    { role: 'system', content: QA_SYSTEM },
    { role: 'user', content: `资料片段：\n\n${buildContextBlocks(chunks)}\n\n问题：${question}\n\n请按系统规则回答。` },
  ];
}

// ---------- 知识点整理 ----------
const NOTE_SYSTEM = `你是中文学习资料整理助手。请只依据给出的资料片段整理知识点，输出一个 JSON 对象（不要输出任何其他文字），结构如下：
{
  "core_concepts": [{"name": "概念名", "explain": "一句话解释", "source": [1]}],
  "key_definitions": [{"term": "术语", "definition": "定义", "source": [1]}],
  "relations": [{"desc": "概念/知识点之间的关系描述", "source": [1,2]}],
  "examples": [{"desc": "典型例子", "source": [2]}],
  "pitfalls": [{"desc": "易错点", "source": [3]}],
  "open_questions": ["资料中没讲清楚、需要进一步确认的问题"],
  "knowledge_points": [{"name": "简短知识点名", "source": [1]}]
}
规则：
- source 中的编号必须真实存在于资料片段编号中，禁止编造；
- 资料中没有的内容不要编造，宁可留空数组；
- knowledge_points 给 5~15 个，每个名称不超过 12 个字；
- 全部内容使用简体中文。`;

function noteMessages(chunks, sampledNote) {
  const tail = sampledNote ? `\n\n（注：资料较长，以下为均匀抽样的片段，整理时请注明覆盖范围有限。）` : '';
  return [
    { role: 'system', content: NOTE_SYSTEM },
    { role: 'user', content: `资料片段：\n\n${buildContextBlocks(chunks)}${tail}\n\n请输出整理结果 JSON。` },
  ];
}

// ---------- 练习题生成 ----------
const QUIZ_SYSTEM = `你是中文出题助手。请只依据给出的资料片段出题，输出一个 JSON 对象（不要输出任何其他文字）：
{"questions": [
  {"type": "single", "question": "题干", "options": ["选项1", "选项2", "选项3", "选项4"], "answer": 0, "explanation": "解析：说明为什么，并指出依据片段", "knowledge_point": "知识点", "difficulty": "简单", "source": 1},
  {"type": "multi",   "question": "题干", "options": ["选项1", "选项2", "选项3", "选项4"], "answer": [0,2], "explanation": "...", "knowledge_point": "...", "difficulty": "中等", "source": 2},
  {"type": "judge",   "question": "题干（陈述句）", "options": [], "answer": true, "explanation": "...", "knowledge_point": "...", "difficulty": "简单", "source": 3},
  {"type": "short",   "question": "题干", "options": [], "answer": "参考答案要点", "explanation": "评分要点", "knowledge_point": "...", "difficulty": "困难", "source": 4}
]}
规则：
- type 取值只能是 single / multi / judge / short；
- single 的 answer 是正确选项的下标数字；multi 的 answer 是下标数组；judge 的 answer 是 true/false；short 的 answer 是参考答案字符串；
- source 必须是资料片段的编号数字，题目必须能在该片段中找到依据；资料里没有依据的题不要出；
- difficulty 只能取：简单 / 中等 / 困难；
- 题目之间不要重复，尽量覆盖不同片段；全部内容使用简体中文。`;

function quizMessages(types, count, chunks) {
  return [
    { role: 'system', content: QUIZ_SYSTEM },
    {
      role: 'user',
      content: `资料片段：\n\n${buildContextBlocks(chunks)}\n\n请出 ${count} 道题，题型限定为：${types.join('、')}。请输出 JSON。`,
    },
  ];
}

// ---------- 简答题 AI 评分 ----------
const GRADE_SYSTEM = `你是阅卷助手。根据题目、参考答案和资料片段，评估学生的简答题答案，输出 JSON（不要输出其他文字）：
{"score": 0到100的整数, "verdict": "correct|partial|wrong", "comment": "中文点评：指出答对的内容与遗漏/错误之处"}
规则：只依据参考答案和资料片段判断，不要过度宽容；verdict 三选一：correct（基本答对）/ partial（部分正确）/ wrong（未答对）。`;

function gradingMessages(question, referenceAnswer, userAnswer, chunks, sourceIdx) {
  const ctx = buildContextBlocks(chunks);
  const srcNote = sourceIdx ? `\n\n（题目依据片段：[${sourceIdx}]）` : '';
  return [
    { role: 'system', content: GRADE_SYSTEM },
    {
      role: 'user',
      content: `资料片段：\n\n${ctx}${srcNote}\n\n题目：${question}\n参考答案：${referenceAnswer}\n学生答案：${userAnswer || '（未作答）'}\n\n请输出评分 JSON。`,
    },
  ];
}

module.exports = { qaMessages, noteMessages, quizMessages, gradingMessages, buildContextBlocks, formatSrc };
