import { setTimeout as delay } from 'node:timers/promises';
import { BossCliError } from './errors.js';
import { assertApiSuccess } from './protocol.js';

const origin = 'https://www.zhipin.com';
const listPaths = new Set(['/wapi/zpgeek/search/joblist.json', '/wapi/zpgeek/recommend/job/list.json', '/wapi/zpgeek/pc/recommend/job/list.json']);
const pathOf = page => { try { return new URL(page.url()).pathname; } catch { return ''; } };
const manualCheck = pathname => /\/passport\/zp\/verify|\/user\/safe\/verify-slider|\/geek\/safe-validate|\/captcha|\/security-check/.test(pathname);
const automaticCheck = pathname => /\/passport\/zp\/security\.html|\/common\/security-check\.html/.test(pathname);

// Let the normal site initialize its own session. No challenge parameters, cookie
// values, or generated tokens cross this boundary. The subsequent API request is
// still authoritative and is never automatically retried after a rejection.
export async function prepareJobSession(session, options = {}) {
  if (session.jobReadsPreparation) return session.jobReadsPreparation;
  const activePath = session.page ? pathOf(session.page) : '';
  if (session.jobReadsReady && session.browser?.isConnected?.() && !manualCheck(activePath) && !automaticCheck(activePath)) return;
  const preparation = (async () => {
    const rawPage = typeof session.openJobPage === 'function';
    const page = rawPage ? await session.openJobPage() : await session.connect();
    try {
      if (session.restartRequired) throw new BossCliError('当前专用浏览器使用旧启动配置。请关闭该 profile 的浏览器窗口，再运行 boss login 后重试。', {
        code: 'BROWSER_RESTART_REQUIRED', exitCode: 4, details: { profile: session.options.profile, profileDir: session.options.profileDir },
      });
      const currentPath = pathOf(page);
      if (manualCheck(currentPath) && !automaticCheck(currentPath)) throw new BossCliError('站点要求安全验证，请在当前浏览器页面完成后重试。', {
        code: 'VERIFICATION_REQUIRED', exitCode: 4, details: { phase: 'browser-initialization', path: currentPath },
      });
      if (session.jobReadsReady && !automaticCheck(currentPath)) return;
      return await initialize(session, options, page);
    } finally { if (rawPage) await page.release(); }
  })();
  session.jobReadsPreparation = preparation;
  try { return await preparation; }
  finally { if (session.jobReadsPreparation === preparation) session.jobReadsPreparation = null; }
}

async function initialize(session, { query, city } = {}, page) {
  const timeout = session.options.timeout;
  const deadline = Date.now() + timeout;
  let successfulList = false, verificationSeen = false, verificationCode, failure, navigationDone = false;
  const responseListener = async response => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== origin || !listPaths.has(url.pathname)) return;
    // Only this page's own top-level app request may establish readiness.
    try { if (response.request().frame() !== page.mainFrame()) return; } catch { return; }
    if (response.status() === 429) {
      failure = new BossCliError('站点要求降低访问频率，请稍后重试。', { code: 'RATE_LIMITED', exitCode: 4 });
      return;
    }
    try {
      const payload = await response.json();
      assertApiSuccess(payload, { path: url.pathname });
      if (response.status() >= 200 && response.status() < 300 && Array.isArray(payload.zpData?.jobList)) successfulList = true;
    } catch (error) {
      if (error.code === 'VERIFICATION_REQUIRED') { verificationSeen = true; verificationCode = error.details?.apiCode; }
      else if (['AUTH_REQUIRED', 'RATE_LIMITED'].includes(error.code)) failure = error;
    }
  };
  page.on('response', responseListener);
  const url = new URL('/web/geek/jobs', origin);
  if (query) url.searchParams.set('query', String(query));
  if (city) url.searchParams.set('city', String(city));
  try {
    // Security pages may redirect while goto is in flight. Observe the final
    // business response rather than treating an interrupted goto as logout.
    if (automaticCheck(pathOf(page))) { verificationSeen = true; navigationDone = true; }
    else void page.goto(url.href, { waitUntil: 'domcontentloaded', timeout }).catch(() => {}).finally(() => { navigationDone = true; });
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (page.isClosed()) throw new BossCliError('职位页面已关闭，请重新运行 boss login。', { code: 'BROWSER_SESSION_UNAVAILABLE', exitCode: 4 });
      const pathname = pathOf(page);
      if (successfulList && page.url().startsWith(origin + '/web/geek/jobs') && pathname === '/web/geek/jobs') {
        session.jobReadsReady = true;
        return;
      }
      if (manualCheck(pathname) && !automaticCheck(pathname)) throw new BossCliError('站点要求安全验证，请在当前浏览器页面完成后重试。', {
        code: 'VERIFICATION_REQUIRED', exitCode: 4, details: { phase: 'browser-initialization', path: pathname },
      });
      if (/\/passport\/.*login|\/web\/user\//.test(pathname)) throw new BossCliError('请在当前浏览器页面完成登录后重试。', { code: 'AUTH_REQUIRED', exitCode: 3 });
      if (navigationDone && page.url() === 'about:blank') throw new BossCliError('职位页面被浏览器环境中断。请关闭该 profile 的浏览器窗口，再运行 boss login 后重试。', {
        code: 'BROWSER_SESSION_UNAVAILABLE', exitCode: 4, details: { phase: 'browser-initialization', profile: session.options.profile },
      });
      verificationSeen ||= automaticCheck(pathname);
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    // Keep the page open so a visible manual challenge can be completed by the user.
    throw new BossCliError(verificationSeen ? '站点自动校验尚未完成，请检查已打开的浏览器页面，完成提示后重试。' : '职位页面初始化未完成，请检查浏览器页面或稍后重试。', {
      code: verificationSeen ? 'VERIFICATION_REQUIRED' : 'BROWSER_INITIALIZATION_TIMEOUT', exitCode: 4,
      details: { phase: 'browser-initialization', path: pathOf(page), ...(verificationCode !== undefined ? { apiCode: verificationCode } : {}) },
    });
  } finally { page.off('response', responseListener); }
}
