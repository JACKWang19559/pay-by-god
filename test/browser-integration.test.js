import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserSession, findBrowserExecutable, SITE_ORIGIN } from '../src/browser-session.js';
import { BossClient } from '../src/boss-client.js';
import { SiteTransport } from '../src/site-transport.js';
import { main } from '../src/cli.js';
import { parseJobTarget } from '../src/protocol.js';

// Every browser request is fulfilled here. This suite cannot reach a real recruiter.
const jobId = 'fixture-job-001';
const friend = { uid: 123, friendSource: 0, encryptBossId: 'fixture-boss', encryptJobId: jobId, securityId: 'fixture-security', name: '测试招聘者', brandName: '本地测试公司' };
const cities = { code: 0, zpData: { cityList: [{ code: 101270000, name: '四川', subLevelModelList: [{ code: 101270100, name: '成都', pinyin: 'chengdu' }] }] } };
function detail(state) {
  return { jobInfo: { encryptId: jobId, jobName: 'Python 测试职位', salaryDesc: '10-20K', postDescription: '这是隔离测试数据', cityName: '成都' }, bossInfo: { name: friend.name }, brandComInfo: { brandName: friend.brandName }, relationInfo: { interestJob: state.favorite, beFriend: state.started }, oneKeyResumeInfo: { canSendResume: true }, securityId: friend.securityId, lid: 'fixture-lid', sessionId: 'fixture-session' };
}
function html(state, chat = false) {
  const jobBody = state.domOnly ? `<div class="nav-figure">测试账户</div><div class="job-detail-container"><div class="job-name">DOM 测试职位</div><span class="job-salary">15-25K</span><p class="desc">第一行<br>第二行</p><button class="btn-deliver" data-url="/wapi/zpgeek/resume/onekeydeliver.json?jobId=${jobId}&securityId=fixture-security&lid=fixture-lid">发送简历</button></div>` : '<div class="nav-figure">测试账户</div><div class="job-detail-box"><h1>Python 测试职位</h1><button class="btn-deliver">发送简历</button></div>';
  const body = chat ? '<div id="app"><div id="editbox" contenteditable="true"></div></div>' : jobBody;
  return `<!doctype html><html><head><meta charset="UTF-8"><title>本地合同测试</title></head><body>${body}<script>
  const initial = ${JSON.stringify({ detail: detail(state), precheck: state.precheck, acknowledgment: state.acknowledgment, draft: state.draft })};
  if (document.querySelector('.job-detail-box')) document.querySelector('.job-detail-box').__vue__ = { $props: {data: initial.detail} };
  window.$ = () => ({length: document.querySelector('.btn-deliver') ? 1 : 0, first(){return this}});
  window.Detail = {
    exchangePrecheck(){return initial.precheck === 'late' ? new Promise(resolve=>setTimeout(()=>resolve(true),500)) : Promise.resolve(initial.precheck)},
    deliveResume(button, target, resumeId){const url=new URL(target,location.origin);url.searchParams.set('resumeId',resumeId);fetch(url,{method:'POST',body:new URLSearchParams({}).toString()});}
  };
  if (document.querySelector('#app')) {
    const subject=()=>{const listeners=new Set();return {subscribe(fn){listeners.add(fn);return {unsubscribe(){listeners.delete(fn)}}},next(value){for(const fn of listeners)fn(value)}}};
    const socket={message$:subject(),sync$:subject(),deliver$:subject(),client:{isConnected(){return true}}};
    window.ChatWebsocket=socket;window._PAGE={userId:777};
    const editbox=document.querySelector('#editbox');editbox.textContent=initial.draft;
    const editor={$options:{name:'Editor'},$refs:{editbox},conversation$:{uniqueId:'123-0',uid:123,friendSource:0,encryptBossId:'fixture-boss'},conversationLoading$:false,enableSubmit:false,
      getInputText(){return editbox.textContent},_observerCallbackImpl(){this.enableSubmit=Boolean(editbox.textContent)},$nextTick(){return Promise.resolve()},
      sendText(){const text=editbox.textContent;socket.message$.next([{mid:999,isSelf:true,from:{uid:777},to:{uid:123,source:0},body:{text}}]);fetch('/fixture/send',{method:'POST',body:text}).then(()=>{if(initial.acknowledgment)socket.sync$.next([{clientMid:999,serverMid:1000}])});editbox.textContent=''}
    };
    document.querySelector('#app').__vue__={$children:[editor]};
  }
  </script></body></html>`;
}

