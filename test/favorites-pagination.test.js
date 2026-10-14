import test from 'node:test';
import assert from 'node:assert/strict';
import { BossClient } from '../src/boss-client.js';

test('logical favorites pages aggregate fixed fifteen-row server pages without unobserved pageSize', async () => {
  const all = Array.from({ length: 48 }, (_, n) => ({ encryptJobId: `fixture-job-${String(n).padStart(3, '0')}`, jobName: `Job ${n}`, expectId: `expect-${n}` }));
  const calls = [];
  const client = new BossClient({ session: { options: {} }, transport: { async request(route, options) {
    assert.equal(route, '/wapi/zprelation/interaction/geekGetJob');
    assert.deepEqual(Object.keys(options.query).sort(), ['isActive', 'page', 'tag']);
    calls.push(options.query.page);
    return { code: 0, zpData: { cardList: all.slice((options.query.page - 1) * 15, options.query.page * 15), totalCount: all.length } };
  } } });
  const result = await client.favorites({ page: 2, limit: 20 });
  assert.deepEqual(calls, [2, 3]);
  assert.deepEqual(result.items.map(x => x.title), all.slice(20, 40).map(x => x.jobName));
  assert.equal(result.items[0].expectId, 'expect-20');
  assert.equal(result.total, 48); assert.equal(result.hasMore, true);
  const last = await client.favorites({ page: 3, limit: 20 });
  assert.equal(last.items.length, 8); assert.equal(last.hasMore, false);
});
