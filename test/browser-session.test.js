import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { BrowserSession, SITE_ORIGIN, OWNED_ENDPOINT_FILE, availableLoopbackPort, isBossUrl, validateCdpUrl } from '../src/browser-session.js';

async function temporaryProfile(t) {
  const root = os.tmpdir();
  const profileDir = await fs.mkdtemp(path.join(root, 'boss-browser-session-'));
  t.after(async () => {
    const relative = path.relative(root, profileDir);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(profileDir, { recursive: true, force: true });
  });
  return profileDir;
}

function statePage({ url = SITE_ORIGIN, title = 'BOSS直聘', user = '测试求职者', loginVisible = false, readBody = () => { throw new Error('Status must not read private page body'); } } = {}) {
  const document = {
    title,
    querySelector: () => user === null ? null : { textContent: user },
    querySelectorAll: () => loginVisible ? [{ textContent: '登录/注册', getClientRects: () => [1] }] : [],
    get body() { return readBody(); },
  };
  return {
    url: () => url,
    isClosed: () => false,
    setDefaultTimeout() {},
    evaluate: async (callback) => vm.runInNewContext(`(${callback.toString()})()`, { document, location: { href: url } }),
  };
}

function sessionWithPage(page) {
  const session = new BrowserSession({ profile: 'browser-test' });
  session.connect = async () => page;
  return session;
}

function logoutContext() {
  const calls = { cookieFilters: [], storage: [], navigation: [], unloadedTabs: [] };
  const makeTab = (url) => ({
    url: () => url,
    isClosed: () => false,
    goto: async (target, options) => calls.unloadedTabs.push({ from: url, target, options }),
    evaluate: async (callback) => vm.runInNewContext(`(${callback.toString()})()`, {
      localStorage: { clear: () => calls.storage.push({ url, type: 'local' }) },
      sessionStorage: { clear: () => calls.storage.push({ url, type: 'session' }) },
    }),
  });
  const tabs = [makeTab('https://www.zhipin.com/web/geek/chat'), makeTab('https://login.zhipin.com/'), makeTab('https://example.com/private')];
  const context = { clearCookies: async (filter) => calls.cookieFilters.push(filter), pages: () => tabs };
  return { context, page: tabs[0], calls };
}

test('CDP validation permits only explicit loopback ports and rejects malformed URLs as typed usage errors', () => {
  assert.equal(validateCdpUrl('http://127.0.0.1:9222'), 'http://127.0.0.1:9222/');
  assert.equal(validateCdpUrl('ws://localhost:9222/devtools/browser/test'), 'ws://localhost:9222/devtools/browser/test');
  assert.equal(validateCdpUrl('http://[::1]:9222'), 'http://[::1]:9222/');
  for (const url of ['not a URL', '', 'file:///tmp/socket', 'http://example.com:9222', 'https://localhost:9222', 'http://localhost', 'http://user:pass@localhost:9222', 'http://127.0.0.1.example.com:9222']) {
    assert.throws(() => validateCdpUrl(url), { code: 'INVALID_ARGUMENT' }, url);
  }
  assert.equal(isBossUrl('https://www.zhipin.com/'), true);
  assert.equal(isBossUrl('https://login.zhipin.com/'), true);
  for (const url of ['http://www.zhipin.com/', 'https://zhipin.com.example.com/', 'https://evilzhipin.com/', 'invalid']) assert.equal(isBossUrl(url), false);
});

