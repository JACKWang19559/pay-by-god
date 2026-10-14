import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openCdpJobPage } from '../src/cdp-job-page.js';

const origin = 'http://127.0.0.1:9222';
const site = 'https://www.zhipin.com';
const target = (id, url, browserContextId = 'default-context') => ({ id, targetId: id, type: 'page', url, browserContextId, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}` });

function fixture({ targets = [target('boss-page', site + '/web/geek/jobs')], created = target('new-page', 'about:blank'), browserSocket = 'ws://127.0.0.1:9222/devtools/browser/owned-browser', defaultBrowserContextId = 'default-context', respond, probeNavigated = false } = {}) {
  let availableTargets = Array.isArray(targets) ? [...targets] : targets;
  const calls = { http: [], commands: [], browserCommands: [], sockets: [], browserSockets: [], closed: 0, browserClosed: 0 };
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.browser = url.includes('/devtools/browser/'); (this.browser ? calls.browserSockets : calls.sockets).push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    emit(method, params) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method, params }) })); }
    reply(id, result) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) })); }
    send(text) {
      const message = JSON.parse(text);
      (this.browser ? calls.browserCommands : calls.commands).push(message);
      let result;
      if (this.browser) {
        switch (message.method) {
          case 'Target.getBrowserContexts': result = { browserContextIds: ['incognito-context'], defaultBrowserContextId }; break;
          case 'Target.getTargets': result = { targetInfos: Array.isArray(availableTargets) ? availableTargets : [] }; break;
          case 'Target.createTarget': if (Array.isArray(availableTargets)) availableTargets.push(created); result = { targetId: created.id }; break;
          case 'Target.getTargetInfo': {
            const info = availableTargets?.find?.(item => item.id === message.params.targetId) ?? created;
            const previousInfoReads = calls.browserCommands.filter(item => item.method === 'Target.getTargetInfo').length;
            result = { targetInfo: probeNavigated && previousInfoReads > 1 ? { ...info, url: site + '/user-opened' } : info }; break;
          }
          case 'Target.closeTarget': availableTargets = availableTargets.filter(item => item.id !== message.params.targetId); result = { success: true }; break;
          default: throw new Error(`Unexpected browser metadata command: ${message.method}`);
        }
      } else result = respond ? respond(message, this) : message.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main-frame', url: site + '/web/geek/jobs' } } } : {};
      if (result !== undefined) queueMicrotask(() => this.reply(message.id, result));
    }
    close() { if (this.browser) calls.browserClosed++; else calls.closed++; this.dispatchEvent(new Event('close')); }
  }
  const options = {
    timeout: 1000, WebSocket: Socket,
    fetch: async (url, request) => {
      calls.http.push({ url, request });
      return { ok: true, json: async () => url.endsWith('/json/version') ? { webSocketDebuggerUrl: browserSocket } : availableTargets };
    },
  };
  return { calls, options };
}

test('direct page connection enables only Page and Network and never subscribes to Runtime or console', async () => {
  const { calls, options } = fixture({ targets: [target('blank', 'about:blank'), target('foreign', 'https://example.com/'), target('boss', site + '/')] });
  const page = await openCdpJobPage(origin, options);
  assert.equal(calls.sockets[0].url, 'ws://127.0.0.1:9222/devtools/page/boss');
  assert.deepEqual(calls.commands.map(item => item.method), ['Page.enable', 'Network.enable', 'Page.getFrameTree']);
  assert.deepEqual(calls.browserCommands.map(item => item.method), ['Target.getBrowserContexts', 'Target.getTargets']);
  assert.equal(calls.browserClosed, 1, 'Browser metadata socket is released before page initialization');
  assert.equal(page.url(), site + '/web/geek/jobs');
  assert.equal(page.isClosed(), false);
  const frame = page.mainFrame();
  const navigation = page.goto(site + '/web/geek/jobs?query=Python');
  calls.sockets[0].emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main-frame', url: 'about:blank' } });
  assert.equal(page.url(), site + '/web/geek/jobs');
  calls.sockets[0].emit('Page.frameNavigated', { frame: { id: 'main-frame', url: site + '/web/geek/jobs?query=Python' } });
  await navigation;
  assert.equal(page.url(), site + '/web/geek/jobs?query=Python');
  assert.equal(page.mainFrame(), frame);
  assert.ok(calls.commands.every(item => !/^(Runtime|Log|Debugger|Console)\./.test(item.method)));
  assert.equal(calls.http[0].request.redirect, 'error');
  assert.equal(Object.hasOwn(calls.http[0].request, 'headers'), false);
  await page.release();
  assert.equal(page.isClosed(), true);
  assert.ok(calls.commands.every(item => item.method !== 'Browser.close' && item.method !== 'Target.closeTarget'));
});

test('empty or unrelated default-context pages use an existing blank page or create one without a context override', async () => {
  for (const useBlank of [true, false]) {
    const { calls, options } = fixture({ targets: [target('foreign', 'https://example.com/'), ...(useBlank ? [target('blank', 'about:blank')] : [])] });
    const page = await openCdpJobPage('ws://127.0.0.1:9222/devtools/browser/owned-browser', options);
    assert.equal(calls.sockets[0].url, `ws://127.0.0.1:9222/devtools/page/${useBlank ? 'blank' : 'new-page'}`);
    assert.equal(calls.http[0].url, origin + '/json/version');
    assert.equal(calls.http.length, 2);
    if (!useBlank) assert.deepEqual(calls.browserCommands.find(item => item.method === 'Target.createTarget').params, { url: 'about:blank' });
    await page.release();
  }
});

