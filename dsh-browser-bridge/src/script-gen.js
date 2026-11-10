/**
 * 录制结果 → 可重放的请求脚本（纯函数，便于单测）。
 *
 * 输入是扩展返回的 actions / requests / sockets：
 *   actions  = [{ seq, at, kind, selector, text, value, masked }]
 *   requests = [{ method, url, type, status, startedAt, requestHeaders, requestBody, body }]
 *   sockets  = [{ url, sent, received, frames }]
 *
 * 输出 node 版（fetch + COOKIE 环境变量）或 browser 版（页面内 fetch，带 credentials）。
 */

const DROP_HEADERS = new Set([
  'cookie', 'host', 'content-length', 'connection', 'accept-encoding', 'origin', 'referer',
  'user-agent', 'priority', 'pragma', 'cache-control', 'if-none-match', 'if-modified-since',
  'te', 'trailer', 'upgrade', 'transfer-encoding',
]);

const STATIC_EXT = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|pdf)(?:\?|$)/i;

/** 只保留值得重放的业务请求。 */
export function filterReplayableRequests(requests = []) {
  return requests.filter((request) => {
    if (!request || !request.url) return false;
    const method = String(request.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') return false;
    if (STATIC_EXT.test(request.url)) return false;
    const type = String(request.type || '').toLowerCase();
    if (type && !['xhr', 'fetch'].includes(type)) return false;
    const status = Number(request.status) || 0;
    if (status >= 300 && status < 400) return false;
    return true;
  });
}

/** 过滤掉不需要携带的请求头（Cookie 单独用环境变量处理）。 */
export function cleanHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const name = String(key).toLowerCase();
    if (DROP_HEADERS.has(name) || name.startsWith('sec-') || name.startsWith(':')) continue;
    if (value == null || value === '') continue;
    out[name] = String(value);
  }
  return out;
}

/** 解析 multipart/form-data 请求体。 */
export function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!match) return null;
  const boundary = `--${match[1] || match[2]}`;
  const text = String(body || '');
  if (!text.includes(boundary)) return null;
  const parts = text.split(boundary).slice(1, -1);
  const fields = [];
  for (const raw of parts) {
    const part = raw.replace(/^\r?\n/, '');
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = part.slice(0, split);
    let value = part.slice(split + 4);
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    const name = /name="([^"]*)"/i.exec(head);
    if (!name) continue;
    const filename = /filename="([^"]*)"/i.exec(head);
    fields.push({
      name: name[1],
      value,
      filename: filename ? filename[1] : '',
      contentType: (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || '',
    });
  }
  return fields;
}

function escapeTemplate(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function codeString(text) {
  return `\`${escapeTemplate(text)}\``;
}

function prettyBody(body) {
  const text = String(body ?? '');
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
  } catch { /* 不是 JSON，原样保留 */ }
  return text;
}

function actionLabel(action) {
  if (!action) return '';
  const target = action.selector || action.text || '';
  const value = action.masked ? '••••••' : action.value;
  if (action.kind === 'input' || action.kind === 'change') return `${action.kind} ${target}${value ? ` = ${JSON.stringify(value)}` : ''}`;
  if (action.kind === 'keydown') return `按 ${action.key || 'Enter'} 于 ${target}`;
  return `${action.kind} ${target}`;
}

/** 把请求与最近一次操作关联起来。 */
function attachActions(requests, actions) {
  return requests.map((request) => {
    const at = Number(request.startedAt) || 0;
    let best = null;
    for (const action of actions) {
      if (Number(action.at) <= at && (!best || Number(action.at) >= Number(best.at))) best = action;
    }
    if (best && at - Number(best.at) > 15_000) best = null;
    return { request, action: best };
  });
}

function requestPath(url, baseUrl) {
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    if (target.origin === base.origin) return `${target.pathname}${target.search}`;
    return target.toString();
  } catch {
    return String(url || '');
  }
}

/**
 * @param {{ actions?: any[], requests?: any[], sockets?: any[] }} capture
 * @param {{ runtime?: 'node'|'browser', baseUrl?: string, generatedAt?: number }} [options]
 */
