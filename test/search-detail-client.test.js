import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BossClient, JOB_CONTEXT_MAX_AGE_MS } from '../src/boss-client.js';
import { BossCliError } from '../src/errors.js';
import { SiteTransport } from '../src/site-transport.js';

const JOB = 'targetJob123';
const NOW = 2_000_000_000_000;
const detail = () => ({ jobInfo: { encryptId: JOB, jobName: '测试详情', postDescription: '第一行\n第二行' }, securityId: 'fresh-page-security', lid: 'fresh-page-lid' });
const cache = (updatedAt = NOW - 1000) => ({ records: { [JOB]: { updatedAt, normalized: { id: JOB, encryptJobId: JOB, title: '缓存职位', securityId: 'cached-security', lid: 'cached-lid', expectId: 'cached-expectation' } } } });
const noNetwork = async () => { throw new Error('Tests must not access the network'); };

function fixture({ cached = cache(), respond = async () => ({ code: 0, zpData: { jobInfo: { encryptId: JOB, jobName: 'API职位' } } }), dom = async () => detail() } = {}) {
  const calls = { requests: [], dom: [], writes: [] };
  const session = { options: { profile: 'search-detail-test', timeout: 1000 } };
  const client = new BossClient({ session, fetch: noNetwork, transport: { request: async (route, options) => { calls.requests.push({ route, options }); return respond(route, options); } } });
  client._readCache = async () => cached;
  client._writeCache = async (name, value) => calls.writes.push({ name, value });
  client._domDetail = async (target) => { calls.dom.push(target); return dom(target); };
  return { client, calls };
}

function domDetailFixture(prepare) {
  const events = [];
  const url = `https://www.zhipin.com/job_detail/${JOB}.html`;
  const page = {
    url: () => url,
    locator: () => ({ first: () => ({ waitFor: async () => { events.push('wait-for-detail'); } }) }),
    evaluate: async () => { events.push('read-detail'); return detail(); },
  };
  const session = {
    options: { profile: 'dom-detail-test', timeout: 1000 },
    navigate: async target => { assert.equal(target, url); events.push('navigate'); return page; },
    assertUsable: async () => { events.push('assert-usable'); },
    ...(prepare ? { prepareJobReads: async () => { events.push('prepare'); await prepare(); events.push('prepared'); } } : {}),
  };
  const client = new BossClient({ session, fetch: noNetwork, transport: { request: noNetwork } });
  client._readCache = async () => null;
  client._writeCache = async () => { events.push('write-cache'); };
  return { client, events };
}

test('bare job detail waits for job-session preparation before navigating or reading the page', async () => {
  let releasePreparation, preparationStarted;
  const started = new Promise(resolve => { preparationStarted = resolve; });
  const preparation = new Promise(resolve => { releasePreparation = resolve; });
  const { client, events } = domDetailFixture(async () => { preparationStarted(); await preparation; });
  const pending = client._jobContext(JOB);
  await started;
  assert.deepEqual(events, ['prepare']);
  releasePreparation();
  const result = await pending;
  assert.equal(result.job.title, '测试详情');
  assert.equal(result.context.source, 'rendered-page');
  assert.deepEqual(events, ['prepare', 'prepared', 'navigate', 'assert-usable', 'wait-for-detail', 'read-detail', 'write-cache']);
});

test('failed job-session preparation stops bare job detail before navigation and preserves the error', async () => {
  const failure = new BossCliError('Automatic environment check did not finish', { code: 'VERIFICATION_REQUIRED', details: { apiCode: 37 } });
  const { client, events } = domDetailFixture(async () => { throw failure; });
  await assert.rejects(() => client._jobContext(JOB), error => {
    assert.equal(error, failure);
    assert.equal(error.details.apiCode, 37);
    return true;
  });
  assert.deepEqual(events, ['prepare']);
});

test('injected sessions without job preparation retain their local DOM detail path', async () => {
  const { client, events } = domDetailFixture();
  assert.equal((await client._jobContext(JOB)).job.id, JOB);
  assert.deepEqual(events, ['navigate', 'assert-usable', 'wait-for-detail', 'read-detail', 'write-cache']);
});

test('an explicit securityId never borrows lid or expectation from a cached context', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  for (const explicitLid of [undefined, 'explicit-new-lid']) {
    const { client, calls } = fixture();
    const url = new URL(`https://www.zhipin.com/job_detail/${JOB}.html`);
    url.searchParams.set('securityId', 'explicit-new-security');
    if (explicitLid) url.searchParams.set('lid', explicitLid);
    const result = await client._jobContext(url.href);
    assert.deepEqual(calls.requests[0].options.query, { securityId: 'explicit-new-security', lid: explicitLid ?? '' });
    assert.equal(calls.requests.length, 1);
    assert.equal(calls.dom.length, 0);
    assert.equal(result.data.expectId, undefined);
    assert.equal(result.context.source, 'url');
    assert.equal(result.job.id, JOB);
  }
});