test('an explicit browser WebSocket identity is verified before inspecting or changing any page', async () => {
  for (const browserSocket of ['ws://127.0.0.1:9222/devtools/browser/replaced-browser', 'ws://127.0.0.1:9333/devtools/browser/owned-browser', 'ws://example.com:9222/devtools/browser/owned-browser', 'ws://user:pass@127.0.0.1:9222/devtools/browser/owned-browser', 'ws://127.0.0.1:9222/devtools/browser/owned-browser?other=1']) {
    const { calls, options } = fixture({ browserSocket });
    await assert.rejects(() => openCdpJobPage('ws://127.0.0.1:9222/devtools/browser/owned-browser', options), { code: 'BROWSER_CONNECTION_FAILED' });
    assert.deepEqual(calls.http.map(item => item.url), [origin + '/json/version']);
    assert.equal(calls.sockets.length, 0);
  }
});

test('default context selection excludes incognito pages and prioritizes an existing verification page', async () => {
  const { calls, options } = fixture({ targets: [
    target('incognito-verification', site + '/web/passport/zp/verify.html', 'incognito-context'),
    target('default-jobs', site + '/web/geek/jobs'),
    target('default-verification', site + '/web/passport/zp/security.html'),
    target('unknown-context', site + '/web/user/safe/verify-slider', null),
  ] });
  const page = await openCdpJobPage(origin, options);
  assert.equal(calls.sockets[0].url, 'ws://127.0.0.1:9222/devtools/page/default-verification');
  assert.equal(calls.browserCommands.some(item => /createTarget|closeTarget/.test(item.method)), false);
  assert.ok(calls.browserCommands.every(item => !/enable|attach/i.test(item.method)));
  await page.release();
});

test('missing default context metadata uses a new default-context probe and closes only that unused blank', async () => {
  const { calls, options } = fixture({ defaultBrowserContextId: null, targets: [
    target('incognito-boss', site, 'incognito-context'),
    target('default-boss', site + '/web/geek/jobs'),
    target('user-blank', 'about:blank'),
  ] });
  const page = await openCdpJobPage(origin, options);
  assert.equal(calls.sockets[0].url, 'ws://127.0.0.1:9222/devtools/page/default-boss');
  assert.deepEqual(calls.browserCommands.filter(item => item.method === 'Target.createTarget').map(item => item.params), [{ url: 'about:blank' }]);
  assert.deepEqual(calls.browserCommands.filter(item => item.method === 'Target.closeTarget').map(item => item.params), [{ targetId: 'new-page' }]);
  assert.equal(calls.browserClosed, 1);
  await page.release();
});