export function buildReplayScript(capture = {}, options = {}) {
  const actions = Array.isArray(capture.actions) ? capture.actions : [];
  const runtime = options.runtime === 'browser' ? 'browser' : 'node';
  const replayable = filterReplayableRequests(capture.requests || []).slice(0, 50);
  const firstUrl = replayable[0]?.url || '';
  let baseUrl = options.baseUrl || '';
  if (!baseUrl) {
    try { baseUrl = firstUrl ? new URL(firstUrl).origin : ''; } catch { baseUrl = ''; }
  }
  const generatedAt = options.generatedAt || Date.now();
  const steps = attachActions(replayable, actions);
  const sockets = Array.isArray(capture.sockets) ? capture.sockets : [];

  const lines = [];
  const isBrowser = runtime === 'browser';
  lines.push(isBrowser ? '/* 在目标站点的页面控制台里执行（复用当前登录态） */' : '#!/usr/bin/env node');
  lines.push('/*');
  lines.push(` * 由「DSH 实时浏览器桥」自动生成 · ${new Date(generatedAt).toISOString()}`);
  lines.push(` * 录制：${actions.length} 个操作 · ${steps.length} 个可重放请求${sockets.length ? ` · ${sockets.length} 个 WebSocket` : ''}`);
  lines.push(` * 覆盖范围：${new Date(capture.startedAt || generatedAt).toLocaleString('zh-CN')} → ${new Date(capture.stoppedAt || generatedAt).toLocaleString('zh-CN')}`);
  lines.push(' *');
  if (isBrowser) {
    lines.push(' * 直接粘贴到已登录页面的 Console：fetch 会带上当前 Cookie。');
  } else {
    lines.push(' * 用法：');
    lines.push(' *   BASE=... DSH_COOKIE="JSESSIONID=..." node flow.mjs');
    lines.push(' * DSH_COOKIE 取浏览器请求头里的 Cookie（含会话与 CSRF 相关的 cookie）。');
  }
  lines.push(' */');
  lines.push('');
  if (isBrowser) {
    lines.push('const BASE = location.origin;');
    lines.push('async function call(method, path, init = {}) {');
    lines.push("  const res = await fetch(path, { ...init, method, credentials: 'include', headers: { ...(init.headers || {}) } });");
    lines.push('  const text = await res.text();');
    lines.push('  return { status: res.status, text };');
    lines.push('}');
  } else {
    lines.push(`const BASE = process.env.BASE || ${JSON.stringify(baseUrl || 'http://127.0.0.1')};`);
    lines.push("const COOKIE = process.env.DSH_COOKIE || process.env.CENTRIC_COOKIE || '';");
    lines.push('async function call(method, path, init = {}) {');
    lines.push('  const headers = { ...(init.headers || {}) };');
    lines.push('  if (COOKIE) headers.cookie = COOKIE;');
    lines.push("  const url = /^https?:\\/\\//.test(path) ? path : new URL(path, BASE).toString();");
    lines.push('  const res = await fetch(url, { ...init, method, headers });');
    lines.push('  const text = await res.text();');
    lines.push('  return { status: res.status, text };');
    lines.push('}');
  }
  lines.push('');
  lines.push('const results = {};');

  steps.forEach(({ request, action }, index) => {
    const step = index + 1;
    const path = requestPath(request.url, baseUrl);
    const headers = cleanHeaders(request.requestHeaders);
    const contentType = String(headers['content-type'] || '');
    const body = String(request.requestBody || '');
    lines.push('');
    lines.push(`// [${step}] ${String(request.method || 'GET').toUpperCase()} ${path} · HTTP ${request.status || '?'}${request.mimeType ? ` · ${request.mimeType}` : ''}`);
    if (action) lines.push(`//     触发操作：${actionLabel(action)}`);
    if (Number(request.startedAt)) lines.push(`//     时间：${new Date(Number(request.startedAt)).toLocaleTimeString('zh-CN')}`);
    lines.push(`results.step${step} = await call(${JSON.stringify(String(request.method || 'GET').toUpperCase())}, ${JSON.stringify(path)}, {`);
    if (Object.keys(headers).length) lines.push(`  headers: ${JSON.stringify(headers)},`);
    if (body) {
      if (/^multipart\/form-data/i.test(contentType)) {
        const fields = parseMultipart(body, contentType);
        if (fields && fields.every((field) => !field.filename)) {
          lines.push('  body: (() => {');
          lines.push('    const form = new FormData();');
          for (const field of fields) {
            lines.push(`    form.append(${JSON.stringify(field.name)}, ${JSON.stringify(field.value)});`);
          }
          lines.push('    return form;');
          lines.push('  })(),');
        } else {
          lines.push(`  // multipart 含文件或无法解析，原样请求体如下（可能需要手工改写）`);
          lines.push(`  body: ${codeString(body)},`);
        }
      } else {
        const rendered = prettyBody(body);
        if (rendered.includes('\n')) {
          lines.push(`  body: ${codeString(rendered)},`);
        } else {
          lines.push(`  body: ${JSON.stringify(rendered)},`);
        }
      }
    }
    lines.push('});');
    lines.push(`console.log('step${step}', results.step${step}.status, String(results.step${step}.text).slice(0, 300));`);
  });

  if (!steps.length) {
    lines.push('');
    lines.push("console.log('没有可重放的请求：录制期间页面可能只发了静态资源，或请求已被过滤。');");
  }
  const unusedActions = actions.filter((action) => !steps.some(({ action: linked }) => linked && linked.seq === action.seq));
  if (unusedActions.length) {
    lines.push('');
    lines.push(`// 未产生请求的操作（${unusedActions.length} 个，供人工核对）：`);
    for (const action of unusedActions.slice(0, 20)) lines.push(`//   · ${actionLabel(action)}`);
  }
  if (sockets.length) {
    lines.push('');
    lines.push(`// WebSocket（${sockets.length} 个，未生成重放代码）：`);
    for (const socket of sockets.slice(0, 10)) {
      lines.push(`//   · ${socket.url || '(unknown)'} · 发送 ${socket.sent || 0} / 接收 ${socket.received || 0}`);
      for (const frame of (socket.frames || []).slice(0, 3)) {
        const arrow = frame.direction === 'sent' ? '→' : '←';
        lines.push(`//     ${arrow} ${String(frame.text || '').slice(0, 120)}`);
      }
    }
  }
  lines.push('');
  lines.push(`console.log('done', Object.keys(results).length, 'steps');`);
  if (!isBrowser) {
    lines.push('');
    lines.push('export { results };');
  }

  const scenario = {
    generatedAt: new Date(generatedAt).toISOString(),
    runtime,
    baseUrl,
    startedAt: capture.startedAt || 0,
    stoppedAt: capture.stoppedAt || 0,
    actions: actions.map((action) => ({
      seq: action.seq,
      at: action.at,
      kind: action.kind,
      selector: action.selector,
      text: action.text,
      value: action.masked ? '••••••' : action.value,
    })),
    requests: steps.map(({ request, action }, index) => ({
      step: index + 1,
      method: String(request.method || 'GET').toUpperCase(),
      path: requestPath(request.url, baseUrl),
      status: request.status,
      mimeType: request.mimeType,
      actionSeq: action?.seq ?? null,
      action: action ? actionLabel(action) : '',
    })),
    sockets: sockets.map((socket) => ({
      url: socket.url,
      sent: socket.sent,
      received: socket.received,
      sample: (socket.frames || []).slice(0, 5).map((frame) => ({ direction: frame.direction, text: frame.text })),
    })),
  };

  const summary = [
    `录制时长 ${Math.max(0, Math.round(((capture.stoppedAt || generatedAt) - (capture.startedAt || generatedAt)) / 1000))}s`,
    `${actions.length} 个操作`,
    `${steps.length} 个可重放请求`,
    sockets.length ? `${sockets.length} 个 WebSocket` : '',
    baseUrl ? `站点 ${baseUrl}` : '',
  ].filter(Boolean).join(' · ');

  return { script: lines.join('\n'), scenario, summary, baseUrl };
}
