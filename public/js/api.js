// API 请求封装：自动携带访问令牌，401 时回到登录页
const TOKEN_KEY = 'study_coach_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, { method, headers, body: payload });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('need-login'));
    throw new Error('需要访问密码，请先登录。');
  }
  let data = null;
  try { data = await res.json(); } catch { /* 非_JSON 响应 */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}
