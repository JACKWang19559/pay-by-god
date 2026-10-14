import { BossCliError } from './errors.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

// The job's displayed company may differ from the recruiter's company.
// Only expose observed company fields; do not infer legal-employer identity.
export function normalizeJobCompany({ data, target, job, context }) {
  const brand = data.brandComInfo;
  if (brand !== undefined && brand !== null && !record(brand)) {
    throw new BossCliError('职位返回的公司信息格式已变化。', { code: 'SITE_CHANGED' });
  }
  if (!record(brand) || !text(brand.brandName)) {
    throw new BossCliError('该职位未提供可读取的公司资料，请在对应职位页面核对。', { code: 'COMPANY_INFO_UNAVAILABLE' });
  }
  const info = record(data.jobInfo) ? data.jobInfo : {};
  const boss = record(data.bossInfo) ? data.bossInfo : {};
  const id = text(brand.encryptBrandId);
  const recruitingName = text(boss.brandName);
  // The site disables anonymous and hunter links. Conservatively omit other
  // mediated-job links too; their displayed name may not identify the recruiter.
  const mediated = info.proxyJob || info.proxyType || [data, info, boss].some(value => value.hunterJob || value.bossSource === 1);
  const linkedId = id && /^[A-Za-z0-9_~-]{1,200}$/.test(id) && info.anonymous === 0 && brand.visibleBrandInfo !== false && !mediated ? id : undefined;
  return compact({
    id: linkedId,
    url: linkedId ? `https://www.zhipin.com/gongsi/${linkedId}.html` : undefined,
    name: text(brand.brandName),
    industry: text(brand.industryName),
    scale: text(brand.scaleName),
    stage: text(brand.stageName),
    description: text(brand.introduce),
    welfare: Array.isArray(brand.labels) ? [...new Set(brand.labels.map(text).filter(Boolean))] : undefined,
    recruitingCompany: recruitingName ? { name: recruitingName } : undefined,
    job: compact({
      id: target.id,
      title: job.title,
      location: text(info.locationName) ?? text(info.cityName),
      workAddress: info.anonymous === 0 && brand.visibleBrandInfo === true ? text(info.address) : undefined,
    }),
    observedFrom: data.observedFrom ?? 'job/detail.json',
    context,
  });
}
