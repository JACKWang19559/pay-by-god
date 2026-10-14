import { BossCliError } from './errors.js';
import { positiveInteger } from './config.js';

const ORIGIN = 'https://www.zhipin.com';
const JOB_ID = /^(?!\d+$)[A-Za-z0-9][A-Za-z0-9_-]{5,199}$/;
// Names and codes are from the site's retained common-condition response.
const FILTER_CODES = {
  experience: { 不限: '0', 在校生: '108', 应届生: '102', 经验不限: '101', '1年以内': '103', '1-3年': '104', '3-5年': '105', '5-10年': '106', '10年以上': '107' },
  degree: { 不限: '0', '初中及以下': '209', '中专/中技': '208', 高中: '206', 大专: '202', 本科: '203', 硕士: '204', 博士: '205' },
  salary: { 不限: '0', '3K以下': '402', '3-5K': '403', '5-10K': '404', '10-20K': '405', '20-50K': '406', '50K以上': '407' },
  stage: { 不限: '0', 未融资: '801', 天使轮: '802', A轮: '803', B轮: '804', C轮: '805', 'D轮及以上': '806', 已上市: '807', 不需要融资: '808' },
  scale: { 不限: '0', '0-20人': '301', '20-99人': '302', '100-499人': '303', '500-999人': '304', '1000-9999人': '305', '10000人以上': '306' },
  jobType: { 不限: '0', 全职: '1901', 兼职: '1903' },
};

const FILTER_FIELDS = {
  position: 'position', industry: 'industry', experience: 'experience', education: 'degree', degree: 'degree', salary: 'salary', scale: 'scale', stage: 'stage', jobType: 'jobType', businessDistrict: 'multiBusinessDistrict', multiBusinessDistrict: 'multiBusinessDistrict', subway: 'multiSubway', multiSubway: 'multiSubway',
};

function filterValue(field, value) {
  if (value === null || value === undefined || value === '') return '';
  const values = (Array.isArray(value) ? value : String(value).split(',')).map((item) => String(item).trim());
  if (values.some((item) => !item || /[\x00-\x1f\x7f]/.test(item))) throw new BossCliError(`搜索筛选 ${field} 包含无效值。`, { code: 'INVALID_ARGUMENT' });
  const dictionary = FILTER_CODES[field];
  return values.map((item) => {
    if (!dictionary) return item;
    if (/^\d+$/.test(item)) return item;
    const exact = Object.keys(dictionary).find((key) => key.toLowerCase() === item.toLowerCase());
    if (exact !== undefined) return dictionary[exact];
    throw new BossCliError(`不支持的 ${field} 筛选：${item}。请使用站点数值代码或以下名称：${Object.keys(dictionary).join('、')}。`, { code: 'INVALID_ARGUMENT' });
  }).join(',');
}

export function buildSearchParams({ query = '', city = '100010000', page, limit, filters = {} } = {}) {
  if (typeof query !== 'string') throw new BossCliError('搜索关键词必须是文字。', { code: 'INVALID_ARGUMENT' });
  const cityCode = city === '' || city === null || city === undefined ? '100010000' : String(city);
  if (!/^\d{9}$/.test(cityCode)) throw new BossCliError('搜索请求需要 9 位城市代码；请先通过 cities 命令解析城市名称。', { code: 'INVALID_ARGUMENT' });
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new BossCliError('搜索筛选必须是对象。', { code: 'INVALID_ARGUMENT' });
  const params = new URLSearchParams({
    query: query.trim(), city: cityCode,
    page: String(positiveInteger(page, 'page', { defaultValue: 1, max: 500 })),
    pageSize: String(positiveInteger(limit, 'limit', { defaultValue: 15, max: 100 })),
    scene: '1', encryptExpectId: '',
    position: '', industry: '', experience: '', degree: '', salary: '', scale: '', stage: '', jobType: '', multiBusinessDistrict: '', multiSubway: '',
  });
  const assigned = new Set();
  for (const [name, value] of Object.entries(filters)) {
    const field = FILTER_FIELDS[name];
    if (!field) throw new BossCliError(`当前已观察到的站点搜索请求不支持筛选 ${name}。`, { code: 'INVALID_ARGUMENT' });
    if (assigned.has(field)) throw new BossCliError(`筛选 ${field} 被重复指定。`, { code: 'INVALID_ARGUMENT' });
    assigned.add(field);
    params.set(field, filterValue(field, value));
  }
  return params;
}

function optionalString(value) {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}
function opaqueJobId(value) {
  // Internal numeric IDs are not interchangeable with the site's encrypted IDs.
  return typeof value === 'string' && JOB_ID.test(value) && !/^\d+$/.test(value) ? value : undefined;
}
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}
function stringList(value) {
  if (!Array.isArray(value)) return value === undefined || value === null || value === '' ? [] : [String(value)];
  return value.map((item) => typeof item === 'object' && item !== null ? item.name ?? item.label ?? item.text : item).filter((item) => item !== undefined && item !== null && item !== '').map(String);
}

