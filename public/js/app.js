// 前端路由：hash 路由 + 登录门 + 导航
import { api, getToken, clearToken } from './api.js';
import { el, toast } from './ui.js';
import * as dashboard from './pages/dashboard.js';
import * as materials from './pages/materials.js';
import * as chat from './pages/chat.js';
import * as notes from './pages/notes.js';
import * as quiz from './pages/quiz.js';
import * as mistakes from './pages/mistakes.js';
import * as review from './pages/review.js';
import * as settings from './pages/settings.js';

const ROUTES = [
  { path: '', title: '仪表盘', icon: '📊', page: dashboard },
  { path: 'materials', title: '学习资料库', icon: '📚', page: materials },
  { path: 'chat', title: '资料问答', icon: '💬', page: chat },
  { path: 'notes', title: '知识点笔记', icon: '🧠', page: notes },
  { path: 'quiz', title: '练习题库', icon: '✍️', page: quiz },
  { path: 'mistakes', title: '错题本', icon: '📕', page: mistakes },
  { path: 'review', title: '复习计划', icon: '🗓️', page: review },
  { path: 'settings', title: '设置', icon: '⚙️', page: settings },
];

let appSettings = null;

function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  return ROUTES.find((r) => r.path === h) || ROUTES[0];
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const r of ROUTES) {
    const active = currentRoute().path === r.path;
    nav.append(el('a', { class: 'nav-item' + (active ? ' active' : ''), href: '#/' + r.path },
      [el('span', { class: 'icon' }, r.icon), r.title]));
  }
  const footer = document.getElementById('nav-footer');
  footer.innerHTML = appSettings
    ? `v${appSettings.version}<br>模型：${appSettings.ai.api_key_set ? esc2(appSettings.ai.model) : '<span style="color:var(--yellow)">未配置</span>'}`
    : '';
}
function esc2(s) { return String(s ?? '').replace(/</g, '&lt;'); }

async function render() {
  const route = currentRoute();
  document.getElementById('page-title').textContent = route.title;
  renderNav();
  const root = document.getElementById('page');
  root.innerHTML = '';
  root.append(el('div', { class: 'loading' }, [el('span', { class: 'spinner' }), '加载中…']));
  try {
    await route.page.render(root, appSettings);
  } catch (e) {
    root.innerHTML = '';
    root.append(el('div', { class: 'card' },
      [el('p', { class: 'error-text' }, '页面加载失败：' + e.message)]));
  }
  // 移动端点击导航后收起侧栏
  document.getElementById('sidebar').classList.remove('open');
  window.scrollTo(0, 0);
}

async function checkAuth() {
  try {
    appSettings = await api('/auth/state').then(async (s) => {
      if (!s.passwordEnabled) return null;
      return s;
    });
  } catch { /* 忽略 */ }

  // 密码模式下检查登录状态
  try {
    const state = await fetch('/api/auth/state', {
      headers: getToken() ? { Authorization: 'Bearer ' + getToken() } : {},
    }).then((r) => r.json());
    if (state.passwordEnabled && !state.authed) {
      showLogin();
      return false;
    }
  } catch { /* 服务器未就绪时忽略 */ }
  return true;
}

function showLogin() {
  const mask = document.getElementById('login-mask');
  mask.classList.remove('hidden');
  const form = document.getElementById('login-form');
  const errEl = document.getElementById('login-error');
  form.onsubmit = async (e) => {
    e.preventDefault();
    errEl.classList.add('hidden');
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    try {
      const r = await api('/auth/login', { method: 'POST', body: { password: document.getElementById('login-password').value } });
      if (r.token) setTokenLocal(r.token);
      mask.classList.add('hidden');
      toast('已进入', 'ok');
      boot();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  };
}
function setTokenLocal(t) { localStorage.setItem('study_coach_token', t); }

window.addEventListener('need-login', () => showLogin());
window.addEventListener('hashchange', render);
document.getElementById('nav-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

async function boot() {
  try {
    appSettings = await api('/settings');
  } catch { appSettings = null; }
  render();
}

(async function init() {
  const ok = await checkAuth();
  if (ok) boot();
})();
