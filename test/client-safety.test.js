import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BossClient } from '../src/boss-client.js';
import { SiteTransport } from '../src/site-transport.js';
import { ChatGateway } from '../src/chat-gateway.js';

const JOB_ID = 'targetJob123';
const JOB_URL = `https://www.zhipin.com/job_detail/${JOB_ID}.html?securityId=bound-security&lid=bound-lid`;
const goodContext = () => ({ target: { id: JOB_ID, url: JOB_URL }, data: { securityId: 'bound-security', lid: 'bound-lid', jobInfo: { encryptJobId: JOB_ID }, oneKeyResumeInfo: { canSendResume: true } }, job: { id: JOB_ID, title: '测试职位' } });

function fakeSession(options = {}) {
  return { options: { profile: 'safety-test', timeout: 1000, ...options }, navigate: async () => { throw new Error('Unexpected browser navigation'); }, assertUsable: async () => {}, close: async () => {} };
}

test('API detail must independently identify its encrypted job before any action can use it', async () => {
  for (const jobInfo of [{ jobName: 'No ID' }, { id: 123456, jobName: 'Only internal ID' }, { encryptId: null, jobName: 'Null encrypted ID' }, { encryptJobId: '', jobName: 'Empty encrypted ID' }]) {
    const routes = [];
    const client = new BossClient({ session: fakeSession(), transport: { request: async (route) => { routes.push(route); return { code: 0, zpData: { jobInfo } }; } } });
    await assert.rejects(() => client._jobContext(JOB_URL), { code: 'SITE_CHANGED' });
    assert.deepEqual(routes, ['/wapi/zpgeek/job/detail.json']);
  }
  for (const field of ['encryptJobId', 'encryptId']) {
    const client = new BossClient({ session: fakeSession(), transport: { request: async () => ({ code: 0, zpData: { jobInfo: { [field]: 'differentJob123', jobName: 'Wrong job' } } }) } });
    await assert.rejects(() => client._jobContext(JOB_URL), { code: 'JOB_MISMATCH' });
  }
  const verified = new BossClient({ session: fakeSession(), transport: { request: async () => ({ code: 0, zpData: { jobInfo: { encryptId: JOB_ID, jobName: 'Right job' } } }) } });
  assert.equal((await verified._jobContext(JOB_URL)).job.id, JOB_ID);
});

