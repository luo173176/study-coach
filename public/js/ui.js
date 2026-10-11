// 常用 UI 辅助：转义、元素构建、Toast、空状态、加载态
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 可变参数写法 el(tag, attrs, child1, child2, ...) 与数组写法 el(tag, attrs, [child1, child2]) 都支持
export function el(tag, attrs = {}, ...args) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if ((k === 'selected' || k === 'checked' || k === 'disabled') && typeof v === 'boolean') node[k] = v;
    else if (k === 'value') node.value = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  const children = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function toast(msg, type = '') {
  const wrap = document.getElementById('toast-wrap');
  const t = el('div', { class: 'toast ' + (type || '') }, msg);
  wrap.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => t.remove(), 3600);
}

export function emptyState(icon, text, action) {
  const box = el('div', { class: 'empty' }, [el('span', { class: 'icon' }, icon), el('div', {}, text)]);
  if (action) box.append(el('div', { style: 'margin-top:10px' }, action));
  return box;
}

export function loadingEl(text = '加载中…') {
  return el('div', { class: 'loading' }, [el('span', { class: 'spinner' }), text]);
}

export function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

const STATUS_BADGE = {
  ready: ['badge-green', '成功'],
  failed: ['badge-red', '失败'],
  processing: ['badge-yellow', '处理中'],
};
export function statusBadge(status) {
  const [cls, text] = STATUS_BADGE[status] || ['badge-gray', status];
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

export function difficultyBadge(d) {
  const map = { '简单': 'badge-green', '中等': 'badge-yellow', '困难': 'badge-red' };
  return `<span class="badge ${map[d] || 'badge-gray'}">${esc(d || '中等')}</span>`;
}

const TYPE_TEXT = { single: '单选', multi: '多选', judge: '判断', short: '简答' };
export function typeText(t) { return TYPE_TEXT[t] || t; }
export function typeBadge(t) { return `<span class="badge badge-blue">${esc(typeText(t))}</span>`; }

export function masteryBadge(m) {
  const map = { 0: ['badge-red', '未掌握'], 1: ['badge-yellow', '学习中'], 2: ['badge-green', '已掌握'] };
  const [cls, text] = map[m] || ['badge-gray', '未知'];
  return `<span class="badge ${cls}">${text}</span>`;
}

// 打开模态框（内容为 DOM 或 HTML 字符串）
export function openModal(content) {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  body.innerHTML = '';
  if (typeof content === 'string') body.innerHTML = content;
  else body.append(content);
  if (!modal.open) modal.showModal();
  return modal;
}
export function closeModal() {
  const modal = document.getElementById('modal');
  if (modal.open) modal.close();
}

// 问答答案中的引用标记 [n] 渲染为可点击的来源芯片
export function renderAnswerWithCitations(answer, sources, onSourceClick) {
  const div = el('div', { style: 'white-space:pre-wrap;word-break:break-word' });
  const parts = String(answer).split(/(\[\d{1,3}\])/g);
  for (const part of parts) {
    const m = part.match(/^\[(\d{1,3})\]$/);
    if (m) {
      const idx = parseInt(m[1], 10);
      const src = sources.find((s) => s.idx === idx);
      const chip = el('button', { class: 'src-chip', title: src ? `来源：${src.filename}` : '引用' }, `[${idx}]`);
      if (src) chip.addEventListener('click', () => onSourceClick(src));
      else chip.disabled = true;
      div.append(chip);
    } else if (part) {
      div.append(document.createTextNode(part));
    }
  }
  return div;
}

export function usageText(usage, durationMs, cached) {
  if (!usage) return '';
  const tokens = usage.unknown
    ? 'Token 用量未知（平台未返回）'
    : `Token：${usage.prompt_tokens ?? '?'} 输入 / ${usage.completion_tokens ?? '?'} 输出`;
  const secs = durationMs ? ` · 耗时 ${(durationMs / 1000).toFixed(1)}s` : '';
  const c = cached ? ' · 缓存' : '';
  return `${tokens}${secs}${c}`;
}