test('a fresh bare job ID uses its cached securityId and lid as a pair', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { client, calls } = fixture();
  const result = await client._jobContext(JOB);
  assert.deepEqual(calls.requests[0].options.query, { securityId: 'cached-security', lid: 'cached-lid' });
  assert.equal(calls.dom.length, 0);
  assert.equal(result.data.expectId, 'cached-expectation');
  assert.deepEqual(result.context, { source: 'cache', ageMs: 1000, localMaxAgeMs: JOB_CONTEXT_MAX_AGE_MS });
});

test('expired or future-dated cached context is not transmitted and normal page data replaces it', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  assert.equal(JOB_CONTEXT_MAX_AGE_MS, 30 * 60 * 1000);
  for (const updatedAt of [NOW - JOB_CONTEXT_MAX_AGE_MS - 1, NOW + 1000]) {
    const { client, calls } = fixture({ cached: cache(updatedAt), respond: noNetwork });
    const result = await client._jobContext(JOB);
    assert.equal(calls.requests.length, 0);
    assert.equal(calls.dom.length, 1);
    assert.equal(calls.dom[0].securityId, undefined);
    assert.equal(calls.dom[0].lid, undefined);
    assert.equal(result.job.securityId, 'fresh-page-security');
    assert.equal(result.job.lid, 'fresh-page-lid');
    assert.equal(result.data.expectId, undefined);
    assert.equal(result.context.source, 'rendered-page');
    assert.equal(calls.writes[0].value.records[JOB].normalized.securityId, 'fresh-page-security');
  }
});

test('an unavailable page after local expiry reports stale context rather than retrying the old API credentials', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const cause = new BossCliError('Page did not provide usable details', { code: 'SITE_CHANGED' });
  const { client, calls } = fixture({ cached: cache(NOW - JOB_CONTEXT_MAX_AGE_MS - 10), respond: noNetwork, dom: async () => { throw cause; } });
  await assert.rejects(() => client._jobContext(JOB), (error) => {
    assert.equal(error.code, 'STALE_JOB_CONTEXT');
    assert.equal(error.cause, cause);
    assert.equal(error.details.ageMs, JOB_CONTEXT_MAX_AGE_MS + 10);
    assert.equal(error.details.localMaxAgeMs, JOB_CONTEXT_MAX_AGE_MS);
    return true;
  });
  assert.equal(calls.requests.length, 0);
  assert.equal(calls.dom.length, 1);
  assert.equal(calls.writes.length, 0);
});

test('API verification, authentication, rate and network failures never trigger a second request or DOM fallback', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  for (const code of ['VERIFICATION_REQUIRED', 'AUTH_REQUIRED', 'RATE_LIMITED', 'NETWORK_ERROR']) {
    const failure = new BossCliError('Expected access error', { code, details: { ...(code === 'VERIFICATION_REQUIRED' ? { apiCode: 37 } : {}) } });
    const { client, calls } = fixture({ respond: async () => { throw failure; }, dom: noNetwork });
    await assert.rejects(() => client._jobContext(JOB), (error) => error === failure && error.code === code && error.details.context.source === 'cache' && (code !== 'VERIFICATION_REQUIRED' || error.details.apiCode === 37));
    assert.equal(calls.requests.length, 1, code);
    assert.equal(calls.dom.length, 0, code);
    assert.equal(calls.writes.length, 0, code);
  }
});

test('expiry does not relabel a page verification or network error as stale context', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  for (const code of ['VERIFICATION_REQUIRED', 'AUTH_REQUIRED', 'RATE_LIMITED', 'NETWORK_ERROR', 'JOB_MISMATCH']) {
    const failure = new BossCliError('Expected page error', { code });
    const { client, calls } = fixture({ cached: cache(NOW - JOB_CONTEXT_MAX_AGE_MS - 1), respond: noNetwork, dom: async () => { throw failure; } });
    await assert.rejects(() => client._jobContext(JOB), (error) => error === failure && error.code === code);
    assert.equal(calls.requests.length, 0);
    assert.equal(calls.dom.length, 1);
  }
});

test('bad cache shapes are misses and cannot corrupt a new valid detail record', async () => {
  for (const cached of [{}, { records: null }, { records: [] }, { records: { [JOB]: null } }, { records: { [JOB]: { normalized: null } } }, { records: { [JOB]: { normalized: { id: 'otherJob123' } } } }]) {
    const { client, calls } = fixture({ cached, respond: noNetwork });
    const result = await client._jobContext(JOB);
    assert.equal(result.job.id, JOB);
    assert.equal(calls.requests.length, 0);
    assert.equal(calls.dom.length, 1);
    assert.equal(calls.writes[0].value.records[JOB].normalized.id, JOB);
  }
});

test('non-object API jobInfo is a typed site-change error and does not activate fallback', async () => {
  for (const jobInfo of ['broken', [], null]) {
    const { client, calls } = fixture({ respond: async () => ({ code: 0, zpData: { jobInfo } }), dom: noNetwork });
    await assert.rejects(() => client._jobContext(`https://www.zhipin.com/job_detail/${JOB}.html?securityId=explicit`), { code: 'SITE_CHANGED' });
    assert.equal(calls.requests.length, 1);
    assert.equal(calls.dom.length, 0);
    assert.equal(calls.writes.length, 0);
  }
});

