import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArguments, resolveCommand } from '../src/commands.js';
import { resolveConfig } from '../src/config.js';
import { redactSensitive, normalizeError, BossCliError } from '../src/errors.js';
import { renderOutput, renderCsv } from '../src/output.js';
import { main } from '../src/cli.js';

const parse = (args) => resolveCommand(parseArguments(args));
function capture() { let value = ''; return { write(text) { value += text; }, get value() { return value; } }; }

test('search parser accepts Unicode, equals options, filters and global options before command', () => {
  assert.deepEqual(parse(['--profile', 'work', 'search', '前端 开发', '--city=北京', '--page', '2', '--limit=30', '--education', '本科']).args, {
    query: '前端 开发', city: '北京', page: 2, limit: 30, filters: { education: '本科' },
  });
  assert.equal(parse(['search', '--', '--literal']).args.query, '--literal');
});

test('parser rejects typos, malformed integers, option conflicts and missing arguments', () => {
  for (const args of [
    ['search', 'dev', '--limt', '1'], ['search', 'dev', '--page', '0'], ['search', 'dev', '--limit', '2.5'],
    ['search', 'dev', '--limit', '101'], ['search', 'dev', '--city'], ['search', 'dev', '--page', '2', '--page', '3'],
    ['search', 'dev', '--json', '--format', 'csv'], ['job'], ['job', 'one', 'two'], ['chats', 'send', 'user'],
    ['chats', 'send', 'user', 'hello', '--text', 'other'], ['status', '--execute'], ['apply', 'preview', 'job', '--execute'],
    ['status', '--city', '北京'], ['chats', 'send', 'user', 'hello', '--page', '2'], ['job', 'one', '--wait', '30000'],
    ['cities', '北京', '--query', '上海'],
    ['search', 'dev', '--sort', 'recent'], ['job', 'job123', '--resume-id', '42'], ['chats', 'start'],
    ['chats', 'start', 'job123', 'extra'], ['chats', 'start', 'job123', '--page', '2'],
    ['chats', 'start', 'job123', '--text', 'hello', '--message', 'other'], ['chats', 'start', 'job123', '--text', '   '],
  ]) assert.throws(() => parse(args), { code: 'USAGE_ERROR' }, args.join(' '));
});

test('every remote write defaults to preview and only --execute enables execution', () => {
  for (const args of [['favorites', 'add', 'job'], ['favorites', 'remove', 'job'], ['chats', 'send', 'chat', '你好'], ['chats', 'start', 'job123'], ['apply', 'send', 'job']]) {
    assert.equal(parse(args).args.execute, false);
    assert.equal(parse([...args, '--execute']).args.execute, true);
  }
  assert.equal(parse(['apply', 'job']).args.action, 'preview');
  assert.equal(parse(['apply', 'job']).args.execute, false);
});

test('starting a conversation forwards only the selected job, optional message and explicit execute flag', () => {
  assert.deepEqual(parse(['chats', 'start', 'job123']).args, { action: 'start', target: 'job123', execute: false });
  assert.deepEqual(parse(['chats', 'start', 'job123', '--message', '您好，期待了解职位', '--execute']).args, { action: 'start', target: 'job123', text: '您好，期待了解职位', execute: true });
  assert.equal(parse(['chats', 'start', 'job123', '--text', '我的介绍']).args.text, '我的介绍');
});

test('resume selection is an opaque explicit apply option and never enables execution', () => {
  assert.deepEqual(parse(['apply', 'preview', 'job123', '--resume-id', 'resume-42']).args, { action: 'preview', target: 'job123', resumeId: 'resume-42', execute: false });
  assert.deepEqual(parse(['apply', 'send', 'job123', '--resume-id', '42', '--message', '您好', '--execute']).args, { action: 'send', target: 'job123', resumeId: '42', message: '您好', execute: true });
  assert.throws(() => parse(['apply', 'job123', '--resume-id', '   ']), { code: 'USAGE_ERROR' });
});

