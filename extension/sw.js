/**
 * DSH 实时浏览器桥 —— background service worker。
 *
 * 职责：
 *  1. 通过本地 WebSocket 连接 DSH Host 插件（127.0.0.1:51919），保持重连；
 *  2. 接收 Host 的 RPC（tab.eval / tab.query / tab.network / ...），
 *     用 chrome.debugger（CDP）在「用户已授权」的标签页里执行；
 *  3. 持续捕获已授权标签页的网络请求与控制台日志，供 Host 随取随用；
 *  4. 向 popup 提供连接状态与授权管理。
 *
 * 安全模型：只有用户在扩展弹窗里显式授权的标签页才会被附加调试器；
 * 授权状态存 chrome.storage.session（浏览器重启即失效）。
 */
const PROTOCOL = 1;
const VERSION = '0.2.0';
const DEFAULT_PORT = 51919;
const BODY_MAX_CHARS = 20_000;
const NET_MAX_ENTRIES = 1_000;
const CON_MAX_ENTRIES = 800;
const MAX_BODY_BYTES = 3_000_000;
const WS_FRAME_MAX_CHARS = 4_000;
const WS_FRAMES_PER_SOCKET = 200;
const WS_MAX_SOCKETS = 30;
const RECORD_BINDING = '__dshRecordEvent';

/** 已授权标签页：tabId -> grant。 */
const grants = new Map();

/** 连接与配置状态。 */
const state = {
  ws: null,
  open: false,
  handshaken: false,
  connecting: false,
  lastError: '',
  port: DEFAULT_PORT,
  token: '',
  clientId: '',
  defaultTabId: null,
  retryDelay: 500,
  retryTimer: null,
  targetDebug: [],
  pingTimer: null,
  lastSeenAt: 0,
};

// ---------------------------------------------------------------------------
// 初始化与连接
// ---------------------------------------------------------------------------

const ready = init();

async function init() {
  const stored = await chrome.storage.local.get({ bridgePort: DEFAULT_PORT, bridgeToken: '', clientId: '' });
  state.port = Number(stored.bridgePort) || DEFAULT_PORT;
  state.token = String(stored.bridgeToken || '');
  if (!stored.clientId) {
    state.clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId: state.clientId });
  } else {
    state.clientId = String(stored.clientId);
  }
  await restoreGrants();
  chrome.alarms.create('dsh-bridge-keepalive', { periodInMinutes: 0.5 });
  connect();
}

async function restoreGrants() {
  let saved = {};
  try {
    const s = await chrome.storage.session.get({ grants: {} });
    saved = s.grants || {};
  } catch {
    saved = {};
  }
  const ids = Object.keys(saved).map(Number).filter((n) => Number.isFinite(n));
  for (const tabId of ids) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) continue;
    grants.set(tabId, { tabId, attached: false, buffer: newBuffer(), mainFrameId: null, url: tab.url, title: tab.title });
  }
  // 重新附加调试器（SW 被回收后 socket 与 debugger 都会断，需要恢复）。
  for (const grant of grants.values()) {
    try {
      await attachDebugger(grant);
    } catch (err) {
      grants.delete(grant.tabId);
      state.lastError = `恢复标签页 ${grant.tabId} 失败：${errorText(err)}`;
    }
  }
  state.defaultTabId = [...grants.keys()][0] ?? null;
  await persistGrants();
}

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  state.connecting = true;
  const query = new URLSearchParams({ v: String(PROTOCOL), client: state.clientId });
  if (state.token) query.set('token', state.token);
  const url = `ws://127.0.0.1:${state.port}/bridge?${query.toString()}`;
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    state.connecting = false;
    state.lastError = errorText(err);
    scheduleReconnect();
    return;
  }
  state.ws = socket;
  socket.addEventListener('open', () => {
    if (state.ws !== socket) return;
    state.open = true;
    state.connecting = false;
    state.retryDelay = 500;
    state.lastError = '';
    send({
      type: 'hello',
      protocol: PROTOCOL,
      client: { id: state.clientId, name: browserName(), version: VERSION, platform: navigator.platform || '' },
      capabilities: ['debugger', 'eval', 'query', 'network', 'console', 'click', 'type', 'frames', 'websocket', 'record'],
    });
    startPing();
    broadcastState();
  });
  socket.addEventListener('message', (event) => {
    if (state.ws !== socket) return;
    state.lastSeenAt = Date.now();
    void onMessage(event.data);
  });
  socket.addEventListener('close', () => {
    // 旧连接的 close 事件可能晚于重连，不能覆盖新连接的状态。
    if (state.ws !== socket) return;
    const wasOpen = state.open;
    state.open = false;
    state.handshaken = false;
    state.ws = null;
    stopPing();
    if (wasOpen) state.lastError = '与 DSH 的连接已断开，正在重连…';
    broadcastState();
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    if (state.ws !== socket) return;
    state.lastError = `无法连接 DSH（127.0.0.1:${state.port}）。请确认 DSH 正在运行，且已安装 dsh-browser-bridge 插件。`;
    broadcastState();
  });
}

function scheduleReconnect() {
  if (state.retryTimer) return;
  const delay = state.retryDelay;
  state.retryDelay = Math.min(10_000, Math.round(state.retryDelay * 1.7));
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    connect();
  }, delay);
}

function startPing() {
  stopPing();
  state.pingTimer = setInterval(() => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    // 超过 45s 没有任何入站消息视为死连接（半开 TCP）。
    if (state.lastSeenAt && Date.now() - state.lastSeenAt > 45_000) {
      try { state.ws.close(); } catch { /* ignore */ }
      return;
    }
    send({ type: 'ping', at: Date.now() });
  }, 20_000);
}

function stopPing() {
  if (state.pingTimer) clearInterval(state.pingTimer);
  state.pingTimer = null;
}

function send(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  try {
    state.ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function sendEvent(event, data) {
  send({ type: 'event', event, data });
}

async function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'welcome':
      state.handshaken = true;
      state.lastError = '';
      broadcastState();
      break;
    case 'request':
      await handleRequest(msg);
      break;
    case 'ping':
      send({ type: 'pong', at: Date.now() });
      break;
    case 'error':
      state.lastError = String(msg.message || 'Host 返回错误');
      broadcastState();
      break;
    default:
      break;
  }
}

async function handleRequest(msg) {
  const id = msg.id;
  const method = String(msg.method || '');
  try {
    const handler = HANDLERS[method];
    if (!handler) throw new Error(`未知方法：${method}`);
    const result = await handler(msg.params || {});
    send({ type: 'reply', id, ok: true, result });
  } catch (err) {
    send({ type: 'reply', id, ok: false, error: { message: errorText(err), code: err && err.code ? String(err.code) : undefined } });
  }
}

// ---------------------------------------------------------------------------
// RPC 处理器
// ---------------------------------------------------------------------------