test('job caches are isolated by profile and CDP endpoint while public city data stays shared', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'boss-cli-safety-'));
  try {
    const make = (profile, cdpUrl) => new BossClient({ session: fakeSession({ dataDir, profile, ...(cdpUrl ? { cdpUrl } : {}) }), transport: {} });
    const ownedA = make('accountA'); const ownedB = make('accountB');
    const cdpA = make('accountA', 'http://127.0.0.1:9222'); const cdpB = make('accountA', 'http://127.0.0.1:9333');
    const clients = [ownedA, ownedB, cdpA, cdpB];
    assert.equal(new Set(clients.map((client) => client._cachePath('jobs'))).size, 4);
    assert.equal(new Set(clients.map((client) => client._cachePath('cities'))).size, 1);
    assert.equal(cdpA._cachePath('jobs'), make('accountA', 'http://127.0.0.1:9222')._cachePath('jobs'));
    assert.ok(!cdpA._cachePath('jobs').includes('http://'));
    for (let index = 0; index < clients.length; index++) await clients[index]._writeCache('jobs', { accountMarker: index });
    for (let index = 0; index < clients.length; index++) assert.deepEqual(await clients[index]._readCache('jobs'), { accountMarker: index });
    await ownedA._writeCache('cities', { items: [{ name: '北京', code: '101010100' }], updatedAt: 123 });
    assert.deepEqual(await cdpB._readCache('cities'), { items: [{ name: '北京', code: '101010100' }], updatedAt: 123 });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('invalid start/apply followup text fails before fetching job details or performing writes', async () => {
  for (const message of ['x'.repeat(1000), '   ', 123, null]) {
    let reads = 0; let requests = 0;
    const client = new BossClient({ session: fakeSession(), transport: { request: async () => { requests++; throw new Error('Unexpected network request'); } } });
    client._jobContext = async () => { reads++; return goodContext(); };
    await assert.rejects(() => client.chats({ action: 'start', target: JOB_URL, text: message, execute: true }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(() => client.apply({ action: 'send', target: JOB_URL, message, execute: true }), { code: 'INVALID_ARGUMENT' });
    assert.equal(reads, 0);
    assert.equal(requests, 0);
  }
});

test('malformed or duplicated attachment identifiers stop before any resume submission', async () => {
  const invalidLists = [undefined, null, {}, [null], [undefined], [{}], [{ resumeId: null }], [{ resumeId: '' }], [{ resumeId: '  ' }], [{ resumeId: 'bad\u0000id' }], [{ resumeId: '42' }, { resumeId: 42 }]];
  for (const resumeList of invalidLists) {
    const requests = []; let navigation = 0;
    const session = fakeSession(); session.navigate = async () => { navigation++; throw new Error('Must not begin UI delivery'); };
    const client = new BossClient({ session, transport: { request: async (route, options) => { requests.push({ route, options }); return { code: 0, zpData: { resumeList } }; } } });
    client._jobContext = async () => goodContext();
    await assert.rejects(() => client.apply({ action: 'send', target: JOB_URL, execute: true }), { code: 'SITE_CHANGED' });
    assert.equal(navigation, 0);
    assert.deepEqual(requests.map(({ route }) => route), ['/wapi/zpgeek/resume/attachment/checkbox.json']);
    assert.ok(requests.every(({ options }) => !options || options.method !== 'POST'));
  }
});

test('zero attachments is a valid preview and requires a user-provided site attachment before execution', async () => {
  const client = new BossClient({ session: fakeSession(), transport: { request: async () => ({ code: 0, zpData: { resumeList: [] } }) } });
  client._jobContext = async () => goodContext();
  const preview = await client.apply({ target: JOB_URL });
  assert.deepEqual(preview.resumes, []);
  assert.equal(preview.executed, false);
  assert.equal(preview.selectedResume, null);
  await assert.rejects(() => client.apply({ action: 'send', target: JOB_URL, execute: true }), { code: 'INVALID_ARGUMENT' });
});

test('a successful initial greeting followed by failed friend lookup is reported as partial success without resending', async () => {
  for (const lookup of [async () => { throw new Error('SDK lookup failed'); }, async () => null]) {
    const writes = []; let followupSends = 0;
    const client = new BossClient({ session: fakeSession(), transport: { request: async (route, options) => { writes.push({ route, options }); return { code: 0, message: 'Success' }; } } });
    client._jobContext = async () => goodContext();
    client._chatGateway = async () => ({ findByJob: lookup, send: async () => { followupSends++; throw new Error('No unique recipient'); } });
    await assert.rejects(() => client.chats({ action: 'start', target: JOB_URL, text: '您好，想进一步了解职位', execute: true }), (error) => {
      assert.equal(error.code, 'PARTIAL_SUCCESS');
      assert.equal(error.details.started, true);
      assert.match(error.message, /勿重复开聊/);
      return true;
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].route, '/wapi/zpgeek/friend/add.json');
    assert.equal(writes[0].options.method, 'POST');
    assert.equal(writes[0].options.query.jobId, JOB_ID);
    assert.equal(followupSends, 0);
  }
});

test('uncertain write POST delivery requires record reconciliation and disables automatic retries', async () => {
  let requests = 0;
  const failure = new Error('Connection dropped after request dispatch');
  const session = { options: { timeout: 1000 }, connect: async () => {}, context: { request: { fetch: async () => { requests++; throw failure; } } } };
  const transport = new SiteTransport(session);
  await assert.rejects(() => transport.request('/wapi/zpgeek/friend/add.json', { method: 'POST', form: { sessionId: '' } }), (error) => {
    assert.equal(error.code, 'DELIVERY_UNCONFIRMED');
    assert.equal(error.exitCode, 4);
    assert.equal(error.details.automaticRetry, false);
    assert.equal(error.details.attempted, 'unknown');
    assert.match(error.message, /核对站点记录.*勿直接重试/);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(requests, 1);
});

test('read-only POST search and getFriends transport failures remain network errors', async () => {
  const requests = [];
  const session = { options: { timeout: 1000 }, connect: async () => {}, context: { request: { fetch: async (url, options) => { requests.push({ url, options }); throw new Error('Network unavailable'); } } } };
  const transport = new SiteTransport(session);
  const client = new BossClient({ session, transport });
  const chats = new ChatGateway(session, transport);
  await assert.rejects(() => client.search({ query: '开发' }), { code: 'NETWORK_ERROR' });
  await assert.rejects(() => chats.details([{ friendId: '42', friendSource: 0 }]), { code: 'NETWORK_ERROR' });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), ['/wapi/zpgeek/search/joblist.json', '/wapi/zprelation/friend/getGeekFriendList.json']);
  assert.ok(requests.every(({ options }) => options.method === 'POST'));
});
