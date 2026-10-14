import { BossCliError } from './errors.js';
import { SITE_ORIGIN } from './browser-session.js';

const FILTER = '/wapi/zprelation/friend/geekFilterByLabel';
const FRIENDS = '/wapi/zprelation/friend/getGeekFriendList.json';
const HISTORY = '/wapi/zpchat/geek/historyMsg';

function pagination(page = 1, limit = 20) {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BossCliError('page 必须是正整数，limit 必须为 1 到 100。', { code: 'INVALID_ARGUMENT' });
  }
  return { page, limit };
}

function parseChatId(chatId) {
  const match = /^(\d+)-([01])$/.exec(String(chatId ?? ''));
  if (!match || /^0+$/.test(match[1])) throw new BossCliError('chat-id 使用会话列表返回的 friendId-source，例如 123456-0。', { code: 'INVALID_ARGUMENT' });
  return { friendId: match[1], friendSource: Number(match[2]), chatId: `${match[1]}-${match[2]}` };
}

function normalizeFriend(detail, basic = {}) {
  const friendId = String(detail.uid ?? detail.friendId ?? basic.friendId ?? '');
  const friendSource = Number(detail.friendSource ?? basic.friendSource ?? 0);
  if (!/^\d+$/.test(friendId) || /^0+$/.test(friendId) || ![0, 1].includes(friendSource)) return null;
  return {
    chatId: `${friendId}-${friendSource}`, friendId, friendSource,
    name: detail.name ?? basic.name ?? '', brandName: detail.brandName ?? basic.brandName ?? '',
    title: detail.title ?? detail.bossTitle ?? basic.bossTitle ?? '',
    encryptBossId: detail.encryptBossId ?? detail.encryptUid ?? basic.encryptFriendId ?? '',
    encryptJobId: detail.encryptJobId ?? '', jobId: detail.jobId ?? '',
    securityId: detail.securityId ?? '',
    unreadCount: detail.unreadCount ?? basic.unreadCount ?? 0,
    lastText: detail.lastMessageInfo?.showText ?? detail.lastText ?? '',
    updateTime: detail.lastTS ?? detail.updateTime ?? basic.updateTime ?? 0,
  };
}

function normalizeMessage(message) {
  const body = message.body ?? {};
  return {
    mid: message.mid, time: message.time,
    fromId: message.from?.uid ?? message.fromId,
    toId: message.to?.uid ?? message.toId,
    type: message.messageType ?? body.type ?? message.type,
    text: message.text ?? body.text ?? '', status: message.status,
    body,
  };
}

/** Resolve conversation IDs against their matching recipient details before reading or sending. */
export class ChatGateway {
  constructor(session, transport) { this.session = session; this.transport = transport; }

  async details(ids) {
    if (!ids.length) return [];
    const form = {};
    const bossIds = ids.filter(x => Number(x.friendSource ?? 0) === 0).map(x => String(x.friendId));
    const dzIds = ids.filter(x => Number(x.friendSource) === 1).map(x => String(x.friendId));
    if (bossIds.length) form.friendIds = bossIds.join(',');
    if (dzIds.length) form.dzFriendIds = dzIds.join(',');
    const result = await this.transport.request(FRIENDS, { method: 'POST', form, mutation: false });
    const records = result.zpData?.result;
    if (!Array.isArray(records)) throw new BossCliError('会话详情结构已变化。', { code: 'SITE_CHANGED', details: { path: FRIENDS } });
    return records.map(record => normalizeFriend(record, ids.find(item => String(item.friendId) === String(record.uid ?? record.friendId) && Number(item.friendSource ?? 0) === Number(record.friendSource ?? 0)))).filter(Boolean);
  }

  async list({ page = 1, limit = 20 } = {}) {
    pagination(page, limit);
    const result = await this.transport.request(FILTER, { query: { labelId: 0 } });
    const all = result.zpData?.friendList;
    if (!Array.isArray(all)) throw new BossCliError('会话列表结构已变化。', { code: 'SITE_CHANGED', details: { path: FILTER } });
    const ids = all.filter(item => /^\d+$/.test(String(item.friendId)) && [0, 1].includes(Number(item.friendSource ?? 0)));
    const selected = ids.slice((page - 1) * limit, page * limit);
    const details = await this.details(selected);
    const byId = new Map(details.map(item => [item.chatId, item]));
    const items = selected.map(item => byId.get(`${item.friendId}-${item.friendSource ?? 0}`)).filter(Boolean);
    return { items, page, limit, total: ids.length, hasMore: page * limit < ids.length };
  }

