import test from 'node:test';
import assert from 'node:assert/strict';
import { BossClient } from '../src/boss-client.js';
import { BossCliError } from '../src/errors.js';

function fixture(state, respond) {
  const requests = [];
  const client = new BossClient({ session: { options: { profile: 'status-test' }, pageState: async () => ({ ...state }) }, transport: { request: async (route, options) => { requests.push({ route, options }); return respond(); } } });
  return { client, requests };
}

test('status does not request private API data without a connected browser or with a known DOM state', async () => {
  for (const state of [{ connected: false, authenticated: null }, { connected: false, authenticated: false }, { connected: true, authenticated: false }, { connected: true, authenticated: true }]) {
    const { client, requests } = fixture(state, () => { throw new Error('No API probe needed'); });
    assert.deepEqual(await client.status(), state);
    assert.equal(requests.length, 0);
  }
});

test('unknown DOM authentication is confirmed only by successful authenticated friend-list data', async () => {
  const state = { connected: true, authenticated: null, profile: 'status-test', instruction: 'DOM identity unavailable' };
  const { client, requests } = fixture(state, () => ({ code: 0, zpData: { friendList: [] } }));
  const result = await client.status();
  assert.equal(result.authenticated, true);
  assert.equal(result.authenticationSource, 'authenticated-api');
  assert.equal(Object.hasOwn(result, 'instruction'), false);
  assert.deepEqual(requests, [{ route: '/wapi/zprelation/friend/geekFilterByLabel', options: { query: { labelId: 0 } } }]);
  const malformed = fixture(state, () => ({ code: 0, zpData: {} }));
  assert.equal((await malformed.client.status()).authenticated, null);
});

test('an explicit authentication error makes status false while network uncertainty stays null', async () => {
  const state = { connected: true, authenticated: null, verificationRequired: false };
  const auth = fixture(state, () => { throw new BossCliError('请登录', { code: 'AUTH_REQUIRED' }); });
  const authState = await auth.client.status();
  assert.equal(authState.authenticated, false);
  assert.equal(authState.authenticationSource, 'authenticated-api');
  const network = fixture(state, () => { throw new BossCliError('Network unavailable', { code: 'NETWORK_ERROR' }); });
  const uncertain = await network.client.status();
  assert.equal(uncertain.authenticated, null);
  assert.equal(uncertain.authenticationCheck, 'NETWORK_ERROR');
});

test('a verification challenge during the authentication probe is retained in status', async () => {
  const { client } = fixture({ connected: true, authenticated: null, verificationRequired: false }, () => { throw new BossCliError('安全验证', { code: 'VERIFICATION_REQUIRED' }); });
  const result = await client.status();
  assert.equal(result.authenticated, null);
  assert.equal(result.verificationRequired, true);
  assert.equal(result.authenticationCheck, 'VERIFICATION_REQUIRED');
});

test('a navigating page can use authenticated API state without reading private page text again', async () => {
  let probes = 0;
  const session = {
    options: { profile: 'status-test' },
    browser: { isConnected: () => true }, context: {},
    pageState: async () => { throw new BossCliError('page navigated', { code: 'BROWSER_STATE_UNAVAILABLE', exitCode: 4 }); },
    login: async () => { throw new BossCliError('page navigated', { code: 'BROWSER_STATE_UNAVAILABLE', exitCode: 4 }); },
  };
  const client = new BossClient({ session, transport: { request: async () => { probes++; return { code: 0, zpData: { friendList: [] } }; } } });
  const status = await client.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.domState, 'unavailable');
  assert.equal(probes, 1);
  const login = await client.login();
  assert.equal(login.authenticated, true);
  assert.equal(login.browserOpened, true);
  assert.equal(probes, 2);
});

test('page state failures cannot imply an authenticated or connected browser without an actual connection', async () => {
  const cause = new BossCliError('page navigated', { code: 'BROWSER_STATE_UNAVAILABLE', exitCode: 4 });
  let probes = 0;
  const client = new BossClient({ session: { options: {}, browser: { isConnected: () => false }, context: {}, pageState: async () => { throw cause; } }, transport: { request: async () => { probes++; } } });
  await assert.rejects(() => client.status(), error => error === cause);
  assert.equal(probes, 0);
});
