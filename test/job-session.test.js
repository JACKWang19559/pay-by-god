import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { prepareJobSession } from '../src/job-session.js';
import { findBrowserExecutable, SITE_ORIGIN } from '../src/browser-session.js';
import { SiteTransport } from '../src/site-transport.js';
import { normalizeError } from '../src/errors.js';

const jobsUrl = SITE_ORIGIN + '/web/geek/jobs';
const listPath = '/wapi/zpgeek/search/joblist.json';
const successfulList = { code: 0, zpData: { jobList: [] } };
const challenge = { code: 37, message: '您的环境存在异常', zpData: { seed: 'private-seed', name: 'private-script', ts: 'private-timestamp' } };

function fixture({ timeout = 300, goto } = {}) {
  const page = new EventEmitter();
  const frame = {};
  const calls = { connected: 0, navigations: [], credentialReads: 0, jsonReads: 0 };
  let currentUrl = SITE_ORIGIN + '/';
  let closed = false;
  const forbidden = () => { calls.credentialReads++; throw new Error('Initialization must not inspect credentials or page globals'); };
  page.url = () => currentUrl;
  page.setUrl = value => { currentUrl = value; };
  page.mainFrame = () => frame;
  page.isClosed = () => closed;
  page.closeFixture = () => { closed = true; };
  page.evaluate = forbidden;
  page.goto = async (url, options) => {
    calls.navigations.push({ url, options });
    currentUrl = url;
    await goto?.(page);
  };
  page.respond = ({ payload = successfulList, status = 200, url = SITE_ORIGIN + listPath, responseFrame = frame, jsonError } = {}) => {
    page.emit('response', {
      url: () => url,
      status: () => status,
      request: () => ({ frame: () => responseFrame, headers: forbidden, postData: forbidden }),
      json: async () => { calls.jsonReads++; if (jsonError) throw jsonError; return payload; },
      headers: forbidden,
      allHeaders: forbidden,
    });
  };
  const session = {
    page,
    options: { timeout, profile: 'isolated-unit-test', profileDir: 'fixture-profile' },
    connect: async () => { calls.connected++; return page; },
    context: { cookies: forbidden, storageState: forbidden, addCookies: forbidden },
  };
  return { session, page, calls };
}

test('job initialization requires the normal page list response and only forwards search parameters', async () => {
  const { session, page, calls } = fixture({ goto: page => page.respond() });
  await prepareJobSession(session, { query: '前端 & Python', city: '101270100', seed: 'never-forward-this' });
  assert.equal(session.jobReadsReady, true);
  assert.equal(session.jobReadsPreparation, null);
  assert.equal(calls.navigations.length, 1);
  const url = new URL(calls.navigations[0].url);
  assert.equal(url.origin, SITE_ORIGIN);
  assert.equal(url.pathname, '/web/geek/jobs');
  assert.deepEqual(Object.fromEntries(url.searchParams), { query: '前端 & Python', city: '101270100' });
  assert.equal(calls.navigations[0].options.waitUntil, 'domcontentloaded');
  assert.equal(calls.credentialReads, 0);
  assert.equal(page.listenerCount('response'), 0);
  await prepareJobSession(session);
  assert.equal(calls.navigations.length, 1, 'A ready session should not navigate again');
});

test('an ordinary recommendation response can establish readiness without exporting its payload', async () => {
  for (const route of ['/wapi/zpgeek/recommend/job/list.json', '/wapi/zpgeek/pc/recommend/job/list.json']) {
    const { session, calls } = fixture({ goto: page => page.respond({ url: SITE_ORIGIN + route }) });
    assert.equal(await prepareJobSession(session), undefined);
    assert.equal(session.jobReadsReady, true);
    assert.equal(calls.credentialReads, 0);
  }
});

test('automatic security navigation is allowed to return naturally before initialization completes', async () => {
  let returnToJobs;
  const { session, page, calls } = fixture({ timeout: 600, goto: async page => {
    page.respond({ payload: challenge });
    page.setUrl(SITE_ORIGIN + '/web/passport/zp/security.html?seed=private-seed');
    returnToJobs = () => { page.setUrl(jobsUrl); page.respond(); };
    throw new Error('Navigation interrupted by another navigation');
  } });
  const ready = prepareJobSession(session);
  await delay(20);
  assert.notEqual(session.jobReadsReady, true);
  assert.match(page.url(), /\/passport\/zp\/security\.html/);
  returnToJobs();
  await ready;
  assert.equal(session.jobReadsReady, true);
  assert.equal(calls.navigations.length, 1, 'Only the site itself should follow the challenge navigation');
  assert.equal(calls.credentialReads, 0);
  assert.equal(page.listenerCount('response'), 0);
});

