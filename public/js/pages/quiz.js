// 练习题库：AI 生成、题库管理、在线练习（作答前不显示答案）
import { api } from '../api.js';
import { el, esc, toast, emptyState, loadingEl, fmtTime, typeText, typeBadge, difficultyBadge, openModal, closeModal } from '../ui.js';

let tab = 'practice'; // practice | bank

export async function render(root) {
  root.innerHTML = '';
  const tabs = el('div', { class: 'row', style: 'margin-bottom:14px' });
  const practiceBtn = el('button', { class: 'btn' + (tab === 'practice' ? ' btn-primary' : ''), onclick: () => { tab = 'practice'; render(root); } }, '📝 做练习');
  const bankBtn = el('button', { class: 'btn' + (tab === 'bank' ? ' btn-primary' : ''), onclick: () => { tab = 'bank'; render(root); } }, '🗂️ 题库管理');
  tabs.append(practiceBtn, bankBtn);
  root.append(tabs);
  if (tab === 'practice') await renderPractice(root);
  else await renderBank(root);
}

/* ================= 题库管理 ================= */
async function renderBank(root) {
  const genCard = el('div', { class: 'card' });
  genCard.append(el('h3', {}, '🤖 AI 生成练习题'));
  const matSelect = el('select');
  const countInput = el('input', { type: 'number', min: 1, max: 10, value: 5, class: 'input', style: 'width:90px' });
  const typeDefs = [['single', '单选'], ['multi', '多选'], ['judge', '判断'], ['short', '简答']];
  const typeBoxes = typeDefs.map(([t, label]) => {
    const cb = el('input', { type: 'checkbox', value: t, checked: t === 'single' || t === 'judge' });
    return { cb, label };
  });
  const typeRow = el('div', { class: 'row', style: 'gap:14px;margin-top:6px' },
    typeBoxes.map(({ cb, label }) =>
      el('label', { style: 'display:flex;gap:5px;align-items:center;font-size:13.5px' }, [cb, label])));
  const genBtn = el('button', { class: 'btn btn-primary', style: 'margin-top:12px' }, '生成题目');
  const resultBox = el('div');
  genBtn.addEventListener('click', async () => {
    const types = typeBoxes.filter(({ cb }) => cb.checked).map(({ cb }) => cb.value);
    if (!matSelect.value) return toast('请先选择资料', 'err');
    if (!types.length) return toast('请至少选择一种题型', 'err');
    genBtn.disabled = true;
    genBtn.textContent = 'AI 出题中，约需几十秒…';
    resultBox.innerHTML = '';
    try {
      const r = await api('/questions/generate', { method: 'POST', body: { material_id: matSelect.value, types, count: parseInt(countInput.value, 10) || 5 } });
      const msg = `✅ 已入库 ${r.saved_count} / 要求 ${r.requested} 题${r.skipped_count ? `，跳过 ${r.skipped_count} 条（${esc(r.skipped_reasons.join('；'))}）` : ''}`;
      resultBox.append(el('div', { class: r.saved_count ? 'answer-box' : 'insufficient-banner' }, msg));
      if (r.hint) resultBox.append(el('p', { class: 'muted' }, esc(r.hint)));
      if (r.usage) resultBox.append(el('p', { class: 'muted' }, r.usage.unknown ? 'Token 用量未知（平台未返回）' : `Token：${r.usage.prompt_tokens ?? '?'} / ${r.usage.completion_tokens ?? '?'}`));
      loadBankList();
    } catch (e) {
      resultBox.append(el('div', { class: 'insufficient-banner' }, '❌ ' + esc(e.message)));
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = '生成题目';
    }
  });

  genCard.append(
    el('label', { class: 'field' }, '从哪份资料出题', matSelect),
    el('label', { class: 'field' }, '数量（1-10）', countInput),
    el('div', { class: 'muted' }, '题型：'),
    typeRow,
    genBtn,
    resultBox
  );
  root.append(genCard);

  const filterType = el('select', { style: 'width:130px' });
  filterType.append(el('option', { value: '' }, '全部题型'));
  for (const t of ['single', 'multi', 'judge', 'short']) filterType.append(el('option', { value: t }, typeText(t)));
  filterType.addEventListener('change', loadBankList);

  const bankCard = el('div', { class: 'card' });
  bankCard.append(el('h3', {}, '题库'), el('div', { class: 'row', style: 'margin-bottom:8px' }, [filterType]));
  const listWrap = el('div');
  bankCard.append(listWrap);
  root.append(bankCard);

  async function loadBankList() {
    listWrap.innerHTML = '';
    listWrap.append(loadingEl());
    try {
      const q = filterType.value ? '?type=' + filterType.value : '';
      const { items } = await api('/questions' + q);
      listWrap.innerHTML = '';
      if (!items.length) {
        listWrap.append(emptyState('🗂️', '题库还是空的。用上方的 AI 生成功能，从你的资料出题。'));
        return;
      }
      for (const q of items) {
        listWrap.append(questionRow(q, loadBankList));
      }
    } catch (e) {
      listWrap.innerHTML = '';
      listWrap.append(el('p', { class: 'error-text' }, e.message));
    }
  }
  await Promise.all([loadMaterialsForSelect(matSelect), loadBankList()]);
}

