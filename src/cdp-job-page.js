import { EventEmitter } from 'node:events';
import { BossCliError } from './errors.js';

const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);
const listPaths = new Set(['/wapi/zpgeek/search/joblist.json', '/wapi/zpgeek/recommend/job/list.json', '/wapi/zpgeek/pc/recommend/job/list.json']);
const siteOrigin = 'https://www.zhipin.com';
const isBossUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com')); }
  catch { return false; }
};

function connectionError(message, cause) {
  return new BossCliError(message, { code: 'BROWSER_CONNECTION_FAILED', exitCode: 4, cause });
}

function endpointOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'ws:'].includes(url.protocol) || !loopbackHosts.has(url.hostname) || !url.port || Number(url.port) < 1 || url.username || url.password || url.search || url.hash) throw new Error('Invalid endpoint');
    if (url.protocol === 'http:' ? url.pathname !== '/' : !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error('Invalid endpoint path');
    return `http://${url.host}`;
  } catch (cause) { throw connectionError('CDP 地址必须是有效的本机回环浏览器地址。', cause); }
}

function targetSocket(target, origin) {
  try {
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || !loopbackHosts.has(url.hostname) || url.port !== new URL(origin).port || url.username || url.password || url.search || url.hash || !/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error('Invalid target socket');
    if (!target.id || url.pathname !== `/devtools/page/${target.id}`) throw new Error('Target identity mismatch');
    return url.href;
  } catch (cause) { throw connectionError('浏览器页面调试地址与当前本机会话不一致。', cause); }
}

function browserSocket(version, origin, requestedEndpoint) {
  try {
    const current = new URL(version.webSocketDebuggerUrl);
    if (current.protocol !== 'ws:' || !loopbackHosts.has(current.hostname) || current.port !== new URL(origin).port || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(current.pathname) || current.username || current.password || current.search || current.hash) throw new Error('Invalid browser socket');
    if (requestedEndpoint.protocol === 'ws:' && current.pathname !== requestedEndpoint.pathname) throw new Error('Browser identity mismatch');
    return current.href;
  } catch (cause) { throw connectionError('指定的浏览器调试会话已变化，请使用当前有效的 CDP 地址。', cause); }
}

const verificationPage = target => {
  if (!isBossUrl(target.url)) return false;
  return /\/passport\/zp\/(?:verify|security)|\/web\/geek\/safe-validate|\/web\/user\/safe\/verify-slider|\/captcha|\/security-check/.test(new URL(target.url).pathname);
};

async function defaultContextTarget(browser) {
  const [contexts, targets] = await Promise.all([browser.command('Target.getBrowserContexts'), browser.command('Target.getTargets')]);
  if (!Array.isArray(targets.targetInfos)) throw connectionError('浏览器没有提供可识别的页面上下文。');
  const existing = targets.targetInfos.filter(target => target.type === 'page');
  let defaultId = typeof contexts.defaultBrowserContextId === 'string' && contexts.defaultBrowserContextId ? contexts.defaultBrowserContextId : null;
  let probeId, probe, selected;
  const createDefaultPage = async () => {
    const created = await browser.command('Target.createTarget', { url: 'about:blank' });
    if (typeof created.targetId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(created.targetId) || targets.targetInfos.some(target => target.targetId === created.targetId)) throw connectionError('浏览器未能创建独立的默认会话页面。');
    probeId = created.targetId;
    const { targetInfo } = await browser.command('Target.getTargetInfo', { targetId: probeId });
    if (!targetInfo || targetInfo.targetId !== probeId || targetInfo.type !== 'page') throw connectionError('浏览器未能确认新页面身份。');
    probe = targetInfo;
    return probe;
  };
  try {
    if (!defaultId) {
      await createDefaultPage();
      defaultId = typeof probe.browserContextId === 'string' && probe.browserContextId ? probe.browserContextId : null;
      // A target created without browserContextId belongs to the default context.
      // If Chromium cannot identify that context, reuse no pre-existing target.
      if (!defaultId) { selected = probe; return selected; }
    }
    const pages = existing.filter(target => target.browserContextId === defaultId);
    selected = pages.find(verificationPage) ?? pages.find(target => isBossUrl(target.url)) ?? pages.find(target => target.url === 'about:blank');
    if (!selected) {
      selected = probe ?? await createDefaultPage();
      if (selected.browserContextId && selected.browserContextId !== defaultId) throw connectionError('新页面没有使用预期的默认浏览器会话。');
    }
    return selected;
  } finally {
    if (probeId && selected?.targetId !== probeId) {
      // Never close a pre-existing page or a probe that the user has navigated.
      try {
        const { targetInfo } = await browser.command('Target.getTargetInfo', { targetId: probeId });
        if (targetInfo?.targetId === probeId && targetInfo.type === 'page' && targetInfo.url === 'about:blank') await browser.command('Target.closeTarget', { targetId: probeId });
      } catch {}
    }
  }
}

