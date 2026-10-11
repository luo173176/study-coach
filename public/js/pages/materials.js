// 学习资料库：上传、列表、查看、删除
import { api } from '../api.js';
import { el, esc, toast, emptyState, loadingEl, fmtTime, fmtSize, statusBadge, openModal, closeModal } from '../ui.js';

// 处理中（OCR）轮询：有资料在处理时每 3 秒刷新一次列表
let pollTimer = null;

export async function render(root) {
  root.innerHTML = '';
  root.append(uploadCard());
  const listCard = el('div', { class: 'card' }, [el('h3', {}, '已导入的资料')]);
  root.append(listCard);
  await loadList(listCard);
}

function schedulePoll(materials) {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!materials.some((m) => m.status === 'processing')) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    const path = location.hash.replace(/^#\/?/, '').split('?')[0];
    if (path === 'materials' || path === '') rerenderList();
  }, 3000);
}

function uploadCard() {
  const input = el('input', { type: 'file', accept: '.pdf,.txt,.md,.markdown', style: 'display:none' });
  const dropZone = el('div', {
    style: 'border:2px dashed var(--border);border-radius:var(--radius);padding:26px;text-align:center;cursor:pointer;background:var(--gray-bg)',
  }, [
    el('div', { style: 'font-size:30px' }, '📤'),
    el('div', { style: 'font-weight:600;margin-top:4px' }, '点击选择或拖拽文件到此处'),
    el('div', { class: 'muted', style: 'margin-top:2px' }, '支持 PDF / TXT / Markdown，单个文件不超过 20MB'),
  ]);
  dropZone.addEventListener('click', () => input.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--primary)'; });
  dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--border)'; });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--border)';
    if (e.dataTransfer.files && e.dataTransfer.files[0]) doUpload(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files[0]) doUpload(input.files[0]); input.value = ''; });

  async function doUpload(file) {
    const fd = new FormData();
    fd.append('file', file);
    dropZone.innerHTML = `<div class="loading"><span class="spinner"></span>正在上传并解析「${esc(file.name)}」，请稍候…</div>`;
    try {
      const r = await api('/materials', { method: 'POST', form: fd });
      const m = r.material;
      if (m.status === 'ready') {
        toast(`「${m.filename}」导入成功：${r.chunk_count} 个文本片段${r.truncated ? '（资料过长，已截断）' : ''}`, 'ok');
      } else if (m.status === 'processing') {
        toast(`「${m.filename}」已上传，正在后台 OCR 识别（约 ${r.ocr_pages} 页，可能需要几分钟），列表会自动刷新`, 'ok');
      } else {
        toast(`「${m.filename}」导入失败：${m.error}`, 'err');
      }
      window.dispatchEvent(new CustomEvent('materials-changed'));
      rerender();
    } catch (e) {
      toast(e.message, 'err');
      rerender();
    }
  }

  function rerender() {
    const page = document.getElementById('page');
    if (page) import('./materials.js').then((m) => m.render(page));
  }

  return el('div', { class: 'card' }, [el('h3', {}, '导入学习资料'), dropZone, input]);
}

