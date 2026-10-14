import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSearchParams, normalizeJob, parseJobTarget, assertApiSuccess, flattenCities, resolveCity } from '../src/protocol.js';

test('search protocol serializes observed fields with names mapped to site codes', () => {
  const params = buildSearchParams({ query: ' 前端 开发 ', city: '101010100', page: 2, limit: 30, filters: { education: '本科', experience: ['1-3年', '3-5年'], salary: '10-20K', jobType: '全职', businessDistrict: '110108:123', subway: '1:2', industry: [100001, 100002] } });
  assert.ok(params instanceof URLSearchParams);
  assert.equal(params.get('query'), '前端 开发');
  assert.equal(params.get('city'), '101010100');
  assert.equal(params.get('page'), '2');
  assert.equal(params.get('pageSize'), '30');
  assert.equal(params.get('degree'), '203');
  assert.equal(params.get('experience'), '104,105');
  assert.equal(params.get('salary'), '405');
  assert.equal(params.get('jobType'), '1901');
  assert.equal(params.get('multiBusinessDistrict'), '110108:123');
  assert.equal(params.get('multiSubway'), '1:2');
  assert.equal(params.get('industry'), '100001,100002');
  assert.equal(params.get('scene'), '1');
  assert.equal(params.get('encryptExpectId'), '');
  assert.equal(params.get('position'), '');
  const defaults = buildSearchParams({ query: '开发' });
  assert.equal(defaults.get('page'), '1');
  assert.equal(defaults.get('pageSize'), '15');
  assert.equal(defaults.get('city'), '100010000');
});

test('search protocol refuses unsupported, duplicate or invalid parameters', () => {
  for (const options of [{ city: '北京' }, { page: 0 }, { limit: 101 }, { filters: { sort: 'recent' } }, { filters: { degree: '203', education: '本科' } }, { filters: { salary: '很多钱' } }, { filters: [] }]) {
    assert.throws(() => buildSearchParams({ query: 'dev', ...options }), (error) => ['INVALID_ARGUMENT', 'USAGE_ERROR'].includes(error.code));
  }
});

test('job normalization keeps public fields and opaque IDs without retaining entire raw response', () => {
  const job = normalizeJob({ encryptJobId: 'abc123_XYZ', jobName: '前端开发', salaryDesc: '20-30K', brandName: '示例公司', cityName: '北京', areaDistrict: '海淀区', businessDistrict: '中关村', jobExperience: '3-5年', jobDegree: '本科', skills: ['JavaScript'], jobLabels: ['HTML', 'CSS'], welfareList: [{ name: '五险一金' }], bossName: '张女士', bossTitle: '招聘经理', securityId: 'opaque+value=', jobType: 0, extraSecret: 'not copied' }, { lid: 'trace-1' });
  assert.equal(job.id, 'abc123_XYZ');
  assert.equal(job.title, '前端开发');
  assert.equal(job.company, '示例公司');
  assert.equal(job.district, '海淀区');
  assert.deepEqual(job.welfare, ['五险一金']);
  assert.equal(job.jobType, 0);
  assert.ok(!('raw' in job));
  assert.ok(!('extraSecret' in job));
  const url = new URL(job.url);
  assert.equal(url.searchParams.get('securityId'), 'opaque+value=');
  assert.equal(url.searchParams.get('lid'), 'trace-1');
  assert.deepEqual(parseJobTarget(job.url), { id: 'abc123_XYZ', encryptJobId: 'abc123_XYZ', securityId: 'opaque+value=', lid: 'trace-1', url: job.url });
  const detail = normalizeJob({ jobInfo: { encryptJobId: 'detail123', jobName: '工程师' }, bossInfo: { name: '李经理', title: 'HR' }, brandComInfo: { brandName: '公司', welfareList: ['带薪年假'] } });
  assert.equal(detail.bossName, '李经理');
  assert.equal(detail.company, '公司');
});

test('job targets accept only valid IDs and exact HTTPS site detail URLs', () => {
  assert.equal(parseJobTarget('abc123_XYZ').id, 'abc123_XYZ');
  assert.equal(parseJobTarget('https://zhipin.com/job_detail/abc123_XYZ.html?ka=search&lid=a&securityId=b').url, 'https://www.zhipin.com/job_detail/abc123_XYZ.html?securityId=b&lid=a');
  for (const target of ['abc', '../abc123', 'https://example.com/job_detail/abc123.html', 'http://www.zhipin.com/job_detail/abc123.html', 'https://evil.zhipin.com/job_detail/abc123.html', 'https://user:password@www.zhipin.com/job_detail/abc123.html', 'https://www.zhipin.com:123/job_detail/abc123.html', 'https://www.zhipin.com/job_detail/../job_detail/abc123.html', 'https://www.zhipin.com/job_detail/%2e%2e/job_detail/abc123.html', 'https://www.zhipin.com/job_detail/a%2fb123.html', 'https://www.zhipin.com/job_detail/abc123.html?lid=a&lid=b', 'https://www.zhipin.com/job_detail/abc123.html#token']) {
    assert.throws(() => parseJobTarget(target), { code: 'INVALID_ARGUMENT' }, target);
  }
});