test('port allocation returns a nonzero loopback port and releases its reservation', async () => {
  const port = await availableLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
  assert.equal(server.address().address, '127.0.0.1');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('owned browser launch uses an explicit port, disables extensions and saves its own endpoint manifest', async (t) => {
  const profileDir = await temporaryProfile(t);
  const session = new BrowserSession({ profileDir, browserPath: process.execPath, timeout: 1000 });
  let launched;
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    launched = { executable, args, options };
    return { once() { return this; }, unref() {} };
  });
  session._readEndpointVersion = async endpoint => ({ endpoint, browserPath: '/devtools/browser/new-browser-identity' });
  const endpoint = await session.launch();
  const port = Number(new URL(endpoint).port);
  assert.ok(port > 0 && port <= 65535);
  assert.ok(launched.args.includes(`--remote-debugging-port=${port}`));
  assert.ok(launched.args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(launched.args.includes('--disable-extensions'));
  assert.ok(launched.args.includes(`--user-data-dir=${profileDir}`));
  assert.equal(launched.args.includes('--remote-debugging-port=0'), false);
  assert.equal(launched.args.some(arg => /enable-automation|disable-blink-features/.test(arg)), false);
  const record = JSON.parse(await fs.readFile(path.join(profileDir, OWNED_ENDPOINT_FILE), 'utf8'));
  assert.deepEqual(record, { version: 1, endpoint, browserPath: '/devtools/browser/new-browser-identity', launchMode: 'explicit-port', extensionsDisabled: true });
  await assert.rejects(fs.access(path.join(profileDir, 'DevToolsActivePort')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(profileDir), [OWNED_ENDPOINT_FILE]);
  assert.equal(session.restartRequired, false);
  assert.equal(session.launchMode, 'explicit-port');
});

test('manifest discovery requires the same live browser identity and rejects remote, changed or redirected endpoints', async (t) => {
  const profileDir = await temporaryProfile(t);
  const record = { version: 1, endpoint: 'http://127.0.0.1:9222', browserPath: '/devtools/browser/owned-identity', launchMode: 'explicit-port', extensionsDisabled: true };
  await fs.writeFile(path.join(profileDir, OWNED_ENDPOINT_FILE), JSON.stringify(record));
  const session = new BrowserSession({ profileDir });
  let socket = 'ws://127.0.0.1:9222/devtools/browser/owned-identity';
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    assert.equal(String(url), 'http://127.0.0.1:9222/json/version');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ webSocketDebuggerUrl: socket }) };
  });
  assert.equal(await session.ownedEndpoint(), record.endpoint);
  assert.equal(session.restartRequired, false);
  assert.equal(session.launchMode, 'explicit-port');
  for (const mismatch of ['ws://127.0.0.1:9222/devtools/browser/different-browser', 'ws://127.0.0.1:9333/devtools/browser/owned-identity', 'ws://example.com:9222/devtools/browser/owned-identity', 'ws://user:pass@127.0.0.1:9222/devtools/browser/owned-identity', 'ws://127.0.0.1:9222/devtools/browser/owned-identity?other=1']) {
    socket = mismatch;
    assert.equal(await session.ownedEndpoint(), null, mismatch);
  }
  const before = requests;
  for (const endpoint of ['http://example.com:9222', 'http://127.0.0.1:9222/foreign', 'http://user:pass@127.0.0.1:9222']) {
    await fs.writeFile(path.join(profileDir, OWNED_ENDPOINT_FILE), JSON.stringify({ ...record, endpoint }));
    assert.equal(await session.ownedEndpoint(), null);
  }
  assert.equal(requests, before, 'Untrusted manifest destinations must never be requested');
});

test('legacy DevToolsActivePort stays connectable and reports an actionable restart without killing or relaunching it', async (t) => {
  const profileDir = await temporaryProfile(t);
  await fs.writeFile(path.join(profileDir, 'DevToolsActivePort'), '9222\n/devtools/browser/legacy-identity\n');
  const session = new BrowserSession({ profile: 'legacy', profileDir, browserPath: process.execPath });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/legacy-identity' }) }));
  t.mock.method(childProcess, 'spawn', () => { throw new Error('Must not relaunch an existing owned browser'); });
  assert.equal(await session.launch(), 'http://127.0.0.1:9222');
  assert.equal(session.restartRequired, true);
  assert.equal(session.launchMode, 'legacy-port-zero');
  const page = statePage();
  const browser = { contexts: () => [{ pages: () => [page] }], isConnected: () => true, close: async () => {} };
  t.mock.method(chromium, 'connectOverCDP', async () => browser);
  assert.equal(await session.connect(), page);
  const state = await session.pageState();
  assert.equal(state.authenticated, true);
  assert.equal(state.restartRequired, true);
  assert.match(state.restartInstruction, /boss login --profile legacy/);
  assert.ok(state.restartInstruction.includes(profileDir));
  await assert.rejects(fs.access(path.join(profileDir, OWNED_ENDPOINT_FILE)), { code: 'ENOENT' });
  await session.close();
});

