import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ChatGateway } from '../src/chat-gateway.js';

const basic = [
  { friendId: 123, friendSource: 0, name: '张先生', encryptFriendId: 'boss-a' },
  { friendId: 456, friendSource: 0, name: '李女士', encryptFriendId: 'boss-b' },
];
const detail = [
  { uid: 123, friendSource: 0, name: '张先生', encryptBossId: 'boss-a', encryptJobId: 'job-a', securityId: 'sec-a', brandName: '甲公司', lastMessageInfo: { showText: '您好' } },
  { uid: 456, friendSource: 0, name: '李女士', encryptBossId: 'boss-b', encryptJobId: 'job-b', securityId: 'sec-b', brandName: '乙公司' },
];

function fakeTransport({ records = detail, history = [] } = {}) {
  const calls = [];
  return {
    calls,
    async request(route, options = {}) {
      calls.push({ route, options });
      if (route.endsWith('geekFilterByLabel')) return { code: 0, zpData: { friendList: basic } };
      if (route.endsWith('getGeekFriendList.json')) {
        const ids = `${options.form.friendIds ?? ''},${options.form.dzFriendIds ?? ''}`.split(',');
        return { code: 0, zpData: { result: records.filter(record => ids.includes(String(record.uid))) } };
      }
      if (route.endsWith('historyMsg')) return { code: 0, zpData: history[options.query.page - 1] };
      throw new Error(`Unexpected route ${route}`);
    },
  };
}

function subject() {
  const listeners = new Set();
  return { subscribe(fn) { listeners.add(fn); return { unsubscribe() { listeners.delete(fn); } }; }, next(value) { for (const fn of [...listeners]) fn(value); }, get size() { return listeners.size; } };
}

function fakeSession({ selectedId = '123-0', acknowledgment = true, draft = '' } = {}) {
  const socket = { message$: subject(), sync$: subject(), deliver$: subject(), client: { isConnected() { return true; } } };
  const editbox = { textContent: draft };
  let sends = 0;
  const editor = {
    $options: { name: 'Editor' }, $refs: { editbox },
    conversation$: { uniqueId: selectedId, uid: 123, friendSource: 0, encryptBossId: 'boss-a' },
    conversationLoading$: false, enableSubmit: false,
    getInputText() { return editbox.textContent; },
    _observerCallbackImpl() { this.enableSubmit = editbox.textContent.length > 0 && editbox.textContent.length < 1000; },
    $nextTick() { return Promise.resolve(); },
    sendText() {
      sends += 1;
      socket.message$.next([{ mid: 999, isSelf: true, from: { uid: 777 }, to: { uid: 123, source: 0 }, body: { text: editbox.textContent } }]);
      if (acknowledgment) socket.sync$.next([{ clientMid: 999, serverMid: 1000 }]);
      editbox.textContent = '';
    },
  };
  const context = vm.createContext({
    document: { querySelector() { return { __vue__: { $children: [editor] } }; } },
    window: { ChatWebsocket: socket, _PAGE: { userId: 777 } },
    setTimeout, clearTimeout,
  });
  const page = { async evaluate(fn, args) { context.args = args; return vm.runInContext(`(${fn.toString()})(args)`, context); } };
  return {
    options: { timeout: 25 }, navigation: [], socket,
    get sends() { return sends; },
    async navigate(url) { this.navigation.push(url); return page; },
    async assertUsable() {},
  };
}

test('conversation listing joins the observed ID list with exact friend details and paginates', async () => {
  const transport = fakeTransport();
  const gateway = new ChatGateway(fakeSession(), transport);
  const result = await gateway.list({ page: 2, limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.hasMore, false);
  assert.equal(result.items[0].chatId, '456-0');
  assert.deepEqual(transport.calls[1].options.form, { friendIds: '456' });
});

test('history page two uses the preceding server cursor and the observed request fields', async () => {
  const transport = fakeTransport({ history: [
    { messages: [{ mid: 10, body: { type: 1, text: 'newer' } }], hasMore: true, minMsgId: 10 },
    { messages: [{ mid: 8, body: { type: 1, text: 'older' } }], hasMore: false, minMsgId: 8 },
  ] });
  const result = await new ChatGateway(fakeSession(), transport).messages({ chatId: '123-0', page: 2, limit: 1 });
  const history = transport.calls.filter(call => call.route.endsWith('historyMsg'));
  assert.equal(history[0].options.query.maxMsgId, 0);
  assert.equal(history[1].options.query.maxMsgId, 10);
  assert.equal(history[1].options.query.bossId, 'boss-a');
  assert.equal(history[1].options.query.securityId, 'sec-a');
  assert.equal(history[1].options.query.c, 1);
  assert.equal(result.items[0].text, 'older');
});

test('send defaults to a recipient-resolved preview without navigating or invoking the editor', async () => {
  const session = fakeSession();
  const result = await new ChatGateway(session, fakeTransport()).send({ chatId: '123-0', text: '您好' });
  assert.equal(result.executed, false);
  assert.equal(result.recipient.name, '张先生');
  assert.equal(session.navigation.length, 0);
  assert.equal(session.sends, 0);
});

test('execute checks recipient identity and returns only a correlated application receipt', async () => {
  const session = fakeSession();
  const result = await new ChatGateway(session, fakeTransport()).send({ chatId: '123-0', text: '您好', execute: true });
  assert.equal(result.delivered, true);
  assert.equal(result.clientMessageId, '999');
  assert.equal(result.serverMessageId, '1000');
  assert.equal(result.receipt, 'messageSync');
  assert.equal(session.sends, 1);
  assert.equal(session.socket.message$.size, 0);
  assert.equal(session.socket.sync$.size, 0);
});

test('a different selected conversation prevents sending', async () => {
  const session = fakeSession({ selectedId: '456-0' });
  await assert.rejects(new ChatGateway(session, fakeTransport()).send({ chatId: '123-0', text: '您好', execute: true }), error => error.code === 'RECIPIENT_MISMATCH');
  assert.equal(session.sends, 0);
});

test('an existing browser draft prevents overwrite and sending', async () => {
  const session = fakeSession({ draft: '待处理草稿' });
  await assert.rejects(new ChatGateway(session, fakeTransport()).send({ chatId: '123-0', text: '您好', execute: true }), error => error.code === 'DRAFT_PRESENT');
  assert.equal(session.sends, 0);
});

test('missing receipt reports unconfirmed delivery and never retries the send', async () => {
  const session = fakeSession({ acknowledgment: false });
  await assert.rejects(new ChatGateway(session, fakeTransport()).send({ chatId: '123-0', text: '您好', execute: true }), error => error.code === 'DELIVERY_UNCONFIRMED' && error.details.attempted === true && error.details.automaticRetry === false);
  assert.equal(session.sends, 1);
  assert.equal(session.socket.message$.size, 0);
});

test('findByJob rejects ambiguous recipients instead of choosing the first', async () => {
  const records = detail.map(record => ({ ...record, encryptJobId: 'same-job' }));
  await assert.rejects(new ChatGateway(fakeSession(), fakeTransport({ records })).findByJob('same-job'), error => error.code === 'AMBIGUOUS_CHAT');
});

test('a detail response for another recipient cannot satisfy the requested chat-id', async () => {
  const transport = { async request() { return { code: 0, zpData: { result: [detail[1]] } }; } };
  await assert.rejects(new ChatGateway(fakeSession(), transport).recipient('123-0'), error => error.code === 'CHAT_NOT_FOUND');
});