test('an unidentifiable default context uses its newly created page without reusing unknown or incognito pages', async () => {
  const { calls, options } = fixture({ defaultBrowserContextId: null, created: target('new-default', 'about:blank', null), targets: [
    target('unknown-verification', site + '/web/passport/zp/verify.html', null),
    target('unknown-blank', 'about:blank', null),
    target('incognito-boss', site, 'incognito-context'),
  ] });
  const page = await openCdpJobPage(origin, options);
  assert.equal(calls.sockets[0].url, 'ws://127.0.0.1:9222/devtools/page/new-default');
  assert.equal(calls.browserCommands.some(item => item.method === 'Target.closeTarget'), false);
  await page.release();
});

test('an unused probe that the user navigated is preserved', async () => {
  const { calls, options } = fixture({ defaultBrowserContextId: null, probeNavigated: true });
  const page = await openCdpJobPage(origin, options);
  assert.equal(calls.sockets[0].url, 'ws://127.0.0.1:9222/devtools/page/boss-page');
  assert.equal(calls.browserCommands.some(item => item.method === 'Target.closeTarget'), false);
  await page.release();
});

test('endpoint and target validation reject foreign, mismatched and credential-bearing destinations', async () => {
  for (const endpoint of ['http://example.com:9222', 'http://127.0.0.1:0', 'http://user:pass@127.0.0.1:9222', 'http://127.0.0.1:9222/other', 'ws://127.0.0.1:9222/devtools/page/page1', 'http://127.0.0.1:9222/?next=1']) {
    const { calls, options } = fixture();
    await assert.rejects(() => openCdpJobPage(endpoint, options), { code: 'BROWSER_CONNECTION_FAILED' });
    assert.equal(calls.http.length, 0);
  }
  for (const webSocketDebuggerUrl of ['ws://example.com:9222/devtools/page/boss-page', 'ws://127.0.0.1:9333/devtools/page/boss-page', 'ws://127.0.0.1:9222/devtools/page/other', 'ws://user:pass@127.0.0.1:9222/devtools/page/boss-page']) {
    const { calls, options } = fixture({ targets: [{ ...target('boss-page', site), webSocketDebuggerUrl }] });
    await assert.rejects(() => openCdpJobPage(origin, options), { code: 'BROWSER_CONNECTION_FAILED' });
    assert.equal(calls.sockets.length, 0);
  }
});