function questionRow(q, onChanged) {
  const d = el('details', { style: 'border-bottom:1px solid var(--border);padding:9px 0' });
  const summary = el('summary', { style: 'cursor:pointer' }, [
    typeBadge(q.type), ' ', difficultyBadge(q.difficulty), ' ',
    el('span', { style: 'font-weight:500' }, esc(q.question.length > 70 ? q.question.slice(0, 69) + '…' : q.question)),
    el('span', { class: 'muted' }, `　${esc(q.kp_name || '未关联知识点')} · ${esc(q.filename || '')}${q.source_page ? ' 第' + q.source_page + '页' : ''}`),
  ]);
  d.append(summary);

  const body = el('div', { style: 'padding:8px 4px' });
  body.append(el('div', { style: 'font-weight:600;margin:4px 0' }, esc(q.question)));
  if (q.options && q.options.length) {
    q.options.forEach((o, i) => body.append(el('div', { class: 'kv' }, `${String.fromCharCode(65 + i)}. ${esc(o)}`)));
  }
  const revealBtn = el('button', { class: 'btn btn-sm', style: 'margin:8px 0' }, '查看答案与解析');
  revealBtn.addEventListener('click', async () => {
    try {
      const full = await api('/questions/' + q.id + '?include_answer=1');
      revealBtn.replaceWith(renderAnswerBlock(full));
    } catch (e) { toast(e.message, 'err'); }
  });
  body.append(revealBtn);
  body.append(el('div', { class: 'row', style: 'margin-top:8px' }, [
    el('button', { class: 'btn btn-sm', onclick: () => editQuestion(q, onChanged) }, '编辑'),
    el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
      if (!confirm('删除这道题及其答题记录？')) return;
      try { await api('/questions/' + q.id, { method: 'DELETE' }); toast('已删除', 'ok'); onChanged(); }
      catch (e) { toast(e.message, 'err'); }
    } }, '删除'),
  ]));
  d.append(body);
  return d;
}

function renderAnswerBlock(full) {
  const box = el('div', { class: 'explain-box' });
  const answerText = full.type === 'judge'
    ? (full.answer ? '正确（对）' : '错误（错）')
    : full.type === 'single'
      ? String.fromCharCode(65 + full.answer) + '. ' + (full.options[full.answer] || '')
      : full.type === 'multi'
        ? full.answer.map((i) => String.fromCharCode(65 + i)).join('、')
        : String(full.answer);
  box.append(el('div', {}, [
    el('span', { class: 'badge badge-green' }, '答案'),
    el('b', { style: 'margin-left:6px' }, answerText),
  ]));
  box.append(el('div', { style: 'margin-top:6px' }, '解析：' + esc(full.explanation)));
  if (full.source_snippet) box.append(el('div', { class: 'snippet', style: 'margin-top:6px' }, '原文依据：' + full.source_snippet));
  return box;
}