class CdpJobPage extends EventEmitter {
  constructor(socket, target, timeout) {
    super();
    this.socket = socket;
    this.timeout = timeout;
    this.currentUrl = target.url;
    this.closed = false;
    this.released = false;
    this.sequence = 0;
    this.pending = new Map();
    this.responses = new Map();
    this.frames = new Map();
    this.main = {};
    this.mainId = null;
    socket.addEventListener('message', event => this._message(event.data));
    socket.addEventListener('close', () => this._close(connectionError('浏览器页面连接已断开。')));
    socket.addEventListener('error', () => this._close(connectionError('浏览器页面连接发生错误。')));
  }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  mainFrame() { return this.main; }
  _frame(id) {
    if (id === this.mainId) return this.main;
    if (!id) return null;
    if (!this.frames.has(id)) this.frames.set(id, {});
    return this.frames.get(id);
  }
  _close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.responses.clear();
    this.emit('connectionClosed', error);
  }
  command(method, params = {}, timeout = this.timeout) {
    if (this.closed) return Promise.reject(connectionError('浏览器页面连接已断开。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BossCliError('浏览器页面命令超时。', { code: 'BROWSER_COMMAND_TIMEOUT', exitCode: 4, details: { method } }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (cause) { clearTimeout(timer); this.pending.delete(id); reject(connectionError('浏览器页面命令未发送成功。', cause)); }
    });
  }
  _message(text) {
    let message;
    try { message = JSON.parse(String(text)); } catch { return; }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(connectionError('浏览器未能完成页面命令。'));
      else entry.resolve(message.result ?? {});
      return;
    }
    const params = message.params ?? {};
    if (message.method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
      this.mainId = params.frame.id;
      this.currentUrl = params.frame.url;
      this.emit('mainFrameCommit');
    } else if (message.method === 'Page.navigatedWithinDocument' && params.frameId === this.mainId) {
      this.currentUrl = params.url;
      this.emit('mainFrameCommit');
    } else if (message.method === 'Network.responseReceived') {
      let url;
      try { url = new URL(params.response?.url); } catch { return; }
      if (url.origin !== siteOrigin || !listPaths.has(url.pathname)) return;
      this.responses.set(params.requestId, { url: url.href, status: params.response.status, frame: this._frame(params.frameId) });
    } else if (message.method === 'Network.loadingFinished') {
      const response = this.responses.get(params.requestId);
      if (!response) return;
      this.responses.delete(params.requestId);
      this._finishResponse(params.requestId, response).catch(() => {});
    } else if (message.method === 'Network.loadingFailed') {
      this.responses.delete(params.requestId);
    }
  }
  async _finishResponse(requestId, response) {
    let text, failure;
    try {
      const result = await this.command('Network.getResponseBody', { requestId });
      text = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
    } catch (error) { failure = error; }
    if (this.closed) return;
    this.emit('response', {
      url: () => response.url,
      status: () => response.status,
      request: () => ({ frame: () => response.frame }),
      json: async () => { if (failure) throw failure; return JSON.parse(text); },
    });
  }
  async initialize() {
    await this.command('Page.enable');
    await this.command('Network.enable');
    const { frameTree } = await this.command('Page.getFrameTree');
    if (!frameTree?.frame?.id) throw connectionError('浏览器没有提供主页面信息。');
    this.mainId = frameTree.frame.id;
    this.currentUrl = frameTree.frame.url;
    return this;
  }
  async goto(url, { timeout = this.timeout } = {}) {
    if (!isBossUrl(url)) throw new BossCliError('职位页面地址必须属于 HTTPS Boss 直聘站点。', { code: 'INVALID_ARGUMENT', exitCode: 2 });
    let committed, disconnected, timer;
    const commit = new Promise((resolve, reject) => {
      committed = resolve;
      disconnected = reject;
      this.once('mainFrameCommit', committed);
      this.once('connectionClosed', disconnected);
      timer = setTimeout(() => reject(new BossCliError('浏览器导航未完成，请检查当前页面。', { code: 'BROWSER_NAVIGATION_FAILED', exitCode: 4 })), timeout);
    });
    try {
      await Promise.all([
        commit,
        this.command('Page.navigate', { url }, timeout).then(result => {
          if (result.errorText || result.isDownload) throw new BossCliError('浏览器未能打开职位页面。', { code: 'BROWSER_NAVIGATION_FAILED', exitCode: 4 });
        }),
      ]);
      return null;
    } finally {
      clearTimeout(timer);
      this.off('mainFrameCommit', committed);
      this.off('connectionClosed', disconnected);
    }
  }
  async release() {
    if (this.released) return;
    this.released = true;
    this._close(connectionError('职位页面观察已结束。'));
    try { this.socket.close(); } catch {}
  }
}