test('search reports the resolved city and filter codes that were actually sent', async () => {
  const { client, calls } = fixture({ cached: {}, respond: async () => ({ code: 0, zpData: { jobList: [{ encryptJobId: JOB, jobName: '开发职位', securityId: 'search-security' }], lid: 'search-lid', hasMore: false } }) });
  client._cityList = async () => [{ name: '北京', code: '101010100' }];
  const result = await client.search({ query: ' 开发 ', city: '北京', page: 2, limit: 30, filters: { education: '本科', salary: '10-20K', experience: '3-5年' } });
  assert.equal(result.city, '101010100');
  assert.deepEqual(result.filters, { experience: '105', degree: '203', salary: '405' });
  assert.equal(result.items[0].securityId, 'search-security');
  assert.equal(result.items[0].lid, 'search-lid');
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.requests[0].options.method, 'POST');
  assert.equal(calls.requests[0].options.mutation, false);
  assert.equal(calls.requests[0].options.form.query, '开发');
  assert.equal(calls.requests[0].options.form.city, result.city);
  assert.equal(calls.requests[0].options.form.page, '2');
  assert.equal(calls.requests[0].options.form.pageSize, '30');
});

test('a typed search challenge keeps code 37 and adds resolved request diagnostics without retrying', async () => {
  const failure = new BossCliError('请登录后完成安全验证', { code: 'VERIFICATION_REQUIRED', details: { apiCode: 37, path: '/wapi/zpgeek/search/joblist.json' } });
  const { client, calls } = fixture({ respond: async () => { throw failure; }, dom: noNetwork });
  client._cityList = async () => [{ name: '北京', code: '101010100' }];
  await assert.rejects(() => client.search({ query: '开发', city: '北京', filters: { education: '本科' } }), (error) => {
    assert.equal(error, failure);
    assert.equal(error.code, 'VERIFICATION_REQUIRED');
    assert.equal(error.details.apiCode, 37);
    assert.equal(error.details.request.method, 'POST');
    assert.equal(error.details.request.parameters.city, '101010100');
    assert.equal(error.details.request.parameters.degree, '203');
    assert.equal(Object.hasOwn(error.details.request.parameters, 'encryptExpectId'), false);
    return true;
  });
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.dom.length, 0);
  assert.equal(calls.writes.length, 0);
});

test('login confirmation removes old instructions and login/logout clear only the current profile/CDP job cache', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'boss-search-detail-'));
  try {
    const make = (profile, cdpUrl) => {
      const unknown = { connected: true, authenticated: null, instruction: 'Old DOM login instruction' };
      const session = { options: { profile, dataDir, ...(cdpUrl ? { cdpUrl } : {}) }, login: async () => ({ ...unknown, browserOpened: true }), pageState: async () => ({ ...unknown }), logout: async () => ({ loggedOut: true }) };
      return new BossClient({ session, fetch: noNetwork, transport: { request: async () => ({ code: 0, zpData: { friendList: [] } }) } });
    };
    const current = make('accountA', 'http://127.0.0.1:9222');
    const others = [make('accountA'), make('accountB'), make('accountA', 'http://127.0.0.1:9333')];
    await current._writeCache('jobs', { marker: 'current' });
    for (let index = 0; index < others.length; index++) await others[index]._writeCache('jobs', { marker: index });
    const cities = { items: [{ code: '101010100', name: '北京' }], updatedAt: NOW };
    await current._writeCache('cities', cities);
    const result = await current.login();
    assert.equal(result.authenticated, true);
    assert.equal(result.authenticationSource, 'authenticated-api');
    assert.equal(Object.hasOwn(result, 'instruction'), false);
    assert.equal(await current._readCache('jobs'), null);
    for (let index = 0; index < others.length; index++) assert.deepEqual(await others[index]._readCache('jobs'), { marker: index });
    assert.deepEqual(await current._readCache('cities'), cities);
    await current._writeCache('jobs', { marker: 'current-again' });
    assert.equal((await current.logout()).loggedOut, true);
    assert.equal(await current._readCache('jobs'), null);
    for (let index = 0; index < others.length; index++) assert.deepEqual(await others[index]._readCache('jobs'), { marker: index });
    assert.deepEqual(await others[0]._readCache('cities'), cities);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('HTTP 403 JSON code 37 retains verification classification and both status/code diagnostics', async () => {
  let requests = 0; let disposals = 0;
  const session = { options: { timeout: 1000 }, connect: async () => {}, context: { request: { fetch: async () => { requests++; return { status: () => 403, text: async () => JSON.stringify({ code: 37, message: '请登录后进行安全验证' }), dispose: async () => { disposals++; } }; } } } };
  await assert.rejects(() => new SiteTransport(session).request('/wapi/zpgeek/job/detail.json'), (error) => {
    assert.equal(error.code, 'VERIFICATION_REQUIRED');
    assert.equal(error.exitCode, 4);
    assert.equal(error.details.status, 403);
    assert.equal(error.details.apiCode, 37);
    assert.equal(error.details.path, '/wapi/zpgeek/job/detail.json');
    return true;
  });
  assert.equal(requests, 1);
  assert.equal(disposals, 1);
});
