// 首页仪表盘
import { api } from '../api.js';
import { el, esc, fmtTime, emptyState, typeBadge } from '../ui.js';

export async function render(root) {
  const data = await api('/dashboard');
  root.innerHTML = '';
  const s = data.stats;

  const stats = el('div', { class: 'grid stats-grid' });
  const items = [
    [s.materials_ready, '已导入资料'],
    [s.knowledge_points, '知识点'],
    [s.questions, '题库题目'],
    [s.attempts, '已答题目'],
    [s.recent_accuracy === null ? '—' : s.recent_accuracy + '%', '最近正确率（近30题）'],
    [s.today_tasks, '今日待复习'],
  ];
  for (const [num, label] of items) {
    stats.append(el('div', { class: 'stat' }, [
      el('div', { class: 'num' }, String(num)),
      el('div', { class: 'label' }, label),
    ]));
  }
  root.append(stats);

  // 今日复习任务
  const taskCard = el('div', { class: 'card', style: 'margin-top:16px' });
  taskCard.append(el('h3', {}, '🗓️ 今日复习任务'));
  if (!data.today_tasks.length) {
    taskCard.append(emptyState('✅', '今天没有到期复习任务。继续加油，或去练习题库巩固一下。'));
  } else {
    const list = el('div');
    for (const t of data.today_tasks) {
      list.append(el('div', { class: 'row', style: 'justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)' }, [
        el('div', {}, [
          el('span', { style: 'font-weight:600' }, t.name),
          el('span', { class: 'muted' }, `　来自「${t.material_filename}」`),
          t.last_result === 'wrong' ? el('span', { class: 'badge badge-red', style: 'margin-left:8px' }, '上次答错') : '',
        ]),
        el('a', { href: '#/review', class: 'btn btn-sm' }, '去复习'),
      ]));
    }
    taskCard.append(list);
  }
  root.append(taskCard);

  const twoCol = el('div', { class: 'grid', style: 'grid-template-columns: 1fr 1fr;' });

  // 高频错题知识点
  const wrongCard = el('div', { class: 'card' });
  wrongCard.append(el('h3', {}, '📕 高频错题知识点'));
  if (!data.top_wrong_kps.length) {
    wrongCard.append(emptyState('👍', '暂无错题记录。做完练习后，这里会显示需要加强的知识点。'));
  } else {
    for (const w of data.top_wrong_kps) {
      wrongCard.append(el('div', { class: 'row', style: 'justify-content:space-between;padding:6px 0' }, [
        el('span', {}, esc(w.name)),
        el('span', { class: 'badge badge-red' }, `答错 ${w.wrong_count} 次`),
      ]));
    }
  }
  twoCol.append(wrongCard);

  // 最近学习记录
  const actCard = el('div', { class: 'card' });
  actCard.append(el('h3', {}, '🕐 最近学习记录'));
  if (!data.recent_activity.length) {
    actCard.append(emptyState('🚀', '还没有学习记录。先去导入一份学习资料吧！', el('a', { class: 'btn btn-primary btn-sm', href: '#/materials' }, '导入资料')));
  } else {
    for (const a of data.recent_activity) {
      const icon = { upload: '📥', note: '🧠', qa: '💬', attempt: '✍️', review: '🔁' }[a.type] || '•';
      actCard.append(el('div', { class: 'kv' }, `${icon} ${esc(a.text)}`, el('span', { class: 'muted', style: 'float:right' }, fmtTime(a.at))));
    }
  }
  twoCol.append(actCard);
  root.append(twoCol);

  // 快捷入口
  const quick = el('div', { class: 'card' });
  quick.append(el('h3', {}, '⚡ 开始学习'));
  quick.append(el('div', { class: 'row' }, [
    el('a', { class: 'btn', href: '#/materials' }, '📚 导入资料'),
    el('a', { class: 'btn', href: '#/chat' }, '💬 资料问答'),
    el('a', { class: 'btn', href: '#/notes' }, '🧠 整理知识点'),
    el('a', { class: 'btn', href: '#/quiz' }, '✍️ 做练习题'),
  ]));
  root.append(quick);
}