async function connectSocket(Socket, address, target, timeout) {
  let socket;
  try { socket = new Socket(address); }
  catch (cause) { throw connectionError('无法打开本机浏览器页面连接。', cause); }
  const page = new CdpJobPage(socket, target, timeout);
  try {
    await new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); socket.removeEventListener('open', opened); socket.removeEventListener('close', closed); socket.removeEventListener('error', closed); };
      const opened = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(connectionError('本机浏览器页面连接未建立。')); };
      const timer = setTimeout(() => { clean(); reject(connectionError('本机浏览器页面连接超时。')); }, timeout);
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('close', closed, { once: true });
      socket.addEventListener('error', closed, { once: true });
    });
    return page;
  } catch (error) { await page.release(); throw error; }
}

export async function openCdpJobPage(endpoint, { timeout = 45000, fetch: fetchImpl = globalThis.fetch, WebSocket: Socket = globalThis.WebSocket } = {}) {
  const origin = endpointOrigin(endpoint);
  const getJson = async route => {
    try {
      const response = await fetchImpl(origin + route, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeout) });
      if (!response.ok) throw new Error('CDP HTTP failure');
      return await response.json();
    } catch (cause) { throw connectionError('无法读取本机浏览器页面列表。', cause); }
  };
  const version = await getJson('/json/version');
  const address = browserSocket(version, origin, new URL(endpoint));
  // Browser metadata commands do not attach to targets or enable Runtime events.
  const browser = await connectSocket(Socket, address, { url: 'about:blank' }, timeout);
  let selected;
  try { selected = await defaultContextTarget(browser); }
  finally { await browser.release(); }
  const targets = await getJson('/json/list');
  if (!Array.isArray(targets)) throw connectionError('本机浏览器页面列表格式无效。');
  const target = targets.find(item => item?.type === 'page' && item.id === selected.targetId);
  if (!target) throw connectionError('选定的默认会话页面已关闭，请重试。');
  const page = await connectSocket(Socket, targetSocket(target, origin), target, timeout);
  try { return await page.initialize(); }
  catch (error) { await page.release(); throw error; }
}