test('concurrent job reads share one initialization and detach the response listener afterward', async () => {
  const { session, page, calls } = fixture({ goto: async page => { await delay(20); page.respond(); } });
  await Promise.all([prepareJobSession(session), prepareJobSession(session), prepareJobSession(session)]);
  assert.equal(calls.navigations.length, 1);
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(session.jobReadsPreparation, null);
});

test('raw job-page acquisition is shared and its release finishes before preparation resolves', async () => {
  const { session, page, calls } = fixture({ goto: page => page.respond() });
  let opened = 0, released = 0, settled = false, finishRelease, announceRelease;
  const releaseStarted = new Promise(resolve => { announceRelease = resolve; });
  session.openJobPage = async () => { opened++; return page; };
  session.connect = async () => { throw new Error('Raw initialization must not attach Playwright'); };
  page.release = async () => {
    released++;
    assert.equal(page.listenerCount('response'), 0, 'The initialization listener must be removed before releasing CDP');
    announceRelease();
    await new Promise(resolve => { finishRelease = resolve; });
  };
  const first = prepareJobSession(session).then(() => { settled = true; });
  const second = prepareJobSession(session);
  const third = prepareJobSession(session);
  await releaseStarted;
  assert.equal(settled, false);
  assert.equal(opened, 1);
  assert.equal(released, 1);
  assert.equal(calls.navigations.length, 1);
  finishRelease();
  await Promise.all([first, second, third]);
  assert.equal(settled, true);
  assert.equal(session.jobReadsReady, true);
  assert.equal(session.jobReadsPreparation, null);
  assert.equal(calls.credentialReads, 0);
});

test('raw job pages are released on every initialization failure without attaching Playwright', async t => {
  const scenarios = [
    ['timeout', undefined, 'BROWSER_INITIALIZATION_TIMEOUT'],
    ['authentication failure', page => page.respond({ payload: { code: 7, message: '请登录' } }), 'AUTH_REQUIRED'],
    ['rate limit', page => page.respond({ status: 429 }), 'RATE_LIMITED'],
    ['closed page', page => page.closeFixture(), 'BROWSER_SESSION_UNAVAILABLE'],
    ['existing manual verification', undefined, 'VERIFICATION_REQUIRED'],
    ['obsolete browser configuration', undefined, 'BROWSER_RESTART_REQUIRED'],
  ];
  for (const [name, goto, code] of scenarios) await t.test(name, async () => {
    const { session, page } = fixture({ timeout: 150, goto });
    let released = 0;
    if (name === 'existing manual verification') page.setUrl(SITE_ORIGIN + '/web/user/safe/verify-slider');
    session.openJobPage = async () => {
      if (name === 'obsolete browser configuration') session.restartRequired = true;
      return page;
    };
    session.connect = async () => { throw new Error('A failed raw initialization must not attach Playwright'); };
    page.release = async () => { released++; assert.equal(page.listenerCount('response'), 0); };
    await assert.rejects(() => prepareJobSession(session), { code });
    assert.equal(released, 1);
    assert.equal(session.jobReadsPreparation, null);
    assert.notEqual(session.jobReadsReady, true);
  });
});

test('raw page acquisition failure is propagated without a Playwright fallback', async () => {
  const { session } = fixture();
  const failure = new Error('Isolated CDP connection failed');
  session.openJobPage = async () => { throw failure; };
  session.connect = async () => { throw new Error('Must not fall back to Playwright initialization'); };
  await assert.rejects(() => prepareJobSession(session), error => error === failure);
  assert.equal(session.jobReadsPreparation, null);
  assert.notEqual(session.jobReadsReady, true);
});