async function loadList(card) {
  card.innerHTML = '';
  card.append(loadingEl());
  try {
    const { materials } = await api('/materials');
    card.innerHTML = '';
    card.append(el('h3', {}, `已导入的资料（${materials.length}）`));
    if (!materials.length) {
      card.append(emptyState('📭', '还没有资料。上传你的第一份学习资料（PDF/TXT/Markdown）开始使用。'));
      return;
    }
    schedulePoll(materials);
    if (materials.some((m) => m.status === 'processing')) {
      card.append(el('p', { class: 'muted' }, '⏳ 有资料正在 OCR 识别中，列表会自动刷新（扫描件识别可能需要几分钟）…'));
    }
    const table = el('table', { class: 'table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, '文件名'), el('th', {}, '状态'), el('th', {}, '大小'), el('th', {}, '页数'),
        el('th', {}, '字符数'), el('th', {}, '上传时间'), el('th', {}, '操作'),
      ])),
    ]);
    const tbody = el('tbody');
    for (const m of materials) {
      const statusCell = el('td', {}, [
        el('span', { html: statusBadge(m.status) }),
        m.note ? el('div', { class: 'muted', style: 'font-size:12px;max-width:180px;white-space:normal' }, m.note) : '',
      ]);
      const tr = el('tr', {}, [
        el('td', { style: 'max-width:220px;word-break:break-all' }, m.filename),
        statusCell,
        el('td', {}, fmtSize(m.size)),
        el('td', {}, m.page_count ?? '—'),
        el('td', {}, m.char_count?.toLocaleString() ?? '—'),
        el('td', {}, fmtTime(m.uploaded_at)),
        el('td', { style: 'white-space:nowrap' }, [
          el('button', { class: 'btn btn-sm', onclick: () => viewMaterial(m.id) }, '查看'),
          ' ',
          m.status === 'ready'
            ? el('a', { class: 'btn btn-sm', href: '#/notes?material=' + m.id, title: '让 AI 整理这份资料的知识点' }, '整理知识点')
            : '',
          ' ',
          el('button', {
            class: 'btn btn-sm btn-danger',
            onclick: async () => {
              if (!confirm(`确定删除「${m.filename}」吗？\n将同时删除它的文本片段、知识点、笔记、题目和答题记录，且不可恢复。`)) return;
              try { await api('/materials/' + m.id, { method: 'DELETE' }); toast('已删除', 'ok'); rerenderList(); }
              catch (e) { toast(e.message, 'err'); }
            },
          }, '删除'),
        ]),
      ]);
      tbody.append(tr);
    }
    table.append(tbody);
    card.append(table);
    if (materials.some((m) => m.status === 'failed')) {
      card.append(el('p', { class: 'muted', style: 'margin-top:10px' }, '⚠️ 失败的资料不会参与问答和出题。常见原因：扫描版 PDF 无法提取文字、文件为空或已损坏。'));
    }
  } catch (e) {
    card.innerHTML = '';
    card.append(el('p', { class: 'error-text' }, e.message));
  }
}

function rerenderList() {
  const page = document.getElementById('page');
  import('./materials.js').then((m) => m.render(page));
}

async function viewMaterial(id) {
  openModal(loadingEl('加载资料内容…'));
  try {
    const { material: m } = await api('/materials/' + id);
    const body = el('div');
    body.append(el('h3', { style: 'margin-top:0;word-break:break-all' }, m.filename));
    body.append(el('p', { class: 'muted' }, [
      el('span', { html: statusBadge(m.status) }),
      m.status === 'ready' ? `　共 ${m.page_count ?? '—'} 页 · ${m.char_count?.toLocaleString()} 字符` : '',
    ]));
    if (m.error) body.append(el('div', { class: 'insufficient-banner' }, '处理失败：' + esc(m.error)));
    if (m.status === 'ready' && m.pages && m.pages.length) {
      const selector = el('select');
      const textDiv = el('div', { class: 'snippet', style: 'max-height:50vh;overflow:auto' });
      const show = (i) => {
        const p = m.pages[i];
        textDiv.textContent = p.text || '（此页没有可提取的文字，可能是扫描图片页）';
      };
      m.pages.forEach((p, i) => {
        const label = (p.page ? `第 ${p.page} 页` : `片段 ${i + 1}`) + (p.section ? `（${p.section}）` : '') + (p.ocr ? '（OCR 识别）' : '');
        selector.append(el('option', { value: String(i) }, label));
      });
      selector.addEventListener('change', () => show(parseInt(selector.value, 10)));
      show(0);
      body.append(el('label', { class: 'field' }, '选择页/章节'), selector, textDiv);
    }
    body.append(el('div', { style: 'text-align:right;margin-top:12px' },
      el('button', { class: 'btn', onclick: closeModal }, '关闭')));
    openModal(body);
  } catch (e) {
    openModal(el('p', { class: 'error-text' }, e.message));
  }
}
