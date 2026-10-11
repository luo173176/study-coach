// 复习计划：今日任务（记住了/仍不熟悉/已掌握）、规则说明、历史
import { api } from '../api.js';
import { el, esc, toast, emptyState, loadingEl, fmtTime, masteryBadge } from '../ui.js';

export async function render(root) {
  root.innerHTML = '';

  const todayCard = el('div', { class: 'card' });
  todayCard.append(el('h3', {}, '🗓️ 今日复习任务'));
  const taskWrap = el('div');
  todayCard.append(taskWrap);
  root.append(todayCard);

  const rulesCard = el('div', { class: 'card' });
  rulesCard.append(el('h3', {}, '📏 复习规则（透明可查）'));
  try {
    const rules = await api('/review/rules');
    const ul = el('ul', { style: 'padding-left:20px;margin:6px 0' });
    for (const line of rules.description) ul.append(el('li', {}, line));
    rulesCard.append(
      el('div', { class: 'kv' }, '间隔表（连续记住时依次拉长）：' + rules.intervals_days.map((d) => d + ' 天').join(' → ')),
      ul
    );
  } catch { /* 规则加载失败不阻塞 */ }
  root.append(rulesCard);

  const historyCard = el('div', { class: 'card' });
  historyCard.append(el('h3', {}, '🕘 复习历史'));
  const histWrap = el('div');
  historyCard.append(histWrap);
  root.append(historyCard);

  await Promise.all([loadTasks(taskWrap), loadHistory(histWrap)]);
}

async function loadTasks(wrap) {
  wrap.innerHTML = '';
  wrap.append(loadingEl());
  try {
    const data = await api('/review/today');
    wrap.innerHTML = '';
    wrap.append(el('p', { class: 'muted' }, `今天是 ${data.date}，共有 ${data.total} 个知识点到期。`));
    if (!data.tasks.length) {
      wrap.append(emptyState('✅', '今天没有需要复习的知识点。去「练习题库」做一轮题，答错的知识点明天会安排复习。'));
      return;
    }
    for (const t of data.tasks) wrap.append(taskCard(t));
  } catch (e) {
    wrap.innerHTML = '';
    wrap.append(el('p', { class: 'error-text' }, e.message));
  }
}

function taskCard(t) {
  const box = el('div', { style: 'border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:10px 0' });
  const head = el('div', { class: 'row', style: 'justify-content:space-between' });
  head.append(el('div', {}, [
    el('b', {}, t.name),
    ' ', masteryBadge(t.mastery),
    t.last_result === 'wrong' ? el('span', { class: 'badge badge-red', style: 'margin-left:6px' }, '上次答错') : '',
  ]));
  head.append(el('span', { class: 'muted' }, t.overdue_days > 0 ? `已过期 ${t.overdue_days} 天` : '今日到期'));
  box.append(head);
  box.append(el('div', { class: 'muted', style: 'margin:4px 0' },
    `来自「${esc(t.material_filename)}」· 累计 ${t.correct}/${t.attempts} 次答对`));

  if (t.snippet && t.snippet.text) {
    const detail = el('div', { class: 'snippet hidden' }, t.snippet.text);
    const toggle = el('button', { class: 'btn btn-sm', style: 'margin:6px 0' }, '查看原文提示');
    toggle.addEventListener('click', () => detail.classList.toggle('hidden'));
    box.append(toggle, detail);
  }

  const actions = el('div', { class: 'row', style: 'margin-top:8px' });
  const btnDefs = [
    ['got', '✅ 记住了', 'btn'],
    ['fuzzy', '😵 仍不熟悉', 'btn-danger'],
    ['mastered', '🏆 已掌握', 'btn'],
  ];
  for (const [action, label, cls] of btnDefs) {
    actions.append(el('button', {
      class: 'btn btn-sm ' + cls,
      onclick: async (e) => {
        try {
          await api(`/review/knowledge-points/${t.kp_id}/action`, { method: 'POST', body: { action } });
          toast(action === 'mastered' ? `「${t.name}」已移出复习计划` : `已记录，按规则安排下次复习`, 'ok');
          e.target.closest('div[style*="border"]').style.opacity = '0.45';
          e.target.closest('div[style*="border"]').querySelectorAll('button').forEach((b) => b.disabled = true);
        } catch (err) { toast(err.message, 'err'); }
      },
    }, label));
  }
  box.append(actions);
  return box;
}

async function loadHistory(wrap) {
  wrap.innerHTML = '';
  try {
    const { items } = await api('/review/history?limit=30');
    if (!items.length) {
      wrap.append(el('p', { class: 'muted' }, '暂无复习记录。'));
      return;
    }
    for (const h of items) {
      wrap.append(el('div', { class: 'kv' }, [
        el('span', { class: 'badge badge-gray' }, h.action_text),
        ` ${esc(h.name)} `, el('span', { class: 'muted' }, `「${esc(h.filename)}」· ${fmtTime(h.reviewed_at)}`),
      ]));
    }
  } catch (e) {
    wrap.append(el('p', { class: 'error-text' }, e.message));
  }
}