const HANDLERS = {
  'bridge.status': async () => ({
    connected: true,
    version: VERSION,
    port: state.port,
    browser: browserName(),
    defaultTabId: state.defaultTabId,
    grants: [...grants.values()].map((g) => ({ tabId: g.tabId, attached: g.attached, url: g.url, title: g.title })),
  }),

  'tabs.list': async () => {
    const tabs = await chrome.tabs.query({});
    const list = tabs
      .filter((t) => t.id != null && /^https?:|^file:/.test(t.url || ''))
      .map((t) => ({
        tabId: t.id,
        windowId: t.windowId,
        active: Boolean(t.active),
        title: t.title || '',
        url: t.url || '',
        status: t.status || '',
        granted: grants.has(t.id),
        attached: Boolean(grants.get(t.id)?.attached),
      }))
      .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.granted) - Number(a.granted) || a.tabId - b.tabId);
    return { tabs: list, defaultTabId: state.defaultTabId };
  },

  'tab.grant': async (p) => {
    const tabId = Number(p.tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(`标签页 ${tabId} 不存在`);
    if (p.grant === false) {
      await revokeTab(tabId);
      return { tabId, granted: false };
    }
    const existing = grants.get(tabId);
    if (existing && existing.attached) {
      state.defaultTabId = tabId;
      return { tabId, granted: true, title: existing.title, url: existing.url };
    }
    const grant = existing || { tabId, attached: false, buffer: newBuffer(), mainFrameId: null };
    grant.url = tab.url;
    grant.title = tab.title;
    grants.set(tabId, grant);
    await attachDebugger(grant);
    state.defaultTabId = tabId;
    await persistGrants();
    broadcastState();
    return { tabId, granted: true, title: tab.title, url: tab.url };
  },

  'tab.activate': async (p) => {
    const tabId = resolveTabId(p);
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    state.defaultTabId = tabId;
    return { tabId, url: tab?.url || '', title: tab?.title || '' };
  },

  'tab.navigate': async (p) => {
    const tabId = resolveTabId(p);
    requireGrant(tabId);
    const url = String(p.url || '');
    if (!/^https?:|^file:/.test(url)) throw new Error('url 必须是 http(s) 或 file 地址');
    await chrome.tabs.update(tabId, { url });
    await waitForLoad(tabId, Number(p.timeoutMs) || 30_000);
    return tabSummary(tabId);
  },

  'tab.reload': async (p) => {
    const tabId = resolveTabId(p);
    requireGrant(tabId);
    await chrome.tabs.reload(tabId, { bypassCache: Boolean(p.ignoreCache) });
    await waitForLoad(tabId, Number(p.timeoutMs) || 30_000);
    return tabSummary(tabId);
  },

  'tab.eval': async (p) => {
    const tabId = resolveTabId(p);
    const grant = requireGrant(tabId);
    const expression = String(p.expression ?? '');
    if (!expression.trim()) throw new Error('expression 不能为空');
    const timeoutMs = clamp(Number(p.timeoutMs) || 15_000, 1_000, 120_000);
    const maxChars = clamp(Number(p.maxChars) || BODY_MAX_CHARS, 1_000, 200_000);
    const frame = resolveFrame(grant.buffer, p.frame, grant.mainFrameId);
    let response;
    try {
      response = await evaluateInFrame(grant, frame, expression, {
        awaitPromise: p.awaitPromise !== false,
        returnByValue: true,
        timeoutMs,
      });
    } catch (err) {
      throw new Error(`页面执行失败：${errorText(err)}`);
    }
    const out = { tabId, url: grant.url || '', exception: '', truncated: false, value: '', type: '', at: Date.now() };
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      out.exception = String(details.exception?.description || details.text || '未知异常');
      out.type = 'exception';
      return out;
    }
    const remote = response.result || {};
    out.type = remote.type || 'undefined';
    let value;
    if (remote.type === 'undefined') value = 'undefined';
    else if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
      value = typeof remote.value === 'string' ? remote.value : safeJson(remote.value);
      if (value === undefined) value = String(remote.value);
    } else {
      value = remote.description || remote.unserializableValue || remote.type;
    }
    if (value.length > maxChars) {
      out.truncated = true;
      value = `${value.slice(0, maxChars)}\n…（已截断，共 ${value.length} 字符）`;
    }
    out.value = value;
    // 页面地址可能因 SPA 路由变化，回读一次。
    const href = await evaluateInFrame(grant, frame, 'location.href', { timeoutMs: 3_000 })
      .then((r) => (r?.result?.value ? String(r.result.value) : '')).catch(() => '');
    if (href) {
      if (frame.frameId === grant.mainFrameId) grant.url = href;
      out.url = href;
    }
    return out;
  },

  'tab.query': async (p) => {
    const tabId = resolveTabId(p);
    const grant = requireGrant(tabId);
    const selector = String(p.selector || '').trim();
    if (!selector) throw new Error('selector 不能为空');
    const mode = String(p.mode || 'text');
    const args = {
      selector,
      mode,
      attr: p.attr ? String(p.attr) : '',
      limit: clamp(Number(p.limit) || 5, 1, 200),
      pierce: Boolean(p.pierce),
      collapse: p.collapse !== false,
      maxChars: clamp(Number(p.maxChars) || 4_000, 100, 20_000),
    };
    const frame = resolveFrame(grant.buffer, p.frame, grant.mainFrameId);
    const response = await evaluateInFrame(grant, frame, buildQueryExpression(args), {
      returnByValue: true,
      awaitPromise: false,
      timeoutMs: 15_000,
    });
    if (response.exceptionDetails) {
      throw new Error(`查询失败：${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`);
    }
    const value = response.result?.value || {};
    if (value.error) throw new Error(`选择器执行失败：${value.error}`);
    if (value.url && frame.frameId === grant.mainFrameId) grant.url = value.url;
    return {
      tabId,
      url: value.url || frame.url || grant.url || '',
      title: value.title || grant.title || '',
      matched: Number(value.matched) || 0,
      items: Array.isArray(value.items) ? value.items : [],
      truncated: Boolean(value.truncated) || (Number(value.matched) || 0) > args.limit,
    };
  },

  'tab.click': async (p) => {
    const tabId = resolveTabId(p);
    const grant = requireGrant(tabId);
    const selector = String(p.selector || '').trim();
    if (!selector) throw new Error('selector 不能为空');
    const index = clamp(Number(p.index) || 0, 0, 500);
    const frame = resolveFrame(grant.buffer, p.frame, grant.mainFrameId);
    const hit = await locateElement(grant, frame, selector, index);
    if (!hit.found) throw new Error(`未找到可点击元素：${selector}（第 ${index + 1} 个）`);
    if (!hit.visible) throw new Error(`元素存在但不可见（尺寸 ${Math.round(hit.w)}x${Math.round(hit.h)}）：${selector}`);
    const offset = await frameOffset(grant, frame);
    const x = hit.x + offset.x;
    const y = hit.y + offset.y;
    const button = ['left', 'right', 'middle'].includes(String(p.button)) ? String(p.button) : 'left';
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
    if (p.waitMs) await sleep(clamp(Number(p.waitMs), 0, 10_000));
    return { tabId, clicked: true, x: Math.round(x), y: Math.round(y), tag: hit.tag, text: hit.text, url: grant.url || '' };
  },

  'tab.type': async (p) => {
    const tabId = resolveTabId(p);
    const grant = requireGrant(tabId);
    const text = String(p.text ?? '');
    const mode = ['fill', 'insert', 'keys'].includes(String(p.mode)) ? String(p.mode) : 'fill';
    const selector = p.selector ? String(p.selector) : '';
    const clear = p.clear !== false;
    const frame = resolveFrame(grant.buffer, p.frame, grant.mainFrameId);
    if (mode === 'fill') {
      if (!selector) throw new Error('mode=fill 需要同时提供 selector（要写入的输入框）');
      const filled = await fillElement(grant, frame, selector, text, clear);
      if (!filled) throw new Error(`无法向元素写入文本：${selector}`);
    } else if (mode === 'insert') {
      if (selector) {
        const focus = await focusElement(grant, frame, selector, clear);
        if (!focus.found) throw new Error(`未找到输入元素：${selector}`);
      }
      if (text) await cdp(tabId, 'Input.insertText', { text });
    } else {
      if (selector) {
        const focus = await focusElement(grant, frame, selector, clear);
        if (!focus.found) throw new Error(`未找到输入元素：${selector}`);
      }
      for (const char of text) {
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: char });
      }
    }
    if (p.pressEnter) {
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    if (p.waitMs) await sleep(clamp(Number(p.waitMs), 0, 10_000));
    return { tabId, typed: true, mode, chars: text.length };
  },

  'tab.frames': async (p) => {
    const tabId = resolveTabId(p);
    const grant = requireGrant(tabId);
    await refreshOopifTargets(grant);
    const buffer = grant.buffer;
    if (grant.mainFrameId && !buffer.frames.has(grant.mainFrameId)) {
      upsertFrame(buffer, { frameId: grant.mainFrameId, parentId: null, url: grant.url || '', name: grant.title || '', depth: 0 });
    }
    const frames = [...buffer.frames.values()].sort((a, b) => (a.depth || 0) - (b.depth || 0));
    const items = [];
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      let title = '';
      try {
        const evaluated = await evaluateInFrame(grant, frame, 'document.title', { timeoutMs: 3_000 });
        title = String(evaluated?.result?.value ?? '');
      } catch {
        title = '';
      }
      items.push({
        index,
        frameId: frame.frameId,
        parentId: frame.parentId || '',
        url: frame.url || '',
        name: frame.name || '',
        depth: frame.depth || 0,
        crossProcess: Boolean(frame.crossProcess),
        hasContext: Boolean(frame.sessionId || frame.frameId === grant.mainFrameId || buffer.contexts.has(frame.frameId)),
        title,
      });
    }
    return { tabId, url: grant.url || '', frames: items };
  },

  'tab.socket': async (p) => {
    const tabId = resolveTabId(p);
    const grant = requireGrant(tabId);
    const buffer = grant.buffer;
    if (p.action === 'clear') {
      buffer.sockets.clear();
      return { tabId, sockets: [], totalFrames: 0, nextSeq: 0 };
    }
    const urlContains = p.urlContains ? String(p.urlContains).toLowerCase() : '';
    const direction = p.direction === 'sent' || p.direction === 'received' ? p.direction : '';
    const textContains = p.textContains ? String(p.textContains).toLowerCase() : '';
    const afterSeq = p.afterSeq != null && p.afterSeq !== '' ? Number(p.afterSeq) : null;
    const matchFrame = (frame) => {
      if (direction && frame.direction !== direction) return false;
      if (textContains && !frame.text.toLowerCase().includes(textContains)) return false;
      if (afterSeq != null && frame.seq <= afterSeq) return false;
      return true;
    };
    const pickSockets = () => [...buffer.sockets.values()]
      .filter((socket) => !urlContains || String(socket.url).toLowerCase().includes(urlContains))
      .sort((a, b) => a.seq - b.seq);
    if (p.action === 'wait') {
      const timeoutMs = clamp(Number(p.waitTimeoutMs) || 15_000, 300, 120_000);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pickSockets().some((socket) => socket.frames.some(matchFrame))) break;
        await sleep(120);
        if (!grants.has(tabId)) throw new Error('标签页授权已取消');
      }
    }
    const limit = clamp(Number(p.limit) || 20, 1, 100);
    const sockets = pickSockets().slice(-5).map((socket) => ({
      seq: socket.seq,
      url: socket.url,
      status: socket.status,
      openedAt: socket.openedAt,
      closedAt: socket.closedAt,
      sent: socket.sent,
      received: socket.received,
      lastError: socket.lastError,
      frames: socket.frames.filter(matchFrame).slice(-limit).map((frame) => ({
        seq: frame.seq,
        at: frame.at,
        direction: frame.direction,
        opcode: frame.opcode,
        size: frame.size,
        text: frame.text,
        truncated: frame.truncated,
      })),
    }));
    return {
      tabId,
      sockets,
      totalFrames: [...buffer.sockets.values()].reduce((sum, socket) => sum + socket.frames.length, 0),
      nextSeq: buffer.socketSeq,
    };
  },

  'tab.record': async (p) => {
    const tabId = resolveTabId(p);
    const grant = requireGrant(tabId);
    const action = String(p.action || 'status');
    if (action === 'start') {
      const started = await startRecording(grant);
      return { active: true, startedAt: started.startedAt, stoppedAt: 0, actions: [], requests: [], sockets: [], install: started.install };
    }
    if (action === 'cancel') {
      const recording = grant.buffer.recording;
      grant.buffer.recording = null;
      await cdp(tabId, 'Runtime.removeBinding', { name: RECORD_BINDING }).catch(() => {});
      return { active: false, startedAt: recording?.startedAt || 0, stoppedAt: Date.now(), actions: [], requests: [], sockets: [], canceled: true };
    }
    if (action === 'stop') {
      const result = await stopRecording(grant);
      return { active: false, ...result };
    }
    const recording = grant.buffer.recording;
    return {
      active: Boolean(recording),
      startedAt: recording?.startedAt || 0,
      stoppedAt: 0,
      actions: recording?.actions || [],
      requests: [],
      sockets: [],
    };
  },

  'tab.network': async (p) => {
    const tabId = resolveTabId(p);
    const grant = requireGrant(tabId);
    const buffer = grant.buffer;
    if (p.action === 'clear') {
      buffer.net.length = 0;
      buffer.byRequest.clear();
      return { tabId, cleared: true, entries: [], total: 0, nextSeq: buffer.netSeq, captureStartedAt: buffer.startedAt };
    }
    const filter = {
      urlContains: p.urlContains ? String(p.urlContains) : '',
      method: p.method ? String(p.method).toUpperCase() : '',
      type: p.type ? String(p.type).toLowerCase() : '',
      status: p.status != null && p.status !== '' ? Number(p.status) : null,
      afterSeq: p.afterSeq != null && p.afterSeq !== '' ? Number(p.afterSeq) : null,
    };
    if (p.action === 'wait') {
      const timeoutMs = clamp(Number(p.waitTimeoutMs) || 15_000, 500, 120_000);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (buffer.net.some((e) => matchNetworkEntry(e, filter))) break;
        await sleep(150);
        if (!grants.has(tabId)) throw new Error('标签页授权已取消');
      }
    }
    // 等待仍在抓取的响应体完成（最多 1.2s），避免刚点完按钮读不到 body。
    if (buffer.pendingBodies > 0) {
      const deadline = Date.now() + 1_200;
      while (buffer.pendingBodies > 0 && Date.now() < deadline) await sleep(80);
    }
    const matched = buffer.net.filter((e) => matchNetworkEntry(e, filter));
    const limit = clamp(Number(p.limit) || 20, 1, 200);
    const picked = matched.slice(-limit);
    const entries = picked.map((e) => ({
      seq: e.seq,
      type: e.type,
      method: e.method,
      url: e.url,
      status: e.status,
      statusText: e.statusText,
      mimeType: e.mimeType,
      failed: e.failed,
      errorText: e.errorText,
      durationMs: e.durationMs,
      startedAt: e.startedAt,
      requestHeaders: p.withHeaders === false ? {} : e.requestHeaders,
      requestBody: p.withBody === false ? '' : e.requestBody,
      responseHeaders: p.withHeaders === false ? {} : e.responseHeaders || {},
      body: p.withBody === false ? '' : e.body,
      bodyTruncated: e.bodyTruncated,
      bodyOmitted: e.bodyOmitted,
    }));
    let existing = [];
    if (!matched.length && p.includeExisting !== false) {
      existing = await readPerformanceResources(tabId, limit).catch(() => []);
    }
    return {
      tabId,
      url: grant.url || '',
      total: matched.length,
      ignored: buffer.net.length - matched.length,
      entries,
      existing,
      nextSeq: buffer.netSeq,
      captureStartedAt: buffer.startedAt,
      note: matched.length ? '' : '尚未捕获到匹配请求；若页面在授权前已加载，请先 page_tabs reload 再操作，或查看 existing（仅 URL/耗时，无请求头与响应体）。',
    };
  },

  'tab.console': async (p) => {
    const tabId = resolveTabId(p);
    const grant = requireGrant(tabId);
    const buffer = grant.buffer;
    if (p.action === 'clear') {
      buffer.con.length = 0;
      return { tabId, cleared: true, entries: [], nextSeq: buffer.conSeq, captureStartedAt: buffer.startedAt };
    }
    const level = p.level ? String(p.level).toLowerCase() : '';
    const textContains = p.textContains ? String(p.textContains).toLowerCase() : '';
    const afterSeq = p.afterSeq != null && p.afterSeq !== '' ? Number(p.afterSeq) : null;
    let list = buffer.con.filter((e) => {
      if (level && level !== 'all' && !levelMatches(e.level, level)) return false;
      if (textContains && !e.text.toLowerCase().includes(textContains)) return false;
      if (afterSeq != null && e.seq <= afterSeq) return false;
      return true;
    });
    const limit = clamp(Number(p.limit) || 50, 1, 400);
    list = list.slice(-limit);
    return {
      tabId,
      url: grant.url || '',
      entries: list,
      total: list.length,
      nextSeq: buffer.conSeq,
      captureStartedAt: buffer.startedAt,
    };
  },
};