test('profile path cannot traverse directories or use reserved Windows filenames', () => {
  const config = resolveConfig({ profile: 'my-account' }, { env: {}, baseDir: os.tmpdir() });
  assert.equal(config.profileDir, path.join(os.tmpdir(), '.boss-cli', 'profiles', 'my-account'));
  for (const profile of ['../other', '..', 'C:\\other', 'NUL', 'con.backup']) assert.throws(() => resolveConfig({ profile }, { env: {} }), { code: 'USAGE_ERROR' });
  assert.throws(() => resolveConfig({ cdpUrl: 'file:///tmp/test' }, { env: {} }), { code: 'USAGE_ERROR' });
  assert.throws(() => resolveConfig({ cdpUrl: 'http://user:pass@localhost:9222' }, { env: {} }), { code: 'USAGE_ERROR' });
});

test('CSV preserves Unicode, commas, quotes, line breaks and variable columns', () => {
  assert.equal(renderCsv({ items: [{ title: '开发,"北京"', text: '第一行\n第二行' }, { title: '测试', id: 'a' }] }),
    'title,text,id\r\n"开发,""北京""","第一行\n第二行",\r\n测试,,a\r\n');
  assert.equal(renderCsv([{ text: '=HYPERLINK("x")' }]), 'text\r\n"\'=HYPERLINK(""x"")"\r\n');
  assert.equal(renderCsv({ items: [] }), '');
});

test('sensitive browser tokens are redacted from errors and normal output', () => {
  const text = redactSensitive('failed https://alice:pass@example.com/ __zp_stoken__=secret&city=北京\nCookie: wt2=hidden; token=value\nAuthorization: Bearer abc');
  for (const secret of ['alice', 'pass@', 'secret', 'hidden', 'Bearer abc']) assert.ok(!text.includes(secret));
  const output = renderOutput({ cookies: [{ name: 'wt2', value: 'hidden' }], nested: { authorization: 'private', url: 'https://x/?access_token=secret' } }, { format: 'json' });
  for (const secret of ['hidden', 'private', 'secret']) assert.ok(!output.includes(secret));
  assert.equal(normalizeError(new BossCliError('login required', { code: 'AUTH_REQUIRED', details: { token: 'secret' } })).exitCode, 3);
  assert.equal(normalizeError(Object.assign(new Error('login required'), { code: 'AUTH_REQUIRED' })).exitCode, 3);
});

test('main passes normalized options to client and closes on success', async () => {
  const stdout = capture(); const stderr = capture(); const calls = [];
  const exit = await main(['chats', 'send', 'chat-1', '你好', '--json'], {
    stdout, stderr,
    clientFactory: (config) => ({ chats: async (args) => { calls.push({ config, args }); return { preview: true, text: args.text }; }, close: async () => { calls.push('close'); } }),
  });
  assert.equal(exit, 0);
  assert.equal(calls[0].args.execute, false);
  assert.equal(calls[0].config.profile, 'default');
  assert.equal(calls[1], 'close');
  assert.deepEqual(JSON.parse(stdout.value), { preview: true, text: '你好' });
  assert.equal(stderr.value, '');
});

test('main serializes actionable errors and closes client on failure', async () => {
  const stdout = capture(); const stderr = capture(); let closed = false;
  const exit = await main(['status', '--json'], { stdout, stderr, clientFactory: () => ({ status: async () => { throw Object.assign(new Error('need login token=secret'), { code: 'AUTH_REQUIRED' }); }, close: async () => { closed = true; } }) });
  assert.equal(exit, 3);
  assert.equal(JSON.parse(stderr.value).error.code, 'AUTH_REQUIRED');
  assert.ok(!stderr.value.includes('secret'));
  assert.equal(stdout.value, '');
  assert.equal(closed, true);
});

test('main writes valid output file without mixing status into stdout', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boss-cli-core-'));
  try {
    const target = path.join(directory, 'nested', 'jobs.json'); const stdout = capture(); const stderr = capture();
    const exit = await main(['search', '前端', '--json', '--output', target], { stdout, stderr, clientFactory: () => ({ search: async () => ({ items: [{ title: '前端开发' }] }) }) });
    assert.equal(exit, 0);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { items: [{ title: '前端开发' }] });
    assert.equal(stdout.value, '');
    assert.ok(stderr.value.includes(target));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('help and version never open a browser or instantiate a client', async () => {
  for (const args of [[], ['--help'], ['--version']]) {
    const stdout = capture();
    assert.equal(await main(args, { stdout, stderr: capture(), clientFactory: () => { throw new Error('must not be called'); } }), 0);
    assert.ok(stdout.value.length > 0);
  }
});
