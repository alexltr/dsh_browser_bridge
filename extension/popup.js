/** DSH 实时浏览器桥 —— 弹窗逻辑。 */

const $ = (id) => document.getElementById(id);
let latest = null;

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/** 统一处理 {state} / 裸 state 两种返回。 */
function apply(result) {
  if (!result) return;
  const state = result.state || result;
  if (typeof state.connected === 'boolean') render(state);
  if (result.ok === false && result.error) showError(result.error);
}

function showError(text) {
  const box = $('error');
  if (!text) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.textContent = text;
  box.classList.remove('hidden');
}

function render(state) {
  latest = state;
  $('version').textContent = 'v' + (state.version || '0.1.0');

  const status = $('status');
  const connected = Boolean(state.connected);
  status.textContent = connected ? '已连接' : '未连接';
  status.className = 'pill ' + (connected ? 'pill-on' : 'pill-off');
  $('subtitle').textContent = connected
    ? `已连接 DSH · ${state.port} · ${state.browser || 'Chromium'}`
    : `正在重试 127.0.0.1:${state.port}…`;

  showError(state.lastError && !connected ? state.lastError : (state.lastError || ''));

  // 当前标签页
  const tab = state.currentTab;
  const toggle = $('toggleGrant');
  if (!tab) {
    $('currentTitle').textContent = '没有活动标签页';
    $('currentUrl').textContent = '—';
    toggle.disabled = true;
    toggle.textContent = '授权当前标签页';
  } else {
    $('currentTitle').textContent = tab.title || '（无标题）';
    $('currentUrl').textContent = tab.url || '—';
    const supported = tab.supported !== false;
    toggle.disabled = !supported && !tab.granted;
    if (!supported) toggle.textContent = '此页面不支持（仅限 http/https）';
    else toggle.textContent = tab.granted ? '取消授权，DSH 停止访问此页' : '授权当前标签页';
    toggle.classList.toggle('primary', !tab.granted);
    toggle.classList.toggle('ghost', Boolean(tab.granted));
  }

  // 已授权列表
  const list = $('grantList');
  list.textContent = '';
  const grants = Array.isArray(state.grants) ? state.grants : [];
  $('grantCount').textContent = String(grants.length);
  $('grantEmpty').classList.toggle('hidden', grants.length > 0);
  for (const grant of grants) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot' + (grant.attached ? '' : ' off');
    dot.title = grant.attached ? '调试会话已连接' : '调试会话已断开';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'g-title';
    title.textContent = grant.title || `标签页 ${grant.tabId}`;
    const url = document.createElement('div');
    url.className = 'g-url';
    url.textContent = `${shortUrl(grant.url)} · 请求 ${grant.networkCount || 0} · 日志 ${grant.consoleCount || 0}`;
    meta.append(title, url);

    const focus = document.createElement('button');
    focus.className = 'mini';
    focus.textContent = '切换';
    focus.addEventListener('click', () => {
      void chrome.tabs.update(grant.tabId, { active: true }).then(() => window.close()).catch(() => {});
    });

    const revoke = document.createElement('button');
    revoke.className = 'danger';
    revoke.textContent = '取消授权';
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      apply(await send({ type: 'revoke', tabId: grant.tabId }));
      void refresh();
    });

    li.append(dot, meta, focus, revoke);
    list.append(li);
  }

  $('port').value = String(state.port || 51919);
  $('token').value = state.tokenSet ? '••••••' : '';
  $('token').placeholder = state.tokenSet ? '已设置（重填可覆盖）' : '留空表示不校验';
}

function shortUrl(url) {
  if (!url) return '—';
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return String(url).slice(0, 60);
  }
}

async function refresh() {
  apply(await send({ type: 'state' }));
}

$('toggleGrant').addEventListener('click', async () => {
  if (!latest || !latest.currentTab) return;
  const tab = latest.currentTab;
  const button = $('toggleGrant');
  button.disabled = true;
  apply(await send({ type: tab.granted ? 'revoke' : 'grant', tabId: tab.tabId }));
  button.disabled = false;
  void refresh();
});

$('save').addEventListener('click', async () => {
  const port = Number($('port').value) || 51919;
  const token = $('token').value.trim();
  const message = { type: 'reconnect', port };
  if (token && token !== '••••••') message.token = token;
  const result = await send(message);
  apply(result);
  if (result && result.ok) {
    const details = $('advanced');
    details.open = false;
  }
  void refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'state-changed') apply(message.state);
});

void refresh();
const timer = setInterval(() => void refresh(), 1500);
window.addEventListener('unload', () => clearInterval(timer));