test('an explicit CDP endpoint never inspects or changes the owned profile launch mode', async (t) => {
  const page = statePage();
  const session = new BrowserSession({ cdpUrl: 'http://127.0.0.1:9333' });
  session.ownedEndpoint = async () => { throw new Error('External CDP must not discover or restart an owned profile'); };
  t.mock.method(chromium, 'connectOverCDP', async endpoint => { assert.equal(endpoint, 'http://127.0.0.1:9333/'); return { contexts: () => [{ pages: () => [page] }], close: async () => {} }; });
  assert.equal(await session.connect(), page);
  assert.equal(session.restartRequired, false);
  assert.equal(session.launchMode, 'external-cdp');
  await session.close();
});

test('status does not launch a browser when the configured profile is closed', async () => {
  const session = new BrowserSession({ profile: 'closed-test' });
  let requested;
  session.connect = async (options) => { requested = options; return null; };
  const state = await session.pageState();
  assert.equal(requested.launch, false);
  assert.equal(state.connected, false);
  assert.equal(state.authenticated, false);
  assert.equal(state.profile, 'closed-test');
});

test('status reads navigation identity but never reads private body text', async () => {
  let bodyReads = 0;
  const session = sessionWithPage(statePage({ user: '测试求职者\n个人中心\n退出登录', readBody: () => { bodyReads++; throw new Error('Private body was read'); } }));
  const state = await session.pageState();
  assert.equal(bodyReads, 0);
  assert.equal(state.authenticated, true);
  assert.equal(state.user, '测试求职者');
  assert.ok(!Object.hasOwn(state, 'text'));
  const guest = await sessionWithPage(statePage({ user: null, loginVisible: true })).pageState();
  assert.equal(guest.authenticated, false);
});

test('known verification routes override a displayed authenticated navigation identity', async () => {
  for (const pathname of ['/web/passport/zp/verify.html', '/web/geek/safe-validate', '/web/user/safe/verify-slider', '/captcha', '/security-check']) {
    const session = sessionWithPage(statePage({ url: SITE_ORIGIN + pathname, title: 'BOSS直聘' }));
    const state = await session.pageState();
    assert.equal(state.verificationRequired, true, pathname);
    assert.equal(state.automaticCheck, false, pathname);
    assert.equal(state.authenticated, false, pathname);
    await assert.rejects(() => session.assertUsable({ auth: true }), { code: 'VERIFICATION_REQUIRED', exitCode: 4 });
  }
  await assert.rejects(() => sessionWithPage(statePage({ user: null, loginVisible: true })).assertUsable({ auth: true }), { code: 'AUTH_REQUIRED', exitCode: 3 });
});

test('automatic environment checks are verification states with neutral wait instructions', async () => {
  for (const pathname of ['/web/passport/zp/security.html', '/web/common/security-check.html']) {
    for (const evaluateFails of [false, true]) {
      const page = statePage({ url: SITE_ORIGIN + pathname, title: 'BOSS直聘' });
      if (evaluateFails) page.evaluate = async () => { throw new Error('Execution context was destroyed'); };
      const session = sessionWithPage(page);
      session.page = page;
      const state = await session.pageState();
      assert.equal(state.verificationRequired, true, pathname);
      assert.equal(state.automaticCheck, true, pathname);
      assert.match(state.instruction, /等待浏览器完成环境检查/);
      assert.doesNotMatch(state.instruction, /手动完成安全验证/);
      await assert.rejects(() => session.assertUsable(), error => error.code === 'VERIFICATION_REQUIRED' && error.details.automaticCheck && /环境检查/.test(error.message));
      assert.match((await session.login()).instruction, /等待浏览器完成环境检查/);
    }
  }
});