// ---------------------------------------------------------------------------
// 调试器 / 捕获
// ---------------------------------------------------------------------------

async function attachDebugger(grant) {
  const tabId = grant.tabId;
  if (grant.attached) return grant;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    // 已经在调试（重复调用）时忽略。
    if (!/already attached/i.test(errorText(err))) {
      throw new Error(`无法在标签页上启用调试协议：${errorText(err)}。若该标签页打开了 DevTools，请先关闭后重试。`);
    }
  }
  grant.attached = true;
  grant.buffer = newBuffer();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) {
    grant.url = tab.url || grant.url;
    grant.title = tab.title || grant.title;
  }
  try {
    const tree = await cdp(tabId, 'Page.getFrameTree');
    grant.mainFrameId = tree?.frameTree?.frame?.id || null;
    if (tree?.frameTree) seedFrameTree(grant.buffer, tree.frameTree);
  } catch {
    grant.mainFrameId = null;
  }
  await Promise.all([
    cdp(tabId, 'Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 5_000_000, maxPostDataSize: 1_000_000 }).catch(() => {}),
    cdp(tabId, 'Runtime.enable').catch(() => {}),
    cdp(tabId, 'Log.enable').catch(() => {}),
    cdp(tabId, 'Page.enable').catch(() => {}),
  ]);
  // 跨进程 iframe（OOPIF）：非 flatten 的自动附加，配合 Target.sendMessageToTarget。
  await armAutoAttach(grant);
  return grant;
}