export function parseJobTarget(target) {
  if (typeof target !== 'string' || !target.trim()) throw new BossCliError('请提供职位链接或加密职位 ID。', { code: 'INVALID_ARGUMENT' });
  const input = target.trim();
  let id;
  let securityId;
  let lid;
  if (JOB_ID.test(input)) id = input;
  else {
    const rawPath = input.split(/[?#]/, 1)[0];
    if (rawPath.includes('\\') || /(?:\/\.{1,2}(?:\/|$)|%2e|%2f|%5c)/i.test(rawPath)) throw new BossCliError('职位链接不允许路径跳转或编码后的路径分隔符。', { code: 'INVALID_ARGUMENT' });
    let url;
    try { url = new URL(input); } catch { throw new BossCliError('无效的职位 ID 或链接。请复制站点的完整职位详情链接。', { code: 'INVALID_ARGUMENT' }); }
    if (url.protocol !== 'https:' || !['zhipin.com', 'www.zhipin.com'].includes(url.hostname) || url.port || url.username || url.password || url.hash) throw new BossCliError('职位链接必须是 https://www.zhipin.com/job_detail/<ID>.html。', { code: 'INVALID_ARGUMENT' });
    const match = /^\/job_detail\/([A-Za-z0-9][A-Za-z0-9_-]{5,199})\.html$/.exec(url.pathname);
    if (!match || !JOB_ID.test(match[1])) throw new BossCliError('职位链接路径必须包含站点的加密职位 ID，不能使用内部数字 ID。', { code: 'INVALID_ARGUMENT' });
    id = match[1];
    for (const name of ['securityId', 'lid']) {
      const values = url.searchParams.getAll(name);
      if (values.length > 1 || (values[0] && (values[0].length > 4096 || /[\x00-\x1f\x7f]/.test(values[0])))) throw new BossCliError(`职位链接的 ${name} 参数无效。`, { code: 'INVALID_ARGUMENT' });
    }
    securityId = optionalString(url.searchParams.get('securityId'));
    lid = optionalString(url.searchParams.get('lid'));
  }
  const url = new URL(`/job_detail/${id}.html`, ORIGIN);
  if (securityId) url.searchParams.set('securityId', securityId);
  if (lid) url.searchParams.set('lid', lid);
  return compact({ id, encryptJobId: id, securityId, lid, url: url.href });
}

export function normalizeJob(raw, { lid } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BossCliError('站点返回的职位格式无法识别。', { code: 'SITE_CHANGED' });
  const source = raw.jobInfo && typeof raw.jobInfo === 'object' ? { ...raw, ...raw.jobInfo } : raw;
  const boss = raw.bossInfo && typeof raw.bossInfo === 'object' ? raw.bossInfo : {};
  const brand = raw.brandComInfo && typeof raw.brandComInfo === 'object' ? raw.brandComInfo : {};
  const id = [source.encryptJobId, source.encryptId, source.id, source.jobId].map(opaqueJobId).find(value => value !== undefined);
  const securityId = optionalString(source.securityId ?? raw.securityId);
  const trackingId = optionalString(source.lid ?? lid);
  let url;
  if (id && JOB_ID.test(id)) {
    const parsed = new URL(`/job_detail/${id}.html`, ORIGIN);
    if (securityId) parsed.searchParams.set('securityId', securityId);
    if (trackingId) parsed.searchParams.set('lid', trackingId);
    url = parsed.href;
  }
  return compact({
    id, encryptJobId: id,
    title: optionalString(source.jobName ?? source.title), salary: optionalString(source.salaryDesc ?? source.salary),
    company: optionalString(source.brandName ?? brand.brandName ?? source.company),
    city: optionalString(source.cityName ?? source.city), district: optionalString(source.areaDistrict ?? source.district), businessDistrict: optionalString(source.businessDistrict),
    experience: optionalString(source.jobExperience ?? source.experience), education: optionalString(source.jobDegree ?? source.education),
    skills: stringList(source.skills), labels: stringList(source.jobLabels), welfare: stringList(source.welfareList ?? brand.welfareList),
    bossName: optionalString(source.bossName ?? boss.name), bossTitle: optionalString(source.bossTitle ?? boss.title),
    securityId, lid: trackingId, expectId: optionalString(source.expectId), jobType: source.jobType ?? undefined, url,
  });
}

export function assertApiSuccess(payload, { path } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, 'code') || payload.code === null || !/^-?\d+$/.test(String(payload.code))) {
    throw new BossCliError('站点返回了无法识别的响应，可能需要在浏览器中完成登录或安全验证。', { code: 'SITE_CHANGED', details: compact({ path }) });
  }
  const apiCode = Number(payload.code);
  if (apiCode === 0) return payload;
  const message = String(payload.message ?? payload.msg ?? '站点拒绝了请求');
  let code = 'SITE_API_ERROR';
  let hint = '请在浏览器中检查该操作是否仍可用。';
  // Known business codes take precedence over translated or combined error messages.
  // Auth and verification codes occur in the retained frontend's response interceptor;
  // code 12 is an unavailable job, not an inferred authentication or throttling error.
  if ([7, 1011, 200404].includes(apiCode)) {
    code = 'AUTH_REQUIRED'; hint = '请先运行 login，在浏览器中手动完成登录后重试。';
  } else if ([37, 5012, 120, 121, 122].includes(apiCode)) {
    code = 'VERIFICATION_REQUIRED'; hint = apiCode === 37 ? '浏览器环境检查尚未完成，请查看已打开的页面后重试。' : '请在浏览器中手动完成安全验证或刷新页面后重试。';
  } else if (apiCode !== 12) {
    if (/未登录|请.{0,8}登录|登录.{0,6}(?:失效|过期)|not\s*logged|login\s*(?:required|expired)|unauthenticated/i.test(message)) {
      code = 'AUTH_REQUIRED'; hint = '请先运行 login，在浏览器中手动完成登录后重试。';
    } else if (/验证码|安全验证|身份验证|访问.{0,6}异常|访问受限|行为异常|captcha|verification|verify|risk\s*control/i.test(message)) {
      code = 'VERIFICATION_REQUIRED'; hint = '请在浏览器中手动完成安全验证或刷新页面后重试。';
  } else if (/频繁|频率|操作过快|rate\s*limit|too\s*many\s*requests/i.test(message)) {
      code = 'RATE_LIMITED'; hint = '请停止重试，等待站点恢复后再操作。';
    }
  }
  throw new BossCliError(`${message}（站点代码 ${apiCode}）。${hint}`, { code, ...(code === 'RATE_LIMITED' ? { exitCode: 4 } : {}), details: compact({ path, apiCode }) });
}