async function editQuestion(q, onChanged) {
  openModal(loadingEl());
  try {
    const full = await api('/questions/' + q.id + '?include_answer=1');
    const body = el('div');
    body.append(el('h3', { style: 'margin-top:0' }, '编辑题目'));

    const qInput = el('textarea', { class: 'input' }, full.question);
    body.append(el('label', { class: 'field' }, '题干', qInput));

    const optionInputs = [];
    if (full.type === 'single' || full.type === 'multi') {
      const box = el('div');
      full.options.forEach((o, i) => {
        const inp = el('input', { class: 'input', value: o, style: 'margin-bottom:6px' });
        optionInputs.push(inp);
        const row = el('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap;margin-bottom:6px' }, [
          el('input', {
            type: full.type === 'single' ? 'radio' : 'checkbox', name: 'correct-opt',
            title: '勾选为正确答案', checked: full.type === 'single' ? full.answer === i : full.answer.includes(i),
            style: 'width:auto;margin-top:9px',
          }),
          inp,
        ]);
        box.append(row);
      });
      body.append(el('label', { class: 'field' }, '选项（前面的圆点/勾选框 = 正确答案）', box));
    } else if (full.type === 'judge') {
      const sel = el('select', {}, [el('option', { value: 'true', selected: full.answer === true }, '对（正确）'), el('option', { value: 'false', selected: full.answer === false }, '错（错误）')]);
      body.append(el('label', { class: 'field' }, '正确答案', sel));
      body._judgeSel = sel;
    } else {
      const ans = el('textarea', { class: 'input' }, String(full.answer));
      body.append(el('label', { class: 'field' }, '参考答案', ans));
      body._shortAns = ans;
    }

    const expInput = el('textarea', { class: 'input' }, full.explanation);
    body.append(el('label', { class: 'field' }, '解析', expInput));
    const diffSel = el('select', {}, ['简单', '中等', '困难'].map((d) => el('option', { selected: full.difficulty === d }, d)));
    body.append(el('label', { class: 'field' }, '难度', diffSel));

    const saveBtn = el('button', { class: 'btn btn-primary' }, '保存修改');
    saveBtn.addEventListener('click', async () => {
      const payload = { question: qInput.value, explanation: expInput.value, difficulty: diffSel.value };
      if (full.type === 'single' || full.type === 'multi') {
        payload.options = optionInputs.map((i) => i.value).filter((v) => v.trim());
        const checked = [...body.querySelectorAll('input[name="correct-opt"]')].map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0);
        payload.answer = full.type === 'single' ? checked[0] : checked;
        if (payload.options.length < 2) return toast('选项至少 2 个', 'err');
        if (!checked.length) return toast('请勾选正确答案', 'err');
      } else if (full.type === 'judge') {
        payload.answer = body._judgeSel.value === 'true';
      } else {
        payload.answer = body._shortAns.value;
      }
      try {
        await api('/questions/' + full.id, { method: 'PATCH', body: payload });
        toast('已保存', 'ok');
        closeModal();
        onChanged();
      } catch (e) { toast(e.message, 'err'); }
    });
    body.append(el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, [
      el('button', { class: 'btn', onclick: closeModal }, '取消'), saveBtn,
    ]));
    openModal(body);
  } catch (e) {
    openModal(el('p', { class: 'error-text' }, e.message));
  }
}

async function loadMaterialsForSelect(select) {
  const { materials } = await api('/materials');
  const ready = materials.filter((m) => m.status === 'ready');
  select.innerHTML = '';
  if (!ready.length) select.append(el('option', {}, '（暂无可用资料）'));
  for (const m of ready) select.append(el('option', { value: m.id }, m.filename));
}