/** 每次主框架导航后都要重新武装：auto-attach 关系会随导航失效。 */
async function armAutoAttach(grant) {
  try {
    await cdp(grant.tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
    state.targetDebug.push('setAutoAttach ok');
    if (state.targetDebug.length > 60) state.targetDebug.shift();
  } catch (err) {
    state.targetDebug.push('setAutoAttach err: ' + errorText(err));
    if (state.targetDebug.length > 60) state.targetDebug.shift();
  }
}

function registerOopif(grant, sessionId, info) {
  const buffer = grant.buffer;
  state.targetDebug.push('oopif ' + String(info.url || '').slice(0, 80));
  if (state.targetDebug.length > 60) state.targetDebug.shift();
  const frameId = info.targetId || `oopif:${sessionId}`;
  const existing = buffer.frames.get(frameId);
  if (existing?.sessionId && buffer.oopif.has(existing.sessionId)) return;
  const parent = info.parentFrameId ? buffer.frames.get(info.parentFrameId) : null;
  upsertFrame(buffer, {
    frameId,
    parentId: info.parentFrameId || null,
    url: info.url || '',
    name: '',
    depth: parent ? parent.depth + 1 : 1,
    crossProcess: true,
    sessionId,
  });
  buffer.oopif.set(sessionId, { frameId, url: info.url || '', pending: new Map() });
  void (async () => {
    await sendToChild(grant, sessionId, 'Runtime.enable', {}, 5_000).catch(() => {});
    await sendToChild(grant, sessionId, 'Log.enable', {}, 5_000).catch(() => {});
  })();
}

/**
 * chrome.debugger 下 Target.getTargets 会返回 "Not allowed"，但
 * chrome.debugger.getTargets() 能看到跨进程 iframe（type=other、无 tabId）。
 * auto-attach 只覆盖调用时已存在的 target，所以这里用公开 API 兜底枚举 + 手工附加。
 */
async function refreshOopifTargets(grant) {
  const buffer = grant.buffer;
  let targets = [];
  try {
    targets = await chrome.debugger.getTargets();
  } catch {
    return 0;
  }
  let added = 0;
  for (const info of targets) {
    const url = String(info.url || '');
    if (!/^https?:/i.test(url)) continue;
    if (info.tabId != null) continue; // 顶层页面/标签，不是 iframe
    if (buffer.frames.has(info.id) && buffer.frames.get(info.id)?.sessionId) continue;
    if ([...buffer.oopif.values()].some((session) => session.frameId === info.id)) continue;
    let sessionId = null;
    try {
      const attached = await cdp(grant.tabId, 'Target.attachToTarget', { targetId: info.id, flatten: false });
      sessionId = attached?.sessionId || null;
    } catch {
      continue;
    }
    if (!sessionId) continue;
    registerOopif(grant, sessionId, { targetId: info.id, url, parentFrameId: '' });
    try {
      const probe = await sendToChild(grant, sessionId, 'Runtime.evaluate', {
        expression: 'typeof document + "|" + (typeof document === "object" ? document.title : "")',
        returnByValue: true,
      }, 3_000);
      if (String(probe?.result?.value || '').startsWith('undefined')) {
        buffer.oopif.delete(sessionId);
        buffer.frames.delete(info.id);
        await cdp(grant.tabId, 'Target.detachFromTarget', { sessionId }).catch(() => {});
        continue;
      }
      added += 1;
    } catch {
      buffer.oopif.delete(sessionId);
      buffer.frames.delete(info.id);
    }
  }
  return added;
}


/** 把 Page.getFrameTree 铺平成 frameId -> 帧信息。 */
function seedFrameTree(buffer, node, parentId = null, depth = 0) {
  const frame = node?.frame;
  if (!frame) return;
  upsertFrame(buffer, {
    frameId: frame.id,
    parentId: frame.parentId ?? parentId,
    url: frame.url || '',
    name: frame.name || frame.url || '',
    depth,
  });
  for (const child of node.childFrames || []) seedFrameTree(buffer, child, frame.id, depth + 1);
}

function upsertFrame(buffer, patch) {
  const existing = buffer.frames.get(patch.frameId) || {
    frameId: patch.frameId,
    parentId: null,
    url: '',
    name: '',
    depth: 0,
    crossProcess: false,
    sessionId: null,
  };
  Object.assign(existing, patch);
  buffer.frames.set(existing.frameId, existing);
  return existing;
}

/** 按 index / frameId / url 片段 / name 解析 iframe 引用。 */
function resolveFrame(buffer, ref, mainFrameId) {
  const frames = [...buffer.frames.values()].sort((a, b) => (a.depth || 0) - (b.depth || 0));
  if (ref == null || ref === '' || ref === 'main') {
    return buffer.frames.get(mainFrameId) || frames[0];
  }
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const index = Number(ref);
    if (index < 0 || index >= frames.length) throw new Error(`frame 序号 ${index} 超出范围（共 ${frames.length} 个帧，先 page_frames 查看）`);
    return frames[index];
  }
  const needle = String(ref).toLowerCase();
  const matches = frames.filter((frame) => (
    frame.frameId === ref
    || String(frame.frameId).startsWith(String(ref))
    || (frame.name && String(frame.name).toLowerCase() === needle)
    || (frame.url && String(frame.url).toLowerCase().includes(needle))
  ));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`未找到 iframe：${ref}。请先 page_frames 查看可用帧（index / frameId / url 片段 / name）。`);
  throw new Error(`iframe 引用「${ref}」命中 ${matches.length} 个，请用 page_frames 里的 index 精确指定。`);
}

/** 跨进程 iframe 的命令通道（非 flatten 会话）。 */
function sendToChild(grant, sessionId, method, params, timeoutMs = 15_000) {
  const buffer = grant.buffer;
  const session = buffer.oopif.get(sessionId);
  if (!session) return Promise.reject(new Error('跨进程 iframe 会话已断开，请刷新页面后重试'));
  const id = ++buffer.childSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`跨进程 iframe 在 ${timeoutMs}ms 内没有响应 ${method}`));
    }, timeoutMs);
    session.pending.set(id, { resolve, reject, timer });
    cdp(grant.tabId, 'Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
      .catch((err) => {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(new Error(`发送到 iframe 会话失败：${errorText(err)}`));
      });
  });
}

function onChildMessage(grant, sessionId, raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  const buffer = grant.buffer;
  const session = buffer.oopif.get(sessionId);
  if (!session) return;
  if (message.id != null) {
    const pending = session.pending.get(message.id);
    if (!pending) return;
    session.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'iframe 会话返回错误'));
    else pending.resolve(message.result || {});
    return;
  }
  if (message.error) {
    // CDP 对非法 id 的报错不带 id，只能把最早挂起的请求拒掉。
    const first = session.pending.entries().next();
    if (!first.done) {
      const [pendingId, pending] = first.value;
      session.pending.delete(pendingId);
      clearTimeout(pending.timer);
      pending.reject(new Error(message.error.message || 'iframe 会话返回错误'));
    }
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const args = message.params?.args || [];
    const entry = pushConsole(
      grant,
      normalizeLevel(message.params?.type),
      args.map(describeRemote).join(' '),
      message.params?.stackTrace?.callFrames?.[0],
    );
    if (args.some((arg) => arg && arg.objectId)) void expandConsoleArgs(grant, entry, args, sessionId);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params?.exceptionDetails || {};
    pushConsole(grant, 'error', String(details.exception?.description || details.text || '未捕获异常'), details, 'exception');
    return;
  }
  if (message.method === 'Log.entryAdded') {
    const entry = message.params?.entry || {};
    pushConsole(grant, normalizeLevel(entry.level), String(entry.text || ''), entry, 'log');
  }
}

/** 在指定帧里执行 JS：同进程用 contextId，跨进程走子会话。 */
async function evaluateInFrame(grant, frame, expression, options = {}) {
  const buffer = grant.buffer;
  const timeoutMs = options.timeoutMs || 15_000;
  const params = {
    expression,
    returnByValue: options.returnByValue !== false,
    awaitPromise: Boolean(options.awaitPromise),
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: true,
    timeout: timeoutMs,
  };
  if (frame?.sessionId) {
    return sendToChild(grant, frame.sessionId, 'Runtime.evaluate', params, timeoutMs + 2_000);
  }
  if (frame && frame.frameId !== grant.mainFrameId) {
    const contextId = buffer.contexts.get(frame.frameId);
    if (!contextId) throw new Error(`iframe 尚未加载完成或不可访问：${frame.url || frame.frameId}`);
    params.contextId = contextId;
  }
  return cdp(grant.tabId, 'Runtime.evaluate', params);
}

async function revokeTab(tabId) {
  const grant = grants.get(tabId);
  grants.delete(tabId);
  if (state.defaultTabId === tabId) state.defaultTabId = [...grants.keys()][0] ?? null;
  if (grant?.attached) {
    try { await chrome.debugger.detach({ tabId }); } catch { /* 已断开 */ }
  }
  await persistGrants();
  broadcastState();
}

async function persistGrants() {
  const payload = {};
  for (const g of grants.values()) payload[g.tabId] = { since: g.buffer?.startedAt || Date.now() };
  try {
    await chrome.storage.session.set({ grants: payload });
  } catch { /* storage.session 不可用时忽略 */ }
}

function requireGrant(tabId) {
  const grant = grants.get(tabId);
  if (!grant) {
    throw new Error(`标签页 ${tabId} 未授权。请在浏览器工具栏打开「DSH 实时浏览器桥」扩展，点击「授权当前标签页」，然后重试。`);
  }
  if (!grant.attached) {
    throw new Error(`标签页 ${tabId} 的调试会话已断开（常见原因：手动打开了 DevTools、页面崩溃）。请在扩展弹窗中取消授权后重新授权。`);
  }
  return grant;
}