test('detail jobInfo encryptId remains an actionable public job target instead of falling back to internal numeric ID', () => {
  const job = normalizeJob({ jobInfo: { encryptId: 'detailEncrypted_123', id: 123456, jobName: '后端开发', securityId: 'job-bound-security' }, bossInfo: { name: '招聘负责人' } }, { lid: 'detail-trace' });
  assert.equal(job.id, 'detailEncrypted_123');
  assert.equal(job.encryptJobId, 'detailEncrypted_123');
  assert.equal(parseJobTarget(job.url).id, 'detailEncrypted_123');
  assert.equal(parseJobTarget(job.url).securityId, 'job-bound-security');
  assert.equal(parseJobTarget(job.url).lid, 'detail-trace');
});

test('internal numeric job IDs are rejected before browser navigation', () => {
  for (const value of ['123456', 'https://www.zhipin.com/job_detail/123456.html']) assert.throws(() => parseJobTarget(value), { code: 'INVALID_ARGUMENT' });
});

test('numeric internal IDs and malformed encrypted IDs never become actionable job URLs', () => {
  for (const field of ['id', 'jobId', 'encryptJobId', 'encryptId']) {
    for (const value of [123456, '123456', '000123456', ' abc123 ', '../abc123', 'abc/123', 'abc123?securityId=x', {}, ['abc123']]) {
      const job = normalizeJob({ [field]: value, jobName: '保留可读信息', securityId: 'opaque-context' });
      assert.equal(job.id, undefined, `${field}: ${String(value)}`);
      assert.equal(job.encryptJobId, undefined, `${field}: ${String(value)}`);
      assert.equal(job.url, undefined, `${field}: ${String(value)}`);
      assert.equal(job.title, '保留可读信息');
    }
  }
});

test('opaque compatibility IDs keep their original spelling while explicit encrypted IDs win', () => {
  for (const field of ['id', 'jobId']) {
    const job = normalizeJob({ [field]: 'Opaque_job-123', jobName: '兼容字段职位' });
    assert.equal(job.id, 'Opaque_job-123');
    assert.equal(parseJobTarget(job.url).id, 'Opaque_job-123');
  }
  const job = normalizeJob({ encryptJobId: 'explicitJob123', encryptId: 'secondaryJob123', id: 'legacyJob123', jobId: 'otherLegacy123', jobName: '明确身份' });
  assert.equal(job.id, 'explicitJob123');
  const nested = normalizeJob({ id: 123456, jobInfo: { encryptId: 'detailOpaque123', id: 999999 } });
  assert.equal(nested.id, 'detailOpaque123');
});

test('API failures retain site code and remain errors instead of becoming empty lists', () => {
  const success = { code: 0, zpData: { jobList: [] } };
  assert.equal(assertApiSuccess(success), success);
  for (const [payload, code] of [
    [{ code: 7, message: 'expired' }, 'AUTH_REQUIRED'], [{ code: 1011, message: 'x' }, 'AUTH_REQUIRED'], [{ code: 200404, message: 'x' }, 'AUTH_REQUIRED'],
    [{ code: 5012, message: 'x' }, 'VERIFICATION_REQUIRED'], [{ code: 122, message: 'x' }, 'VERIFICATION_REQUIRED'], [{ code: 37, message: '您的访问行为异常，请进行安全验证' }, 'VERIFICATION_REQUIRED'],
    [{ code: 999, message: '操作过于频繁，请稍后再试' }, 'RATE_LIMITED'], [{ code: 12, message: 'Job unavailable' }, 'SITE_API_ERROR'],
  ]) assert.throws(() => assertApiSuccess(payload, { path: '/wapi/example' }), (error) => error.code === code && error.details.apiCode === payload.code && error.details.path === '/wapi/example');
  for (const payload of [undefined, '', [], {}, { code: null }, { code: 'bad' }]) assert.throws(() => assertApiSuccess(payload), { code: 'SITE_CHANGED' });
});

test('a generic retry hint alone does not prove rate limiting', () => {
  assert.throws(() => assertApiSuccess({ code: 999, message: '系统异常，请稍后再试' }), { code: 'SITE_API_ERROR' });
});

