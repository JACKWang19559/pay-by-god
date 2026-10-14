import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SiteTransport } from '../src/site-transport.js';
import { prepareJobSession } from '../src/job-session.js';

function fixture({ status = 200, body = JSON.stringify({ code: 0, zpData: { ok: true } }), readError } = {}) {
  const calls = { connected: 0, fetches: [], disposed: 0, cookiesRead: 0 };
  const response = { status: () => status, text: async () => { if (readError) throw readError; return body; }, dispose: async () => { calls.disposed++; } };
  const session = {
    options: { timeout: 1234 },
    connect: async () => { calls.connected++; return { evaluate: async () => { throw new Error('Transport must survive page navigation without page fetch'); } }; },
    context: { request: { fetch: async (url, options) => { calls.fetches.push({ url, options }); return response; } }, cookies: async () => { calls.cookiesRead++; throw new Error('Cookies must not be exported'); } },
  };
  return { transport: new SiteTransport(session), session, calls };
}

test('context request preserves opaque query/form values and disables retries and redirects', async () => {
  const { transport, calls } = fixture();
  const form = { query: '前端 开发', tokenLikeValue: 'opaque+a&b=c', empty: '', zero: 0 };
  const payload = await transport.request('/wapi/zpgeek/search/joblist.json', { method: 'POST', mutation: false, query: { securityId: 'a+b&c=d', city: '北京', zero: 0, disabled: false, missing: undefined, nullValue: null }, form });
  assert.deepEqual(payload, { code: 0, zpData: { ok: true } });
  assert.equal(calls.connected, 1);
  assert.equal(calls.fetches.length, 1);
  const { url, options } = calls.fetches[0];
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://www.zhipin.com');
  assert.equal(parsed.pathname, '/wapi/zpgeek/search/joblist.json');
  assert.equal(parsed.searchParams.get('securityId'), 'a+b&c=d');
  assert.equal(parsed.searchParams.get('city'), '北京');
  assert.equal(parsed.searchParams.get('zero'), '0');
  assert.equal(parsed.searchParams.get('disabled'), 'false');
  assert.equal(parsed.searchParams.has('missing'), false);
  assert.equal(parsed.searchParams.has('nullValue'), false);
  assert.match(parsed.searchParams.get('_'), /^\d{13}$/);
  assert.deepEqual(options.form, form);
  assert.equal(options.method, 'POST');
  assert.equal(options.maxRetries, 0);
  assert.equal(options.maxRedirects, 0);
  assert.equal(options.failOnStatusCode, false);
  assert.equal(options.timeout, 1234);
  assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.ok(!Object.keys(options.headers).some((name) => /cookie/i.test(name)));
  assert.equal(calls.cookiesRead, 0);
  assert.equal(calls.disposed, 1);
});

test('GET requests omit a form body and release their response', async () => {
  const { transport, calls } = fixture();
  await transport.request('/wapi/zpgeek/job/detail.json', { query: { securityId: 'job-bound' }, form: { ignored: 'value' } });
  assert.equal(calls.fetches[0].options.method, 'GET');
  assert.equal(Object.hasOwn(calls.fetches[0].options, 'form'), false);
  assert.equal(calls.disposed, 1);
});

test('JSON gateway code 37 and HTTP 429 stay actionable after releasing response buffers', async () => {
  const challenge = fixture({ body: JSON.stringify({ code: 37, message: '请求异常', zpData: { name: 'script', seed: 'challenge', ts: 123 } }) });
  await assert.rejects(() => challenge.transport.request('/wapi/zpgeek/search/joblist.json', { method: 'POST', mutation: false }), { code: 'VERIFICATION_REQUIRED', exitCode: 4 });
  assert.equal(challenge.calls.disposed, 1);
  const limited = fixture({ status: 429, body: 'Too many requests' });
  await assert.rejects(() => limited.transport.request('/wapi/zpgeek/job/detail.json'), { code: 'RATE_LIMITED', exitCode: 4 });
  assert.equal(limited.calls.disposed, 1);
});