function resolveTabId(params) {
  if (params.tabId != null && params.tabId !== '') return Number(params.tabId);
  if (state.defaultTabId && grants.has(state.defaultTabId)) return state.defaultTabId;
  const first = [...grants.keys()][0];
  if (first != null) return first;
  throw new Error('当前没有已授权的标签页。请在浏览器中打开目标页面，点击工具栏上的「DSH 实时浏览器桥」扩展，选择「授权当前标签页」。');
}

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const grant = source.tabId != null ? grants.get(source.tabId) : null;
  if (!grant || !grant.buffer) return;
  const buffer = grant.buffer;
  if (method.startsWith('Target.') && method !== 'Target.receivedMessageFromTarget') {
    state.targetDebug.push(method + ' ' + JSON.stringify(params?.targetInfo || params?.sessionId || '').slice(0, 220));
    if (state.targetDebug.length > 60) state.targetDebug.shift();
  }
  try {
    switch (method) {
      case 'Network.requestWillBeSent': {
        if (!params || params.type === 'WebSocket') return;
        const request = params.request || {};
        const entry = {
          seq: ++buffer.netSeq,
          requestId: params.requestId,
          type: params.type || 'Other',
          method: String(request.method || 'GET'),
          url: String(request.url || ''),
          status: 0,
          statusText: '',
          mimeType: '',
          failed: false,
          errorText: '',
          durationMs: null,
          startedAt: Date.now(),
          requestHeaders: request.headers || {},
          requestBody: typeof request.postData === 'string' ? request.postData : '',
          responseHeaders: null,
          body: '',
          bodyState: 'none',
          bodyTruncated: false,
          bodyOmitted: '',
        };
        buffer.byRequest.set(params.requestId, entry);
        buffer.net.push(entry);
        if (buffer.net.length > NET_MAX_ENTRIES) buffer.net.shift();
        break;
      }
      case 'Network.requestWillBeSentExtraInfo': {
        const entry = buffer.byRequest.get(params?.requestId);
        if (entry && params.headers) entry.requestHeaders = { ...entry.requestHeaders, ...params.headers };
        break;
      }
      case 'Network.responseReceived': {
        const entry = buffer.byRequest.get(params?.requestId);
        if (!entry) return;
        const response = params.response || {};
        entry.status = Number(response.status) || 0;
        entry.statusText = String(response.statusText || '');
        entry.mimeType = String(response.mimeType || '');
        entry.responseHeaders = response.headers || {};
        if (params.type) entry.type = params.type;
        const length = Number(response.encodedDataLength ?? response.contentLength ?? 0);
        if (isTextual(entry.mimeType, entry.url) && (length === 0 || length <= MAX_BODY_BYTES)) entry.bodyState = 'wanted';
        else entry.bodyOmitted = length > MAX_BODY_BYTES ? `响应体 ${Math.round(length / 1024)}KB 超过上限，未读取` : '非文本响应，未读取';
        break;
      }
      case 'Network.loadingFinished': {
        const entry = buffer.byRequest.get(params?.requestId);
        if (!entry) return;
        entry.durationMs = Date.now() - entry.startedAt;
        if (entry.bodyState === 'wanted') {
          void loadBody(grant, entry);
        }
        break;
      }
      case 'Network.loadingFailed': {
        const entry = buffer.byRequest.get(params?.requestId);
        if (!entry) return;
        entry.failed = true;
        entry.errorText = String(params?.errorText || '请求失败');
        entry.durationMs = Date.now() - entry.startedAt;
        break;
      }
      case 'Network.webSocketCreated': {
        getSocket(buffer, params?.requestId, params?.url || '');
        break;
      }
      case 'Network.webSocketWillSendHandshakeRequest': {
        const socket = getSocket(buffer, params?.requestId, params?.request?.url || '');
        socket.requestHeaders = params?.request?.headers || {};
        break;
      }
      case 'Network.webSocketHandshakeResponseReceived': {
        const socket = getSocket(buffer, params?.requestId);
        socket.status = Number(params?.response?.status) || 0;
        socket.responseHeaders = params?.response?.headers || {};
        break;
      }
      case 'Network.webSocketFrameSent': {
        const socket = getSocket(buffer, params?.requestId);
        pushSocketFrame(socket, 'sent', params?.response);
        break;
      }
      case 'Network.webSocketFrameReceived': {
        const socket = getSocket(buffer, params?.requestId);
        pushSocketFrame(socket, 'received', params?.response);
        break;
      }
      case 'Network.webSocketFrameError': {
        const socket = getSocket(buffer, params?.requestId);
        socket.lastError = String(params?.errorMessage || 'WebSocket 错误');
        break;
      }
      case 'Network.webSocketClosed': {
        const socket = getSocket(buffer, params?.requestId);
        socket.closedAt = Date.now();
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const consoleArgs = params?.args || [];
        const entry = pushConsole(
          grant,
          normalizeLevel(params?.type),
          consoleArgs.map(describeRemote).join(' '),
          params?.stackTrace?.callFrames?.[0],
        );
        if (consoleArgs.some((arg) => arg && arg.objectId)) {
          void expandConsoleArgs(grant, entry, consoleArgs);
        }
        break;
      }
      case 'Runtime.exceptionThrown': {
        const details = params?.exceptionDetails || {};
        const text = String(details.exception?.description || details.text || '未捕获异常');
        pushConsole(grant, 'error', text, details, 'exception');
        break;
      }
      case 'Log.entryAdded': {
        const entry = params?.entry || {};
        pushConsole(grant, normalizeLevel(entry.level), String(entry.text || ''), entry, 'log');
        break;
      }
      case 'Page.frameNavigated': {
        const frame = params?.frame;
        if (!frame) return;
        const parent = frame.parentId ? buffer.frames.get(frame.parentId) : null;
        upsertFrame(buffer, {
          frameId: frame.id,
          parentId: frame.parentId || null,
          url: frame.url || '',
          name: frame.name || frame.url || '',
          depth: parent ? parent.depth + 1 : 0,
        });
        if (!frame.parentId) {
          grant.mainFrameId = frame.id;
          grant.url = frame.url || grant.url;
          grant.title = frame.name || grant.title;
          void armAutoAttach(grant);
        }
        break;
      }
      case 'Page.frameAttached': {
        const parent = buffer.frames.get(params?.parentFrameId);
        upsertFrame(buffer, {
          frameId: params?.frameId,
          parentId: params?.parentFrameId || null,
          url: '',
          name: '',
          depth: parent ? parent.depth + 1 : 1,
        });
        break;
      }
      case 'Page.frameDetached': {
        state.targetDebug.push('frameDetached ' + String(params?.frameId || '').slice(0, 8) + ' reason=' + String(params?.reason || ''));
        if (state.targetDebug.length > 80) state.targetDebug.shift();
        // reason=swap：跨进程 iframe 换进程，帧仍然存在，交给 OOPIF 会话继续维护。
        if (params?.reason === 'swap') break;
        if (params?.frameId) {
          buffer.frames.delete(params.frameId);
          buffer.contexts.delete(params.frameId);
        }
        break;
      }
      case 'Runtime.executionContextCreated': {
        const context = params?.context;
        const aux = context?.auxData || {};
        if (aux.isDefault && aux.frameId) buffer.contexts.set(aux.frameId, context.id);
        break;
      }
      case 'Runtime.executionContextDestroyed': {
        for (const [frameId, contextId] of buffer.contexts) {
          if (contextId === params?.executionContextId) buffer.contexts.delete(frameId);
        }
        break;
      }
      case 'Runtime.executionContextsCleared': {
        buffer.contexts.clear();
        break;
      }
      case 'Runtime.bindingCalled': {
        if (params?.name !== RECORD_BINDING || !buffer.recording) break;
        try {
          const payload = JSON.parse(String(params.payload || '{}'));
          pushRecordedAction(buffer, payload);
        } catch { /* 忽略坏载荷 */ }
        break;
      }
      case 'Target.attachedToTarget': {
        const info = params?.targetInfo || {};
        const sessionId = params?.sessionId;
        if (!sessionId) break;
        if (['worker', 'service_worker', 'shared_worker', 'browser', 'tab'].includes(String(info.type))) break;
        if (!info.parentFrameId && !/^https?:/i.test(info.url || '')) break;
        registerOopif(grant, sessionId, info);
        break;
      }
      case 'Target.detachedFromTarget': {
        state.targetDebug.push('detachedFromTarget ' + String(params?.sessionId || '').slice(0, 8));
        if (state.targetDebug.length > 80) state.targetDebug.shift();
        const session = buffer.oopif.get(params?.sessionId);
        if (session) {
          buffer.oopif.delete(params.sessionId);
          buffer.frames.delete(session.frameId);
        }
        break;
      }
      case 'Target.targetInfoChanged': {
        const info = params?.targetInfo || {};
        const session = [...buffer.oopif.values()].find((item) => item.frameId === info.targetId);
        const frame = info.targetId ? buffer.frames.get(info.targetId) : null;
        if (frame && info.url) {
          frame.url = info.url;
          if (session) session.url = info.url;
        }
        break;
      }
      case 'Target.receivedMessageFromTarget': {
        onChildMessage(grant, params?.sessionId, params?.message);
        break;
      }
      case 'Page.frameStartedLoading': {
        if (params?.frameId && grant.mainFrameId && params.frameId === grant.mainFrameId) {
          resetBuffer(grant);
          void armAutoAttach(grant);
        }
        break;
      }
      case 'Page.loadEventFired': {
        buffer.loadedAt = Date.now();
        void refreshOopifTargets(grant);
        break;
      }
      case 'Inspector.detached': {
        grant.attached = false;
        break;
      }
      default:
        break;
    }
  } catch (err) {
    state.lastError = `捕获事件失败：${errorText(err)}`;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const grant = grants.get(tabId);
  if (!grant) return;
  grant.attached = false;
  grants.delete(tabId);
  if (state.defaultTabId === tabId) state.defaultTabId = [...grants.keys()][0] ?? null;
  state.lastError = `标签页 ${tabId} 的调试会话已断开（${describeDetachReason(reason)}）`;
  void persistGrants();
  broadcastState();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!grants.has(tabId)) return;
  grants.delete(tabId);
  if (state.defaultTabId === tabId) state.defaultTabId = [...grants.keys()][0] ?? null;
  void persistGrants();
  broadcastState();
});