test('login clears job readiness before reusing the authenticated browser', async () => {
  const page = statePage();
  const session = sessionWithPage(page);
  session.page = page;
  session.jobReadsReady = true;
  session.jobReadsPreparation = Promise.resolve();
  await session.login();
  assert.equal(session.jobReadsReady, false);
  assert.equal(session.jobReadsPreparation, null);
});

test('a blank or SPA page without account controls cannot prove logout', async () => {
  const session = sessionWithPage(statePage({ url: 'about:blank', title: '', user: null }));
  assert.equal((await session.pageState()).authenticated, null);
  await assert.rejects(() => session.assertUsable({ auth: true }), { code: 'BROWSER_STATE_UNAVAILABLE' });
});

test('connect reuses a healthy open tab and reconnects after its tab closes', async (t) => {
  let connections = 0;
  const freshPage = statePage();
  const context = { pages: () => [statePage({ url: 'https://example.com/' }), freshPage], newPage: async () => { throw new Error('Must select existing Boss tab'); } };
  const browser = { contexts: () => [context], isConnected: () => true, close: async () => {} };
  t.mock.method(chromium, 'connectOverCDP', async (endpoint) => { connections++; assert.equal(endpoint, 'http://127.0.0.1:9222'); return browser; });
  const session = new BrowserSession({ profile: 'connect-test' });
  session.page = freshPage;
  session.browser = browser;
  assert.equal(await session.connect(), freshPage);
  assert.equal(connections, 0);
  session.page = { isClosed: () => true };
  session.ownedEndpoint = async () => 'http://127.0.0.1:9222';
  assert.equal(await session.connect(), freshPage);
  assert.equal(session.context, context);
  assert.equal(connections, 1);
  await session.close();
});

test('connect reports a missing default context instead of inventing a logged in session', async (t) => {
  t.mock.method(chromium, 'connectOverCDP', async () => ({ contexts: () => [], close: async () => {} }));
  const session = new BrowserSession({ cdpUrl: 'http://127.0.0.1:9222' });
  await assert.rejects(() => session.connect(), { code: 'BROWSER_SESSION_MISSING' });
  await session.close();
});

test('concurrent connects share one browser and preserve readiness before closing that connection once', async t => {
  const page = statePage();
  let connections = 0, closes = 0, finishConnection, announceConnection;
  const connecting = new Promise(resolve => { announceConnection = resolve; });
  t.mock.method(chromium, 'connectOverCDP', async () => {
    connections++;
    announceConnection();
    await new Promise(resolve => { finishConnection = resolve; });
    return { isConnected: () => true, contexts: () => [{ pages: () => [page] }], close: async () => { closes++; } };
  });
  const session = new BrowserSession({ cdpUrl: 'http://127.0.0.1:9222' });
  session.endpoint = 'http://127.0.0.1:9222/';
  session.jobReadsReady = true;
  const pending = Promise.all([session.connect(), session.connect(), session.connect()]);
  await connecting;
  assert.equal(connections, 1);
  finishConnection();
  assert.deepEqual(await pending, [page, page, page]);
  assert.equal(session.jobReadsReady, true, 'The same prepared endpoint must remain ready');
  assert.equal(session.connectionPreparation, null);
  await session.close();
  await session.close();
  assert.equal(connections, 1);
  assert.equal(closes, 1);
});