test('real Edge browser: CLI commands, previews, writes, errors and receipt handling against an isolated fixture', { timeout: 60_000 }, async t => {
  let executable;
  try { executable = await findBrowserExecutable(); } catch { t.skip('Install Edge/Chrome to run browser integration tests.'); return; }
  await fs.mkdir(path.resolve('.boss-cli'), { recursive: true });
  const temp = await fs.mkdtemp(path.join(path.resolve('.boss-cli'), 'browser-test-'));
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const state = { favorite: false, started: false, precheck: true, acknowledgment: true, draft: '', resumes: [{ resumeId: 'r-1', resumeName: '测试简历.pdf' }], deliveries: [], messages: [], calls: [], searchCode: 0 };
  const session = new BrowserSession({ profile: 'fixture', dataDir: temp, profileDir: path.join(temp, 'profile'), timeout: 1200 });
  session.browser = browser; session.context = context; session.page = page;
  // This injected browser only visits the local fixture; raw-CDP preparation is tested separately.
  session.prepareJobReads = undefined;
  // Route the injected API request context through the isolated fixture page, too.
  // Production uses the native BrowserContext.request cookie jar and never this adapter.
  const fixtureRequest = { async fetch(url, options) {
    const result = await page.evaluate(async ({ url, options }) => {
      const response = await fetch(url, { method: options.method, headers: { ...options.headers, ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, ...(options.form ? { body: new URLSearchParams(options.form).toString() } : {}) });
      return { status: response.status, text: await response.text() };
    }, { url, options });
    return { status: () => result.status, text: async () => result.text };
  } };
  const client = new BossClient({ session, transport: new SiteTransport(session, { request: fixtureRequest }), fetch: async () => ({ ok: true, json: async () => cities }) });
  client.close = async () => {};
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), form = Object.fromEntries(new URLSearchParams(request.postData() ?? ''));
    state.calls.push({ path: url.pathname, method: request.method(), query: Object.fromEntries(url.searchParams), form });
    let data;
    switch (url.pathname) {
      case '/wapi/zpgeek/search/joblist.json':
        assert.equal(request.method(), 'POST'); assert.equal(form.city, '101270100'); assert.equal(form.degree, '203');
        data = state.searchCode ? { code: state.searchCode, message: '您的环境存在异常', zpData: { seed: 'fixture-challenge' } } : { code: 0, zpData: { jobList: [detail(state)], lid: 'fixture-lid', hasMore: false } }; break;
      case '/wapi/zpgeek/job/detail.json': data = { code: 0, zpData: detail(state) }; break;
      case '/wapi/zprelation/interaction/geekGetJob': data = { code: 0, zpData: { cardList: state.favorite ? [detail(state)] : [], hasMore: false } }; break;
      case '/wapi/zprelation/geekTag/job/interest': state.favorite = form.flag === '1'; data = { code: 0 }; break;
      case '/wapi/zpgeek/friend/add.json': state.started = true; data = { code: 0 }; break;
      case '/wapi/zprelation/friend/geekFilterByLabel': data = { code: 0, zpData: { friendList: [{ friendId: 123, friendSource: 0 }] } }; break;
      case '/wapi/zprelation/friend/getGeekFriendList.json': data = { code: 0, zpData: { result: [friend] } }; break;
      case '/wapi/zpchat/geek/historyMsg': data = { code: 0, zpData: { messages: [{ mid: 1000, body: { type: 1, text: '历史测试消息' } }], hasMore: false, minMsgId: 1000 } }; break;
      case '/wapi/zpgeek/resume/attachment/checkbox.json': data = { code: 0, zpData: { resumeList: state.resumes } }; break;
      case '/wapi/zpgeek/resume/onekeydeliver.json': state.deliveries.push(Object.fromEntries(url.searchParams)); data = { code: 0, message: '附件简历已经发送' }; break;
      case '/fixture/send': state.messages.push(request.postData()); data = { ok: true }; break;
      default:
        if (request.resourceType() === 'document' && url.origin === SITE_ORIGIN) { await route.fulfill({ status: 200, contentType: 'text/html', body: html(state, url.pathname === '/web/geek/chat') }); return; }
        await route.fulfill({ status: 404, body: 'Fixture blocks all external requests' }); return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  async function run(argv, expected = 0) {
    let stdout = '', stderr = '';
    const code = await main([...argv, '--json'], { clientFactory: async () => client, stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } });
    assert.equal(code, expected, `${argv.join(' ')}: ${stderr}`);
    return JSON.parse(expected ? stderr : stdout);
  }
  try {
    await page.goto(SITE_ORIGIN);
    await t.test('login/status/city/search/detail with the same browser and cache', async () => {
      assert.equal((await run(['login'])).authenticated, true);
      assert.equal((await run(['status'])).authenticated, true);
      assert.equal((await run(['cities', '成都'])).items[0].code, '101270100');
      assert.equal((await run(['search', 'Python', '--city', '成都', '--education', '本科'])).items[0].id, jobId);
      assert.equal((await run(['job', jobId])).description, '这是隔离测试数据');
    });
    await t.test('favorite previews do not write; add/list/remove execute', async () => {
      assert.equal((await run(['favorites', 'add', jobId])).executed, false); assert.equal(state.favorite, false);
      assert.equal((await run(['favorites', 'add', jobId, '--execute'])).executed, true);
      assert.equal((await run(['favorites', 'list'])).items.length, 1);
      await run(['favorites', 'remove', jobId, '--execute']); assert.equal(state.favorite, false);
    });
    await t.test('chat list/history, preview, start with followup and correlated send receipt', async () => {
      assert.equal((await run(['chats', 'list'])).items[0].chatId, '123-0');
      assert.equal((await run(['chats', 'messages', '123-0'])).items[0].text, '历史测试消息');
      assert.equal((await run(['chats', 'send', '123-0', '预览消息'])).executed, false); assert.equal(state.messages.length, 0);
      assert.equal((await run(['chats', 'start', jobId])).executed, false); assert.equal(state.started, false);
      const started = await run(['chats', 'start', jobId, '--text', '开聊跟进', '--execute']);
      assert.equal(started.message.delivered, true); assert.deepEqual(state.messages, ['开聊跟进']);
      const sent = await run(['chats', 'send', '123-0', '独立发送', '--execute']);
      assert.equal(sent.receipt, 'messageSync'); assert.equal(state.messages.length, 2);
      const initialGreetings = state.calls.filter(x => x.path === '/wapi/zpgeek/friend/add.json').length;
      const existing = await run(['chats', 'start', jobId, '--execute']);
      assert.equal(existing.unchanged, true);
      assert.equal(state.calls.filter(x => x.path === '/wapi/zpgeek/friend/add.json').length, initialGreetings);
    });
    await t.test('resume preview and submit with exact selected attachment and followup', async () => {
      assert.equal((await run(['apply', 'preview', jobId])).selectedResume.id, 'r-1'); assert.equal(state.deliveries.length, 0);
      assert.equal((await run(['apply', 'send', jobId])).executed, false); assert.equal(state.deliveries.length, 0);
      const result = await run(['apply', 'send', jobId, '--resume-id', 'r-1', '--message', '投递跟进', '--execute']);
      assert.equal(result.executed, true); assert.equal(result.message.delivered, true);
      assert.equal(state.deliveries[0].jobId, jobId); assert.equal(state.deliveries[0].resumeId, 'r-1');
    });
    await t.test('multiple resumes require explicit selection and invalid IDs cannot submit', async () => {
      state.resumes.push({ resumeId: 'r-2', resumeName: '另一份.pdf' });
      const before = state.deliveries.length;
      assert.equal((await run(['apply', 'send', jobId, '--execute'], 2)).error.code, 'INVALID_ARGUMENT');
      await run(['apply', 'send', jobId, '--resume-id', 'unknown', '--execute'], 2);
      assert.equal(state.deliveries.length, before);
      await run(['apply', 'send', jobId, '--resume-id', 'r-2', '--execute']); assert.equal(state.deliveries.at(-1).resumeId, 'r-2');
    });
    await t.test('a late resume precheck cannot submit after the CLI timeout', async () => {
      state.precheck = 'late'; session.options.timeout = 100;
      await page.goto(SITE_ORIGIN);
      const before = state.deliveries.length;
      assert.equal((await run(['apply', 'send', jobId, '--resume-id', 'r-1', '--execute'], 1)).error.code, 'SITE_ACTION_UNAVAILABLE');
      await page.waitForTimeout(600); assert.equal(state.deliveries.length, before);
      state.precheck = true; session.options.timeout = 1200;
    });
    await t.test('server verification is exit4 and no challenge secrets are exported', async () => {
      state.searchCode = 37;
      const result = await run(['search', 'Python', '--city', '成都', '--education', '本科'], 4);
      assert.equal(result.error.code, 'VERIFICATION_REQUIRED'); assert.ok(!JSON.stringify(result).includes('fixture-challenge'));
      state.searchCode = 0;
    });
    await t.test('plain DOM fallback reads shipped SPA fields and keeps description line breaks without Vue data', async () => {
      state.domOnly = true;
      await page.goto(SITE_ORIGIN);
      const target = parseJobTarget(`${SITE_ORIGIN}/job_detail/${jobId}.html`);
      const result = await client._domDetail(target);
      assert.equal(result.jobInfo.encryptJobId, jobId);
      assert.equal(result.jobInfo.jobName, 'DOM 测试职位');
      assert.equal(result.jobInfo.salaryDesc, '15-25K');
      assert.equal(result.jobInfo.postDescription, '第一行\n第二行');
      assert.equal(result.securityId, 'fixture-security');
      assert.equal(result.observedFrom, 'rendered-page');
      state.domOnly = false;
    });
    await t.test('logout clears only this fixture browser session and foreign cookies survive', async () => {
      await context.addCookies([{ name: 'fixture', value: '1', domain: '.zhipin.com', path: '/' }, { name: 'foreign', value: '1', domain: 'example.com', path: '/' }]);
      await page.evaluate(() => localStorage.setItem('fixture', '1'));
      assert.equal((await run(['logout'])).loggedOut, true);
      const cookies = await context.cookies(); assert.ok(!cookies.some(x => /zhipin/.test(x.domain))); assert.ok(cookies.some(x => x.name === 'foreign'));
      assert.equal(await page.evaluate(() => localStorage.getItem('fixture')), null);
    });
  } finally {
    await browser.close();
    const relative = path.relative(path.resolve('.boss-cli'), temp);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(temp, { recursive: true, force: true });
  }
});
