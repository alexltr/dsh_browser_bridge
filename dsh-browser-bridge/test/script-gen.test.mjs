/**
 * 录制脚本生成器单测（纯函数，不需要浏览器）。
 * 运行：node --test test/script-gen.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReplayScript,
  cleanHeaders,
  filterReplayableRequests,
  parseMultipart,
} from '../src/script-gen.js';

const SAMPLE = {
  startedAt: 1_700_000_000_000,
  stoppedAt: 1_700_000_004_000,
  actions: [
    { seq: 1, at: 1_700_000_000_500, kind: 'input', selector: '#q', value: 'hello' },
    { seq: 2, at: 1_700_000_001_000, kind: 'click', selector: 'button#search', text: '查询' },
    { seq: 3, at: 1_700_000_002_000, kind: 'click', selector: 'button#save', text: '保存' },
  ],
  requests: [
    { method: 'GET', url: 'https://app.test/static/app.js', type: 'Script', status: 200, startedAt: 1_700_000_000_100 },
    { method: 'GET', url: 'https://app.test/api/list?q=hello', type: 'Fetch', status: 200, mimeType: 'application/json', startedAt: 1_700_000_001_100, requestHeaders: { accept: '*/*', cookie: 'sid=secret', referer: 'https://app.test/' }, requestBody: '', body: '{"items":[1]}' },
    { method: 'OPTIONS', url: 'https://app.test/api/echo', type: 'XHR', status: 204, startedAt: 1_700_000_001_200 },
    { method: 'POST', url: 'https://app.test/api/echo', type: 'XHR', status: 200, mimeType: 'application/json', startedAt: 1_700_000_002_100, requestHeaders: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' }, requestBody: '{"sku":"A1","qty":2}' },
  ],
  sockets: [
    { url: 'wss://app.test/ws', sent: 1, received: 2, frames: [{ direction: 'sent', text: '{"hello":1}' }, { direction: 'received', text: '{"ok":true}' }] },
  ],
};

test('filterReplayableRequests：只保留业务 xhr/fetch', () => {
  const kept = filterReplayableRequests(SAMPLE.requests);
  assert.deepEqual(kept.map((r) => r.url), [
    'https://app.test/api/list?q=hello',
    'https://app.test/api/echo',
  ]);
});

test('cleanHeaders：去掉 cookie/referer/sec-*，保留 content-type 与 x-requested-with', () => {
  const cleaned = cleanHeaders({
    cookie: 'a=1',
    referer: 'https://app.test/',
    'sec-ch-ua': 'x',
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    accept: '*/*',
  });
  assert.deepEqual(cleaned, {
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    accept: '*/*',
  });
});

test('parseMultipart：拆出字段', () => {
  const body = [
    '------B',
    'Content-Disposition: form-data; name="Module"',
    '',
    'Search',
    '------B',
    'Content-Disposition: form-data; name="Qry.XML"',
    '',
    '<Query/>',
    '------B--',
    '',
  ].join('\r\n');
  const fields = parseMultipart(body, 'multipart/form-data; boundary=----B');
  assert.deepEqual(fields.map((f) => [f.name, f.value]), [['Module', 'Search'], ['Qry.XML', '<Query/>']]);
});

test('node 脚本：按顺序生成 fetch 步骤、动作注释、不写 Cookie', () => {
  const { script, scenario, summary } = buildReplayScript(SAMPLE, { generatedAt: 1_700_000_005_000 });
  assert.match(script, /^#!\/usr\/bin\/env node/);
  assert.match(script, /const BASE = process\.env\.BASE \|\| "https:\/\/app\.test"/);
  assert.match(script, /\[1\] GET \/api\/list\?q=hello/);
  assert.match(script, /触发操作：click button#search/);
  assert.match(script, /\[2\] POST \/api\/echo/);
  assert.match(script, /results\.step1 = await call\("GET", "\/api\/list\?q=hello"/);
  assert.match(script, /headers: \{"content-type":"application\/json","x-requested-with":"XMLHttpRequest"\}/);
  assert.match(script, /body: `\{\n  "sku": "A1",\n  "qty": 2\n\}`/);
  assert.doesNotMatch(script, /sid=secret/);
  assert.doesNotMatch(script, /cookie: "sid/);
  assert.match(script, /WebSocket（1 个/);
  assert.equal(scenario.requests.length, 2);
  assert.equal(scenario.requests[0].actionSeq, 2);
  assert.match(summary, /3 个操作/);
});

test('browser 脚本：使用 credentials:include，且不含 COOKIE 环境变量', () => {
  const { script, scenario } = buildReplayScript(SAMPLE, { runtime: 'browser', generatedAt: 1_700_000_005_000 });
  assert.match(script, /credentials: 'include'/);
  assert.doesNotMatch(script, /DSH_COOKIE/);
  assert.equal(scenario.runtime, 'browser');
});

test('multipart 请求体生成 FormData', () => {
  const body = [
    '------X',
    'Content-Disposition: form-data; name="Module"',
    '',
    'Search',
    '------X',
    'Content-Disposition: form-data; name="Operation"',
    '',
    'QueryByURL',
    '------X--',
    '',
  ].join('\r\n');
  const capture = {
    startedAt: 1_700_000_000_000,
    stoppedAt: 1_700_000_001_000,
    actions: [],
    requests: [{
      method: 'POST', url: 'https://centric.test/csi-requesthandler/RequestHandler', type: 'XHR', status: 200,
      startedAt: 1_700_000_000_500,
      requestHeaders: { 'content-type': 'multipart/form-data; boundary=----X' },
      requestBody: body,
    }],
  };
  const { script } = buildReplayScript(capture, { generatedAt: 1_700_000_002_000 });
  assert.match(script, /const form = new FormData\(\);/);
  assert.match(script, /form\.append\("Module", "Search"\)/);
  assert.match(script, /form\.append\("Operation", "QueryByURL"\)/);
});

test('没有请求时给出明确提示', () => {
  const { script, scenario } = buildReplayScript({ actions: [{ seq: 1, at: 1, kind: 'click', selector: '#x' }], requests: [] }, { generatedAt: 2 });
  assert.match(script, /没有可重放的请求/);
  assert.match(script, /未产生请求的操作/);
  assert.equal(scenario.requests.length, 0);
});