test('search and detail initialize and release raw CDP before connecting the API browser session', async t => {
  for (const route of [listPath, '/wapi/zpgeek/job/detail.json']) await t.test(route, async () => {
    const events = [];
    const { session, page } = fixture({ goto: page => { events.push('navigate'); page.respond(); } });
    session.context = null;
    session.openJobPage = async () => { events.push('open-raw'); return page; };
    page.release = async () => { events.push('release-raw'); assert.equal(page.listenerCount('response'), 0); };
    session.prepareJobReads = options => prepareJobSession(session, options);
    session.connect = async () => {
      assert.equal(session.jobReadsReady, true, 'Playwright must connect only after the normal page completed initialization');
      assert.deepEqual(events, ['open-raw', 'navigate', 'release-raw']);
      events.push('connect-api');
      session.context = { request: { fetch: async (url, options) => {
        events.push('fetch-api');
        assert.equal(new URL(url).pathname, route);
        assert.equal(options.maxRetries, 0);
        return { status: () => 200, text: async () => JSON.stringify({ code: 0, zpData: { fixture: true } }) };
      } } };
      return page;
    };
    const options = route === listPath ? { method: 'POST', mutation: false, form: { query: 'fixture', city: '101270100' } } : {};
    const result = await new SiteTransport(session).request(route, options);
    assert.equal(result.code, 0);
    assert.deepEqual(events, ['open-raw', 'navigate', 'release-raw', 'connect-api', 'fetch-api']);
  });
});

test('failed raw initialization is released and prevents both API connection and request', async () => {
  const { session, page } = fixture({ timeout: 30 });
  const events = [];
  session.openJobPage = async () => { events.push('open-raw'); return page; };
  page.release = async () => { events.push('release-raw'); };
  session.prepareJobReads = options => prepareJobSession(session, options);
  session.connect = async () => { events.push('connect-api'); throw new Error('Preparation failure must prevent this connection'); };
  session.context.request = { fetch: async () => { events.push('fetch-api'); throw new Error('Preparation failure must prevent this request'); } };
  await assert.rejects(() => new SiteTransport(session).request('/wapi/zpgeek/job/detail.json'), { code: 'BROWSER_INITIALIZATION_TIMEOUT' });
  assert.deepEqual(events, ['open-raw', 'release-raw']);
  assert.equal(page.listenerCount('response'), 0);
});

test('unrelated, malformed, or failed list responses cannot make the jobs session ready', async t => {
  const scenarios = [
    ['foreign origin', { url: 'https://example.com' + listPath }],
    ['subframe', { responseFrame: {} }],
    ['filters only', { url: SITE_ORIGIN + '/wapi/zpgeek/search/filter.json' }],
    ['missing jobList', { payload: { code: 0, zpData: {} } }],
    ['non-array jobList', { payload: { code: 0, zpData: { jobList: {} } } }],
    ['HTTP failure despite code zero', { status: 503 }],
    ['business error', { payload: { code: 12, message: '职位不可用', zpData: { jobList: [] } } }],
    ['non-JSON response', { jsonError: new SyntaxError('Unexpected HTML') }],
  ];
  for (const [name, response] of scenarios) await t.test(name, async () => {
    const { session, page } = fixture({ timeout: 30, goto: page => page.respond(response) });
    await assert.rejects(() => prepareJobSession(session), { code: 'BROWSER_INITIALIZATION_TIMEOUT', exitCode: 4 });
    assert.notEqual(session.jobReadsReady, true);
    assert.equal(session.jobReadsPreparation, null);
    assert.equal(page.listenerCount('response'), 0);
  });
});

test('a successful list followed by leaving the jobs page cannot establish readiness', async () => {
  const { session } = fixture({ timeout: 30, goto: page => {
    page.respond();
    page.setUrl(SITE_ORIGIN + '/chengdu/');
  } });
  await assert.rejects(() => prepareJobSession(session), { code: 'BROWSER_INITIALIZATION_TIMEOUT' });
  assert.notEqual(session.jobReadsReady, true);
});

test('authentication and rate-limit failures remain actionable and never mark initialization ready', async t => {
  for (const [name, response, code] of [
    ['login required', { payload: { code: 7, message: '请登录' } }, 'AUTH_REQUIRED'],
    ['HTTP rate limit', { status: 429 }, 'RATE_LIMITED'],
    ['business rate limit', { payload: { code: 8, message: '请求过于频繁' } }, 'RATE_LIMITED'],
  ]) await t.test(name, async () => {
    const { session, page } = fixture({ goto: page => page.respond(response) });
    await assert.rejects(() => prepareJobSession(session), { code });
    assert.notEqual(session.jobReadsReady, true);
    assert.equal(page.listenerCount('response'), 0);
  });
});

