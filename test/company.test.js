import test from 'node:test';
import assert from 'node:assert/strict';
import { BossClient } from '../src/boss-client.js';
import { BossCliError } from '../src/errors.js';

const JOB = 'company-test-job';
const NOW = 2_000_000_000_000;
const url = `https://www.zhipin.com/job_detail/${JOB}.html?securityId=url-security&lid=url-lid`;
const noNetwork = async () => { throw new Error('Company tests must not access the network'); };
const company = () => ({
  encryptBrandId: 'company-test-brand', brandName: ' 发布公司 ', industryName: '软件',
  scaleName: '100-499人', stageName: 'B轮', introduce: ' 公司简介\n第二行 ',
  labels: ['五险一金', ' 五险一金 ', null, '年假'], visibleBrandInfo: true,
  customerBrandName: '客户公司', customerBrandStageName: '上市公司',
  phone: 'private-company-phone', secret: 'private-company-secret',
});
const detail = (brand = company()) => ({
  jobInfo: { encryptId: JOB, jobName: '开发岗位', cityName: '成都', locationName: '成都·高新区', address: '工作地点示例路1号', postDescription: 'private-job-description', anonymous: 0 },
  brandComInfo: brand, bossInfo: { name: 'private-recruiter-name', brandName: '招聘者所属公司' },
  securityId: 'private-security', lid: 'private-lid', sessionId: 'private-session',
});
const cache = () => ({ records: { [JOB]: { updatedAt: NOW - 1000, normalized: { id: JOB, title: '缓存岗位', securityId: 'cache-security', lid: 'cache-lid' } } } });

function fixture({ cached = null, data = detail(), failure, domData = data } = {}) {
  const calls = { requests: [], pages: [], localCacheWrites: [] };
  const client = new BossClient({
    session: { options: { profile: 'company-unit-fixture', timeout: 1000 } }, fetch: noNetwork,
    transport: { request: async (route, options) => {
      calls.requests.push({ route, options });
      assert.equal(route, '/wapi/zpgeek/job/detail.json', 'Company reads must not request write or extra endpoints');
      assert.notEqual(options?.mutation, true);
      assert.ok(!options?.method || options.method === 'GET');
      if (failure) throw failure;
      return { code: 0, zpData: data };
    } },
  });
  client._readCache = async () => cached;
  client._writeCache = async (name, value) => calls.localCacheWrites.push({ name, value });
  client._domDetail = async target => { calls.pages.push(target); if (failure) throw failure; return domData; };
  return { client, calls };
}

test('company exposes only supported fields and distinguishes job company, recruiter company and workplace', async () => {
  const { client, calls } = fixture();
  const result = await client.company({ target: url });
  assert.equal(result.id, 'company-test-brand');
  assert.equal(result.url, 'https://www.zhipin.com/gongsi/company-test-brand.html');
  assert.equal(result.name, '发布公司');
  assert.equal(result.industry, '软件');
  assert.equal(result.scale, '100-499人');
  assert.equal(result.stage, 'B轮');
  assert.equal(result.description, '公司简介\n第二行');
  assert.deepEqual(result.welfare, ['五险一金', '年假']);
  assert.deepEqual(result.recruitingCompany, { name: '招聘者所属公司' });
  assert.deepEqual(result.job, { id: JOB, title: '开发岗位', location: '成都·高新区', workAddress: '工作地点示例路1号' });
  assert.equal(result.observedFrom, 'job/detail.json');
  assert.deepEqual(result.context, { source: 'url' });
  assert.ok(!JSON.stringify(result).includes('private-'), 'Do not expose recruiter/contact/session or unrelated job data');
  for (const field of ['address', 'registeredAddress', 'legalRepresentative', 'registrationNumber', 'raw', 'securityId', 'lid', 'sessionId', 'profileVisible', 'customerCompany']) assert.equal(Object.hasOwn(result, field), false, field);
  assert.equal(calls.requests.length, 1);
  assert.deepEqual(calls.requests[0].options.query, { securityId: 'url-security', lid: 'url-lid' });
  assert.equal(calls.pages.length, 0);
});