test('a failed shared connection rejects every caller and allows a later explicit connection attempt', async t => {
  const page = statePage();
  let connections = 0, closes = 0;
  t.mock.method(chromium, 'connectOverCDP', async () => {
    if (++connections === 1) throw new Error('Connection unavailable');
    return { isConnected: () => true, contexts: () => [{ pages: () => [page] }], close: async () => { closes++; } };
  });
  const session = new BrowserSession({ cdpUrl: 'http://127.0.0.1:9222' });
  const failures = await Promise.allSettled([session.connect(), session.connect()]);
  assert.equal(connections, 1);
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.code === 'BROWSER_CONNECTION_FAILED'));
  assert.equal(session.connectionPreparation, null);
  assert.equal(await session.connect(), page);
  assert.equal(connections, 2);
  await session.close();
  assert.equal(closes, 1);
});

test('a launch request following an in-flight offline status check still opens the browser', async t => {
  const page = statePage();
  let launches = 0, connections = 0, finishDiscovery;
  const discovery = new Promise(resolve => { finishDiscovery = resolve; });
  const session = new BrowserSession();
  session.ownedEndpoint = async () => { await discovery; return null; };
  session.launch = async () => { launches++; return 'http://127.0.0.1:9222'; };
  t.mock.method(chromium, 'connectOverCDP', async () => {
    connections++;
    return { isConnected: () => true, contexts: () => [{ pages: () => [page] }], close: async () => {} };
  });
  const status = session.connect({ launch: false });
  const requested = session.connect();
  finishDiscovery();
  assert.equal(await status, null);
  assert.equal(await requested, page);
  assert.equal(launches, 1);
  assert.equal(connections, 1);
  await session.close();
});

test('close and raw initialization wait for an in-flight connection before detaching it', async t => {
  for (const operation of ['close', 'openJobPage']) await t.test(operation, async t => {
    const page = statePage();
    let closes = 0, finishConnection, announceConnection;
    const connecting = new Promise(resolve => { announceConnection = resolve; });
    t.mock.method(chromium, 'connectOverCDP', async () => {
      announceConnection();
      await new Promise(resolve => { finishConnection = resolve; });
      return { isConnected: () => true, contexts: () => [{ pages: () => [page] }], close: async () => { closes++; } };
    });
    t.mock.method(globalThis, 'fetch', async () => {
      assert.equal(closes, 1, 'Playwright must be detached before raw CDP begins');
      throw new Error('No live browser is used by this fixture');
    });
    const session = new BrowserSession({ cdpUrl: 'http://127.0.0.1:9222' });
    const pending = session.connect();
    await connecting;
    const ending = operation === 'close' ? session.close() : assert.rejects(() => session.openJobPage(), { code: 'BROWSER_CONNECTION_FAILED' });
    assert.equal(closes, 0);
    finishConnection();
    await pending;
    await ending;
    assert.equal(closes, 1);
    assert.equal(session.browser, null);
    assert.equal(session.connectionPreparation, null);
    await session.close();
    assert.equal(closes, 1);
  });
});

test('a closed tab in a connected browser is replaced without another CDP connection', async (t) => {
  t.mock.method(chromium, 'connectOverCDP', async () => { throw new Error('Existing connected browser must be reused'); });
  const freshPage = statePage();
  const closedPage = { isClosed: () => true, url: () => SITE_ORIGIN + '/old' };
  const session = new BrowserSession();
  session.browser = { isConnected: () => true, close: async () => {} };
  session.page = closedPage;
  session.context = { pages: () => [closedPage, freshPage], newPage: async () => { throw new Error('Fresh Boss tab is available'); } };
  assert.equal(await session.connect(), freshPage);
  await session.close();
});