/* ================= 在线练习 ================= */
async function renderPractice(root) {
  const setupCard = el('div', { class: 'card' });
  setupCard.append(el('h3', {}, '📝 开始一轮练习'));
  const matSelect = el('select');
  const typeSel = el('select', { style: 'width:130px' });
  typeSel.append(el('option', { value: '' }, '全部题型'));
  for (const t of ['single', 'multi', 'judge', 'short']) typeSel.append(el('option', { value: t }, typeText(t)));
  const countSel = el('select', { style: 'width:110px' });
  [3, 5, 10, 20].forEach((n) => countSel.append(el('option', { value: n, selected: n === 5 }, n + ' 题')));
  const startBtn = el('button', { class: 'btn btn-primary' }, '开始练习');
  const practiceArea = el('div');

  startBtn.addEventListener('click', async () => {
    const params = new URLSearchParams();
    if (matSelect.value) params.set('material_id', matSelect.value);
    if (typeSel.value) params.set('type', typeSel.value);
    params.set('limit', '100');
    startBtn.disabled = true;
    try {
      const { items } = await api('/questions?' + params.toString());
      if (!items.length) { toast('题库中没有符合条件的题目，请先生成', 'err'); return; }
      const picked = shuffle(items).slice(0, parseInt(countSel.value, 10));
      renderQuizSet(practiceArea, picked);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      startBtn.disabled = false;
    }
  });

  setupCard.append(
    el('div', { class: 'row' }, [
      el('div', { style: 'flex:1;min-width:200px' }, [el('label', { class: 'field' }, '资料范围', matSelect)]),
      el('div', { style: 'width:130px' }, [el('label', { class: 'field' }, '题型', typeSel)]),
      el('div', { style: 'width:110px' }, [el('label', { class: 'field' }, '题量', countSel)]),
    ]),
    startBtn
  );
  root.append(setupCard);
  root.append(practiceArea);
  await loadMaterialsForSelect(matSelect);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderQuizSet(area, questions) {
  area.innerHTML = '';
  const form = el('div', { class: 'card' });
  form.append(el('h3', {}, `本轮共 ${questions.length} 题（作答后点击提交查看结果）`));
  const answers = new Map();

  questions.forEach((q, qi) => {
    const box = el('div', { style: 'border-bottom:1px solid var(--border);padding:12px 0' });
    box.append(el('div', { style: 'font-weight:600' }, `${qi + 1}. [${typeText(q.type)}] ${q.question}`));
    if (q.type === 'single' || q.type === 'multi') {
      q.options.forEach((opt, oi) => {
        const input = el('input', { type: q.type === 'single' ? 'radio' : 'checkbox', name: 'q-' + q.id, style: 'width:auto;margin-top:6px' });
        input.addEventListener('change', () => {
          if (q.type === 'single') {
            answers.set(q.id, oi);
            box.querySelectorAll('input[type=radio]').forEach((r, ri) => r.checked = ri === oi);
          } else {
            const cur = new Set(answers.get(q.id) || []);
            if (input.checked) cur.add(oi); else cur.delete(oi);
            answers.set(q.id, [...cur]);
          }
        });
        box.append(el('label', { class: 'opt' }, [input, el('span', {}, `${String.fromCharCode(65 + oi)}. ${esc(opt)}`)]));
      });
    } else if (q.type === 'judge') {
      const wrap = el('div', { class: 'row' });
      for (const [v, label] of [[true, '对'], [false, '错']]) {
        const input = el('input', { type: 'radio', name: 'q-' + q.id, style: 'width:auto;margin-top:4px' });
        input.addEventListener('change', () => answers.set(q.id, v));
        wrap.append(el('label', { style: 'display:flex;gap:6px;align-items:center' }, [input, label]));
      }
      box.append(wrap);
    } else {
      const ta = el('textarea', { placeholder: '输入你的答案…' });
      ta.addEventListener('input', () => answers.set(q.id, ta.value));
      box.append(ta);
    }
    form.append(box);
  });

  const submitBtn = el('button', { class: 'btn btn-primary', style: 'margin-top:14px' }, '提交全部答案');
  const resultArea = el('div');
  submitBtn.addEventListener('click', async () => {
    const unanswered = questions.filter((q) => !answers.has(q.id));
    if (unanswered.length) {
      if (!confirm(`还有 ${unanswered.length} 题未作答，未作答按错误处理，确定提交？`)) return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '评分中…';
    resultArea.innerHTML = '';
    let correctCount = 0;
    let graded = 0;
    for (const q of questions) {
      try {
        const r = await api('/attempts', { method: 'POST', body: { question_id: q.id, answer: answers.get(q.id) ?? null } });
        if (r.is_correct === 1) correctCount++;
        if (r.is_correct !== null) graded++;
        resultArea.append(renderResult(q, r));
      } catch (e) {
        resultArea.append(el('div', { class: 'insufficient-banner' }, `第 ${q.id} 题提交失败：${esc(e.message)}`));
      }
    }
    const summary = el('div', { class: 'card' });
    summary.append(el('h3', {}, `🎉 本轮结果：${graded ? correctCount + ' / ' + graded : '客观题 ' + correctCount + ' 题正确'}`));
    summary.append(el('p', { class: 'muted' },
      '简答题由 AI 给出评分建议（不计入自动统计），需要你在下方确认；答错的题目已进入错题本，相关知识点将在明天安排复习。'));
    resultArea.insertBefore(summary, resultArea.firstChild);
    submitBtn.textContent = '提交完成';
    window.dispatchEvent(new CustomEvent('materials-changed'));
  });
  form.append(submitBtn);
  area.append(form, resultArea);
}

function renderResult(q, r) {
  const box = el('div', { class: 'card', style: 'border-left:4px solid ' + (r.is_correct === 1 ? 'var(--green)' : r.is_correct === 0 ? 'var(--red)' : 'var(--yellow)') });
  const status = r.is_correct === 1
    ? el('span', { class: 'badge badge-green' }, '✅ 回答正确')
    : r.is_correct === 0
      ? el('span', { class: 'badge badge-red' }, '❌ 回答错误')
      : el('span', { class: 'badge badge-yellow' }, '⏳ 待确认（简答题）');
  box.append(el('div', { style: 'font-weight:600;margin-bottom:6px' }, q.question, ' ', status));

  const answerText = q.type === 'judge'
    ? (r.correct_answer ? '对' : '错')
    : q.type === 'single'
      ? String.fromCharCode(65 + r.correct_answer)
      : q.type === 'multi'
        ? r.correct_answer.map((i) => String.fromCharCode(65 + i)).join('、')
        : String(r.correct_answer);
  box.append(el('div', { class: 'answer-box' }, [
    el('b', {}, '正确答案：'), answerText,
    el('div', { style: 'margin-top:4px' }, '解析：' + esc(r.explanation)),
  ]));
  if (r.source && r.source.snippet) {
    box.append(el('div', { class: 'snippet' }, `原文依据${r.source.page ? '（第' + r.source.page + '页）' : ''}：` + r.source.snippet));
  }

  if (r.needs_confirm) {
    if (r.ai) {
      const verdictText = { correct: '基本答对', partial: '部分正确', wrong: '未答对' }[r.ai.verdict] || r.ai.verdict;
      box.append(el('div', { class: 'explain-box' }, [
        el('b', {}, `AI 评分建议：${r.ai.score ?? '?'} 分（${verdictText}）`),
        r.ai.usage && !r.ai.usage.unknown ? el('span', { class: 'muted' }, `　Token ${r.ai.usage.prompt_tokens}/${r.ai.usage.completion_tokens}`) : '',
        el('div', { style: 'margin-top:4px' }, esc(r.ai.comment || '')),
      ]));
    } else if (r.ai_error) {
      box.append(el('div', { class: 'insufficient-banner' }, 'AI 评分暂不可用：' + esc(r.ai_error)));
    }
    const confirmRow = el('div', { class: 'row', style: 'margin-top:8px' });
    confirmRow.append(el('span', { class: 'muted' }, '请自己判断并确认：'));
    for (const [v, label, cls] of [[1, '我答对了', 'btn'], [0, '我答错了', 'btn-danger']]) {
      confirmRow.append(el('button', {
        class: 'btn btn-sm ' + cls,
        onclick: async (e) => {
          try {
            await api('/attempts/' + r.attempt_id + '/confirm', { method: 'PATCH', body: { is_correct: v } });
            toast('已确认', 'ok');
            e.target.replaceWith(el('span', { class: 'badge ' + (v ? 'badge-green' : 'badge-red') }, '已确认：' + label));
          } catch (err) { toast(err.message, 'err'); }
        },
      }, label));
    }
    box.append(confirmRow);
  }
  return box;
}
