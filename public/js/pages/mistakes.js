// 错题本：按知识点/日期筛选，查看解析，手动调整掌握程度
import { api } from '../api.js';
import { el, esc, toast, emptyState, loadingEl, fmtTime, typeText, masteryBadge, typeBadge, difficultyBadge } from '../ui.js';

export async function render(root) {
  root.innerHTML = '';
  const filterCard = el('div', { class: 'card' });
  filterCard.append(el('h3', {}, '📕 错题本'));

  const kpSel = el('select');
  kpSel.append(el('option', { value: '' }, '全部知识点'));
  const dateFrom = el('input', { type: 'date', style: 'width:160px' });
  const dateTo = el('input', { type: 'date', style: 'width:160px' });
  const searchBtn = el('button', { class: 'btn btn-primary' }, '筛选');

  filterCard.append(el('div', { class: 'row' }, [
    el('div', { style: 'flex:1;min-width:180px' }, [el('label', { class: 'field' }, '知识点', kpSel)]),
    el('div', {}, [el('label', { class: 'field' }, '开始日期', dateFrom)]),
    el('div', {}, [el('label', { class: 'field' }, '结束日期', dateTo)]),
    el('div', { style: 'align-self:flex-end' }, searchBtn),
  ]));
  root.append(filterCard);

  const listCard = el('div', { class: 'card' });
  root.append(listCard);

  async function loadKps() {
    const { items } = await api('/knowledge-points');
    for (const kp of items) {
      kpSel.append(el('option', { value: kp.id }, `${kp.name}（${kp.filename || ''}）`));
    }
  }

  async function loadMistakes() {
    listCard.innerHTML = '';
    listCard.append(loadingEl());
    const params = new URLSearchParams();
    if (kpSel.value) params.set('knowledge_point_id', kpSel.value);
    if (dateFrom.value) params.set('date_from', dateFrom.value);
    if (dateTo.value) params.set('date_to', dateTo.value);
    try {
      const { items } = await api('/mistakes?' + params.toString());
      listCard.innerHTML = '';
      listCard.append(el('h3', {}, `错题记录（${items.length}）`));
      if (!items.length) {
        listCard.append(emptyState('🎉', '没有符合条件的错题。做几轮练习后，答错的题会自动出现在这里。'));
        return;
      }
      for (const m of items) listCard.append(mistakeCard(m));
    } catch (e) {
      listCard.innerHTML = '';
      listCard.append(el('p', { class: 'error-text' }, e.message));
    }
  }

  searchBtn.addEventListener('click', loadMistakes);
  await Promise.all([loadKps(), loadMistakes()]);
}

function mistakeCard(m) {
  const box = el('div', { style: 'border-bottom:1px solid var(--border);padding:12px 0' });
  const head = el('div', { class: 'row', style: 'justify-content:space-between' });
  head.append(el('div', {}, [
    typeBadge(m.type), ' ', difficultyBadge(m.difficulty), ' ',
    el('span', { class: 'muted' }, fmtTime(m.created_at)),
  ]));

  // 掌握程度手动调整
  const masterySel = el('select', { style: 'width:110px' });
  [['0', '未掌握'], ['1', '学习中'], ['2', '已掌握']].forEach(([v, label]) => {
    masterySel.append(el('option', { value: v, selected: String(m.mastery ?? 1) === v }, label));
  });
  if (!m.kp_id) masterySel.disabled = true;
  masterySel.addEventListener('change', async () => {
    try {
      await api('/review/knowledge-points/' + m.kp_id + '/mastery', { method: 'PATCH', body: { mastery: parseInt(masterySel.value, 10) } });
      toast(`已更新「${m.kp_name}」的掌握程度`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  head.append(el('div', { class: 'row', style: 'gap:8px' }, [
    m.kp_name ? el('span', { class: 'badge badge-blue' }, esc(m.kp_name)) : '',
    masterySel,
  ]));
  box.append(head);

  box.append(el('div', { style: 'font-weight:600;margin:8px 0 4px' }, m.question));
  if (m.options && m.options.length) {
    m.options.forEach((o, i) => box.append(el('div', { class: 'kv muted' }, `${String.fromCharCode(65 + i)}. ${esc(o)}`)));
  }
  const myAnswer = m.type === 'judge'
    ? (m.user_answer === true ? '对' : m.user_answer === false ? '错' : '未作答')
    : m.type === 'single'
      ? (Number.isInteger(m.user_answer) ? String.fromCharCode(65 + m.user_answer) : '未作答')
      : m.type === 'multi'
        ? (Array.isArray(m.user_answer) && m.user_answer.length ? m.user_answer.map((i) => String.fromCharCode(65 + i)).join('、') : '未作答')
        : (m.user_answer || '未作答');
  const correctText = m.type === 'judge'
    ? (m.correct_answer ? '对' : '错')
    : m.type === 'single'
      ? String.fromCharCode(65 + m.correct_answer)
      : m.type === 'multi'
        ? m.correct_answer.map((i) => String.fromCharCode(65 + i)).join('、')
        : String(m.correct_answer);
  box.append(el('div', { class: 'kv' }, [
    el('span', { class: 'badge badge-red' }, '我的答案'), ' ', esc(myAnswer),
    el('span', { class: 'badge badge-green', style: 'margin-left:12px' }, '正确答案'), ' ', esc(correctText),
  ]));
  box.append(el('div', { class: 'explain-box' }, '解析：' + esc(m.explanation)));
  if (m.ai_comment) box.append(el('div', { class: 'kv muted' }, 'AI 点评：' + esc(m.ai_comment)));
  box.append(el('div', { class: 'kv muted' }, `来源：${esc(m.filename || '')}${m.source_page ? ' · 第' + m.source_page + '页' : ''}`));
  return box;
}
