/**
 * Host 侧协议自测：不启动浏览器，用一个「假扩展」WebSocket 客户端验证
 * 握手鉴权、RPC 往返、超时、以及 page_* 工具的渲染。
 *
 * 运行：node --test test/protocol.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { createTools } from '../src/tools.js';

const EXT_ID = 'hlfcjpadcahkpbdnhomoagoekopdmnfo';
const PORT = 51991;

/** 假的浏览器扩展：自动应答 RPC，并支持按方法覆盖返回值。 */
function connectFakeExtension({ port = PORT, origin = `chrome-extension://${EXT_ID}` } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge?v=1&client=fake`, { headers: { Origin: origin } });
    const handlers = new Map();
    const calls = [];
    const client = {
      handlers,
      calls,
      socket,
      reply(method, fn) { handlers.set(method, fn); },
    };
    const timer = setTimeout(() => reject(new Error('连接超时')), 5_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(client);
    });
    socket.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(new Error(`连接失败：${event?.message ?? 'unknown'}`));
    });
    socket.addEventListener('message', async (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'welcome') {
        socket.send(JSON.stringify({
          type: 'hello',
          protocol: 1,
          client: { id: 'fake', name: 'Fake Edge', version: '9.9.9', platform: 'test' },
          capabilities: ['eval'],
        }));
        return;
      }
      if (message.type !== 'request') return;
      calls.push(message);
      const handler = handlers.get(message.method) || (() => ({}));
      try {
        const result = await handler(message.params);
        socket.send(JSON.stringify({ type: 'reply', id: message.id, ok: true, result }));
      } catch (error) {
        socket.send(JSON.stringify({ type: 'reply', id: message.id, ok: false, error: { message: String(error.message || error) } }));
      }
    });
  });
}

test('协议：握手、鉴权与 RPC 往返', async (t) => {
  const bridge = new Bridge({ port: PORT });
  await bridge.start();
  const fake = await connectFakeExtension();
  const tools = Object.fromEntries(createTools(bridge).map((tool) => [tool.name, tool]));
  const exec = { signal: new AbortController().signal };

  try {
    await t.test('连接状态与 hello', async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const status = bridge.status();
      assert.equal(status.connected, true);
      assert.equal(status.client.name, 'Fake Edge');
      assert.equal(status.port, PORT);
    });

    await t.test('page_status 渲染已连接与标签页', async () => {
      fake.reply('tabs.list', () => ({
        tabs: [
          { tabId: 7, windowId: 1, active: true, title: '示例页面', url: 'https://example.com/', status: 'complete', granted: true, attached: true },
          { tabId: 8, windowId: 1, active: false, title: '未授权页', url: 'https://other.test/', status: 'complete', granted: false, attached: false },
        ],
        defaultTabId: 7,
      }));
      const value = await tools.page_status.execute({}, exec);
      assert.equal(value.connected, true);
      assert.equal(value.defaultTabId, 7);
      const rendered = tools.page_status.output.render({}, value)[0].text;
      assert.match(rendered, /已连接（Fake Edge/);
      assert.match(rendered, /#7 \[前台\] 示例页面/);
      assert.match(rendered, /#8 未授权页/);
    });

    await t.test('page_eval 往返与异常归一', async () => {
      fake.reply('tab.eval', (params) => ({
        tabId: 7,
        url: 'https://example.com/',
        value: params.expression,
        truncated: false,
        exception: '',
      }));
      const ok = await tools.page_eval.execute({ expression: 'document.title' }, exec);
      assert.equal(ok.value, 'document.title');
      assert.match(tools.page_eval.output.render({}, ok)[0].text, /执行成功/);

      fake.reply('tab.eval', () => ({ tabId: 7, url: '', value: '', truncated: false, exception: 'ReferenceError: foo is not defined' }));
      const failed = await tools.page_eval.execute({ expression: 'foo' }, exec);
      assert.match(failed.exception, /ReferenceError/);
      assert.match(tools.page_eval.output.render({}, failed)[0].text, /执行出错：ReferenceError/);
    });

    await t.test('page_query 命中/box 渲染', async () => {
      fake.reply('tab.query', () => ({
        tabId: 7,
        url: 'https://example.com/',
        title: '示例页面',
        matched: 2,
        items: ['标题一', '标题二'],
        truncated: false,
      }));
      const value = await tools.page_query.execute({ selector: 'h2', mode: 'text' }, exec);
      assert.equal(value.matched, 2);
      const rendered = tools.page_query.output.render({ selector: 'h2', mode: 'text' }, value)[0].text;
      assert.match(rendered, /\[0\] 标题一/);

      fake.reply('tab.query', () => ({
        tabId: 7, url: '', title: '', matched: 1, truncated: false,
        items: [{ tag: 'button', id: 'save', classes: 'primary large', text: '保存', x: 10, y: 20, w: 80, h: 32, visible: true, role: 'button', aria: '保存', name: '', type: '' }],
      }));
      const box = await tools.page_query.execute({ selector: 'button', mode: 'box' }, exec);
      assert.match(box.items[0], /<button#save\.primary\.large> 「保存」 @\(10,20\) 80×32 可见 role=button/);
    });

    await t.test('page_network：头部与响应体渲染、nextSeq', async () => {
      fake.reply('tab.network', () => ({
        tabId: 7,
        url: 'https://example.com/',
        total: 1,
        nextSeq: 12,
        captureStartedAt: Date.now(),
        note: '',
        existing: [],
        entries: [{
          seq: 12, type: 'Fetch', method: 'POST', url: 'https://example.com/api/order', status: 200, statusText: 'OK',
          mimeType: 'application/json', failed: false, errorText: '', durationMs: 42, startedAt: Date.now(),
          requestHeaders: { 'content-type': 'application/json', cookie: 'sid=1' },
          requestBody: '{"sku":"A1"}',
          responseHeaders: { 'content-type': 'application/json' },
          body: '{"ok":true}', bodyTruncated: false, bodyOmitted: '',
        }],
      }));
      const value = await tools.page_network.execute({ action: 'list' }, exec);
      assert.equal(value.nextSeq, 12);
      const rendered = tools.page_network.output.render({}, value)[0].text;
      assert.match(rendered, /#12 POST https:\/\/example\.com\/api\/order/);
      assert.match(rendered, /请求头：content-type: application\/json; cookie: sid=1/);
      assert.match(rendered, /响应体：\{"ok":true\}/);
    });

    await t.test('page_console 渲染与级别', async () => {
      fake.reply('tab.console', () => ({
        tabId: 7,
        nextSeq: 3,
        captureStartedAt: Date.now(),
        entries: [{ seq: 3, level: 'error', text: 'boom', kind: 'console', at: Date.now(), url: 'app.js', line: 12 }],
      }));
      const value = await tools.page_console.execute({ action: 'list' }, exec);
      const rendered = tools.page_console.output.render({}, value)[0].text;
      assert.match(rendered, /ERROR boom/);
      assert.match(rendered, /nextSeq=3/);
    });

    await t.test('超时与未连接提示', async () => {
      fake.reply('tab.eval', () => new Promise((resolve) => setTimeout(resolve, 1_500)));
      await assert.rejects(
        () => bridge.request('tab.eval', {}, { timeoutMs: 1_000 }),
        /没有响应 tab\.eval/,
      );
    });
  } finally {
    fake.socket.close();
    await bridge.stop();
  }
});

test('鉴权：拒绝网页来源，接受扩展来源', async (t) => {
  const bridge = new Bridge({ port: PORT + 1 });
  await bridge.start();
  try {
    await t.test('https 来源被拒绝', async () => {
      await assert.rejects(() => connectFakeExtension({ port: PORT + 1, origin: 'https://evil.test' }), /连接失败|401|403/);
    });
    await t.test('错误扩展 ID 被拒绝', async () => {
      const other = 'a'.repeat(32);
      await assert.rejects(() => connectFakeExtension({ port: PORT + 1, origin: `chrome-extension://${other}` }), /连接失败|403/);
    });
    await t.test('正确扩展来源被接受', async () => {
      const fake = await connectFakeExtension({ port: PORT + 1 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(bridge.status().connected, true);
      fake.socket.close();
    });
  } finally {
    await bridge.stop();
  }
});

test('令牌：配置后必须匹配', async (t) => {
  const bridge = new Bridge({ port: PORT + 2, token: 's3cret' });
  await bridge.start();
  try {
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${PORT + 2}/bridge`, { headers: { Origin: `chrome-extension://${EXT_ID}` } });
        socket.addEventListener('open', () => resolve(socket));
        socket.addEventListener('error', () => reject(new Error('连接失败')));
      }),
      /连接失败/,
    );
    const ok = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${PORT + 2}/bridge?token=s3cret`, { headers: { Origin: `chrome-extension://${EXT_ID}` } });
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', () => reject(new Error('连接失败')));
    });
    assert.ok(ok);
  } finally {
    await bridge.stop();
  }
});