test('session rejection invalidates readiness without retrying and a later explicit read initializes again', async t => {
  const site = 'https://www.zhipin.com';
  const route = '/wapi/zpgeek/job/detail.json';
  for (const [name, body, code] of [
    ['JSON verification', JSON.stringify({ code: 37, message: '请求异常' }), 'VERIFICATION_REQUIRED'],
    ['JSON authentication', JSON.stringify({ code: 7, message: '请登录' }), 'AUTH_REQUIRED'],
    ['HTML verification', '<html>安全验证</html>', 'VERIFICATION_REQUIRED'],
  ]) await t.test(name, async () => {
    const { transport, session, calls } = fixture({ body });
    const page = new EventEmitter();
    const frame = {};
    let navigations = 0, releases = 0;
    page.url = () => site + '/web/geek/jobs';
    page.isClosed = () => false;
    page.mainFrame = () => frame;
    page.goto = async () => {
      navigations++;
      page.emit('response', {
        url: () => site + '/wapi/zpgeek/search/joblist.json',
        status: () => 200,
        request: () => ({ frame: () => frame }),
        json: async () => ({ code: 0, zpData: { jobList: [] } }),
      });
    };
    page.release = async () => { releases++; };
    session.page = page;
    session.browser = { isConnected: () => true };
    session.jobReadsReady = true;
    session.openJobPage = async () => page;
    session.prepareJobReads = options => prepareJobSession(session, options);

    await assert.rejects(() => transport.request(route), { code });
    assert.equal(session.jobReadsReady, false);
    assert.equal(calls.fetches.length, 1, 'A rejected request must never be retried automatically');
    assert.equal(calls.disposed, 1);
    assert.equal(navigations, 0, 'The initially ready session should have been reused');

    session.context.request.fetch = async (url, options) => {
      calls.fetches.push({ url, options });
      assert.equal(session.jobReadsReady, true);
      assert.equal(releases, 1, 'The replacement initialization must finish before fetching');
      return { status: () => 200, text: async () => JSON.stringify({ code: 0 }), dispose: async () => { calls.disposed++; } };
    };
    assert.deepEqual(await transport.request(route), { code: 0 });
    assert.equal(navigations, 1);
    assert.equal(calls.fetches.length, 2);
    assert.equal(calls.disposed, 2);
    assert.equal(page.listenerCount('response'), 0);
  });
});

test('unrelated API failures preserve readiness and invalidation preserves an in-flight preparation', async () => {
  for (const response of [
    { status: 429, body: 'Too many requests' },
    { body: JSON.stringify({ code: 8, message: '请求过于频繁' }) },
    { body: JSON.stringify({ code: 12, message: '职位不可用' }) },
    { body: '<html>Service unavailable</html>' },
  ]) {
    const { transport, session } = fixture(response);
    session.jobReadsReady = true;
    await assert.rejects(() => transport.request('/wapi/zpgeek/job/detail.json'));
    assert.equal(session.jobReadsReady, true);
  }
  for (const body of [JSON.stringify({ code: 7, message: '请登录' }), '<html>安全验证</html>']) {
    const { transport, session, calls } = fixture({ body });
    const preparation = Promise.resolve();
    session.jobReadsReady = true;
    session.jobReadsPreparation = preparation;
    await assert.rejects(() => transport.request('/wapi/zpgeek/friend/add.json', { method: 'POST' }));
    assert.equal(session.jobReadsReady, false);
    assert.equal(session.jobReadsPreparation, preparation);
    assert.equal(calls.fetches.length, 1, 'Session invalidation must not resubmit a write');
  }
});

test('non-JSON read errors differ from writes whose delivery cannot be confirmed', async () => {
  const read = fixture({ body: '<html>Service unavailable</html>' });
  await assert.rejects(() => read.transport.request('/wapi/zpgeek/job/detail.json'), { code: 'SITE_CHANGED' });
  assert.equal(read.calls.disposed, 1);
  const write = fixture({ body: '<html>Service unavailable</html>' });
  await assert.rejects(() => write.transport.request('/wapi/zpgeek/friend/add.json', { method: 'POST' }), (error) => {
    assert.equal(error.code, 'DELIVERY_UNCONFIRMED');
    assert.equal(error.details.automaticRetry, false);
    assert.match(error.message, /勿直接重试/);
    return true;
  });
  assert.equal(write.calls.disposed, 1);
  const verification = fixture({ body: '<html>安全验证</html>' });
  await assert.rejects(() => verification.transport.request('/wapi/zpgeek/friend/add.json', { method: 'POST' }), { code: 'VERIFICATION_REQUIRED' });
  assert.equal(verification.calls.disposed, 1);
});

test('HTTP failures preserve uncertainty for writes and do not turn reads into successes', async () => {
  for (const [method, code] of [['GET', 'SITE_API_ERROR'], ['POST', 'DELIVERY_UNCONFIRMED']]) {
    const { transport, calls } = fixture({ status: 503 });
    await assert.rejects(() => transport.request('/wapi/zpgeek/friend/add.json', { method }), { code });
    assert.equal(calls.disposed, 1);
    assert.equal(calls.fetches.length, 1);
  }
});

test('a response buffer is disposed even when reading its body fails', async () => {
  const readError = new Error('Body stream interrupted');
  const read = fixture({ readError });
  await assert.rejects(() => read.transport.request('/wapi/zpgeek/job/detail.json'), (error) => error.code === 'NETWORK_ERROR' && error.cause === readError);
  assert.equal(read.calls.fetches.length, 1);
  assert.equal(read.calls.disposed, 1);
  const write = fixture({ readError });
  await assert.rejects(() => write.transport.request('/wapi/zpgeek/friend/add.json', { method: 'POST' }), (error) => error.code === 'DELIVERY_UNCONFIRMED' && error.cause === readError);
  assert.equal(write.calls.disposed, 1);
});
