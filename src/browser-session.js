import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BossCliError } from './errors.js';
import { resolveConfig } from './config.js';
import { prepareJobSession } from './job-session.js';
import { openCdpJobPage } from './cdp-job-page.js';

export const SITE_ORIGIN = 'https://www.zhipin.com';
export const OWNED_ENDPOINT_FILE = 'BossCliEndpoint.json';
const browserPathPattern = /^\/devtools\/browser\/[A-Za-z0-9_-]+$/;
const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);
const automaticVerificationPath = value => /\/passport\/zp\/security\.html|\/common\/security-check\.html/.test(new URL(value).pathname);
const verificationPath = value => automaticVerificationPath(value) || /\/passport\/zp\/verify|\/web\/geek\/safe-validate|\/web\/user\/safe\/verify-slider|\/captcha|\/security-check/.test(new URL(value).pathname);

export async function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
export function isBossUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && (u.hostname === 'zhipin.com' || u.hostname.endsWith('.zhipin.com')); } catch { return false; }
}
export function validateCdpUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new BossCliError('CDP 地址必须是有效的本机回环地址。', { code: 'INVALID_ARGUMENT', exitCode: 2 }); }
  if (!['http:', 'ws:'].includes(u.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || !u.port || u.username || u.password) {
    throw new BossCliError('CDP 地址必须是带端口的本机回环 HTTP/WebSocket 地址。', { code: 'INVALID_ARGUMENT', exitCode: 2 });
  }
  return u.href;
}
export async function findBrowserExecutable(explicit) {
  const candidates = [explicit, process.env.BOSS_BROWSER_PATH, process.env.CHROME_PATH];
  if (process.platform === 'win32') {
    for (const root of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
      if (root) candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      for (const name of ['google-chrome', 'microsoft-edge', 'chromium', 'chromium-browser']) candidates.push(path.join(dir, name));
    }
  }
  for (const candidate of candidates.filter(Boolean)) {
    try { await fs.access(candidate); return path.resolve(candidate); } catch {}
  }
  throw new BossCliError('未找到 Chrome 或 Edge。请用 --browser-path 指定已安装浏览器的可执行文件。', { code: 'BROWSER_NOT_FOUND' });
}