const CHILD_KEYS = new Set(['zpData', 'data', 'result', 'list', 'children', 'province', 'provinces', 'provinceList', 'city', 'cities', 'cityList', 'hotCityList', 'subLevelModelList']);
export function flattenCities(payload) {
  if (payload && typeof payload === 'object' && Object.hasOwn(payload, 'code') && !Object.hasOwn(payload, 'name')) assertApiSuccess(payload, { path: '/wapi/zpCommon/data/city.json' });
  const results = new Map();
  const seen = new WeakSet();
  function visit(node, context = {}) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach((item) => visit(item, context)); return; }
    const name = optionalString(node.name ?? node.cityName ?? node.label);
    const code = optionalString(node.code ?? node.cityCode ?? node.value);
    const hasChildren = [...CHILD_KEYS].some((key) => Array.isArray(node[key]) && node[key].length);
    const isProvince = context.role === 'province' || (code && code !== '100010000' && (/^\d{9}$/.test(code) && code.endsWith('0000') || hasChildren && /^\d{6}$/.test(code) && code.endsWith('0000')));
    const isDistrict = context.role === 'district' || node.cityType === 4;
    const isCity = name && code && /^\d+$/.test(code) && !isProvince && !isDistrict && (context.role === 'city' || /^\d{9}$/.test(code));
    const province = isProvince ? name : context.province;
    if (isCity) {
      const current = results.get(code) ?? {};
      results.set(code, compact({ ...current, code, name, province: context.province ?? current.province, pinyin: optionalString(node.pinyin) ?? current.pinyin }));
    }
    for (const [key, value] of Object.entries(node)) {
      if (!CHILD_KEYS.has(key) || !value || typeof value !== 'object') continue;
      let role;
      if (['province', 'provinces', 'provinceList'].includes(key)) role = 'province';
      else if (['city', 'cities', 'cityList', 'hotCityList'].includes(key)) role = 'city';
      else if (['subLevelModelList', 'children'].includes(key)) role = isProvince ? 'city' : isCity || isDistrict ? 'district' : context.role;
      visit(value, { role, province });
    }
  }
  visit(payload);
  return [...results.values()];
}

export function resolveCity(query, cities) {
  const value = String(query ?? '').trim();
  if (!value) throw new BossCliError('请提供城市名称或代码，例如 北京 或 101010100。', { code: 'INVALID_ARGUMENT' });
  const list = flattenCities(cities);
  if (!list.length) throw new BossCliError('站点未返回可识别的城市列表。', { code: 'SITE_CHANGED' });
  let matches = list.filter((city) => city.code === value || city.name === value);
  if (!matches.length && !/^\d+$/.test(value)) matches = list.filter((city) => city.name.replace(/市$/, '') === value.replace(/市$/, ''));
  matches = [...new Map(matches.map((city) => [city.code, city])).values()];
  if (matches.length === 1) return matches[0].code;
  if (matches.length > 1) throw new BossCliError(`城市名称 ${value} 存在多个匹配，请直接使用城市代码。`, { code: 'INVALID_ARGUMENT', details: { candidates: matches } });
  const candidates = list.filter((city) => city.name.includes(value) || city.pinyin?.toLowerCase().includes(value.toLowerCase())).slice(0, 10);
  throw new BossCliError(`未找到城市 ${value}。请运行 cities <关键词> 查询准确名称和代码。`, { code: 'INVALID_ARGUMENT', ...(candidates.length ? { details: { candidates } } : {}) });
}
