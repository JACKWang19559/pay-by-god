import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserSession, SITE_ORIGIN } from './browser-session.js';
import { SiteTransport } from './site-transport.js';
import { normalizeJobCompany } from './company.js';
import { BossCliError } from './errors.js';
import { assertApiSuccess, buildSearchParams, flattenCities, normalizeJob, parseJobTarget, resolveCity } from './protocol.js';

// Local freshness policy, not a claim about the server's securityId lifetime.
export const JOB_CONTEXT_MAX_AGE_MS = 30 * 60 * 1000;
const recordObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class BossClient {
  constructor(options = {}) {
    this.options = options;
    this.session = options.session ?? new BrowserSession(options);
    this.transport = options.transport ?? new SiteTransport(this.session);
    this.dataDir = this.session.options?.dataDir ?? options.dataDir;
    const profile = this.session.options?.profile ?? options.profile ?? 'default';
    const endpoint = this.session.options?.cdpUrl ?? options.cdpUrl;
    this.cacheScope = endpoint ? `${profile}-${createHash('sha256').update(endpoint).digest('hex').slice(0, 16)}` : profile;
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  async login(options = {}) {
    let result, statusResolved = false;
    try { result = await this.session.login(options); }
    catch (error) {
      if (error.code !== 'BROWSER_STATE_UNAVAILABLE') throw error;
      const state = await this.status();
      result = { ...state, browserOpened: Boolean(state.connected), profileDir: this.session.options?.profileDir };
      statusResolved = true;
    }
    const confirmed = !statusResolved && result.authenticated === null ? { ...result, ...await this.status() } : result;
    await this._clearJobCache();
    if (confirmed.authenticated) { const { instruction, ...state } = confirmed; return state; }
    return confirmed;
  }
  async status() {
    let state;
    try { state = await this.session.pageState(); }
    catch (error) {
      if (error.code !== 'BROWSER_STATE_UNAVAILABLE' || !this.session.browser?.isConnected?.() || !this.session.context) throw error;
      state = { connected: true, authenticated: null, verificationRequired: false, profile: this.session.options?.profile, domState: 'unavailable' };
    }
    if (!state.connected || state.authenticated !== null) return state;
    try {
      const payload = await this.transport.request('/wapi/zprelation/friend/geekFilterByLabel', { query: { labelId: 0 } });
      if (Array.isArray(payload.zpData?.friendList)) {
        const { instruction, ...confirmed } = state;
        return { ...confirmed, authenticated: true, authenticationSource: 'authenticated-api' };
      }
    } catch (error) {
      if (error.code === 'AUTH_REQUIRED') return { ...state, authenticated: false, authenticationSource: 'authenticated-api' };
      if (error.code === 'VERIFICATION_REQUIRED') return { ...state, verificationRequired: true, authenticationCheck: error.code };
      return { ...state, authenticationCheck: error.code ?? 'UNAVAILABLE' };
    }
    return state;
  }
  async logout() { const result = await this.session.logout(); await this._clearJobCache(); return result; }
  async close() { return this.session.close(); }

  async _readCache(name) {
    if (!this.dataDir) return null;
    try { return JSON.parse(await fs.readFile(this._cachePath(name), 'utf8')); } catch { return null; }
  }
  _cachePath(name) { return path.join(this.dataDir, 'cache', ...(name === 'cities' ? [] : ['profiles', this.cacheScope]), name + '.json'); }
  async _clearJobCache() { if (this.dataDir) await fs.rm(this._cachePath('jobs'), { force: true }); }
  async _jobCache() {
    const cache = await this._readCache('jobs');
    const records = recordObject(cache?.records) ? cache.records : {};
    return { records: Object.fromEntries(Object.entries(records).filter(([id, record]) => {
      try { return recordObject(record) && recordObject(record.normalized) && normalizeJob(record.normalized).id === id; } catch { return false; }
    })) };
  }
  async _writeCache(name, value) {
    if (!this.dataDir) return;
    const target = this._cachePath(name);
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = target + '.' + process.pid + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temporary, target);
  }
  async _cityList() {
    const cache = await this._readCache('cities');
    if (cache?.items?.length && Date.now() - cache.updatedAt < 86400000) return cache.items;
    let response;
    try { response = await this.fetch(`${SITE_ORIGIN}/wapi/zpCommon/data/city.json`, { signal: AbortSignal.timeout(this.options.timeout ?? 45000) }); }
    catch (cause) {
      if (cache?.items?.length) return cache.items;
      throw new BossCliError('城市数据读取失败，请检查网络。', { code: 'NETWORK_ERROR', cause });
    }
    if (!response.ok) throw new BossCliError('城市接口返回 HTTP 错误。', { code: 'NETWORK_ERROR', details: { status: response.status } });
    let payload;
    try { payload = await response.json(); } catch { throw new BossCliError('城市接口未返回 JSON。', { code: 'SITE_CHANGED' }); }
    assertApiSuccess(payload, { path: '/wapi/zpCommon/data/city.json' });
    const items = flattenCities(payload);
    if (!items.length) throw new BossCliError('城市接口没有可识别的城市记录。', { code: 'SITE_CHANGED' });
    await this._writeCache('cities', { updatedAt: Date.now(), items });
    return items;
  }
  async cities({ query = '' } = {}) {
    const cities = await this._cityList();
    const value = String(query).trim().toLowerCase();
    const items = value ? cities.filter(city => city.code === value || city.name.includes(value) || city.pinyin?.toLowerCase().includes(value)) : cities;
    return { items, total: items.length, source: '/wapi/zpCommon/data/city.json' };
  }
  async _rememberJobs(records, lid) {
    const cache = await this._jobCache();
    for (const record of records) {
      const normalized = normalizeJob(record, { lid });
      if (!normalized.id) throw new BossCliError('职位记录缺少有效的加密标识，无法创建可靠的详情链接。', { code: 'SITE_CHANGED' });
      if (normalized.id) cache.records[normalized.id] = { normalized, detail: record.jobInfo ? record : undefined, updatedAt: Date.now() };
    }
    cache.records = Object.fromEntries(Object.entries(cache.records).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 1000));
    await this._writeCache('jobs', cache);
  }
  async search(options = {}) {
    const city = options.city ? resolveCity(options.city, await this._cityList()) : '100010000';
    const params = buildSearchParams({ ...options, city });
    const form = Object.fromEntries(params);
    let payload;
    try { payload = await this.transport.request('/wapi/zpgeek/search/joblist.json', { method: 'POST', form, mutation: false }); }
    catch (error) { if (error instanceof BossCliError) error.details = { ...error.details, request: { method: 'POST', parameters: Object.fromEntries(Object.entries(form).filter(([, value]) => value !== '')) } }; throw error; }
    const data = payload.zpData;
    if (!data || !Array.isArray(data.jobList)) throw new BossCliError('职位搜索返回结构已变化。', { code: 'SITE_CHANGED' });
    await this._rememberJobs(data.jobList, data.lid);
    const filterFields = ['position', 'industry', 'experience', 'degree', 'salary', 'scale', 'stage', 'jobType', 'multiBusinessDistrict', 'multiSubway'];
    return { items: data.jobList.map(job => normalizeJob(job, { lid: data.lid })), query: options.query, city, page: Number(params.get('page')), limit: Number(params.get('pageSize')), filters: Object.fromEntries(filterFields.filter(key => form[key] !== '').map(key => [key, form[key]])), hasMore: Boolean(data.hasMore), lid: data.lid };
  }
  async _domDetail(target) {
    if (typeof this.session.prepareJobReads === 'function') await this.session.prepareJobReads();
    const page = await this.session.navigate(target.url);
    await this.session.assertUsable();
    let renderedTarget;
    try { renderedTarget = parseJobTarget(page.url()); } catch { throw new BossCliError('浏览器未停留在指定职位详情页，已停止操作。', { code: 'SITE_CHANGED' }); }
    if (renderedTarget.id !== target.id) throw new BossCliError('浏览器详情页与指定职位不一致，已停止操作。', { code: 'JOB_MISMATCH' });
    await page.locator('.job-detail-box, .job-detail-container, .job-primary, .job-banner').first().waitFor({ state: 'attached', timeout: this.session.options.timeout }).catch(async cause => {
      await this.session.assertUsable();
      throw new BossCliError('职位详情未加载，请在浏览器检查职位是否已失效。', { code: 'SITE_CHANGED', cause });
    });
    const data = await page.evaluate(() => {
      const id = /^\/job_detail\/([A-Za-z0-9_-]+)\.html$/.exec(location.pathname)?.[1];
      const action = document.querySelector('.btn-deliver[data-url], .btn-startchat[data-url], .btn-container [data-url]');
      const actionUrl = action?.getAttribute('data-url');
      const parsed = actionUrl ? new URL(actionUrl, location.origin) : new URL(location.href);
      if (parsed.searchParams.get('jobId') && parsed.searchParams.get('jobId') !== id) return { identityMismatch: true };
      for (const el of document.querySelectorAll('.job-detail-box, #app, .job-detail-container')) {
        let vue = el.__vue__;
        for (let depth = 0; vue && depth < 8; depth++, vue = vue.$parent) {
          const candidate = vue.$props?.data ?? vue.data ?? vue.jobDetail;
          if (candidate?.jobInfo) return { ...JSON.parse(JSON.stringify(candidate)), observedJobId: id, observedFrom: 'rendered-page' };
        }
      }
      const text = selector => document.querySelector(selector)?.textContent?.trim() ?? '';
      const description = document.querySelector('.job-sec-text, .job-detail-section .text, .job-detail-container .desc, .job-detail-box .desc');
      const descriptionText = description?.innerText?.trim() || description?.textContent?.trim() || '';
      const companyDescription = document.querySelector('.company-info-box .job-sec-text, .company-info .text');
      return {
        securityId: parsed.searchParams.get('securityId') ?? undefined, lid: parsed.searchParams.get('lid') ?? undefined,
        jobInfo: { encryptJobId: id, jobName: text('.job-banner h1, .job-primary h1, .job-detail-box .job-title, .job-detail-box .job-name, .job-detail-container .job-name'), salaryDesc: text('.job-banner .salary, .job-primary .salary, .job-detail-box .job-salary, .job-detail-container .job-salary'), postDescription: descriptionText, cityName: text('.text-city'), jobExperience: text('.text-experiece'), jobDegree: text('.text-degree') },
        bossInfo: { name: text('.boss-info .name, .boss-info-attr .name'), title: text('.boss-info .job-title') },
        brandComInfo: { brandName: text('.company-info .name, .sider-company .company-info a'), introduce: companyDescription?.innerText?.trim() || companyDescription?.textContent?.trim() || '' },
        relationInfo: {}, oneKeyResumeInfo: { canSendResume: Boolean(document.querySelector('.btn-deliver:not(.btn-disabled)')) },
        observedFrom: 'rendered-page',
      };
    });
    if (data.identityMismatch) throw new BossCliError('详情页操作按钮与当前职位不一致，已停止操作。', { code: 'JOB_MISMATCH' });
    if (data.observedJobId) data.jobInfo.encryptJobId ??= data.jobInfo.encryptId ?? data.observedJobId;
    if (!data.jobInfo?.jobName) throw new BossCliError('未读到职位名称，详情页可能已关闭或受验证限制。', { code: 'SITE_CHANGED' });
    return data;
  }
  async _jobContext(value) {
    const target = parseJobTarget(value);
    const cache = await this._jobCache();
    const record = cache.records[target.id];
    const ageMs = record ? Date.now() - record.updatedAt : null;
    const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= JOB_CONTEXT_MAX_AGE_MS;
    const stored = fresh ? record.normalized : undefined;
    const fromUrl = Boolean(target.securityId);
    const securityId = fromUrl ? target.securityId : stored?.securityId;
    const lid = fromUrl ? target.lid ?? '' : stored?.lid ?? '';
    const contextSource = fromUrl ? 'url' : securityId ? 'cache' : 'rendered-page';
    let data;
    if (securityId) {
      let payload;
      try { payload = await this.transport.request('/wapi/zpgeek/job/detail.json', { query: { securityId, lid } }); }
      catch (error) { if (error instanceof BossCliError) error.details = { ...error.details, context: { source: contextSource, ...(contextSource === 'cache' ? { ageMs } : {}) } }; throw error; }
      if (!recordObject(payload.zpData) || !recordObject(payload.zpData.jobInfo)) throw new BossCliError('职位详情接口返回结构已变化。', { code: 'SITE_CHANGED' });
      data = { ...payload.zpData, securityId: payload.zpData.securityId ?? securityId, lid: payload.zpData.lid ?? lid };
    } else {
      try { data = await this._domDetail(target); }
      catch (cause) {
        if (record && !fresh && cause.code === 'SITE_CHANGED') throw new BossCliError('本地职位上下文已超过刷新期限，页面也未提供新详情。请重新查询职位或读取收藏后使用最新链接。', { code: 'STALE_JOB_CONTEXT', details: { ageMs, localMaxAgeMs: JOB_CONTEXT_MAX_AGE_MS }, cause });
        throw cause;
      }
    }
    if (!recordObject(data) || !recordObject(data.jobInfo)) throw new BossCliError('职位详情没有有效的 jobInfo 对象。', { code: 'SITE_CHANGED' });
    if (!fromUrl) data.expectId ??= stored?.expectId;
    data.jobInfo.encryptJobId ??= data.jobInfo.encryptId;
    if (!data.jobInfo.encryptJobId) throw new BossCliError('详情返回缺少职位标识，已停止操作。', { code: 'SITE_CHANGED' });
    if (String(data.jobInfo.encryptJobId) !== target.id) throw new BossCliError('详情返回的职位与指定目标不一致，已停止操作。', { code: 'JOB_MISMATCH' });
    await this._rememberJobs([data], data.lid);
    return { target, data, job: normalizeJob(data, { lid: data.lid }), context: { source: contextSource, ...(contextSource === 'cache' ? { ageMs, localMaxAgeMs: JOB_CONTEXT_MAX_AGE_MS } : {}) } };
  }
  async job({ target }) {
    const context = await this._jobContext(target);
    return { ...context.job, description: context.data.jobInfo.postDescription ?? '', relationship: { favorite: context.data.relationInfo?.interestJob ?? null, hasConversation: context.data.relationInfo?.beFriend ?? null, canSendResume: context.data.oneKeyResumeInfo?.canSendResume ?? null }, observedFrom: context.data.observedFrom ?? 'job/detail.json', context: context.context };
  }
  async company({ target }) {
    return normalizeJobCompany(await this._jobContext(target));
  }
  async favorites({ action = 'list', target, page = 1, limit = 15, execute = false } = {}) {
    if (action === 'list') {
      // The actual full-page UI sends page only and fixes the server page size at 15.
      const serverSize = 15, start = (page - 1) * limit;
      const first = Math.floor(start / serverSize) + 1, last = Math.ceil((start + limit) / serverSize);
      const records = [];
      let total = null, lastCount = 0;
      for (let serverPage = first; serverPage <= last; serverPage++) {
        const payload = await this.transport.request('/wapi/zprelation/interaction/geekGetJob', { query: { tag: 4, isActive: true, page: serverPage } });
        const data = payload.zpData;
        const jobs = Array.isArray(data) ? data : data?.cardList ?? data?.jobList ?? data?.list;
        if (!Array.isArray(jobs)) throw new BossCliError('收藏列表返回结构已变化。', { code: 'SITE_CHANGED' });
        if (data?.totalCount !== undefined && Number.isSafeInteger(Number(data.totalCount)) && Number(data.totalCount) >= 0) total = Number(data.totalCount);
        records.push(...jobs); lastCount = jobs.length;
        if (lastCount < serverSize || (total !== null && serverPage * serverSize >= total)) break;
      }
      const jobs = records.slice(start % serverSize, start % serverSize + limit);
      await this._rememberJobs(jobs);
      return { items: jobs.map(job => normalizeJob(job)), page, limit, total, hasMore: total !== null ? start + jobs.length < total : lastCount < serverSize ? false : null };
    }
    if (!['add', 'remove'].includes(action)) throw new BossCliError('无效的收藏操作。', { code: 'INVALID_ARGUMENT' });
    const context = await this._jobContext(target);
    const desired = action === 'add';
    const preview = { action: desired ? 'favorite' : 'unfavorite', job: context.job, current: context.data.relationInfo?.interestJob ?? null, desired, executed: false };
    if (!execute) return preview;
    if (preview.current === desired) return { ...preview, unchanged: true };
    if (!context.data.securityId) throw new BossCliError('职位缺少站点提供的 securityId，请从 search 输出的完整链接操作。', { code: 'SITE_CHANGED' });
    const receipt = await this.transport.request('/wapi/zprelation/geekTag/job/interest', { method: 'POST', query: { securityId: context.data.securityId, jobId: context.target.id, expectId: context.data.expectId ?? '', tag: 4, lid: context.data.lid ?? '' }, form: { flag: desired ? 1 : 0 } });
    return { ...preview, executed: true, receipt: { code: receipt.code, message: receipt.message } };
  }
  async _chatGateway() {
    if (!this.chatGateway) { const { ChatGateway } = await import('./chat-gateway.js'); this.chatGateway = new ChatGateway(this.session, this.transport); }
    return this.chatGateway;
  }
  async chats(options = {}) {
    if (options.action === 'start') {
      if (options.text !== undefined && (typeof options.text !== 'string' || !options.text.trim() || options.text.trim().length >= 1000)) throw new BossCliError('跟进消息需要 1 到 999 个字符。', { code: 'INVALID_ARGUMENT' });
      const context = await this._jobContext(options.target);
      const existing = Boolean(context.data.relationInfo?.beFriend);
      const preview = { action: 'start-conversation', job: context.job, existingConversation: existing, greeting: existing ? null : '站点设置的默认招呼语', ...(options.text ? { followupMessage: options.text } : {}), executed: false };
      if (!options.execute) return preview;
      if (existing) {
        if (!options.text) return { ...preview, unchanged: true };
        const gateway = await this._chatGateway();
        const friend = await gateway.findByJob(context.target.id);
        const message = await gateway.send({ chatId: friend.chatId, text: options.text, execute: true });
        return { ...preview, executed: true, message };
      }
      if (!context.data.securityId) throw new BossCliError('职位缺少 securityId，请从 search 的完整链接开始沟通。', { code: 'SITE_CHANGED' });
      const receipt = await this.transport.request('/wapi/zpgeek/friend/add.json', { method: 'POST', query: { securityId: context.data.securityId, jobId: context.target.id, lid: context.data.lid ?? '' }, form: { sessionId: context.data.sessionId ?? '' } });
      if (options.text) {
        try {
          const gateway = await this._chatGateway();
          const friend = await gateway.findByJob(context.target.id);
          if (!friend?.chatId) throw new Error('Unique conversation not found');
          const message = await gateway.send({ chatId: friend.chatId, text: options.text, execute: true });
          return { ...preview, executed: true, receipt: { code: receipt.code }, message };
        } catch (cause) { throw new BossCliError('已发起沟通，但后续消息未确认发送。请查看会话记录，勿重复开聊。', { code: 'PARTIAL_SUCCESS', cause, details: { started: true, job: context.job } }); }
      }
      return { ...preview, executed: true, receipt: { code: receipt.code, message: receipt.message } };
    }
    const gateway = await this._chatGateway();
    if (options.action === 'send') return gateway.send(options);
    if (options.action === 'messages') return gateway.messages(options);
    return gateway.list(options);
  }
  async apply({ target, action = 'preview', execute = false, resumeId, message } = {}) {
    if (message !== undefined && (typeof message !== 'string' || !message.trim() || message.trim().length >= 1000)) throw new BossCliError('跟进消息需要 1 到 999 个字符。', { code: 'INVALID_ARGUMENT' });
    const context = await this._jobContext(target);
    const attachments = await this.transport.request('/wapi/zpgeek/resume/attachment/checkbox.json');
    const resumes = attachments.zpData?.resumeList;
    if (!Array.isArray(resumes)) throw new BossCliError('附件简历列表返回结构已变化。', { code: 'SITE_CHANGED' });
    if (resumes.some(resume => !resume || typeof resume !== 'object' || resume.resumeId === undefined || resume.resumeId === null || !String(resume.resumeId).trim() || /[\x00-\x1f\x7f]/.test(String(resume.resumeId))) || new Set(resumes.map(resume => String(resume.resumeId))).size !== resumes.length) throw new BossCliError('附件简历标识缺失或重复，已停止投递。', { code: 'SITE_CHANGED' });
    const items = resumes.map(resume => ({ id: String(resume.resumeId), name: resume.resumeName ?? resume.name ?? resume.fileName ?? '附件简历' }));
    const selected = resumeId ? items.find(resume => resume.id === String(resumeId)) : items.length === 1 ? items[0] : null;
    if (resumeId && !selected) throw new BossCliError('指定的 resume-id 不在当前账号的附件简历列表中。', { code: 'INVALID_ARGUMENT', details: { resumes: items } });
    const preview = { action: 'send-attachment-resume', job: context.job, resumes: items, selectedResume: selected, canSendResume: context.data.oneKeyResumeInfo?.canSendResume ?? null, ...(message ? { followupMessage: message } : {}), executed: false };
    if (!execute || action !== 'send') return preview;
    if (!selected) throw new BossCliError(items.length ? '存在多份附件简历，请先预览，再用 --resume-id 明确选择。' : '账号没有附件简历，请先在站点上传后重试。', { code: 'INVALID_ARGUMENT', details: { resumes: items } });
    if (preview.canSendResume === false) throw new BossCliError('站点当前不允许向此职位发送附件简历，请在浏览器查看具体条件。', { code: 'SITE_ACTION_UNAVAILABLE' });
    const page = await this.session.navigate(context.target.url);
    await this.session.assertUsable();
    const securityId = context.data.securityId;
    if (!securityId) throw new BossCliError('职位没有可用的站点 securityId。', { code: 'SITE_CHANGED' });
    const precheck = await page.evaluate(async ({ securityId, timeout }) => {
      if (!window.Detail?.exchangePrecheck || !window.Detail?.deliveResume || !window.$) return { started: false, reason: 'helper-unavailable' };
      const button = window.$('.btn-deliver').first();
      if (!button.length) return { started: false, reason: 'button-unavailable' };
      const allowed = await Promise.race([Promise.resolve(window.Detail.exchangePrecheck({ type: 3, securityId })), new Promise(resolve => setTimeout(() => resolve(false), timeout))]);
      if (!allowed) return { started: false, reason: 'precheck-declined' };
      return { started: true };
    }, { securityId, timeout: this.session.options.timeout });
    if (!precheck.started) throw new BossCliError('投递尚未提交。请检查浏览器中的站点预检提示或简历按钮，然后重新预览。', { code: 'SITE_ACTION_UNAVAILABLE', details: precheck });
    const responsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/wapi/zpgeek/resume/onekeydeliver.json' && url.searchParams.get('jobId') === context.target.id && url.searchParams.get('resumeId') === selected.id && response.request().method() === 'POST';
    }, { timeout: this.session.options.timeout });
    responsePromise.catch(() => {});
    let initiated;
    try { initiated = await page.evaluate(({ securityId, jobId, lid, resumeId }) => {
      if (!window.Detail?.deliveResume || !window.$) return { started: false, reason: 'helper-unavailable' };
      const button = window.$('.btn-deliver').first();
      if (!button.length) return { started: false, reason: 'button-unavailable' };
      const url = new URL('/wapi/zpgeek/resume/onekeydeliver.json', location.origin);
      url.searchParams.set('securityId', securityId); url.searchParams.set('jobId', jobId); url.searchParams.set('lid', lid);
      window.Detail.deliveResume(button, url.pathname + url.search, resumeId, {});
      return { started: true };
    }, { securityId, jobId: context.target.id, lid: context.data.lid ?? '', resumeId: selected.id }); }
    catch (cause) { throw new BossCliError('投递流程中断，是否已提交尚未确认，请先核对站点记录。', { code: 'DELIVERY_UNCONFIRMED', exitCode: 4, cause, details: { automaticRetry: false, job: context.job, resume: selected } }); }
    if (!initiated.started) {
      throw new BossCliError('站点投递流程尚未提交，请在浏览器检查简历按钮及预检提示。', { code: 'SITE_ACTION_UNAVAILABLE', details: initiated });
    }
    let response;
    try { response = await responsePromise; } catch { throw new BossCliError('投递已发起，但未收到服务器回执。请先在站点核对投递状态，勿直接重试。', { code: 'DELIVERY_UNCONFIRMED', exitCode: 4, details: { job: context.job, resume: selected } }); }
    let receipt;
    try { receipt = await response.json(); } catch { throw new BossCliError('投递已发起，但服务器回执无法解析，请先核对站点记录，勿直接重试。', { code: 'DELIVERY_UNCONFIRMED', exitCode: 4, details: { job: context.job, resume: selected } }); }
    if (!response.ok()) throw new BossCliError('投递已发起，但服务器未确认成功，请先核对站点记录。', { code: 'DELIVERY_UNCONFIRMED', exitCode: 4, details: { status: response.status() } });
    assertApiSuccess(receipt, { path: '/wapi/zpgeek/resume/onekeydeliver.json' });
    if (message) {
      try {
        const gateway = await this._chatGateway();
        const friend = await gateway.findByJob(context.target.id);
        if (!friend?.chatId) throw new Error('Unique conversation not found');
        const sent = await gateway.send({ chatId: friend.chatId, text: message, execute: true });
        return { ...preview, executed: true, receipt: { code: receipt.code }, message: sent };
      } catch (cause) { throw new BossCliError('附件简历已投递，但后续消息未确认发送。请勿重复投递。', { code: 'PARTIAL_SUCCESS', cause, details: { resumeSent: true, job: context.job, resume: selected } }); }
    }
    return { ...preview, executed: true, receipt: { code: receipt.code, message: receipt.message } };
  }
}
