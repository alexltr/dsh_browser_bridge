/**
 * 真实浏览器端到端测试：
 *   启动 Edge + 侧载扩展 → 扩展连上本地桥 → 授权 fixture 标签页 →
 *   用和模型完全相同的 RPC 验证 元素查询 / JS 执行 / 网络抓包 / 控制台 / 点击 / 输入 / 取消授权。
 *
 * 用法：node test/extension.e2e.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'file:///C:/Users/alexl/.dsh/profiles/desktop/node_modules/playwright-core/index.mjs';
import { Bridge } from '../dsh-browser-bridge/src/bridge.js';
import { buildReplayScript } from '../dsh-browser-bridge/src/script-gen.js';
import { startFixture } from '../fixture/server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXTENSION = path.resolve(import.meta.dirname, '..', 'extension');
const PROFILE = path.resolve(import.meta.dirname, '..', '_probe', 'e2e-profile');
const EXTENSION_ID = 'hlfcjpadcahkpbdnhomoagoekopdmnfo';
const BRIDGE_PORT = 51994;
const FIXTURE_PORT = 8767;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✘ ${name}\n    ${error.message}`);
  }
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(200);
  }
  throw new Error(`等待超时：${label}`);
}

const bridge = new Bridge({ port: BRIDGE_PORT });
let fixture;
let context;

try {
  await fs.rm(PROFILE, { recursive: true, force: true });
  await bridge.start();
  fixture = await startFixture(FIXTURE_PORT);

  console.log('\n1) 启动 Edge 并侧载扩展');
  context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: false,
    viewport: { width: 1280, height: 820 },
    args: [
      `--load-extension=${EXTENSION}`,
      `--disable-extensions-except=${EXTENSION}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,860',
    ],
  });
  check('Edge 启动', () => assert.ok(context));

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${FIXTURE_PORT}/`, { waitUntil: 'load' });
  check('fixture 页面已打开', () => assert.equal(page.url(), `http://127.0.0.1:${FIXTURE_PORT}/`));

  console.log('\n2) 扩展连接本地桥');
  // 打开扩展页面：既唤醒 SW，也把测试端口写进扩展配置（默认端口是 51919）。
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`).catch(() => {});
  await popup.evaluate((port) => chrome.storage.local.set({ bridgePort: port }), BRIDGE_PORT).catch(() => {});
  await popup.evaluate((port) => chrome.runtime.sendMessage({ type: 'reconnect', port }), BRIDGE_PORT).catch(() => {});
  let connected = false;
  try {
    await waitFor(() => bridge.status().connected, 15_000, '扩展连接');
    connected = true;
  } catch {
    await popup.evaluate((port) => chrome.runtime.sendMessage({ type: 'reconnect', port }), BRIDGE_PORT).catch(() => {});
    await waitFor(() => bridge.status().connected, 10_000, '扩展连接（重试）');
    connected = true;
  }
  check('扩展已连接（hello 完成）', () => assert.equal(connected, true));
  check('桥报告客户端信息', () => assert.match(bridge.status().client.name, /Edge|Chrome/));

  console.log('\n3) 列出标签页并授权 fixture');
  const listed = await bridge.request('tabs.list', {});
  check('tabs.list 返回标签页', () => assert.ok(Array.isArray(listed.tabs) && listed.tabs.length > 0));
  const target = listed.tabs.find((tab) => tab.url.startsWith(`http://127.0.0.1:${FIXTURE_PORT}`));
  check('找到 fixture 标签页', () => assert.ok(target, '未找到 fixture 标签页'));
  await bridge.request('tab.grant', { tabId: target.tabId });
  const granted = await bridge.request('tabs.list', {});
  check('标签页显示已授权', () => {
    const tab = granted.tabs.find((item) => item.tabId === target.tabId);
    assert.equal(tab.granted, true);
    assert.equal(tab.attached, true);
  });

  console.log('\n4) 重新加载以从零抓取网络');
  await bridge.request('tab.reload', { tabId: target.tabId }, { timeoutMs: 35_000 });
  await sleep(600);
  const loaded = await bridge.request('tab.eval', { tabId: target.tabId, expression: 'document.title' });
  check('reload 后页面可执行 JS', () => assert.equal(loaded.value, 'Fixture 页面'));

  console.log('\n5) 元素读取');
  const h1 = await bridge.request('tab.query', { tabId: target.tabId, selector: 'h1#title', mode: 'text' });
  check('text 模式读到标题', () => {
    assert.equal(h1.matched, 1);
    assert.equal(h1.items[0], 'Fixture 页面');
  });
  const count = await bridge.request('tab.query', { tabId: target.tabId, selector: '#items li', mode: 'count' });
  check('count 模式统计列表项', () => assert.equal(count.matched, 3));
  const attr = await bridge.request('tab.query', { tabId: target.tabId, selector: '#q', mode: 'attr', attr: 'placeholder' });
  check('attr 模式读属性', () => assert.equal(attr.items[0], '输入关键词'));
  const shadow = await bridge.request('tab.query', { tabId: target.tabId, selector: 'span.shadow-text', mode: 'text', pierce: true });
  check('pierce 穿透 Shadow DOM', () => assert.equal(shadow.items[0], 'Shadow 内容'));
  const box = await bridge.request('tab.query', { tabId: target.tabId, selector: 'button', mode: 'box' });
  check('box 模式返回尺寸与可见性', () => {
    assert.ok(box.matched >= 2);
    assert.equal(box.items[0].visible, true);
    assert.ok(box.items[0].w > 0 && box.items[0].h > 0);
  });

  console.log('\n6) 执行 JS（含异步与异常）');
  const title = await bridge.request('tab.eval', { tabId: target.tabId, expression: 'document.title' });
  check('同步表达式', () => assert.equal(title.value, 'Fixture 页面'));
  const asyncEval = await bridge.request('tab.eval', {
    tabId: target.tabId,
    expression: '(async () => { const r = await fetch("/api/list"); return await r.json(); })()',
  });
  check('异步 IIFE 返回对象 JSON', () => assert.match(asyncEval.value, /"items":\[1,2,3\]/));
  const failed = await bridge.request('tab.eval', { tabId: target.tabId, expression: '(() => { throw new Error("boom-e2e"); })()' });
  check('页面异常被归一为 exception', () => assert.match(failed.exception, /boom-e2e/));
  const big = await bridge.request('tab.eval', { tabId: target.tabId, expression: '"x".repeat(50000)' });
  check('超长结果被截断', () => assert.equal(big.truncated, true));

  console.log('\n7) 点击 + 网络抓包');
  await bridge.request('tab.click', { tabId: target.tabId, selector: '#save', waitMs: 200 });
  const net = await bridge.request('tab.network', {
    tabId: target.tabId,
    action: 'wait',
    urlContains: '/api/echo',
    waitTimeoutMs: 8_000,
  });
  check('等待并捕获到 POST /api/echo', () => {
    assert.ok(net.entries.length >= 1, '没有捕获到 /api/echo');
    const entry = net.entries.at(-1);
    assert.equal(entry.method, 'POST');
    assert.equal(entry.status, 200);
    assert.match(entry.requestBody, /"sku":"A1"/);
    assert.match(entry.body, /"ok":true/);
    assert.match(entry.requestHeaders['content-type'], /application\/json/);
  });
  check('网络条目带耗时与时间戳', () => {
    const entry = net.entries.at(-1);
    assert.ok(entry.durationMs >= 0);
    assert.ok(entry.startedAt > 0);
  });

  console.log('\n8) 控制台');
  await sleep(400); // 等扩展把 console 里的对象参数展开成 JSON
  const logs = await bridge.request('tab.console', { tabId: target.tabId, action: 'list' });
  check('捕获 console.info/warn/log', () => {
    assert.ok(logs.entries.some((entry) => /fixture ready/.test(entry.text)));
    assert.ok(logs.entries.some((entry) => /saved/.test(entry.text)));
  });
  check('console 对象参数展开为 JSON', () => {
    assert.ok(logs.entries.some((entry) => /"ok":true/.test(entry.text)), JSON.stringify(logs.entries.map((entry) => entry.text)));
  });
  const errors = await bridge.request('tab.console', { tabId: target.tabId, action: 'list', level: 'error' });
  check('按级别过滤', () => assert.equal(errors.entries.every((entry) => entry.level === 'error'), true));

  console.log('\n9) 输入');
  await bridge.request('tab.type', { tabId: target.tabId, selector: '#q', text: 'hello' });
  const typed = await bridge.request('tab.eval', {
    tabId: target.tabId,
    expression: "document.querySelector('#q').value + '|' + document.querySelector('#echo').textContent",
  });
  check('fill 写值并触发 input 事件', () => assert.equal(typed.value, 'hello|hello'));

  console.log('\n10) 清空后用 performance 兜底');
  await bridge.request('tab.network', { tabId: target.tabId, action: 'clear' });
  const fallback = await bridge.request('tab.network', { tabId: target.tabId, action: 'list', limit: 50 });
  check('existing 兜底列出已发生资源', () => {
    assert.ok(fallback.existing.length > 0);
    assert.ok(fallback.existing.some((item) => item.url.includes('/api/')));
  });

  console.log('\n11) 严格 CSP 页面仍可分析');
  await bridge.request('tab.navigate', { tabId: target.tabId, url: `http://127.0.0.1:${FIXTURE_PORT}/csp` }, { timeoutMs: 35_000 });
  const cspTitle = await bridge.request('tab.query', { tabId: target.tabId, selector: '#csp-title', mode: 'text' });
  check('CSP 页面元素可读', () => assert.equal(cspTitle.items[0], 'CSP 页面'));
  const cspEval = await bridge.request('tab.eval', { tabId: target.tabId, expression: "eval('6*7') + '|' + new Function('return 6*7')()" });
  check('页面禁用 eval 时仍能执行 JS', () => assert.match(cspEval.value, /^42\|42$/));

  console.log('\n12) iframe：同源与跨进程');
  await bridge.request('tab.navigate', { tabId: target.tabId, url: `http://127.0.0.1:${FIXTURE_PORT}/frames` }, { timeoutMs: 35_000 });
  await sleep(1200);
  const frameList = await bridge.request('tab.frames', { tabId: target.tabId });
  const sameFrame = frameList.frames.find((frame) => frame.url.includes('tag=same'));
  const crossFrame = frameList.frames.find((frame) => frame.url.includes('tag=cross'));
  check('列出主页面与两个 iframe', () => {
    assert.ok(frameList.frames.length >= 3, JSON.stringify(frameList.frames));
    assert.ok(sameFrame, '缺少同源 iframe');
    assert.ok(crossFrame, '缺少跨进程 iframe');
    assert.equal(crossFrame.crossProcess, true);
    assert.equal(sameFrame.crossProcess, false);
  });
  const sameQuery = await bridge.request('tab.query', { tabId: target.tabId, frame: sameFrame.index, selector: '#inner-title', mode: 'text' });
  check('同源 iframe 内查询元素', () => assert.equal(sameQuery.items[0], '内嵌页面 same'));
  const crossQuery = await bridge.request('tab.query', { tabId: target.tabId, frame: crossFrame.index, selector: '#inner-title', mode: 'text' });
  check('跨进程 iframe 内查询元素', () => assert.equal(crossQuery.items[0], '内嵌页面 cross'));
  const crossEval = await bridge.request('tab.eval', { tabId: target.tabId, frame: crossFrame.index, expression: 'document.title + "|" + location.host' });
  check('跨进程 iframe 内执行 JS', () => assert.match(crossEval.value, /Iframe 内层 cross\|localhost/));
  await bridge.request('tab.click', { tabId: target.tabId, frame: sameFrame.index, selector: '#inner-btn', waitMs: 400 });
  const iframeNet = await bridge.request('tab.network', { tabId: target.tabId, action: 'wait', urlContains: 'from-iframe-same', waitTimeoutMs: 8_000 });
  check('同源 iframe 内点击触发请求', () => assert.ok(iframeNet.entries.length >= 1));
  await bridge.request('tab.click', { tabId: target.tabId, frame: crossFrame.index, selector: '#inner-btn', waitMs: 600 });
  const crossOut = await bridge.request('tab.eval', { tabId: target.tabId, frame: crossFrame.index, expression: "document.querySelector('#inner-out').textContent" });
  check('跨进程 iframe 内点击生效', () => assert.match(crossOut.value, /from-iframe-cross/));

  console.log('\n13) WebSocket 帧捕获');
  await bridge.request('tab.navigate', { tabId: target.tabId, url: `http://127.0.0.1:${FIXTURE_PORT}/ws` }, { timeoutMs: 35_000 });
  await sleep(2_000);
  const sockets = await bridge.request('tab.socket', { tabId: target.tabId, action: 'list', limit: 30 });
  check('捕获 WebSocket 会话与双向帧', () => {
    assert.ok(sockets.sockets.length >= 1, JSON.stringify(sockets));
    const socket = sockets.sockets[0];
    assert.equal(socket.status, 101);
    assert.ok(socket.sent >= 1, '没有发送帧');
    assert.ok(socket.received >= 1, '没有接收帧');
    assert.ok(socket.frames.some((frame) => frame.text.includes('hello')));
    assert.ok(socket.frames.some((frame) => frame.direction === 'received'));
  });
  const wsWait = await bridge.request('tab.socket', { tabId: target.tabId, action: 'wait', direction: 'received', textContains: 'server', waitTimeoutMs: 8_000 });
  check('等待服务端推送帧', () => assert.ok(wsWait.sockets.some((socket) => socket.frames.some((frame) => frame.text.includes('server')))));

  console.log('\n14) 录制操作并生成请求脚本');
  await bridge.request('tab.navigate', { tabId: target.tabId, url: `http://127.0.0.1:${FIXTURE_PORT}/` }, { timeoutMs: 35_000 });
  await bridge.request('tab.record', { tabId: target.tabId, action: 'start' });
  await bridge.request('tab.type', { tabId: target.tabId, selector: '#q', text: 'abc' });
  await bridge.request('tab.click', { tabId: target.tabId, selector: '#search', waitMs: 400 });
  await bridge.request('tab.click', { tabId: target.tabId, selector: '#save', waitMs: 400 });
  const recording = await bridge.request('tab.record', { tabId: target.tabId, action: 'stop' }, { timeoutMs: 30_000 });
  check('录制到输入与两次点击', () => {
    assert.ok(recording.actions.some((action) => action.kind === 'input' && action.value === 'abc'), JSON.stringify(recording.actions));
    assert.ok(recording.actions.some((action) => action.kind === 'click' && action.selector.includes('search')));
    assert.ok(recording.actions.some((action) => action.kind === 'click' && action.selector.includes('save')));
  });
  check('录制到两个接口请求', () => {
    assert.ok(recording.requests.some((request) => request.url.includes('/api/list?q=abc')));
    assert.ok(recording.requests.some((request) => request.method === 'POST' && request.url.includes('/api/echo')));
  });
  const generated = buildReplayScript(recording, { runtime: 'node', generatedAt: Date.now() });
  check('生成脚本按顺序包含两步请求', () => {
    assert.match(generated.script, /results\.step1 = await call\("GET", "\/api\/list\?q=abc"/);
    assert.match(generated.script, /results\.step2 = await call\("POST", "\/api\/echo"/);
    assert.doesNotMatch(generated.script, /headers: \{[^}]*cookie/i);
  });
  const flowFile = path.join(ROOT, '_scratch', 'generated-flow.mjs');
  await fs.mkdir(path.dirname(flowFile), { recursive: true });
  await fs.writeFile(flowFile, generated.script, 'utf8');
  const flowModule = await import(`${pathToFileURL(flowFile).href}?t=${Date.now()}`);
  check('生成的脚本可直接运行并拿到 200', () => {
    assert.equal(flowModule.results?.step1?.status, 200);
    assert.equal(flowModule.results?.step2?.status, 200);
    assert.match(flowModule.results.step2.text, /"ok":true/);
  });

  console.log('\n15) 取消授权后拒绝访问');
  await bridge.request('tab.grant', { tabId: target.tabId, grant: false });
  await assert.rejects(
    () => bridge.request('tab.eval', { tabId: target.tabId, expression: '1+1' }),
    /未授权/,
  );
  check('取消授权立即生效', () => assert.ok(true));
} catch (error) {
  failures.push({ name: '未捕获异常', error });
  console.error('\n未捕获异常：', error);
} finally {
  console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
  await context?.close().catch(() => {});
  fixture?.close();
  await bridge.stop();
  await sleep(300);
  if (failures.length) {
    process.exitCode = 1;
    for (const failure of failures) console.error(`- ${failure.name}: ${failure.error.stack || failure.error.message}`);
  }
}
