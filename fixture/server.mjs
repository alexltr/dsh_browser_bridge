/**
 * 测试用 fixture 服务：静态页 + 接口 + WebSocket + iframe 页面。
 * 用法：node fixture/server.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BridgeConnection } from '../dsh-browser-bridge/src/ws-server.js';

const htmlPath = path.join(import.meta.dirname, 'index.html');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const sockets = new Set();

function upgrade(req, socket) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const conn = new BridgeConnection(
    socket,
    { origin: req.headers.origin || '', url: req.url || '', remote: socket.remoteAddress },
    { maxPayload: 1_000_000 },
  );
  sockets.add(conn);
  conn.onMessage = (text) => {
    try {
      conn.sendJson({ echo: JSON.parse(text), at: Date.now() });
    } catch {
      conn.sendText(text);
    }
  };
  conn.onClose = () => sockets.delete(conn);
}

export function createFixtureHandler() {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/echo') {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, received: body ? JSON.parse(body) : null, at: Date.now() }));
      return;
    }
    if (url.pathname === '/api/list') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ items: [1, 2, 3], q: url.searchParams.get('q') || '' }));
      return;
    }
    if (url.pathname === '/api/slow') {
      await new Promise((resolve) => setTimeout(resolve, 400));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ slow: true }));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await fs.readFile(htmlPath);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname === '/frames') {
      const port = req.socket.localPort;
      const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Iframe 页面</title>
<style>body{font:14px/1.6 system-ui;margin:24px}iframe{width:640px;height:180px;border:1px solid #94a3b8;border-radius:8px}</style></head>
<body>
  <h1 id="outer-title">Iframe 外层页面</h1>
  <p>同源 iframe：</p>
  <iframe id="same-frame" name="sameFrame" src="/frames-inner?tag=same"></iframe>
  <p>跨源 iframe（localhost vs 127.0.0.1）：</p>
  <iframe id="cross-frame" name="crossFrame" src="http://localhost:${port}/frames-inner?tag=cross"></iframe>
</body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname === '/frames-inner') {
      const tag = url.searchParams.get('tag') || '';
      const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Iframe 内层 ${tag}</title>
<style>body{font:14px/1.5 system-ui;margin:12px}button{padding:4px 10px}</style></head>
<body>
  <h2 id="inner-title">内嵌页面 ${tag}</h2>
  <p id="inner-text" data-frame="${tag}">这是在 iframe 内部的一段文本。</p>
  <button id="inner-btn" data-frame="${tag}">内嵌按钮</button>
  <input id="inner-input" placeholder="内嵌输入框">
  <pre id="inner-out"></pre>
  <script>
    document.querySelector('#inner-btn').addEventListener('click', async () => {
      const res = await fetch('/api/list?q=from-iframe-${tag}');
      const data = await res.json();
      document.querySelector('#inner-out').textContent = JSON.stringify(data);
      console.log('iframe button clicked', ${JSON.stringify(tag)}, data);
    });
  </script>
</body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname === '/ws') {
      const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>WebSocket 页面</title></head>
<body>
  <h1 id="ws-title">WebSocket 测试页</h1>
  <pre id="ws-log"></pre>
  <script>
    const log = (line) => { window.__wsLog = (window.__wsLog || []).concat(line); document.querySelector('#ws-log').textContent = window.__wsLog.join('\\n'); };
    const ws = new WebSocket('ws://' + location.host + '/ws');
    ws.addEventListener('open', () => {
      log('open');
      ws.send(JSON.stringify({ hello: 'world', at: Date.now() }));
      setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ tick: Date.now() })); }, 1500);
    });
    ws.addEventListener('message', (event) => log('recv ' + event.data));
    window.__ws = ws;
  </script>
</body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname === '/csp') {
      const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>CSP 严格页面</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'none'">
</head>
<body>
  <h1 id="csp-title">CSP 页面</h1>
  <p id="csp-out">CSP 禁止了页面内的内联脚本与 eval。</p>
</body>
</html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };
}

/** 启动 fixture 服务，返回 server（调用方负责 close）。 */
export function startFixture(port) {
  const server = http.createServer(createFixtureHandler());
  server.on('upgrade', (req, socket) => upgrade(req, socket));
  const ticker = setInterval(() => {
    for (const conn of sockets) conn.sendJson({ server: 'tick', at: Date.now() });
  }, 3000);
  ticker.unref();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]) || 8766;
  const server = await startFixture(port);
  console.log(`fixture listening http://127.0.0.1:${port}/`);
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}