test('manual verification routes stop initialization without claiming it succeeded', async t => {
  for (const pathname of ['/web/passport/zp/verify.html', '/web/user/safe/verify-slider', '/web/geek/safe-validate', '/captcha']) {
    await t.test(pathname, async () => {
      const { session } = fixture({ timeout: 40, goto: page => page.setUrl(SITE_ORIGIN + pathname) });
      await assert.rejects(() => prepareJobSession(session), { code: 'VERIFICATION_REQUIRED', exitCode: 4 });
      assert.notEqual(session.jobReadsReady, true);
    });
  }
});

test('an already open manual challenge is preserved before any navigation or API request', async () => {
  const { session, page, calls } = fixture();
  page.setUrl(SITE_ORIGIN + '/web/user/safe/verify-slider?callbackUrl=fixture');
  session.jobReadsReady = true;
  let fetches = 0;
  session.prepareJobReads = options => prepareJobSession(session, options);
  session.context.request = { fetch: async () => { fetches++; throw new Error('The pending challenge must prevent this request'); } };
  await assert.rejects(() => new SiteTransport(session).request('/wapi/zpgeek/job/detail.json'), { code: 'VERIFICATION_REQUIRED' });
  assert.equal(calls.navigations.length, 0);
  assert.equal(fetches, 0);
  assert.match(page.url(), /verify-slider/);
});

test('an already open automatic check is allowed to finish without restarting its navigation', async () => {
  const { session, page, calls } = fixture({ timeout: 500 });
  page.setUrl(SITE_ORIGIN + '/web/passport/zp/security.html?seed=private-seed');
  const ready = prepareJobSession(session);
  await delay(20);
  assert.equal(calls.navigations.length, 0);
  assert.notEqual(session.jobReadsReady, true);
  page.setUrl(jobsUrl);
  page.respond();
  await ready;
  assert.equal(session.jobReadsReady, true);
  assert.equal(calls.navigations.length, 0);
  assert.equal(calls.credentialReads, 0);
});

test('an automatic-check URL alone does not fabricate a server API code', async () => {
  const { session, page, calls } = fixture({ timeout: 30 });
  page.setUrl(SITE_ORIGIN + '/web/passport/zp/security.html');
  await assert.rejects(() => prepareJobSession(session), error => {
    assert.equal(error.code, 'VERIFICATION_REQUIRED');
    assert.equal(Object.hasOwn(error.details, 'apiCode'), false);
    return true;
  });
  assert.equal(calls.navigations.length, 0);
  assert.notEqual(session.jobReadsReady, true);
});

test('an unfinished automatic check reports its state without disclosing challenge values', async t => {
  for (const pathname of ['/web/passport/zp/security.html', '/web/common/security-check.html']) await t.test(pathname, async () => {
    const { session, page, calls } = fixture({ timeout: 35, goto: page => {
      page.respond({ payload: challenge });
      page.setUrl(SITE_ORIGIN + pathname + '?seed=private-seed&name=private-script&ts=private-timestamp');
    } });
    await assert.rejects(() => prepareJobSession(session), error => {
      assert.equal(error.code, 'VERIFICATION_REQUIRED');
      assert.equal(error.details.apiCode, 37);
      assert.match(error.message, /自动校验尚未完成/);
      assert.doesNotMatch(JSON.stringify(normalizeError(error)), /private-seed|private-script|private-timestamp/);
      return true;
    });
    assert.notEqual(session.jobReadsReady, true);
    assert.equal(calls.credentialReads, 0);
    assert.equal(page.listenerCount('response'), 0);
  });
});

test('closed pages, top-level blank exits, and obsolete launch configurations fail before an API read', async t => {
  for (const [name, goto] of [
    ['closed page', page => page.closeFixture()],
    ['blank exit', page => page.setUrl('about:blank')],
  ]) await t.test(name, async () => {
    const { session } = fixture({ goto });
    await assert.rejects(() => prepareJobSession(session), { code: 'BROWSER_SESSION_UNAVAILABLE', exitCode: 4 });
    assert.notEqual(session.jobReadsReady, true);
  });
  const { session, calls } = fixture();
  const connect = session.connect;
  session.connect = async () => { const page = await connect(); session.restartRequired = true; return page; };
  session.jobReadsReady = true;
  await assert.rejects(() => prepareJobSession(session), { code: 'BROWSER_RESTART_REQUIRED', exitCode: 4 });
  assert.equal(calls.navigations.length, 0);
});