chrome.tabs.onActivated.addListener((info) => {
  if (grants.has(info.tabId)) {
    state.defaultTabId = info.tabId;
    broadcastState();
  }
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const grant = grants.get(tabId);
  if (!grant) return;
  if (tab.title) grant.title = tab.title;
  if (tab.url) grant.url = tab.url;
  if (change.status === 'complete') broadcastState();
});

function newBuffer() {
  return {
    net: [],
    con: [],
    byRequest: new Map(),
    netSeq: 0,
    conSeq: 0,
    startedAt: Date.now(),
    pendingBodies: 0,
    loadedAt: 0,
    // iframe：frameId -> 帧信息；contextId 只对同进程 iframe 有效
    frames: new Map(),
    contexts: new Map(),
    // 跨进程 iframe：sessionId -> { frameId, url, pending }
    oopif: new Map(),
    childSeq: 0,
    // WebSocket：requestId -> socket
    sockets: new Map(),
    socketSeq: 0,
    // 录制
    recording: null,
  };
}

/** 导航时只清「按文档生命周期」的数据，保留 iframe 会话与录制状态。 */
function resetBuffer(grant) {
  const buffer = grant.buffer || newBuffer();
  buffer.net = [];
  buffer.con = [];
  buffer.byRequest = new Map();
  buffer.netSeq = 0;
  buffer.conSeq = 0;
  buffer.pendingBodies = 0;
  buffer.startedAt = Date.now();
  buffer.loadedAt = 0;
  buffer.sockets = new Map();
  buffer.socketSeq = 0;
  buffer.contexts.clear();
  if (buffer.recording) buffer.recording.navigations += 1;
  grant.buffer = buffer;
}

function getSocket(buffer, requestId, url = '') {
  let socket = buffer.sockets.get(requestId);
  if (!socket) {
    socket = {
      seq: ++buffer.socketSeq,
      requestId,
      url,
      status: 0,
      openedAt: Date.now(),
      closedAt: 0,
      sent: 0,
      received: 0,
      frames: [],
      frameSeq: 0,
      requestHeaders: {},
      responseHeaders: {},
      lastError: '',
    };
    buffer.sockets.set(requestId, socket);
    if (buffer.sockets.size > WS_MAX_SOCKETS) {
      const oldest = [...buffer.sockets.values()].sort((a, b) => a.seq - b.seq)[0];
      if (oldest) buffer.sockets.delete(oldest.requestId);
    }
  }
  if (url) socket.url = url;
  return socket;
}

function pushSocketFrame(socket, direction, payload) {
  const data = String(payload?.payloadData ?? '');
  const frame = {
    seq: ++socket.frameSeq,
    at: Date.now(),
    direction,
    opcode: Number(payload?.opcode) || 1,
    size: data.length,
    text: data.slice(0, WS_FRAME_MAX_CHARS),
    truncated: data.length > WS_FRAME_MAX_CHARS,
  };
  socket.frames.push(frame);
  if (socket.frames.length > WS_FRAMES_PER_SOCKET) socket.frames.shift();
  if (direction === 'sent') socket.sent += 1;
  else socket.received += 1;
  return frame;
}

function pushRecordedAction(buffer, payload) {
  const recording = buffer.recording;
  if (!recording || recording.actions.length >= 500) return;
  const kind = String(payload.kind || 'action');
  const last = recording.actions[recording.actions.length - 1];
  if (kind === 'change' && last && last.kind === 'input' && last.selector === String(payload.selector || '') && last.value === String(payload.value || '') && Date.now() - last.at < 1_000) {
    return;
  }
  recording.actions.push({
    seq: ++recording.actionSeq,
    at: Date.now(),
    kind,
    selector: String(payload.selector || '').slice(0, 300),
    text: String(payload.text || '').slice(0, 120),
    value: String(payload.value || '').slice(0, 300),
    masked: Boolean(payload.masked),
    key: String(payload.key || ''),
    url: String(payload.url || '').slice(0, 300),
  });
}

/** 录制器注入到页面的监听脚本（只装一次，重复调用返回 already）。 */
const RECORD_INSTALL = `(function () {
  var BINDING = '__dshRecordEvent';
  if (window.__dshRecordInstalled) return 'already';
  window.__dshRecordInstalled = true;
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    var auto = el.getAttribute && el.getAttribute('data-csi-automation');
    if (auto) return '[data-csi-automation="' + String(auto).replace(/"/g, '\\\\"') + '"]';
    var testid = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-cy'));
    if (testid) return '[data-testid="' + String(testid).replace(/"/g, '\\\\"') + '"]';
    var id = el.id;
    if (id && !/^(uniqName_|dijit_|ext-gen|:r[0-9])/.test(id)) return '#' + id;
    var name = el.getAttribute && el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + String(name).replace(/"/g, '\\\\"') + '"]';
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return el.tagName.toLowerCase() + '[aria-label="' + String(aria).replace(/"/g, '\\\\"') + '"]';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      var tag = node.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      var parent = node.parentElement;
      if (!parent) break;
      var sameTag = 0;
      for (var i = 0; i < parent.children.length; i++) if (parent.children[i].tagName === node.tagName) sameTag += 1;
      if (sameTag > 1) {
        var index = 1;
        for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === node.tagName) index += 1;
        parts.unshift(tag + ':nth-of-type(' + index + ')');
      } else {
        parts.unshift(tag);
      }
      node = parent;
    }
    return parts.join(' > ');
  }
  function send(kind, el, extra) {
    try {
      if (typeof window[BINDING] !== 'function') return;
      var payload = { kind: kind, selector: selectorFor(el), url: location.href };
      if (extra) for (var key in extra) payload[key] = extra[key];
      window[BINDING](JSON.stringify(payload));
    } catch (e) { /* ignore */ }
  }
  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ? event.target.closest('button,a,input,select,textarea,[role=button],[data-csi-automation]') : event.target;
    send('click', el || event.target, { text: String((el && (el.innerText || el.value)) || '').slice(0, 80) });
  }, true);
  document.addEventListener('input', function (event) {
    var el = event.target;
    if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    var type = (el.getAttribute('type') || '').toLowerCase();
    send('input', el, { value: type === 'password' ? '••••••' : String(el.value || '').slice(0, 200), masked: type === 'password' });
  }, true);
  document.addEventListener('change', function (event) {
    var el = event.target;
    if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    var type = (el.getAttribute('type') || '').toLowerCase();
    send('change', el, { value: type === 'password' ? '••••••' : String(el.value || '').slice(0, 200), masked: type === 'password' });
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    send('keydown', event.target, { key: 'Enter' });
  }, true);
  return 'installed';
})()`;

async function startRecording(grant) {
  const buffer = grant.buffer;
  if (buffer.recording) throw new Error('已经在录制中：先 page_record action=stop 或 cancel。');
  await cdp(grant.tabId, 'Runtime.addBinding', { name: RECORD_BINDING }).catch(() => {});
  const installed = await cdp(grant.tabId, 'Runtime.evaluate', { expression: RECORD_INSTALL, returnByValue: true }).catch(() => null);
  buffer.recording = { startedAt: Date.now(), actionSeq: 0, actions: [], navigations: 0 };
  return { startedAt: buffer.recording.startedAt, install: String(installed?.result?.value || '') };
}

