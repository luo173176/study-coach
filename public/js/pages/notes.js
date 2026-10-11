// 知识点笔记：AI 整理资料（核心概念/定义/关系/例子/易错点/待确认问题/来源）
import { api } from '../api.js';
import { el, esc, toast, emptyState, loadingEl, fmtTime, openModal, closeModal } from '../ui.js';

export async function render(root) {
  root.innerHTML = '';

  const genCard = el('div', { class: 'card' });
  genCard.append(el('h3', {}, '🧠 整理一份资料的知识点'));
  const select = el('select');
  const genBtn = el('button', { class: 'btn btn-primary', style: 'margin-top:10px' }, '开始整理');
  const hint = el('p', { class: 'muted', style: 'margin:8px 0 0' },
    'AI 只依据资料原文整理，每个条目都带来源编号；资料较长时会基于均匀抽样片段，并在结果中注明覆盖范围。');
  genCard.append(el('label', { class: 'field' }, '选择资料', select), genBtn, hint);

  genBtn.addEventListener('click', async () => {
    if (!select.value) return toast('请先选择资料', 'err');
    genBtn.disabled = true;
    genBtn.textContent = 'AI 整理中，约需十几秒…';
    try {
      const r = await api('/notes/generate', { method: 'POST', body: { material_id: select.value } });
      toast(`整理完成，登记了 ${r.kp_created} 个知识点${r.cached ? '（缓存）' : ''}`, 'ok');
      loadList();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = '开始整理';
    }
  });

  root.append(genCard);
  const listCard = el('div', { class: 'card' });
  root.append(listCard);

  await Promise.all([loadMaterials(select), loadList(listCard)]);
}

async function loadMaterials(select) {
  const { materials } = await api('/materials');
  const ready = materials.filter((m) => m.status === 'ready');
  select.innerHTML = '';
  if (!ready.length) {
    select.append(el('option', {}, '（暂无可用资料）'));
    return;
  }
  for (const m of ready) select.append(el('option', { value: m.id }, m.filename));
}

async function loadList(card) {
  card.innerHTML = '';
  card.append(loadingEl());
  try {
    const { items } = await api('/notes');
    card.innerHTML = '';
    card.append(el('h3', {}, `已保存的整理笔记（${items.length}）`));
    if (!items.length) {
      card.append(emptyState('🧠', '还没有整理笔记。选择上面的资料点「开始整理」，AI 会依据原文生成可长期保存的知识点笔记。'));
      return;
    }
    const table = el('table', { class: 'table' });
    table.append(el('thead', {}, el('tr', {}, [
      el('th', {}, '资料'), el('th', {}, '模型'), el('th', {}, 'Token'), el('th', {}, '时间'), el('th', {}, '操作'),
    ])));
    const tbody = el('tbody');
    for (const n of items) {
      tbody.append(el('tr', {}, [
        el('td', { style: 'max-width:260px;word-break:break-all' }, n.filename),
        el('td', {}, esc(n.model || '-')),
        el('td', {}, n.tokens ? n.tokens.toLocaleString() : el('span', { class: 'muted' }, '未知')),
        el('td', {}, fmtTime(n.created_at)),
        el('td', { style: 'white-space:nowrap' }, [
          el('button', { class: 'btn btn-sm', onclick: () => viewNote(n.id) }, '查看'),
          ' ',
          el('button', { class: 'btn btn-sm', onclick: async () => {
            if (!confirm('重新生成将调用一次模型，并保存为新笔记，确定？')) return;
            try {
              await api('/notes/generate', { method: 'POST', body: { material_id: n.material_id, nocache: true } });
              toast('已重新生成', 'ok');
              loadList(card);
            } catch (e) { toast(e.message, 'err'); }
          } }, '重新生成'),
          ' ',
          el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
            if (!confirm('确定删除这份笔记？（知识点不会删除）')) return;
            try { await api('/notes/' + n.id, { method: 'DELETE' }); toast('已删除', 'ok'); loadList(card); }
            catch (e) { toast(e.message, 'err'); }
          } }, '删除'),
        ]),
      ]));
    }
    table.append(tbody);
    card.append(table);
  } catch (e) {
    card.innerHTML = '';
    card.append(el('p', { class: 'error-text' }, e.message));
  }
}

async function viewNote(id) {
  openModal(loadingEl());
  try {
    const n = await api('/notes/' + id);
    const c = n.content;
    const body = el('div');
    body.append(el('h3', { style: 'margin-top:0;word-break:break-all' }, `🧠 ${c.material_filename} · 知识点整理`));
    body.append(el('p', { class: 'muted' }, `覆盖范围：${esc(c.coverage || '全文')} · 生成时间 ${fmtTime(n.created_at)}`));

    const sources = c.sources || [];
    const chip = (idx) => {
      if (!idx || !idx.length) return '';
      return ' ' + idx.map((i) => `<button class="src-chip" data-i="${i}">[${i}]</button>`).join('');
    };
    const section = (title, renderItems) => {
      const items = renderItems();
      if (!items) return;
      body.append(el('div', { class: 'section-title' }, title), items);
    };
    const ul = (arr, fmt) => {
      if (!arr || !arr.length) return null;
      const u = el('ul', { style: 'margin:4px 0;padding-left:20px' });
      for (const x of arr) u.append(el('li', { html: fmt(x) }));
      return u;
    };

    section('📌 核心概念', () => ul(c.core_concepts, (x) => `${esc(x.name)}：${esc(x.explain)}${chip(x.source)}`));
    section('📖 关键定义', () => ul(c.key_definitions, (x) => `<b>${esc(x.term)}</b>：${esc(x.definition)}${chip(x.source)}`));
    section('🔗 知识点之间的关系', () => ul(c.relations, (x) => `${esc(x.desc)}${chip(x.source)}`));
    section('💡 典型例子', () => ul(c.examples, (x) => `${esc(x.desc)}${chip(x.source)}`));
    section('⚠️ 易错点', () => ul(c.pitfalls, (x) => `${esc(x.desc)}${chip(x.source)}`));
    section('❓ 需要进一步确认的问题', () => ul(c.open_questions, (x) => esc(x)));

    if (sources.length) {
      body.append(el('div', { class: 'section-title' }, '📎 原文来源'));
      const srcBox = el('div');
      for (const s of sources) {
        const d = el('div', { class: 'snippet hidden' }, s.snippet);
        const row = el('div', { class: 'kv', style: 'cursor:pointer' },
          `[${s.idx}] ${esc(s.filename)}${s.page ? ' · 第' + s.page + '页' : ''}${s.section ? ' · ' + esc(s.section) : ''}`);
        row.addEventListener('click', () => d.classList.toggle('hidden'));
        srcBox.append(row, d);
      }
      body.append(srcBox);
      // 芯片点击滚动到对应来源
      body.querySelectorAll('.src-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.i, 10);
          const target = srcBox.querySelectorAll('.snippet')[idx - 1];
          if (target) { target.classList.remove('hidden'); target.scrollIntoView({ block: 'nearest' }); }
        });
      });
    }

    body.append(el('div', { style: 'text-align:right;margin-top:14px' },
      el('button', { class: 'btn', onclick: closeModal }, '关闭')));
    openModal(body);
  } catch (e) {
    openModal(el('p', { class: 'error-text' }, e.message));
  }
}