test('a disconnected browser is reconnected even while a stale page object remains open', async (t) => {
  const freshPage = statePage();
  const context = { pages: () => [freshPage] };
  const newBrowser = { isConnected: () => true, contexts: () => [context], close: async () => {} };
  let connected = 0;
  t.mock.method(chromium, 'connectOverCDP', async () => { connected++; return newBrowser; });
  const session = new BrowserSession();
  session.page = statePage({ url: SITE_ORIGIN + '/stale' });
  session.browser = { isConnected: () => false };
  session.context = { pages: () => [session.page] };
  session.jobReadsReady = true;
  session.jobReadsPreparation = Promise.resolve();
  session.ownedEndpoint = async () => 'http://127.0.0.1:9222';
  assert.equal(await session.connect(), freshPage);
  assert.equal(connected, 1);
  assert.equal(session.browser, newBrowser);
  assert.equal(session.jobReadsReady, false);
  assert.equal(session.jobReadsPreparation, null);
  await session.close();
});

test('logout reopens a closed owned profile and clears persisted Boss session state', async () => {
  const { context, page, calls } = logoutContext();
  const session = new BrowserSession({ profile: 'offline-logout' });
  session.context = context;
  session.page = page;
  session.jobReadsReady = true;
  session.jobReadsPreparation = Promise.resolve();
  let reopened = false;
  session.connect = async (options = {}) => { if (options.launch === false) return null; reopened = true; return page; };
  session.navigate = async (url, options) => calls.navigation.push({ url, options });
  const result = await session.logout();
  assert.equal(reopened, true, 'Offline logout must open persisted state to clear it');
  assert.equal(result.loggedOut, true);
  assert.equal(session.jobReadsReady, false);
  assert.equal(session.jobReadsPreparation, null);
  assert.equal(calls.cookieFilters.length, 1);
  assert.equal(calls.navigation[0].url, SITE_ORIGIN);
  assert.equal(calls.navigation[0].options.force, true);
});

test('logout clears only Boss cookies and Boss-tab storage in the connected browser', async () => {
  const { context, page, calls } = logoutContext();
  const session = new BrowserSession({ cdpUrl: 'http://127.0.0.1:9222' });
  session.context = context;
  session.page = page;
  session.connect = async () => page;
  session.navigate = async (url, options) => calls.navigation.push({ url, options });
  const result = await session.logout();
  assert.equal(result.loggedOut, true);
  assert.equal(result.scope, 'connected-browser');
  assert.equal(calls.cookieFilters.length, 1);
  const filter = calls.cookieFilters[0];
  assert.ok(filter.domain instanceof RegExp);
  for (const domain of ['zhipin.com', '.zhipin.com', 'login.zhipin.com']) assert.ok(filter.domain.test(domain));
  for (const domain of ['example.com', 'evilzhipin.com', 'zhipin.com.example.com']) assert.equal(filter.domain.test(domain), false);
  assert.equal(calls.storage.length, 4);
  assert.ok(calls.storage.every(({ url }) => isBossUrl(url)));
  assert.ok(calls.unloadedTabs.some(({ from }) => from === 'https://login.zhipin.com/'));
  assert.ok(calls.unloadedTabs.every(({ from }) => isBossUrl(from)));
  assert.equal(calls.navigation[0].options.force, true);
});

test('an unavailable explicit CDP browser cannot be reported as successfully logged out', async () => {
  const session = new BrowserSession({ cdpUrl: 'http://127.0.0.1:9222' });
  session.connect = async () => null;
  await assert.rejects(() => session.logout());
  const failure = new Error('Cannot reach explicitly selected browser');
  session.connect = async () => { throw failure; };
  await assert.rejects(() => session.logout(), (error) => error === failure || error.cause === failure);
});

test('close detaches once and discards stale browser/page references', async () => {
  const session = new BrowserSession();
  let closed = 0;
  session.browser = { close: async () => { closed++; } };
  session.context = {};
  session.page = statePage();
  session.jobReadsReady = true;
  session.jobReadsPreparation = Promise.resolve();
  await session.close();
  await session.close();
  assert.equal(closed, 1);
  assert.equal(session.browser, null);
  assert.equal(session.context, null);
  assert.equal(session.page, null);
  assert.equal(session.jobReadsReady, false);
  assert.equal(session.jobReadsPreparation, null);
});