test('a failed initialization can be attempted again by a later explicit request', async () => {
  let shouldSucceed = false;
  const { session, page, calls } = fixture({ timeout: 40, goto: page => { if (shouldSucceed) page.respond(); } });
  await assert.rejects(() => prepareJobSession(session), { code: 'BROWSER_INITIALIZATION_TIMEOUT' });
  assert.equal(session.jobReadsPreparation, null);
  shouldSucceed = true;
  session.options.timeout = 300;
  await prepareJobSession(session);
  assert.equal(session.jobReadsReady, true);
  assert.equal(calls.navigations.length, 2);
  assert.equal(page.listenerCount('response'), 0);
});

test('failed initialization prevents the transport from issuing an unprepared API read', async () => {
  const { session, calls } = fixture({ timeout: 30 });
  let fetches = 0;
  session.prepareJobReads = options => prepareJobSession(session, options);
  session.context.request = { fetch: async () => { fetches++; throw new Error('No API call is allowed before initialization'); } };
  await assert.rejects(() => new SiteTransport(session).request(listPath, { method: 'POST', mutation: false }), { code: 'BROWSER_INITIALIZATION_TIMEOUT' });
  assert.equal(fetches, 0);
  assert.equal(calls.credentialReads, 0);
  assert.notEqual(session.jobReadsReady, true);
});

test('an API code 37 after successful initialization is not retried or changed into a success', async () => {
  const { session, page, calls } = fixture({ goto: page => page.respond() });
  let fetches = 0, disposed = 0;
  session.prepareJobReads = options => prepareJobSession(session, options);
  session.context.request = { fetch: async (url, options) => {
    fetches++;
    assert.equal(session.jobReadsReady, true);
    assert.equal(new URL(url).pathname, listPath);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.maxRedirects, 0);
    return { status: () => 200, text: async () => JSON.stringify(challenge), dispose: async () => { disposed++; } };
  } };
  const transport = new SiteTransport(session);
  await assert.rejects(() => transport.request(listPath, { method: 'POST', mutation: false, form: { query: 'Python', city: '101270100' } }), error => {
    assert.equal(error.code, 'VERIFICATION_REQUIRED');
    assert.equal(error.details.apiCode, 37);
    assert.doesNotMatch(JSON.stringify(normalizeError(error)), /private-seed|private-script|private-timestamp/);
    return true;
  });
  assert.equal(fetches, 1);
  assert.equal(disposed, 1);
  assert.equal(calls.navigations.length, 1);
  assert.equal(calls.credentialReads, 0);
  assert.equal(page.listenerCount('response'), 0);
});

test('real Edge: a fully intercepted jobs-to-security-to-jobs navigation establishes readiness', { timeout: 20_000 }, async t => {
  let executablePath;
  try { executablePath = await findBrowserExecutable(); }
  catch { t.skip('Install Edge/Chrome to run the isolated browser fixture.'); return; }
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const documents = [];
    let listRequests = 0;
    // Fulfill every browser request locally. Never continue a request to the network.
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== SITE_ORIGIN) return route.fulfill({ status: 451, body: 'External network blocked by fixture' });
      if (url.pathname === listPath) {
        listRequests++;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listRequests === 1 ? challenge : successfulList) });
      }
      if (request.resourceType() !== 'document') return route.fulfill({ status: 404, body: 'Unknown fixture request' });
      documents.push(url.pathname);
      let script;
      if (url.pathname === '/web/geek/jobs') {
        script = `fetch('${listPath}',{method:'POST'}).then(r=>r.json()).then(data=>{if(data.code===37)location.replace('/web/passport/zp/security.html?seed=private-seed');else document.body.textContent='Jobs loaded';})`;
      } else if (url.pathname === '/web/passport/zp/security.html') {
        script = "setTimeout(()=>location.replace('/web/geek/jobs?returned=1'),80)";
      } else return route.fulfill({ status: 404, body: 'Unknown fixture document' });
      return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>Isolated job initialization fixture</title><body>Loading<script>${script}</script>` });
    });
    const page = await context.newPage();
    const session = { options: { timeout: 5000, profile: 'isolated-browser-test' }, connect: async () => page, context };
    await prepareJobSession(session, { query: 'fixture', city: '101270100' });
    assert.equal(session.jobReadsReady, true);
    assert.equal(listRequests, 2);
    assert.deepEqual(documents, ['/web/geek/jobs', '/web/passport/zp/security.html', '/web/geek/jobs']);
    assert.equal(new URL(page.url()).pathname, '/web/geek/jobs');
    assert.equal(page.listenerCount('response'), 0);
  } finally { await browser.close(); }
});
