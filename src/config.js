import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './errors.js';

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function positiveInteger(value, name, { defaultValue, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
    throw new UsageError(`${name} 必须是 1 到 ${max} 之间的整数。`);
  }
  return Number(value);
}

export function resolveConfig(options = {}, { env = process.env, baseDir = PROJECT_ROOT } = {}) {
  const profile = options.profile ?? env.BOSS_PROFILE ?? 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile) || profile === '.' || profile === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(profile)) {
    throw new UsageError('--profile 仅支持 1–64 位字母、数字、点、下划线或短横线，并须以字母或数字开头。');
  }
  const dataDir = path.resolve(baseDir, env.BOSS_CLI_HOME || '.boss-cli');
  const profileDir = path.join(dataDir, 'profiles', profile);
  const cdpUrl = options.cdpUrl ?? env.BOSS_CDP_URL;
  if (cdpUrl) {
    let url;
    try { url = new URL(cdpUrl); } catch { throw new UsageError('--cdp-url 必须是有效的 HTTP 或 WebSocket 地址。'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new UsageError('--cdp-url 必须使用 http、https、ws 或 wss 协议。');
    if (url.username || url.password) throw new UsageError('--cdp-url 不支持在地址中包含用户名或密码。');
  }
  return {
    profile,
    profileDir,
    dataDir,
    ...(cdpUrl ? { cdpUrl } : {}),
    ...(options.browserPath ? { browserPath: path.resolve(options.browserPath) } : {}),
    timeout: positiveInteger(options.timeout ?? env.BOSS_TIMEOUT, '--timeout', { defaultValue: 45_000, max: 600_000 }),
    headless: options.headless === true,
  };
}
