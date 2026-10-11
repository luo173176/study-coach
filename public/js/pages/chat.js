// 资料问答：选择资料 → 提问 → 带真实引用的回答
import { api } from '../api.js';
import { el, esc, toast, emptyState, fmtTime, renderAnswerWithCitations, usageText } from '../ui.js';

let selectedIds = null; // null = 全部资料

export async function render(root) {
  root.innerHTML = '';

  const askCard = el('div', { class: 'card' });
  askCard.append(el('h3', {}, '💬 向学习资料提问'));

  const materialBox = el('div');
  const loadMaterials = async () => {
    const { materials } = await api('/materials');
    const ready = materials.filter((m) => m.status === 'ready');
    materialBox.innerHTML = '';
    if (!ready.length) {
      materialBox.append(el('p', { class: 'muted' }, '还没有可用的资料，请先到「学习资料库」导入。'));
      return;
    }
    const wrap = el('div', { class: 'row', style: 'gap:8px' });
    const allBtn = el('button', {
      class: 'btn btn-sm' + (selectedIds === null ? ' btn-primary' : ''),
      onclick: () => { selectedIds = null; refreshBtns(); },
    }, '全部资料');
    const chips = [];
    for (const m of ready) {
      const b = el('button', {
        class: 'btn btn-sm' + (selectedIds && selectedIds.includes(m.id) ? ' btn-primary' : ''),
        onclick: () => {
          if (selectedIds === null) selectedIds = [];
          const i = selectedIds.indexOf(m.id);
          if (i >= 0) selectedIds.splice(i, 1); else selectedIds.push(m.id);
          if (!selectedIds.length) selectedIds = null;
          refreshBtns();
        },
      }, m.filename.length > 18 ? m.filename.slice(0, 17) + '…' : m.filename);
      chips.push(b);
    }
    function refreshBtns() {
      allBtn.className = 'btn btn-sm' + (selectedIds === null ? ' btn-primary' : '');
      ready.forEach((m, i) => {
        chips[i].className = 'btn btn-sm' + (selectedIds && selectedIds.includes(m.id) ? ' btn-primary' : '');
      });
    }
    wrap.append(allBtn, ...chips);
    materialBox.append(el('p', { class: 'muted', style: 'margin-bottom:6px' }, '选择要依据的资料（不选则搜索全部）：'), wrap);
  };

  const textarea = el('textarea', { placeholder: '例如：这一章的核心概念是什么？请说明依据。' });
  const askBtn = el('button', { class: 'btn btn-primary', style: 'margin-top:10px' }, '提问');
  const hint = el('p', { class: 'muted', style: 'margin:8px 0 0' },
    '🔒 提问时，你选中资料的相关片段和问题会发送到你配置的模型服务（见「设置」页）用于生成回答。');

  askBtn.addEventListener('click', async () => {
    const q = textarea.value.trim();
    if (q.length < 2) return toast('请输入问题（至少 2 个字）', 'err');
    askBtn.disabled = true;
    askBtn.textContent = '思考中…';
    const resultBox = el('div', { class: 'card', style: 'margin-top:16px' }, [el('div', { class: 'loading' }, [el('span', { class: 'spinner' }), '正在检索资料并生成回答…'])]);
    historyCard.parentNode.insertBefore(resultBox, historyCard);
    try {
      const r = await api('/chat', { method: 'POST', body: { question: q, material_ids: selectedIds || undefined } });
      resultBox.innerHTML = '';
      resultBox.append(renderQA(r));
      textarea.value = '';
      loadHistory();
    } catch (e) {
      resultBox.innerHTML = '';
      resultBox.append(el('div', { class: 'insufficient-banner' }, '❌ ' + esc(e.message)));
    } finally {
      askBtn.disabled = false;
      askBtn.textContent = '提问';
    }
  });

  askCard.append(materialBox, textarea, askBtn, hint);
  root.append(askCard);

  const historyCard = el('div', { class: 'card' }, [el('h3', {}, '🕘 问答历史')]);
  root.append(historyCard);
  await Promise.all([loadMaterials(), loadHistory(historyCard)]);
}

function renderQA(r) {
  const box = el('div');
  box.append(el('p', { style: 'font-weight:600;margin:0 0 6px' }, 'Q：' + r.question));
  if (r.insufficient) {
    box.append(el('div', { class: 'insufficient-banner' }, '⚠️ ' + esc(r.answer) + (r.reason ? '（' + esc(r.reason) + '）' : '')));
  } else {
    box.append(el('div', { style: 'margin:6px 0' }, renderAnswerWithCitations(r.answer, r.sources || [], showSource)));
    if (r.stripped && r.stripped.length) {
      box.append(el('p', { class: 'muted' }, `（已忽略无效引用编号 ${r.stripped.join('、')}，引用只可能来自实际检索到的片段）`));
    }
  }
  if (r.sources && r.sources.length) {
    const srcTitle = el('div', { class: 'section-title' }, '📎 引用来源（点击展开原文片段）');
    box.append(srcTitle);
    for (const s of r.sources) {
      const detail = el('div', { class: 'snippet hidden' }, s.snippet);
      const label = `[${s.idx}] ${s.filename}${s.page ? ' · 第' + s.page + '页' : ''}${s.section ? ' · ' + s.section : ''}${s.cited ? '' : '（参考）'}`;
      const row = el('div', { class: 'kv', style: 'cursor:pointer' }, [
        el('span', { class: 'badge ' + (s.cited ? 'badge-blue' : 'badge-gray') }, s.cited ? '已引用' : '参考'),
        ' ' + esc(label),
      ]);
      row.addEventListener('click', () => detail.classList.toggle('hidden'));
      box.append(row, detail);
    }
  }
  const meta = usageText(r.usage, r.duration_ms, r.cached);
  if (meta) box.append(el('p', { class: 'muted' }, meta));
  return box;
}

function showSource(src) {
  alert(`来源：${src.filename}${src.page ? ' 第' + src.page + '页' : ''}\n\n${src.snippet}`);
}

async function loadHistory(card = null) {
  const target = card || document.querySelector('#page .card:last-child');
  if (!target) return;
  try {
    const { items } = await api('/chat/history?limit=20');
    target.innerHTML = '';
    target.append(el('h3', {}, `🕘 问答历史（${items.length}）`));
    if (!items.length) {
      target.append(emptyState('💬', '还没有提问记录。上方输入问题开始提问，回答会附带真实引用来源。'));
      return;
    }
    for (const item of items) {
      const d = el('details', { style: 'border-bottom:1px solid var(--border);padding:8px 0' });
      d.append(el('summary', { style: 'cursor:pointer;font-weight:500' }, [
        item.insufficient ? el('span', { class: 'badge badge-yellow' }, '证据不足') : el('span', { class: 'badge badge-green' }, '已回答'),
        ' ' + esc(item.question.length > 60 ? item.question.slice(0, 59) + '…' : item.question),
        el('span', { class: 'muted', style: 'float:right' }, fmtTime(item.created_at)),
      ]));
      d.append(renderQA(item));
      target.append(d);
    }
  } catch (e) {
    target.append(el('p', { class: 'error-text' }, e.message));
  }
}