  async recipient(chatId) {
    const parsed = parseChatId(chatId);
    const records = await this.details([parsed]);
    const record = records.find(item => item.chatId === parsed.chatId);
    if (!record) throw new BossCliError('未找到这个会话，请重新运行 boss chats。', { code: 'CHAT_NOT_FOUND' });
    if (!record.securityId || !record.encryptBossId) throw new BossCliError('会话缺少站点提供的 securityId 或 Boss 标识，请在浏览器中刷新该会话。', { code: 'SITE_CHANGED' });
    return record;
  }

  async messages({ chatId, page = 1, limit = 20 } = {}) {
    pagination(page, limit);
    const recipient = await this.recipient(chatId);
    let cursor = 0;
    let data;
    for (let current = 1; current <= page; current += 1) {
      const result = await this.transport.request(HISTORY, {
        query: { bossId: recipient.encryptBossId, groupId: '', maxMsgId: cursor, c: limit, page: current, src: recipient.friendSource, securityId: recipient.securityId, gid: '' },
      });
      data = result.zpData;
      if (!data || !Array.isArray(data.messages)) throw new BossCliError('历史消息结构已变化。', { code: 'SITE_CHANGED', details: { path: HISTORY } });
      const mids = data.messages.map(item => Number(item.mid)).filter(Number.isFinite);
      const next = data.minMsgId || (mids.length ? Math.min(...mids) : 0);
      if (current < page && (!data.messages.length || (!data.hasMore && data.messages.length < limit))) {
        return { recipient, items: [], page, limit, hasMore: false, minMsgId: next };
      }
      if (current < page && (!next || (cursor && Number(next) >= Number(cursor)))) throw new BossCliError('历史消息游标没有前进，已停止翻页。', { code: 'SITE_CHANGED' });
      cursor = next;
    }
    return { recipient, items: data.messages.map(normalizeMessage), page, limit, hasMore: Boolean(data.hasMore), minMsgId: cursor };
  }

  async findByJob(jobId) {
    const expected = String(jobId ?? '');
    if (!expected) throw new BossCliError('缺少职位 ID。', { code: 'INVALID_ARGUMENT' });
    const matches = [];
    for (let page = 1; ; page += 1) {
      const result = await this.list({ page, limit: 100 });
      matches.push(...result.items.filter(item => String(item.encryptJobId) === expected || String(item.jobId) === expected));
      if (!result.hasMore) break;
    }
    const unique = [...new Map(matches.map(item => [item.chatId, item])).values()];
    if (unique.length > 1) throw new BossCliError('该职位对应多个沟通对象，请用 chats 返回的 chat-id 选择收件人。', { code: 'AMBIGUOUS_CHAT', details: { chatIds: unique.map(item => item.chatId) } });
    if (!unique.length) throw new BossCliError('暂未找到该职位的沟通会话。请刷新会话列表，勿重复发起沟通。', { code: 'CHAT_NOT_FOUND' });
    return unique[0];
  }