test('only relevant Boss list bodies are read after loadingFinished, preserving main versus child frame identity', async () => {
  const payload = { code: 0, zpData: { jobList: [] } };
  const { calls, options } = fixture({ respond: message => message.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main-frame', url: site + '/web/geek/jobs' } } } : message.method === 'Network.getResponseBody' ? { body: Buffer.from(JSON.stringify(payload)).toString('base64'), base64Encoded: true } : {} });
  const page = await openCdpJobPage(origin, options);
  const socket = calls.sockets[0];
  let emitted = 0;
  page.on('response', () => emitted++);
  for (const [requestId, url] of [['foreign', 'https://example.com/wapi/zpgeek/search/joblist.json'], ['other', site + '/wapi/zprelation/friend/geekFilterByLabel']]) {
    socket.emit('Network.responseReceived', { requestId, frameId: 'main-frame', response: { url, status: 200, headers: { Authorization: 'must-not-be-copied' } } });
    socket.emit('Network.loadingFinished', { requestId });
  }
  assert.equal(emitted, 0);
  assert.equal(calls.commands.filter(item => item.method === 'Network.getResponseBody').length, 0);
  for (const frameId of ['main-frame', 'child-frame']) {
    const event = once(page, 'response');
    socket.emit('Network.responseReceived', { requestId: frameId, frameId, response: { url: site + '/wapi/zpgeek/search/joblist.json', status: 200 } });
    assert.equal(emitted, frameId === 'main-frame' ? 0 : 1, 'response is delayed until body completion');
    socket.emit('Network.loadingFinished', { requestId: frameId });
    const [response] = await event;
    assert.equal(response.url(), site + '/wapi/zpgeek/search/joblist.json');
    assert.equal(response.status(), 200);
    assert.equal(response.request().frame() === page.mainFrame(), frameId === 'main-frame');
    assert.deepEqual(await response.json(), payload);
    assert.deepEqual(Object.keys(response).sort(), ['json', 'request', 'status', 'url']);
  }
  await page.release();
});

test('failed bodies preserve HTTP response metadata and reject JSON access', async () => {
  const { calls, options } = fixture({ respond: message => message.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main-frame', url: site } } } : message.method === 'Network.getResponseBody' ? { body: 'not json' } : {} });
  const page = await openCdpJobPage(origin, options);
  const event = once(page, 'response');
  calls.sockets[0].emit('Network.responseReceived', { requestId: 'limited', frameId: 'main-frame', response: { url: site + '/wapi/zpgeek/recommend/job/list.json', status: 429 } });
  calls.sockets[0].emit('Network.loadingFinished', { requestId: 'limited' });
  const [response] = await event;
  assert.equal(response.status(), 429);
  await assert.rejects(() => response.json(), SyntaxError);
  await page.release();
});

test('the current PC recommendation job list is a supported initialization response', async () => {
  const payload = { code: 0, zpData: { jobList: [{ encryptJobId: 'recommended-job' }] } };
  const { calls, options } = fixture({ respond: message => message.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main-frame', url: site + '/web/geek/jobs' } } } : message.method === 'Network.getResponseBody' ? { body: JSON.stringify(payload) } : {} });
  const page = await openCdpJobPage(origin, options);
  const event = once(page, 'response');
  calls.sockets[0].emit('Network.responseReceived', { requestId: 'pc-recommend', frameId: 'main-frame', response: { url: site + '/wapi/zpgeek/pc/recommend/job/list.json', status: 200 } });
  calls.sockets[0].emit('Network.loadingFinished', { requestId: 'pc-recommend' });
  const [response] = await event;
  assert.equal(response.request().frame(), page.mainFrame());
  assert.deepEqual(await response.json(), payload);
  await page.release();
});

test('command timeout and disconnect reject pending work without closing a browser target', async () => {
  let hang = false;
  const { calls, options } = fixture({ respond: message => hang ? undefined : message.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main-frame', url: site } } } : {} });
  const page = await openCdpJobPage(origin, { ...options, timeout: 25 });
  hang = true;
  await assert.rejects(() => page.command('Page.getFrameTree'), { code: 'BROWSER_COMMAND_TIMEOUT' });
  const pending = page.command('Page.getFrameTree');
  const rejection = assert.rejects(pending, { code: 'BROWSER_CONNECTION_FAILED' });
  await page.release();
  await page.release();
  await rejection;
  assert.equal(page.pending.size, 0);
  assert.equal(calls.closed, 1);
  assert.ok(calls.commands.every(item => !/closeTarget|Browser.close/.test(item.method)));
});

test('navigation requires a main frame commit, handles same-document commits, and cleans up after timeouts', async () => {
  const { calls, options } = fixture();
  const page = await openCdpJobPage(origin, options);
  await assert.rejects(() => page.goto('https://example.com/'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(() => page.goto(site + '/web/geek/jobs', { timeout: 15 }), { code: 'BROWSER_NAVIGATION_FAILED' });
  assert.equal(page.listenerCount('mainFrameCommit'), 0);
  assert.equal(page.listenerCount('connectionClosed'), 0);
  const navigation = page.goto(site + '/web/geek/jobs?city=101270100');
  calls.sockets[0].emit('Page.navigatedWithinDocument', { frameId: 'main-frame', url: site + '/web/geek/jobs?city=101270100' });
  await navigation;
  assert.equal(page.url(), site + '/web/geek/jobs?city=101270100');
  await page.release();
});

test('initialization failure releases the socket and malformed HTTP data cannot select a target', async () => {
  const broken = fixture({ respond: () => ({}) });
  await assert.rejects(() => openCdpJobPage(origin, broken.options), { code: 'BROWSER_CONNECTION_FAILED' });
  assert.equal(broken.calls.closed, 1);
  const malformed = fixture({ targets: {} });
  await assert.rejects(() => openCdpJobPage(origin, malformed.options), { code: 'BROWSER_CONNECTION_FAILED' });
  assert.equal(malformed.calls.sockets.length, 0);
});