test('code 37 reports the browser environment check without exposing or computing challenge fields', () => {
  const payload = { code: 37, message: '请求异常，请稍后重试', zpData: { name: 'observed-script', ts: 123, seed: 'challenge-seed' } };
  assert.throws(() => assertApiSuccess(payload, { path: '/wapi/zpgeek/search/joblist.json' }), (error) => {
    assert.equal(error.code, 'VERIFICATION_REQUIRED');
    assert.equal(error.exitCode, 4);
    assert.match(error.message, /浏览器环境检查尚未完成/);
    assert.equal(error.details.apiCode, 37);
    assert.ok(!JSON.stringify(error.details).includes('challenge-seed'));
    assert.ok(!JSON.stringify(error.details).includes('observed-script'));
    return true;
  });
  assert.deepEqual(payload.zpData, { name: 'observed-script', ts: 123, seed: 'challenge-seed' });
});

test('known business codes retain their classification despite conflicting login, verification or retry wording', () => {
  for (const apiCode of [37, 5012, 120, 121, 122]) {
    for (const message of ['请登录后完成安全验证', 'login required; too many requests', '未登录，请稍后再试']) {
      assert.throws(() => assertApiSuccess({ code: apiCode, message }, { path: '/wapi/example' }), (error) => error.code === 'VERIFICATION_REQUIRED' && error.exitCode === 4 && error.details.apiCode === apiCode);
    }
  }
  for (const apiCode of [7, 1011, 200404]) {
    for (const message of ['安全验证失败，请稍后再试', 'captcha verification required']) {
      assert.throws(() => assertApiSuccess({ code: apiCode, message }), (error) => error.code === 'AUTH_REQUIRED' && error.exitCode === 3 && error.details.apiCode === apiCode);
    }
  }
  for (const message of ['Job unavailable', '职位不可用，请稍后再试', '请登录后进行安全验证']) {
    assert.throws(() => assertApiSuccess({ code: 12, message }), (error) => error.code === 'SITE_API_ERROR' && error.exitCode === 1 && error.details.apiCode === 12);
  }
  assert.throws(() => assertApiSuccess({ code: '37', message: '请登录' }), { code: 'VERIFICATION_REQUIRED', exitCode: 4 });
  assert.throws(() => assertApiSuccess({ code: 9999, message: '请登录' }), { code: 'AUTH_REQUIRED' });
  assert.throws(() => assertApiSuccess({ code: 9999, message: '需要安全验证' }), { code: 'VERIFICATION_REQUIRED' });
});

test('city flattening deduplicates hot cities and excludes provinces/districts', () => {
  const payload = { code: 0, zpData: { hotCityList: [{ code: 100010000, name: '全国' }, { code: 101010100, name: '北京' }], cityList: [
    { code: 101010000, name: '北京', subLevelModelList: [{ code: 101010100, name: '北京', subLevelModelList: [{ code: 110108, name: '海淀区', cityType: 4 }] }] },
    { code: 101280000, name: '广东', subLevelModelList: [{ code: 101280600, name: '深圳', pinyin: 'shenzhen' }] },
  ] } };
  assert.deepEqual(flattenCities(payload), [{ code: '100010000', name: '全国' }, { code: '101010100', name: '北京', province: '北京' }, { code: '101280600', name: '深圳', province: '广东', pinyin: 'shenzhen' }]);
  assert.equal(resolveCity('北京', payload), '101010100');
  assert.equal(resolveCity('深圳市', payload), '101280600');
  assert.equal(resolveCity('101280600', payload), '101280600');
  assert.throws(() => resolveCity('海淀区', payload), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => flattenCities({ code: 7, message: '未登录' }), { code: 'AUTH_REQUIRED' });
});

test('city resolution reports ambiguous exact names and supports common province/city containers', () => {
  const cities = flattenCities({ province: [{ code: '440000', name: '广东省', city: [{ code: '101280600', name: '深圳市' }] }] });
  assert.deepEqual(cities, [{ code: '101280600', name: '深圳市', province: '广东省' }]);
  assert.equal(resolveCity('深圳', cities), '101280600');
  assert.throws(() => resolveCity('同名', [{ code: '101280100', name: '同名' }, { code: '101280200', name: '同名' }]), (error) => error.code === 'INVALID_ARGUMENT' && error.details.candidates.length === 2);
  assert.throws(() => resolveCity('不存在', cities), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => resolveCity('北京', {}), { code: 'SITE_CHANGED' });
});

test('public city tree fixture resolves municipalities, provinces and special regions correctly', async () => {
  const response = JSON.parse(await readFile(new URL('./fixtures/cities-response.json', import.meta.url), 'utf8'));
  const cities = flattenCities(response);
  assert.ok(cities.length > 300);
  for (const [name, code] of [['全国', '100010000'], ['北京', '101010100'], ['上海', '101020100'], ['深圳', '101280600'], ['香港', '101320300'], ['澳门', '101330100'], ['台湾', '101341100']]) assert.equal(resolveCity(name, cities), code);
  assert.ok(cities.every((city) => city.code.length === 9));
  assert.ok(!cities.some((city) => city.name === '海淀区' || city.name === '广东'));
});