  async send({ chatId, text, execute = false } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.trim().length >= 1000) throw new BossCliError('消息正文需要 1 到 999 个字符。', { code: 'INVALID_ARGUMENT' });
    text = text.trim();
    const recipient = await this.recipient(chatId);
    if (!execute) return { action: 'send-message', executed: false, recipient, text };
    const url = new URL('/web/geek/chat', SITE_ORIGIN);
    url.searchParams.set('id', recipient.encryptBossId);
    if (recipient.encryptJobId || recipient.jobId) url.searchParams.set('jobId', recipient.encryptJobId || recipient.jobId);
    url.searchParams.set('securityId', recipient.securityId);
    const page = await this.session.navigate(url.href);
    // The authenticated friend-details API above establishes the account session;
    // the chat SPA does not consistently render the homepage account menu.
    await this.session.assertUsable();
    let result;
    try {
      result = await page.evaluate(async ({ recipient, text, timeout }) => {
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        const findEditor = () => {
          const root = document.querySelector('#app')?.__vue__;
          const pending = root ? [root] : [], seen = new Set();
          while (pending.length && seen.size < 1000) {
            const item = pending.shift();
            if (!item || seen.has(item)) continue;
            seen.add(item);
            if (item.$options?.name === 'Editor' && typeof item.sendText === 'function' && item.$refs?.editbox) return item;
            pending.push(...(item.$children ?? []));
          }
          return null;
        };
        const started = Date.now();
        let editor;
        while (Date.now() - started < timeout) {
          editor = findEditor();
          if (editor && String(editor.conversation$?.uniqueId) === recipient.chatId && !editor.conversationLoading$) break;
          await delay(100);
        }
        if (!editor || String(editor.conversation$?.uniqueId) !== recipient.chatId) return { error: 'RECIPIENT_MISMATCH', attempted: false };
        const selected = editor.conversation$;
        if (String(selected.uid ?? selected.friendId) !== recipient.friendId || Number(selected.friendSource ?? 0) !== recipient.friendSource || selected.encryptBossId !== recipient.encryptBossId) return { error: 'RECIPIENT_MISMATCH', attempted: false };
        const socket = window.ChatWebsocket;
        if (!socket?.client?.isConnected?.() || !socket.message$?.subscribe || !socket.sync$?.subscribe || !socket.deliver$?.subscribe) return { error: 'CHAT_NOT_READY', attempted: false };
        if (typeof editor.getInputText !== 'function' || typeof editor._observerCallbackImpl !== 'function' || typeof editor.$nextTick !== 'function') return { error: 'SITE_CHANGED', attempted: false };
        if (editor.getInputText().trim()) return { error: 'DRAFT_PRESENT', attempted: false };
        const editbox = editor.$refs.editbox;
        const originalHtml = editbox.innerHTML;
        const originalText = editbox.textContent;
        return await new Promise(resolve => {
          const subscriptions = [];
          const acknowledgments = new Map();
          let clientMessageId, completed = false, attempted = false;
          const finish = result => {
            if (completed) return;
            completed = true;
            clearTimeout(timer);
            subscriptions.forEach(subscription => subscription.unsubscribe());
            if (!attempted && editbox.textContent === text) {
              if (typeof originalHtml === 'string') editbox.innerHTML = originalHtml;
              else editbox.textContent = originalText;
            }
            resolve(result);
          };
          const accepted = () => {
            const receipt = clientMessageId && acknowledgments.get(clientMessageId);
            if (receipt) finish({ delivered: true, attempted: true, clientMessageId, ...receipt });
          };
          const timer = setTimeout(() => finish({ error: 'DELIVERY_UNCONFIRMED', attempted, ...(clientMessageId ? { clientMessageId } : {}) }), timeout);
          subscriptions.push(socket.message$.subscribe(messages => {
            if (!attempted || clientMessageId) return;
            for (const message of messages ?? []) {
              const to = message.to ?? {};
              if (String(to.uid) === recipient.friendId && Number(to.source ?? 0) === recipient.friendSource && message.body?.text === text && (message.isSelf || String(message.from?.uid) === String(window._PAGE?.userId))) {
                clientMessageId = String(message.mid);
                accepted();
              }
            }
          }));
          subscriptions.push(socket.sync$.subscribe(records => {
            for (const record of records ?? []) {
              if (record.clientMid != null && record.serverMid != null) acknowledgments.set(String(record.clientMid), { serverMessageId: String(record.serverMid), receipt: 'messageSync' });
            }
            accepted();
          }));
          // MQTT delivery alone is intentionally insufficient: require the application messageSync receipt.
          subscriptions.push(socket.deliver$.subscribe(() => {}));
          try {
            editbox.textContent = text;
            editor._observerCallbackImpl();
            Promise.resolve(editor.$nextTick()).then(() => {
              const current = editor.conversation$;
              if (String(current?.uniqueId) !== recipient.chatId || String(current?.uid ?? current?.friendId) !== recipient.friendId) return finish({ error: 'RECIPIENT_MISMATCH', attempted: false });
              if (editor.getInputText() !== text || !editor.enableSubmit || editor.conversationLoading$) return finish({ error: 'CHAT_NOT_READY', attempted: false });
              attempted = true;
              editor.sendText();
            }).catch(() => finish({ error: 'DELIVERY_UNCONFIRMED', attempted }));
          } catch { finish({ error: 'DELIVERY_UNCONFIRMED', attempted }); }
        });
      }, { recipient, text, timeout: this.session.options.timeout });
    } catch (cause) {
      throw new BossCliError('浏览器发送流程中断，消息是否送达尚未确认，请先检查会话记录。', { code: 'DELIVERY_UNCONFIRMED', details: { chatId: recipient.chatId, automaticRetry: false }, cause });
    }
    if (!result.delivered) {
      const messages = { RECIPIENT_MISMATCH: '浏览器当前收件人与指定会话不一致，已停止发送。', CHAT_NOT_READY: '沟通页面尚未就绪，未发送消息。', DRAFT_PRESENT: '浏览器编辑框已有草稿，请先处理草稿再发送。', SITE_CHANGED: '站点消息编辑器结构已变化，未发送消息。', DELIVERY_UNCONFIRMED: '未收到与本次消息匹配的服务端回执，请先检查会话记录，勿自动重试。' };
      throw new BossCliError(messages[result.error] ?? messages.DELIVERY_UNCONFIRMED, { code: result.error ?? 'DELIVERY_UNCONFIRMED', details: { chatId: recipient.chatId, attempted: result.attempted, clientMessageId: result.clientMessageId, automaticRetry: false } });
    }
    return { action: 'send-message', executed: true, delivered: true, recipient, text, clientMessageId: result.clientMessageId, serverMessageId: result.serverMessageId, receipt: result.receipt };
  }
}
