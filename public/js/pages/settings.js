// 设置：模型状态与测试、用量统计、数据与隐私管理
import { api } from '../api.js';
import { el, esc, toast, loadingEl, fmtTime, openModal, closeModal } from '../ui.js';

export async function render(root, settings) {
  root.innerHTML = '';
  if (!settings) {
    try { settings = await api('/settings'); } catch (e) {
      root.append(el('p', { class: 'error-text' }, e.message));
      return;
    }
  }

  // ---- 模型服务 ----
  const aiCard = el('div', { class: 'card' });
  aiCard.append(el('h3', {}, '🤖 AI 模型服务'));

  const srcBadge = (src) => src === 'web'
    ? el('span', { class: 'badge badge-blue', title: '来自网页设置，优先于 .env' }, '网页设置')
    : el('span', { class: 'badge badge-gray', title: '来自 .env 文件或默认值' }, '.env');
  aiCard.append(el('div', { class: 'kv' }, ['接口地址：', el('code', {}, settings.ai.base_url), ' ', srcBadge(settings.ai.source.baseUrl)]));
  aiCard.append(el('div', { class: 'kv' }, ['模型：', el('b', {}, settings.ai.model), ' ', srcBadge(settings.ai.source.model)]));
  aiCard.append(el('div', { class: 'kv' }, [
    'API Key：',
    settings.ai.api_key_set
      ? el('span', { class: 'badge badge-green' }, '已配置 ' + settings.ai.api_key_masked)
      : el('span', { class: 'badge badge-red' }, '未配置'),
    ' ', srcBadge(settings.ai.source.apiKey),
  ]));
  aiCard.append(el('p', { class: 'muted' },
    '在下方修改并保存后立即生效，无需重启。Key 只保存在本机（数据库），页面永远只显示掩码（如 sk-***abcd），不会回传完整 Key。'));

  const keyInput = el('input', {
    type: 'password',
    autocomplete: 'new-key',
    placeholder: settings.ai.api_key_set
      ? '留空 = 保持现有 Key（' + settings.ai.api_key_masked + '）不变'
      : '粘贴你的 API Key（在模型平台后台获取）',
  });
  const urlInput = el('input', { value: settings.ai.base_url, spellcheck: 'false' });
  const modelInput = el('input', { value: settings.ai.model, spellcheck: 'false' });
  aiCard.append(
    el('label', { class: 'field' }, 'API Key', keyInput),
    el('label', { class: 'field' }, '接口地址（OpenAI 兼容，常见平台见 README）', urlInput),
    el('label', { class: 'field' }, '模型名称', modelInput),
  );

  const saveBtn = el('button', { class: 'btn btn-primary' }, '保存配置');
  const resetBtn = el('button', { class: 'btn' }, '恢复 .env 默认');
  const saveMsg = el('span', {});
  saveBtn.addEventListener('click', async () => {
    const body = {};
    if (keyInput.value.trim()) body.api_key = keyInput.value.trim();
    if (urlInput.value.trim() !== settings.ai.base_url) body.base_url = urlInput.value.trim();
    if (modelInput.value.trim() !== settings.ai.model) body.model = modelInput.value.trim();
    if (!Object.keys(body).length) { saveMsg.textContent = '没有修改。'; return; }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      await api('/settings/ai', { method: 'POST', body });
      toast('已保存，立即生效', 'ok');
      render(root);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存配置';
    }
  });
  resetBtn.addEventListener('click', async () => {
    if (!confirm('确定清除网页设置的三项配置，恢复为 .env / 默认值吗？')) return;
    try {
      await api('/settings/ai/reset', { method: 'POST' });
      toast('已恢复 .env 默认配置', 'ok');
      render(root);
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  aiCard.append(el('div', { class: 'row', style: 'margin-top:4px' }, [saveBtn, resetBtn, saveMsg]));

  const testBtn = el('button', { class: 'btn', style: 'margin-left:0' }, '测试模型连接');
  const testResult = el('div', { style: 'margin-top:8px' });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = '测试中…';
    testResult.innerHTML = '';
    try {
      const r = await api('/settings/test', { method: 'POST' });
      const usage = r.usage.unknown ? '（平台未返回用量）' : `（Token ${r.usage.prompt_tokens}/${r.usage.completion_tokens}）`;
      testResult.append(el('div', { class: 'answer-box' },
        `✅ 连接正常，${(r.duration_ms / 1000).toFixed(1)} 秒收到回复：「${esc(r.reply)}」 ${usage}`));
    } catch (e) {
      testResult.append(el('div', { class: 'insufficient-banner' }, '❌ ' + esc(e.message)));
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '测试模型连接';
    }
  });
  aiCard.append(el('div', { style: 'margin-top:8px' }, testBtn), testResult);
  root.append(aiCard);

  // ---- 用量统计 ----
  const usageCard = el('div', { class: 'card' });
  usageCard.append(el('h3', {}, '📊 模型用量与调用记录'));
  const usageWrap = el('div');
  usageCard.append(usageWrap);
  const cacheBtn = el('button', { class: 'btn btn-sm', style: 'margin-top:8px' }, '清空结果缓存');
  cacheBtn.addEventListener('click', async () => {
    try { await api('/settings/clear-cache', { method: 'POST' }); toast('缓存已清空', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  });
  usageCard.append(cacheBtn);
  root.append(usageCard);

  // ---- 数据与隐私 ----
  const privacyCard = el('div', { class: 'card' });
  privacyCard.append(el('h3', {}, '🔒 数据与隐私'));
  const ul = el('ul', { style: 'padding-left:20px', class: 'kv' });
  ul.append(
    el('li', {}, `所有数据（资料、题目、答题记录）保存在本机 ${settings.data_dir} 目录，不上传到任何服务器。`),
    el('li', {}, '使用问答/整理/出题/评分功能时，相关资料片段和问题会发送到你配置的模型服务商用于生成结果。'),
    el('li', {}, settings.password_enabled
      ? '已开启访问密码，打开网页需要先输入密码。'
      : '⚠️ 未设置访问密码：仅建议本机使用。若要公网/局域网部署，请在 .env 中设置 APP_PASSWORD。'),
    el('li', {}, '删除资料时会级联删除其文本片段、笔记、题目、答题记录等全部衍生数据。'),
    el('li', {}, '在网页保存的 API Key 只存入本机数据库；页面只显示掩码，任何接口都不会返回完整 Key。')
  );
  privacyCard.append(ul);

  const dangerBtn = el('button', { class: 'btn btn-danger', style: 'margin-top:8px' }, '清空全部数据');
  dangerBtn.addEventListener('click', async () => {
    const confirmText = prompt('此操作将删除全部资料、题目、笔记、答题记录，不可恢复！\n如确认，请输入 DELETE：');
    if (confirmText !== 'DELETE') return toast('已取消', 'ok');
    try {
      const r = await api('/settings/clear-data', { method: 'POST', body: { confirm: 'DELETE' } });
      toast(`已清空全部数据（删除 ${r.removed_files} 个上传文件）`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  privacyCard.append(dangerBtn);
  root.append(privacyCard);

  await loadUsage(usageWrap);
}

async function loadUsage(wrap) {
  wrap.innerHTML = '';
  wrap.append(loadingEl());
  try {
    const u = await api('/settings/usage');
    wrap.innerHTML = '';
    const t = u.total;
    const grid = el('div', { class: 'grid stats-grid', style: 'margin-bottom:12px' });
    const cells = [
      [t.calls, '总调用次数'],
      [t.errors, '失败次数'],
      [t.prompt_tokens == null ? '未知' : t.prompt_tokens.toLocaleString(), '输入 Token 合计'],
      [t.completion_tokens == null ? '未知' : t.completion_tokens.toLocaleString(), '输出 Token 合计'],
      [t.unknown_usage, '用量未知的调用'],
      [t.avg_duration_ms == null ? '—' : (t.avg_duration_ms / 1000).toFixed(1) + 's', '平均耗时'],
    ];
    for (const [num, label] of cells) {
      grid.append(el('div', { class: 'stat' }, [el('div', { class: 'num', style: 'font-size:20px' }, String(num)), el('div', { class: 'label' }, label)]));
    }
    wrap.append(grid);
    if (t.unknown_usage > 0) wrap.append(el('p', { class: 'muted' }, t.note));

    if (u.recent.length) {
      const table = el('table', { class: 'table' });
      table.append(el('thead', {}, el('tr', {}, [
        el('th', {}, '类型'), el('th', {}, '状态'), el('th', {}, 'Token（入/出）'), el('th', {}, '耗时'), el('th', {}, '时间'), el('th', {}, '错误信息'),
      ])));
      const tbody = el('tbody');
      for (const r of u.recent) {
        const kindText = { qa: '问答', note: '整理', quiz: '出题', grade: '评分', test: '测试' }[r.kind] || r.kind;
        tbody.append(el('tr', {}, [
          el('td', {}, kindText),
          el('td', {}, r.status === 'ok'
            ? el('span', { class: 'badge badge-green' }, '成功')
            : el('span', { class: 'badge badge-red' }, '失败')),
          el('td', {}, (r.prompt_tokens ?? '?') + ' / ' + (r.completion_tokens ?? '?')),
          el('td', {}, r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + 's' : '—'),
          el('td', {}, fmtTime(r.created_at)),
          el('td', { style: 'max-width:260px;word-break:break-all', class: 'muted' }, r.error || ''),
        ]));
      }
      table.append(tbody);
      wrap.append(table);
    } else {
      wrap.append(el('p', { class: 'muted' }, '还没有调用记录。使用问答、整理、出题功能后这里会显示真实用量。'));
    }
  } catch (e) {
    wrap.innerHTML = '';
    wrap.append(el('p', { class: 'error-text' }, e.message));
  }
}
