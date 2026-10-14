import { BossCliError } from './errors.js';
import { SITE_ORIGIN } from './browser-session.js';
import { assertApiSuccess } from './protocol.js';

export class SiteTransport {
  constructor(session, { request } = {}) { this.session = session; this.requestContext = request; }
  async request(route, { method = 'GET', query = {}, form = {}, mutation = method !== 'GET' } = {}) {
    if (!route.startsWith('/wapi/') || route.includes('://') || route.includes('..')) throw new BossCliError('无效的站内 API 路径。', { code: 'INVALID_ARGUMENT' });
    if (!this.requestContext && ['/wapi/zpgeek/search/joblist.json', '/wapi/zpgeek/job/detail.json'].includes(route)) {
      await this.session.prepareJobReads?.({ query: form.query, city: form.city });
    }
    await this.session.connect();
    const url = new URL(route, SITE_ORIGIN);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    // The shipped axios wrapper appends this ordinary cache-busting query field.
    if (!url.searchParams.has('_')) url.searchParams.set('_', String(Date.now()));
    let result;
    try {
      // BrowserContext.request shares the live context's cookie jar without exporting it.
      // It stays available when the visible page navigates. Server codes still decide access.
      const request = this.requestContext ?? this.session.context.request;
      const response = await request.fetch(url.href, {
        method, timeout: this.session.options.timeout, failOnStatusCode: false,
        maxRetries: 0, maxRedirects: 0,
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        ...(method !== 'GET' ? { form } : {}),
      });
      try {
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch {}
        result = { status: response.status(), json: data !== undefined, data, verification: /安全验证|captcha|verify\.html|验证后继续访问/.test(text) };
      } finally { try { await response.dispose?.(); } catch {} }
    } catch (cause) {
      if (mutation) throw new BossCliError('操作可能已提交，但未收到服务器回执。请先核对站点记录，勿直接重试。', { code: 'DELIVERY_UNCONFIRMED', exitCode: 4, details: { path: route, attempted: 'unknown', automaticRetry: false }, cause });
      throw new BossCliError('站内请求未完成，请检查浏览器会话及网络后重试。', { code: 'NETWORK_ERROR', cause });
    }
    if (result.status === 429) throw new BossCliError('站点要求降低访问频率，请稍后重试。', { code: 'RATE_LIMITED', exitCode: 4 });
    let apiError;
    if (result.json) {
      try { assertApiSuccess(result.data, { path: route }); } catch (error) { apiError = error; }
      if (apiError && ['VERIFICATION_REQUIRED', 'AUTH_REQUIRED', 'RATE_LIMITED'].includes(apiError.code)) {
        // A later explicit read must initialize again after the server rejects
        // the session. Never retry this request or discard an in-flight prepare.
        if (apiError.code !== 'RATE_LIMITED') this.session.jobReadsReady = false;
        apiError.details = { ...apiError.details, status: result.status };
        throw apiError;
      }
    }
    if (!result.json) {
      if (result.verification) this.session.jobReadsReady = false;
      throw new BossCliError(result.verification ? '站点要求安全验证，请先核对操作记录及浏览器状态。' : mutation ? '操作回执未返回 JSON，请先核对站点记录，勿直接重试。' : '接口返回了非 JSON 页面，站点可能要求重新登录。', { code: result.verification ? 'VERIFICATION_REQUIRED' : mutation ? 'DELIVERY_UNCONFIRMED' : 'SITE_CHANGED', details: { path: route, status: result.status, ...(mutation ? { automaticRetry: false } : {}) } });
    }
    if (result.status < 200 || result.status >= 300) throw new BossCliError(mutation ? '服务器未确认操作成功，请先核对站点记录，勿直接重试。' : '站内接口返回 HTTP 错误。', { code: mutation ? 'DELIVERY_UNCONFIRMED' : 'SITE_API_ERROR', details: { path: route, status: result.status, ...(mutation ? { automaticRetry: false } : {}) } });
    if (apiError) throw apiError;
    return result.data;
  }
}