async function stopRecording(grant) {
  const buffer = grant.buffer;
  const recording = buffer.recording;
  if (!recording) throw new Error('当前没有在录制：先 page_record action=start。');
  buffer.recording = null;
  await cdp(grant.tabId, 'Runtime.removeBinding', { name: RECORD_BINDING }).catch(() => {});
  const requests = buffer.net
    .filter((entry) => entry.startedAt >= recording.startedAt)
    .filter((entry) => !/^(script|stylesheet|image|font|media|other|manifest|texttrack|prefetch)$/i.test(String(entry.type)))
    .slice(0, 100)
    .map((entry) => ({
      seq: entry.seq,
      type: entry.type,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      mimeType: entry.mimeType,
      startedAt: entry.startedAt,
      requestHeaders: entry.requestHeaders,
      requestBody: String(entry.requestBody || '').slice(0, 20_000),
      body: String(entry.body || '').slice(0, 20_000),
    }));
  const sockets = [...buffer.sockets.values()]
    .filter((socket) => socket.openedAt >= recording.startedAt)
    .map((socket) => ({
      seq: socket.seq,
      url: socket.url,
      status: socket.status,
      openedAt: socket.openedAt,
      sent: socket.sent,
      received: socket.received,
      frames: socket.frames.slice(-100).map((frame) => ({ ...frame })),
    }));
  return {
    startedAt: recording.startedAt,
    stoppedAt: Date.now(),
    actions: recording.actions,
    requests,
    sockets,
    navigations: recording.navigations,
  };
}

async function loadBody(grant, entry) {
  const buffer = grant.buffer;
  entry.bodyState = 'loading';
  buffer.pendingBodies += 1;
  try {
    const result = await cdp(grant.tabId, 'Network.getResponseBody', { requestId: entry.requestId });
    if (grant.buffer !== buffer) return;
    let body = result.base64Encoded ? '' : String(result.body ?? '');
    if (result.base64Encoded) entry.bodyOmitted = '二进制响应，未读取';
    if (body.length > BODY_MAX_CHARS) {
      entry.bodyTruncated = true;
      body = body.slice(0, BODY_MAX_CHARS);
    }
    entry.body = body;
    entry.bodyState = 'done';
  } catch (err) {
    entry.bodyState = 'error';
    entry.bodyOmitted = `读取响应体失败：${errorText(err)}`;
  } finally {
    buffer.pendingBodies = Math.max(0, buffer.pendingBodies - 1);
  }
}

function pushConsole(grant, level, text, location, kind = 'console') {
  const buffer = grant.buffer;
  const entry = {
    seq: ++buffer.conSeq,
    level,
    text: String(text ?? '').slice(0, 4_000),
    kind,
    at: Date.now(),
    url: location?.url || location?.sourceURL || '',
    line: Number(location?.lineNumber ?? location?.line ?? 0) + (location?.lineNumber != null ? 1 : 0) || 0,
  };
  buffer.con.push(entry);
  if (buffer.con.length > CON_MAX_ENTRIES) buffer.con.shift();
  return entry;
}

/**
 * console.log(obj) 的 RemoteObject 只有 objectId，直接渲染会变成 "Object"。
 * 这里用 callFunctionOn 把对象转成 JSON 文本后回填到同一条日志里。
 */
async function expandConsoleArgs(grant, entry, args, sessionId = null) {
  const buffer = grant.buffer;
  const parts = [];
  for (const arg of args) {
    if (!arg || !arg.objectId) {
      parts.push(describeRemote(arg));
      continue;
    }
    try {
      const params = {
        objectId: arg.objectId,
        functionDeclaration:
          'function () { try { if (this instanceof Element) return this.outerHTML.slice(0, 500); if (typeof this === "function") return String(this); const text = JSON.stringify(this); return text === undefined ? String(this) : text; } catch (error) { return String(this); } }',
        returnByValue: true,
      };
      const result = sessionId
        ? await sendToChild(grant, sessionId, 'Runtime.callFunctionOn', params, 5_000)
        : await cdp(grant.tabId, 'Runtime.callFunctionOn', params);
      parts.push(String(result.result?.value ?? describeRemote(arg)));
    } catch {
      parts.push(describeRemote(arg));
    }
  }
  if (grant.buffer !== buffer) return;
  entry.text = parts.join(' ').slice(0, 4_000);
}

function describeRemote(remote) {
  if (!remote || typeof remote !== 'object') return String(remote ?? '');
  if (remote.type === 'undefined') return 'undefined';
  if (remote.type === 'string') return String(remote.value ?? '');
  if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
    const value = remote.value;
    if (value === null) return 'null';
    if (typeof value === 'object') return safeJson(value) ?? remote.description ?? '[object]';
    return String(value);
  }
  return String(remote.description || remote.unserializableValue || remote.type || '');
}

function normalizeLevel(level) {
  const value = String(level || 'log').toLowerCase();
  if (value === 'warning' || value === 'warn') return 'warn';
  if (value === 'error' || value === 'assert') return 'error';
  if (value === 'info') return 'info';
  if (value === 'debug' || value === 'verbose') return 'debug';
  return 'log';
}

function levelMatches(entryLevel, wanted) {
  if (entryLevel === wanted) return true;
  if (wanted === 'warn' && entryLevel === 'warning') return true;
  if (wanted === 'log' && entryLevel === 'info') return false;
  return false;
}

function isTextual(mimeType, url) {
  const mime = String(mimeType || '').toLowerCase();
  if (/json|javascript|ecmascript|xml|html|text\/|x-www-form-urlencoded|graphql/.test(mime)) return true;
  if (!mime && /\.(json|js|mjs|html?|xml|txt|graphql)(\?|$)/i.test(url || '')) return true;
  return false;
}

function matchNetworkEntry(entry, filter) {
  if (filter.urlContains && !entry.url.toLowerCase().includes(filter.urlContains.toLowerCase())) return false;
  if (filter.method && entry.method !== filter.method) return false;
  if (filter.type && String(entry.type).toLowerCase() !== filter.type) return false;
  if (filter.status != null && !Number.isNaN(filter.status) && entry.status !== filter.status) return false;
  if (filter.afterSeq != null && entry.seq <= filter.afterSeq) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 页面内辅助：定位、聚焦、填值、读取已有资源
// ---------------------------------------------------------------------------

async function locateElement(grant, frame, selector, index) {
  const expression = `(function(){
    try {
      var list = document.querySelectorAll(${JSON.stringify(selector)});
      var el = list[${index}];
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      var rect = el.getBoundingClientRect();
      var style = getComputedStyle(el);
      var visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
      return { found: true, visible: visible, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
               w: rect.width, h: rect.height, tag: el.tagName.toLowerCase(),
               text: String(el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
    } catch (e) { return { found: false, error: String(e && e.message || e) }; }
  })()`;
  const response = await evaluateInFrame(grant, frame, expression, { timeoutMs: 8_000 });
  if (response.exceptionDetails) throw new Error(`定位元素失败：${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`);
  const value = response.result?.value || { found: false };
  if (value.error) throw new Error(`选择器无效：${value.error}`);
  return value;
}

/**
 * 构造页面内的查询表达式。这是一段「我们自己写的代码」，
 * 通过 CDP Runtime.evaluate 编译执行，因此不受页面 CSP 限制。
 */
function buildQueryExpression(args) {
  const payload = JSON.stringify(args);
  return `(function (args) {
    var out = { matched: 0, items: [], truncated: false, error: null, url: location.href, title: document.title };
    try {
      var roots = [document];
      if (args.pierce) {
        for (var i = 0; i < roots.length && i < 300; i++) {
          var all = roots[i].querySelectorAll('*');
          for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) roots.push(all[j].shadowRoot);
        }
      }
      var nodes = [];
      for (var r = 0; r < roots.length; r++) {
        var list = roots[r].querySelectorAll(args.selector);
        for (var k = 0; k < list.length; k++) nodes.push(list[k]);
      }
      out.matched = nodes.length;
      if (args.mode === 'count') return out;
      var collapse = function (s) { s = String(s == null ? '' : s); return args.collapse ? s.replace(/\\s+/g, ' ').trim() : s; };
      var cut = function (s) { s = String(s == null ? '' : s); if (s.length > args.maxChars) { out.truncated = true; return s.slice(0, args.maxChars); } return s; };
      out.items = nodes.slice(0, args.limit).map(function (el) {
        if (args.mode === 'text') return cut(collapse(el.innerText != null ? el.innerText : el.textContent));
        if (args.mode === 'html') return cut(el.innerHTML);
        if (args.mode === 'outer') return cut(el.outerHTML);
        if (args.mode === 'attr') return args.attr ? el.getAttribute(args.attr) : null;
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          classes: Array.prototype.slice.call(el.classList, 0, 8).join(' '),
          text: cut(collapse(String(el.innerText || el.value || '').slice(0, 200))),
          x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0,
          role: el.getAttribute('role') || '',
          aria: el.getAttribute('aria-label') || '',
          name: el.getAttribute('name') || '',
          type: el.getAttribute('type') || '',
        };
      });
    } catch (e) { out.error = String(e && e.message || e); }
    return out;
  })(${payload})`;
}

async function focusElement(grant, frame, selector, clear) {
  const expression = `(function(){
    try {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      el.focus({ preventScroll: true });
      if (${clear ? 'true' : 'false'}) {
        var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : (el instanceof HTMLInputElement ? HTMLInputElement.prototype : null);
        var setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
        if (setter) setter.call(el, ''); else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { found: true, tag: el.tagName.toLowerCase() };
    } catch (e) { return { found: false, error: String(e && e.message || e) }; }
  })()`;
  const response = await evaluateInFrame(grant, frame, expression, { timeoutMs: 8_000 });
  const value = response.result?.value || { found: false };
  if (value.error) throw new Error(`聚焦失败：${value.error}`);
  return value;
}

async function fillElement(grant, frame, selector, value, clear) {
  const expression = `(function () {
    try {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus({ preventScroll: true });
      var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : (el instanceof HTMLInputElement ? HTMLInputElement.prototype : null);
      var setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
      var next = ${clear ? JSON.stringify(value) : `String(el.value || '') + ${JSON.stringify(value)}`};
      if (setter) setter.call(el, next); else el.value = next;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  })()`;
  const response = await evaluateInFrame(grant, frame, expression, { timeoutMs: 8_000 });
  return response.result?.value === true;
}

/**
 * iframe 内元素 → 顶层视口坐标的偏移。
 * 同源帧用 window.frameElement 拿父级位置；跨进程帧在父帧里按 src/name 找 <iframe>。
 */
async function frameOffset(grant, frame) {
  const buffer = grant.buffer;
  const offset = { x: 0, y: 0 };
  let current = frame;
  let guard = 0;
  while (current && current.frameId !== grant.mainFrameId) {
    if (guard++ > 10) throw new Error('iframe 嵌套层级过深，无法计算点击坐标');
    const parent = current.parentId ? buffer.frames.get(current.parentId) : null;
    let rect = null;
    try {
      const own = await evaluateInFrame(
        grant,
        current,
        '(function () { try { var fe = window.frameElement; if (!fe) return null; var r = fe.getBoundingClientRect(); return { x: r.x + fe.clientLeft, y: r.y + fe.clientTop }; } catch (e) { return null; } })()',
        { timeoutMs: 4_000 },
      );
      rect = own?.result?.value ?? null;
    } catch {
      rect = null;
    }
    if (!rect && parent) {
      const payload = JSON.stringify({ url: current.url || '', name: current.name || '' });
      const expression = `(function (args) {
        try {
          var list = Array.prototype.slice.call(document.querySelectorAll('iframe,frame'));
          function rectOf(el) { var r = el.getBoundingClientRect(); return { x: r.x + el.clientLeft, y: r.y + el.clientTop }; }
          var bySrc = list.find(function (el) { return el.src && el.src === args.url; });
          if (bySrc) return rectOf(bySrc);
          var path = String(args.url || '').replace(/^https?:\\/\\/[^/]+/, '');
          if (path) {
            var byPath = list.find(function (el) { return el.src && el.src.indexOf(path) >= 0; });
            if (byPath) return rectOf(byPath);
          }
          if (args.name) {
            var byName = list.find(function (el) { return el.name === args.name; });
            if (byName) return rectOf(byName);
          }
          return null;
        } catch (e) { return null; }
      })(${payload})`;
      try {
        const found = await evaluateInFrame(grant, parent, expression, { timeoutMs: 4_000 });
        rect = found?.result?.value ?? null;
      } catch {
        rect = null;
      }
    }
    if (!rect) throw new Error('无法定位 iframe 在页面中的坐标，请改用 page_eval（frame 参数）在帧内触发');
    offset.x += Number(rect.x) || 0;
    offset.y += Number(rect.y) || 0;
    if (!parent) break;
    current = parent;
  }
  return offset;
}

async function readPerformanceResources(tabId, limit) {
  const expression = `(function(){
    try {
      return performance.getEntriesByType('resource').slice(-${limit}).map(function(e){
        return { url: e.name, type: (e.initiatorType || 'other').toLowerCase(), startMs: Math.round(e.startTime), durationMs: Math.round(e.duration), transferSize: e.transferSize || 0 };
      });
    } catch (e) { return []; }
  })()`;
  const response = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true });
  return response.result?.value || [];
}