test('company uses the same fresh cached job context without borrowing context for an explicit URL', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const cached = fixture({ cached: cache() });
  const result = await cached.client.company({ target: JOB });
  assert.equal(result.context.source, 'cache');
  assert.equal(result.context.ageMs, 1000);
  assert.deepEqual(cached.calls.requests[0].options.query, { securityId: 'cache-security', lid: 'cache-lid' });
  assert.equal(cached.calls.requests.length, 1);
  assert.equal(cached.calls.pages.length, 0);

  const explicit = fixture({ cached: cache() });
  await explicit.client.company({ target: `https://www.zhipin.com/job_detail/${JOB}.html?securityId=explicit-only` });
  assert.deepEqual(explicit.calls.requests[0].options.query, { securityId: 'explicit-only', lid: '' });
  assert.equal(explicit.calls.requests.length, 1);
});

test('uncached company reads reuse the requested job page and do not invent an independent company API', async () => {
  const data = { ...detail(), observedFrom: 'rendered-page' };
  const { client, calls } = fixture({ domData: data });
  const result = await client.company({ target: JOB });
  assert.equal(result.name, '发布公司');
  assert.equal(result.observedFrom, 'rendered-page');
  assert.deepEqual(result.context, { source: 'rendered-page' });
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.pages[0].id, JOB);
  assert.equal(calls.requests.length, 0);
});

test('company validates the requested job identity before returning a different posting company', async t => {
  for (const source of ['url', 'rendered-page']) {
    await t.test(source, async () => {
      const data = detail(); data.jobInfo.encryptId = 'unrelated-job';
      const { client, calls } = fixture({ data });
      await assert.rejects(() => client.company({ target: source === 'url' ? url : JOB }), { code: 'JOB_MISMATCH' });
      assert.equal(calls.localCacheWrites.length, 0);
      assert.equal(calls.requests.length + calls.pages.length, 1);
    });
  }
});

test('code 37 and other access failures propagate without a second API request or page fallback', async t => {
  for (const code of ['VERIFICATION_REQUIRED', 'AUTH_REQUIRED', 'RATE_LIMITED', 'NETWORK_ERROR']) {
    await t.test(code, async () => {
      const failure = new BossCliError('Synthetic access failure', { code, details: code === 'VERIFICATION_REQUIRED' ? { apiCode: 37, path: '/wapi/zpgeek/job/detail.json' } : {} });
      const { client, calls } = fixture({ failure });
      await assert.rejects(() => client.company({ target: url }), error => {
        assert.equal(error, failure);
        assert.equal(error.code, code);
        if (code === 'VERIFICATION_REQUIRED') assert.equal(error.details.apiCode, 37);
        return true;
      });
      assert.equal(calls.requests.length, 1);
      assert.equal(calls.pages.length, 0);
      assert.equal(calls.localCacheWrites.length, 0);
    });
  }
});

test('missing company data is explicit and malformed company objects are not passed through', async t => {
  const cases = [
    ['missing', undefined, 'COMPANY_INFO_UNAVAILABLE'], ['null', null, 'COMPANY_INFO_UNAVAILABLE'],
    ['empty', {}, 'COMPANY_INFO_UNAVAILABLE'], ['blank name', { brandName: '  ' }, 'COMPANY_INFO_UNAVAILABLE'],
    ['non-text name', { brandName: 123 }, 'COMPANY_INFO_UNAVAILABLE'],
    ['string', 'broken', 'SITE_CHANGED'], ['array', [], 'SITE_CHANGED'], ['number', 42, 'SITE_CHANGED'],
  ];
  for (const [name, brand, code] of cases) {
    await t.test(name, async () => {
      const data = detail(); data.brandComInfo = brand;
      const { client, calls } = fixture({ data });
      await assert.rejects(() => client.company({ target: url }), { code });
      assert.equal(calls.requests.length, 1);
      assert.equal(calls.pages.length, 0);
    });
  }
});