export class BrowserSession {
  constructor(options = {}) {
    this.options = { ...resolveConfig(), ...options };
    this.browser = null;
    this.context = null;
    this.page = null;
    this.endpoint = null;
    this.connectionPreparation = null;
    this.restartRequired = false;
    this.launchMode = this.options.cdpUrl ? 'external-cdp' : null;
    this._resetJobReadiness();
  }
  _resetJobReadiness() { this.jobReadsReady = false; this.jobReadsPreparation = null; }
  async _readEndpointVersion(endpoint, expectedBrowserPath) {
    try {
      const target = new URL(endpoint);
      if (target.protocol !== 'http:' || !loopbackHosts.has(target.hostname) || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash) return null;
      const response = await fetch(new URL('/json/version', target), { signal: AbortSignal.timeout(1500), redirect: 'error' });
      if (!response.ok) return null;
      const version = await response.json();
      const socket = new URL(version.webSocketDebuggerUrl);
      if (socket.protocol !== 'ws:' || !loopbackHosts.has(socket.hostname) || socket.port !== target.port || socket.username || socket.password || socket.search || socket.hash || !browserPathPattern.test(socket.pathname)) return null;
      if (expectedBrowserPath && socket.pathname !== expectedBrowserPath) return null;
      return { endpoint: target.origin, browserPath: socket.pathname };
    } catch { return null; }
  }
  async ownedEndpoint() {
    this.restartRequired = false;
    this.launchMode = null;
    try {
      const record = JSON.parse(await fs.readFile(path.join(this.options.profileDir, OWNED_ENDPOINT_FILE), 'utf8'));
      if (record.version === 1 && record.launchMode === 'explicit-port' && record.extensionsDisabled === true && browserPathPattern.test(record.browserPath)) {
        const live = await this._readEndpointVersion(record.endpoint, record.browserPath);
        if (live) { this.launchMode = 'explicit-port'; return live.endpoint; }
      }
    } catch {}
    try {
      const active = await fs.readFile(path.join(this.options.profileDir, 'DevToolsActivePort'), 'utf8');
      const [port, browserPath] = active.trim().split(/\r?\n/);
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !browserPathPattern.test(browserPath)) return null;
      const endpoint = `http://127.0.0.1:${port}`;
      const live = await this._readEndpointVersion(endpoint, browserPath);
      if (!live) return null;
      this.restartRequired = true;
      this.launchMode = 'legacy-port-zero';
      return live.endpoint;
    } catch { return null; }
  }
  async _saveEndpoint(record) {
    const target = path.join(this.options.profileDir, OWNED_ENDPOINT_FILE);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, ...record, launchMode: 'explicit-port', extensionsDisabled: true }) + '\n', { mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (cause) {
      throw new BossCliError('浏览器已启动，但无法保存专用会话地址。请检查 profile 目录写入权限。', { code: 'BROWSER_ENDPOINT_SAVE_FAILED', details: { profileDir: this.options.profileDir }, cause });
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async launch() {
    await fs.mkdir(this.options.profileDir, { recursive: true, mode: 0o700 });
    const executable = await findBrowserExecutable(this.options.browserPath);
    const existing = await this.ownedEndpoint();
    if (existing) return existing;
    let port;
    try { port = await availableLoopbackPort(); }
    catch (cause) { throw new BossCliError('无法分配本机浏览器调试端口。', { code: 'BROWSER_START_FAILED', cause }); }
    const endpoint = `http://127.0.0.1:${port}`;
    const args = [
      `--user-data-dir=${this.options.profileDir}`,
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
      '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--new-window',
    ];
    if (this.options.headless) args.push('--headless=new');
    args.push(SITE_ORIGIN);
    const child = childProcess.spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: Boolean(this.options.headless) });
    let launchError;
    child.once('error', error => { launchError = error; });
    child.unref();
    const started = Date.now();
    while (Date.now() - started < Math.min(this.options.timeout, 30000)) {
      if (launchError) throw new BossCliError('浏览器启动失败。', { code: 'BROWSER_START_FAILED', cause: launchError });
      const live = await this._readEndpointVersion(endpoint);
      if (live) {
        await this._saveEndpoint(live);
        this.restartRequired = false;
        this.launchMode = 'explicit-port';
        return live.endpoint;
      }
      await delay(200);
    }
    throw new BossCliError('浏览器未开放 CLI 专用会话。请关闭该 profile 的旧窗口后重试 boss login。', { code: 'BROWSER_START_TIMEOUT', exitCode: 4 });
  }
  async connect({ launch = true } = {}) {
    if (this.connectionPreparation) {
      const page = await this.connectionPreparation;
      // A read-only status check may have found no running browser. A caller
      // that permits launch still needs its own attempt after that check ends.
      return page || !launch ? page : this.connect({ launch });
    }
    const connection = this._connect({ launch });
    this.connectionPreparation = connection;
    try { return await connection; }
    finally { if (this.connectionPreparation === connection) this.connectionPreparation = null; }
  }
  async _connect({ launch }) {
    if (this.browser?.isConnected() && this.page && !this.page.isClosed()) return this.page;
    if (this.browser?.isConnected() && this.context) {
      this.page = this.context.pages().find(page => !page.isClosed() && isBossUrl(page.url())) ?? await this.context.newPage();
      this.page.setDefaultTimeout(this.options.timeout);
      return this.page;
    }
    const preparedEndpoint = this.jobReadsReady ? this.endpoint : null;
    this._resetJobReadiness();
    let endpoint = this.options.cdpUrl ? validateCdpUrl(this.options.cdpUrl) : await this.ownedEndpoint();
    if (!endpoint && !launch) return null;
    if (!endpoint) endpoint = await this.launch();
    this.endpoint = endpoint;
    this.jobReadsReady = preparedEndpoint === endpoint;
    const { chromium } = await import('playwright-core');
    try { this.browser = await chromium.connectOverCDP(endpoint, { timeout: this.options.timeout }); }
    catch (cause) { throw new BossCliError('无法连接指定的浏览器会话，请检查调试端口或运行 boss login。', { code: 'BROWSER_CONNECTION_FAILED', exitCode: 4, cause }); }
    this.context = this.browser.contexts()[0];
    if (!this.context) throw new BossCliError('浏览器没有可用的默认会话。', { code: 'BROWSER_SESSION_MISSING' });
    this.page = this.context.pages().find(page => isBossUrl(page.url())) ?? this.context.pages().find(page => page.url() === 'about:blank') ?? await this.context.newPage();
    this.page.setDefaultTimeout(this.options.timeout);
    return this.page;
  }
  async navigate(url, { force = false } = {}) {
    if (!isBossUrl(url)) throw new BossCliError('目标地址必须属于 HTTPS Boss 直聘站点。', { code: 'INVALID_ARGUMENT', exitCode: 2 });
    const page = await this.connect();
    if (force || new URL(page.url()).href !== new URL(url).href) {
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.timeout }); }
      catch (cause) {
        if (/ERR_ABORTED|interrupted by another navigation/.test(cause.message)) {
          await page.waitForLoadState('domcontentloaded', { timeout: Math.min(this.options.timeout, 3000) }).catch(() => {});
          if (isBossUrl(page.url())) return page;
        }
        throw new BossCliError('浏览器导航未完成，请检查网络或站点访问状态。', { code: 'BROWSER_NAVIGATION_FAILED', exitCode: 4, cause });
      }
    }
    return page;
  }
  async openJobPage() {
    // Playwright subscribes to console object previews as part of Runtime.enable.
    // During site initialization use only Page/Network events; otherwise those
    // observations can cause the site's normal page to exit before it is ready.
    if (this.connectionPreparation) await this.connectionPreparation.catch(() => {});
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.jobReadsReady = false;
    const endpoint = this.options.cdpUrl ? validateCdpUrl(this.options.cdpUrl) : await this.ownedEndpoint() ?? await this.launch();
    this.endpoint = endpoint;
    return openCdpJobPage(endpoint, { timeout: this.options.timeout });
  }
  async prepareJobReads(options) { return prepareJobSession(this, options); }
  async pageState() {
    const page = await this.connect({ launch: false });
    if (!page) return { connected: false, authenticated: false, profile: this.options.profile, instruction: '运行 boss login，完成扫码或手机登录。' };
    let state;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      user: document.querySelector('.nav-figure, .user-nav .user-name, .nav-userinfo .name, .user-info .user-name')?.textContent?.trim().split(/\r?\n/)[0]?.trim() ?? null,
      hasLogin: [...document.querySelectorAll('a,button')].some(el => el.getClientRects().length > 0 && /^(登录|登录\/注册|登录注册)$/.test(el.textContent?.trim() ?? '')),
      })); break; }
      catch (cause) {
        if (verificationPath(page.url())) { state = { url: page.url(), title: automaticVerificationPath(page.url()) ? '浏览器环境检查' : '安全验证', user: null, hasLogin: false }; break; }
        if (attempt === 2 || !/context was destroyed|navigation|Execution context/i.test(cause.message)) throw new BossCliError('浏览器页面持续跳转，暂时无法读取状态。', { code: 'BROWSER_STATE_UNAVAILABLE', exitCode: 4, cause });
        await delay(150);
      }
    }
    const verification = verificationPath(state.url) || /安全验证|请完成以下验证|验证后继续访问/.test(state.title);
    const automaticCheck = automaticVerificationPath(state.url);
    const authenticated = verification || state.hasLogin ? false : state.user ? true : null;
    return { connected: true, authenticated, verificationRequired: verification, automaticCheck, profile: this.options.profile, url: state.url, title: state.title, ...(state.user ? { user: state.user } : {}), ...(!authenticated ? { instruction: automaticCheck ? '请等待浏览器完成环境检查，或查看当前页面的提示，随后运行 boss status。' : verification ? '请在浏览器中手动完成安全验证，随后运行 boss status。' : authenticated === null ? '当前页面未显示登录状态，暂时无法确认；可稍后运行 boss status。' : '请在浏览器中登录，随后运行 boss status。' } : {}), ...(this.restartRequired ? { restartRequired: true, launchMode: this.launchMode, restartInstruction: `请关闭 CLI 专用 profile（${this.options.profileDir}）的浏览器窗口，再运行 boss login --profile ${this.options.profile}。` } : {}) };
  }
  async assertUsable({ auth = false } = {}) {
    const state = await this.pageState();
    if (state.verificationRequired) throw new BossCliError(state.automaticCheck ? '浏览器环境检查尚未完成，请等待或查看当前页面的提示后重试。' : 'Boss 直聘要求安全验证，请在 CLI 打开的浏览器中手动完成后重试。', { code: 'VERIFICATION_REQUIRED', exitCode: 4, details: { url: state.url, automaticCheck: state.automaticCheck } });
    if (auth && state.authenticated === null) throw new BossCliError('当前页面无法确认登录状态。', { code: 'BROWSER_STATE_UNAVAILABLE', exitCode: 4 });
    if (auth && !state.authenticated) throw new BossCliError('当前会话尚未登录。请运行 boss login，在浏览器完成登录后重试。', { code: 'AUTH_REQUIRED', exitCode: 3 });
    return state;
  }
  async login({ wait = 0 } = {}) {
    this._resetJobReadiness();
    await this.connect();
    if (!isBossUrl(this.page.url())) await this.navigate(SITE_ORIGIN);
    let state = await this.pageState();
    const deadline = Date.now() + wait;
    while (!state.authenticated && Date.now() < deadline) { await delay(1000); state = await this.pageState(); }
    return { ...state, browserOpened: true, profileDir: this.options.profileDir, ...(state.authenticated ? {} : { instruction: state.automaticCheck ? '请等待浏览器完成环境检查，或查看当前页面的提示，随后运行 boss status。' : '请在此独立浏览器窗口完成安全验证及登录。窗口可保持打开；之后运行 boss status。' }) };
  }
  async logout() {
    this._resetJobReadiness();
    // Reopen an owned profile so persisted cookies are actually cleared even after its window closed.
    const page = await this.connect();
    if (!page) throw new BossCliError('无法打开浏览器，登录状态尚未清理。', { code: 'BROWSER_CONNECTION_FAILED', exitCode: 4 });
    await this.context.clearCookies({ domain: /(^|\.)zhipin\.com$/ });
    for (const tab of this.context.pages().filter(tab => isBossUrl(tab.url()))) {
      await tab.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      if (tab !== page) await tab.goto(SITE_ORIGIN, { waitUntil: 'domcontentloaded', timeout: this.options.timeout });
    }
    await this.navigate(SITE_ORIGIN, { force: true });
    return { loggedOut: true, scope: this.options.cdpUrl ? 'connected-browser' : 'local-profile', profile: this.options.profile };
  }
  async close() {
    if (this.connectionPreparation) await this.connectionPreparation.catch(() => {});
    this._resetJobReadiness();
    // A CDP connection is detached; the user-owned browser and its profile remain available.
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