async function tabSummary(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const grant = grants.get(tabId);
  if (grant && tab) grant.url = tab.url || grant.url;
  return { tabId, url: tab?.url || '', title: tab?.title || '', status: tab?.status || '', captureStartedAt: grant?.buffer?.startedAt || 0 };
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === 'complete') setTimeout(finish, 250);
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // 导航/刷新刚开始时 status 可能还停留在上一页的 complete，
    // 所以等 700ms 再兜底检查一次，避免过早返回。
    setTimeout(() => {
      chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') setTimeout(finish, 250); }).catch(finish);
    }, 700);
  });
}

// ---------------------------------------------------------------------------
// popup 通信
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || typeof message !== 'object') return undefined;
  if (message.type === 'state') {
    void ready.then(() => snapshotState()).then((value) => respond(value));
    return true;
  }
  if (message.type === 'grant' || message.type === 'revoke') {
    void ready.then(async () => {
      try {
        if (message.type === 'grant') {
          const tabId = Number(message.tabId);
          const tab = await chrome.tabs.get(tabId);
          const grant = grants.get(tabId) || { tabId, attached: false, buffer: newBuffer(), mainFrameId: null };
          grant.url = tab.url; grant.title = tab.title;
          grants.set(tabId, grant);
          await attachDebugger(grant);
          state.defaultTabId = tabId;
          await persistGrants();
          broadcastState();
          respond({ ok: true, state: await snapshotState() });
        } else {
          await revokeTab(Number(message.tabId));
          respond({ ok: true, state: await snapshotState() });
        }
      } catch (err) {
        respond({ ok: false, error: errorText(err), state: await snapshotState() });
      }
    });
    return true;
  }
  if (message.type === 'reconnect') {
    void ready.then(async () => {
      const stored = await chrome.storage.local.get({ bridgePort: DEFAULT_PORT, bridgeToken: '' });
      state.port = Number(message.port ?? stored.bridgePort) || DEFAULT_PORT;
      state.token = String(message.token ?? stored.bridgeToken ?? '');
      await chrome.storage.local.set({ bridgePort: state.port, bridgeToken: state.token });
      try { state.ws?.close(); } catch { /* ignore */ }
      state.ws = null;
      state.retryDelay = 500;
      connect();
      respond({ ok: true, state: await snapshotState() });
    });
    return true;
  }
  return undefined;
});

function broadcastState() {
  void snapshotState().then((value) => {
    chrome.runtime.sendMessage({ type: 'state-changed', state: value }).catch(() => {});
  });
}

async function snapshotState() {
  let currentTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      currentTab = {
        tabId: tab.id,
        title: tab.title || '',
        url: tab.url || '',
        granted: grants.has(tab.id),
        supported: /^https?:|^file:/.test(tab.url || ''),
      };
    }
  } catch { /* ignore */ }
  const list = [];
  for (const grant of grants.values()) {
    const tab = await chrome.tabs.get(grant.tabId).catch(() => null);
    list.push({
      tabId: grant.tabId,
      title: tab?.title || grant.title || `标签页 ${grant.tabId}`,
      url: tab?.url || grant.url || '',
      attached: grant.attached,
      active: Boolean(tab?.active),
      networkCount: grant.buffer?.net?.length || 0,
      consoleCount: grant.buffer?.con?.length || 0,
      captureStartedAt: grant.buffer?.startedAt || 0,
    });
  }
  return {
    connected: state.open && state.handshaken,
    socketOpen: state.open,
    port: state.port,
    tokenSet: Boolean(state.token),
    version: VERSION,
    browser: browserName(),
    lastError: state.lastError,
    defaultTabId: state.defaultTabId,
    currentTab,
    grants: list,
  };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function browserName() {
  const ua = navigator.userAgent || '';
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/Chrome\//.test(ua)) return 'Google Chrome';
  if (/Chromium\//.test(ua)) return 'Chromium';
  return 'Chromium';
}

function errorText(err) {
  if (err == null) return '未知错误';
  if (typeof err === 'string') return err;
  return String(err.message || err.error || err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function safeJson(value) {
  const seen = new WeakSet();
  try {
    const text = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[循环引用]';
        seen.add(item);
      }
      if (typeof item === 'bigint') return `${item}n`;
      if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
      return item;
    });
    return text;
  } catch {
    return undefined;
  }
}

function describeDetachReason(reason) {
  const map = {
    target_closed: '标签页已关闭',
    canceled_by_user: '用户关闭了调试会话',
    replaced_with_devtools: '打开了 DevTools',
    inspect_mode: '被 DevTools 接管',
    no_target: '目标不存在',
  };
  return map[reason] || String(reason || '未知原因');
}

// SW 被唤醒时确保连接。（top-level 的 init 已处理；此处兜底浏览器启动事件。）
chrome.runtime.onInstalled.addListener(() => { void ready.then(() => connect()); });
chrome.runtime.onStartup.addListener(() => { void ready.then(() => connect()); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'dsh-bridge-keepalive') return;
  void ready.then(() => {
    if (!state.open) {
      state.retryDelay = 500;
      connect();
    }
  });
});

// 调试用：在扩展的 Service Worker 控制台里可查看 __dshBridge.state。
globalThis.__dshBridge = {
  state,
  grants,
  connect,
  cdp,
  get ready() { return ready; },
};