test('absent optional fields remain absent and a false visibility value cannot authorize a homepage', async () => {
  const data = detail({ brandName: '只有名称的公司', encryptBrandId: 'https://foreign.example/company', industryName: null, scaleName: '', stageName: ' ', introduce: null, labels: [], visibleBrandInfo: false, customerBrandName: ' ', customerBrandStageName: '上市公司' });
  delete data.jobInfo.locationName;
  delete data.jobInfo.address;
  const { client } = fixture({ data });
  const result = await client.company({ target: url });
  assert.equal(result.name, '只有名称的公司');
  assert.deepEqual(result.welfare, []);
  assert.deepEqual(result.job, { id: JOB, title: '开发岗位', location: '成都' });
  for (const field of ['id', 'industry', 'scale', 'stage', 'description', 'customerCompany', 'url', 'address', 'registeredAddress', 'profileVisible']) assert.equal(Object.hasOwn(result, field), false, field);

  const unknown = await fixture({ data: detail({ brandName: '名称', visibleBrandInfo: 'false', labels: 'not-an-array' }) }).client.company({ target: url });
  assert.equal(Object.hasOwn(unknown, 'profileVisible'), false);
  assert.equal(Object.hasOwn(unknown, 'welfare'), false);
});

test('anonymous or hidden job context cannot be presented as a public company profile or address', async t => {
  const cases = [
    ['anonymous job', data => { data.jobInfo.anonymous = 1; }],
    ['unknown anonymity', data => { delete data.jobInfo.anonymous; }],
    ['non-numeric anonymity', data => { data.jobInfo.anonymous = '0'; }],
    ['company visibility false', data => { data.brandComInfo.visibleBrandInfo = false; }],
  ];
  for (const [name, alter] of cases) {
    await t.test(name, async () => {
      const data = detail(); alter(data);
      const result = await fixture({ data }).client.company({ target: url });
      assert.equal(result.name, '发布公司');
      assert.equal(Object.hasOwn(result, 'id'), false);
      assert.equal(Object.hasOwn(result, 'url'), false);
      assert.equal(Object.hasOwn(result.job, 'workAddress'), false);
    });
  }
  for (const visibility of [undefined, null, 'true', 1]) {
    const data = detail(); data.brandComInfo.visibleBrandInfo = visibility;
    const result = await fixture({ data }).client.company({ target: url });
    assert.equal(Object.hasOwn(result.job, 'workAddress'), false, `Visibility ${visibility} must not authorize a work address`);
  }
});

test('recruiter-mediated jobs retain company names without inventing a public homepage', async t => {
  const cases = [
    ['proxy job', data => { data.jobInfo.proxyJob = true; }],
    ['proxy type', data => { data.jobInfo.proxyType = 1; }],
    ['hunter listing', data => { data.hunterJob = true; }],
    ['hunter job', data => { data.jobInfo.hunterJob = true; }],
    ['hunter recruiter', data => { data.bossInfo.hunterJob = true; }],
    ['recruiter source', data => { data.bossInfo.bossSource = 1; }],
  ];
  for (const [name, alter] of cases) {
    await t.test(name, async () => {
      const data = detail(); alter(data);
      const result = await fixture({ data }).client.company({ target: url });
      assert.equal(result.name, '发布公司');
      assert.deepEqual(result.recruitingCompany, { name: '招聘者所属公司' });
      assert.equal(Object.hasOwn(result, 'id'), false);
      assert.equal(Object.hasOwn(result, 'url'), false);
    });
  }
});

test('observed company ID alphabet allows a tilde but cannot inject a different homepage route', async () => {
  for (const id of ['brand_123-~ABC', 'brand/elsewhere', 'brand?redirect=evil', 'brand#fragment', '../elsewhere', 'brand%2Felsewhere', 'https://foreign.example/brand']) {
    const data = detail(); data.brandComInfo.encryptBrandId = id;
    const result = await fixture({ data }).client.company({ target: url });
    if (id === 'brand_123-~ABC') {
      assert.equal(result.id, id);
      assert.equal(result.url, `https://www.zhipin.com/gongsi/${id}.html`);
    } else {
      assert.equal(Object.hasOwn(result, 'id'), false, id);
      assert.equal(Object.hasOwn(result, 'url'), false, id);
    }
  }
});
