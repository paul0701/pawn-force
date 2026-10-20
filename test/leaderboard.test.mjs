import assert from 'node:assert/strict';
import { handle } from '../netlify/lib/core.mjs';

function fakeStore() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v, opts = {}) {
      if (opts.onlyIfNew && m.has(k)) return { modified: false };
      m.set(k, JSON.stringify(v));
      return { modified: true };
    },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    _m: m,
  };
}

let clock = 1_800_000_000_000;
const sent = [];
const d = { players: fakeStore(), scores: fakeStore(), secret: 'test-secret', now: () => clock, sendEmail: async (m) => { sent.push(m); } };

const post = async (body) => {
  const res = await handle(new Request('https://x.test/api/leaderboard', { method: 'POST', body: JSON.stringify(body) }), d);
  return { status: res.status, data: await res.json() };
};
const get = async (q = '') => {
  const res = await handle(new Request('https://x.test/api/leaderboard' + q), d);
  return { status: res.status, data: await res.json() };
};

// An honest 60 second run: about 30 m/s, a x2 multiplier on average, 25 orbs at 10 each, plus some bonuses.
const D60 = 1800;
const honest = { dist: D60, orbs: 25, time: 60, score: D60 * 2 + 250 + 300 };

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  ', name); };

await t('start issues a token', async () => {
  const r = await post({ action: 'start' });
  assert.equal(r.status, 200);
  assert.match(r.data.token, /^\d+\.[0-9a-f]{12}\.[0-9a-f]{64}$/);
});

await t('claim rejects bad names and pins', async () => {
  assert.equal((await post({ action: 'claim', name: 'x', pin: '1234' })).status, 400);
  assert.equal((await post({ action: 'claim', name: 'Bad<script>', pin: '1234' })).status, 400);
  assert.equal((await post({ action: 'claim', name: 'Paul', pin: '12' })).status, 400);
  assert.equal((await post({ action: 'claim', name: 'Paul', pin: 'abcd' })).status, 400);
});

await t('claim creates a name, then protects it with the PIN', async () => {
  const a = await post({ action: 'claim', name: 'Paul', pin: '1234' });
  assert.equal(a.status, 200); assert.equal(a.data.created, true);
  const b = await post({ action: 'claim', name: 'paul', pin: '1234' });
  assert.equal(b.status, 200); assert.equal(b.data.created, false); assert.equal(b.data.name, 'Paul');
  const c = await post({ action: 'claim', name: 'PAUL', pin: '9999' });
  assert.equal(c.status, 403);
});

await t('PIN is never stored in plain text', async () => {
  const raw = d.players._m.get('paul');
  assert.ok(!raw.includes('1234'));
});

await t('honest run is accepted and ranked first', async () => {
  const { data: { token } } = await post({ action: 'start' });
  clock += 75_000; // wall clock passes at least as long as the run
  const r = await post({ action: 'submit', name: 'Paul', pin: '1234', token, ...honest });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.improved, true); assert.equal(r.data.rank, 1); assert.equal(r.data.best, honest.score);
});

await t('claiming run time longer than the real wall clock is rejected', async () => {
  const { data: { token } } = await post({ action: 'start' });
  clock += 10_000; // only 10s have passed
  const r = await post({ action: 'submit', name: 'Paul', pin: '1234', token, ...honest });
  assert.equal(r.status, 400);
});

await t('impossible distance, orbs and bonus are rejected', async () => {
  const mk = async (over) => {
    const { data: { token } } = await post({ action: 'start' });
    clock += 70_000;
    const body = { ...honest, ...over };
    return post({ action: 'submit', name: 'Paul', pin: '1234', token, ...body });
  };
  assert.equal((await mk({ dist: 4000, score: 9000 })).status, 400, 'too far for the time');
  assert.equal((await mk({ dist: 100, score: 600 })).status, 400, 'too slow for the time');
  assert.equal((await mk({ orbs: 5000, score: honest.score + 75000 })).status, 400, 'too many orbs');
  assert.equal((await mk({ score: 400000 })).status, 400, 'score too high for the distance');
  assert.equal((await mk({ score: 1_000_000 })).status, 400, 'rating out of range');
  assert.equal((await mk({ score: 1000 })).status, 400, 'score below what distance and orbs alone give');
  assert.equal((await mk({ time: 2 })).status, 400, 'run too short');
  assert.equal((await mk({ score: 'lots' })).status, 400, 'wrong type');
});

await t('forged and missing tokens are rejected', async () => {
  clock += 10_000;
  const { data: { token } } = await post({ action: 'start' });
  const [a, b] = token.split('.');
  clock += 70_000;
  const base = { action: 'submit', name: 'Paul', pin: '1234', ...honest, score: honest.score + 10 };
  assert.equal((await post({ ...base, token: `${a}.${b}.${'0'.repeat(64)}` })).status, 400);
  assert.equal((await post({ ...base, token: undefined })).status, 400);
  assert.equal((await post({ ...base, token: `${Number(a) - 100000}.${b}.${token.split('.')[2]}` })).status, 400);
});

await t('wrong PIN cannot submit for someone else', async () => {
  const { data: { token } } = await post({ action: 'start' });
  clock += 70_000;
  const r = await post({ action: 'submit', name: 'Paul', pin: '0000', token, ...honest });
  assert.equal(r.status, 403);
});

await t('submissions are rate limited per player', async () => {
  const { data: { token } } = await post({ action: 'start' });
  clock += 70_000;
  const ok = await post({ action: 'submit', name: 'Paul', pin: '1234', token, ...honest, score: honest.score - 50 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.improved, false);
  clock += 500;
  const again = await post({ action: 'submit', name: 'Paul', pin: '1234', token, ...honest });
  assert.equal(again.status, 429);
});

await t('a second player ranks by score, and improving replaces the old entry', async () => {
  await post({ action: 'claim', name: 'Sarah', pin: '5555' });
  const run = async (name, pin, score, time = 60) => {
    const { data: { token } } = await post({ action: 'start' });
    clock += (time + 15) * 1000;
    return post({ action: 'submit', name, pin, token, dist: D60, orbs: 20, time, score });
  };
  const low = await run('Sarah', '5555', honest.score - 100);
  assert.equal(low.data.rank, 2);
  const high = await run('Sarah', '5555', honest.score + 150);
  assert.equal(high.data.improved, true);
  assert.equal(high.data.rank, 1);
  const board = (await get()).data.entries;
  assert.deepEqual(board.map((e) => e.name), ['Sarah', 'Paul']);
  assert.equal(board.length, 2, 'old Sarah entry was removed');
  assert.equal(d.scores._m.size, 2);
});

await t('leaderboard GET honours limit and sends only public fields', async () => {
  const r = await get('?limit=1');
  assert.equal(r.data.entries.length, 1);
  assert.deepEqual(Object.keys(r.data.entries[0]).sort(), ['dist', 'name', 'orbs', 'score']);
});

await t('bad requests are handled', async () => {
  const res = await handle(new Request('https://x.test/api/leaderboard', { method: 'POST', body: 'not json' }), d);
  assert.equal(res.status, 400);
  const res2 = await handle(new Request('https://x.test/api/leaderboard', { method: 'DELETE' }), d);
  assert.equal(res2.status, 405);
  assert.equal((await post({ action: 'nope' })).status, 400);
});

await t('a short and a long honest run both verify', async () => {
  await post({ action: 'claim', name: 'Tester', pin: '7777' });
  for (const time of [8, 30, 120, 240]) {
    const dist = Math.round(22 * time);
    const score = dist * 2 + 5;
    const { data: { token } } = await post({ action: 'start' });
    clock += (time + 6) * 1000 + 5000;
    const r = await post({ action: 'submit', name: 'Tester', pin: '7777', token, dist, orbs: 0, time, score });
    assert.equal(r.status, 200, `${time}s: ${JSON.stringify(r.data)}`);
  }
});

await t('email is optional, validated, masked and never public', async () => {
  assert.equal((await post({ action: 'claim', name: 'Mailer', pin: '1111', email: 'nope' })).status, 400);
  const r = await post({ action: 'claim', name: 'Mailer', pin: '1111', email: 'Mailer.Test@Example.com' });
  assert.equal(r.status, 200); assert.match(r.data.email, /^m\*+@example\.com$/);
  assert.ok(!JSON.stringify((await get()).data).includes('example.com'));
  assert.equal((await post({ action: 'claim', name: 'Nomail', pin: '2222' })).data.email, null);
});

await t('forgot PIN emails a code, reset sets a new PIN, old PIN stops working', async () => {
  sent.length = 0; clock += 120_000;
  const f = await post({ action: 'forgot', name: 'mailer' });
  assert.equal(f.status, 200); assert.equal(sent.length, 1); assert.equal(sent[0].to, 'mailer.test@example.com');
  const code = sent[0].text.match(/is (\d{6})\./)[1];
  assert.equal((await post({ action: 'reset', name: 'Mailer', code: '000000', pin: '3333' })).status, 403);
  const ok = await post({ action: 'reset', name: 'Mailer', code, pin: '3333' });
  assert.equal(ok.status, 200);
  assert.equal((await post({ action: 'claim', name: 'Mailer', pin: '1111' })).status, 403);
  assert.equal((await post({ action: 'claim', name: 'Mailer', pin: '3333' })).status, 200);
  assert.equal((await post({ action: 'reset', name: 'Mailer', code, pin: '4444' })).status, 400, 'code cannot be reused');
});

await t('forgot gives the same answer for unknown names and names without email, and is rate limited', async () => {
  sent.length = 0; clock += 120_000;
  const a = await post({ action: 'forgot', name: 'Ghost' });
  const b = await post({ action: 'forgot', name: 'Nomail' });
  assert.deepEqual(a.data, b.data); assert.equal(sent.length, 0);
  await post({ action: 'forgot', name: 'Mailer' });
  assert.equal((await post({ action: 'forgot', name: 'Mailer' })).status, 429);
});

await t('trophies and stats sync: union of trophies, higher counters, wrong PIN refused, junk trimmed', async () => {
  await post({ action: 'claim', name: 'Trophy', pin: '5555' });
  const phone = { ach: { first_run: 1000, promo1: 2000 }, bestElo: 900, bestDist: 500, runs: 4, totalOrbs: 80, skin: 'jade', trail: 'none' };
  assert.equal((await post({ action: 'progress', name: 'Trophy', pin: '0000', progress: phone })).status, 403);
  assert.equal((await post({ action: 'progress', name: 'Nobody', pin: '5555', progress: phone })).status, 403);
  const a = await post({ action: 'progress', name: 'trophy', pin: '5555', progress: phone });
  assert.equal(a.status, 200); assert.deepEqual(Object.keys(a.data.progress.ach).sort(), ['first_run', 'promo1']);
  // a second device with different trophies and lower counters
  const laptop = { ach: { first_run: 500, gm: 3000, 'BAD ID': 5 }, bestElo: 2650, bestDist: 300, runs: 2, totalOrbs: 999999999999, skin: 'ivory', trail: 'ember' };
  const b = await post({ action: 'progress', name: 'Trophy', pin: '5555', progress: laptop });
  const g = b.data.progress;
  assert.deepEqual(Object.keys(g.ach).sort(), ['first_run', 'gm', 'promo1']);
  assert.equal(g.ach.first_run, 500, 'earliest date wins');
  assert.deepEqual([g.bestElo, g.bestDist, g.runs], [2650, 500, 4]);
  assert.equal(g.totalOrbs, 1_000_000_000, 'absurd numbers are capped');
  // signing in on a brand new device brings it all down
  const c = await post({ action: 'claim', name: 'Trophy', pin: '5555' });
  assert.deepEqual(Object.keys(c.data.progress.ach).sort(), ['first_run', 'gm', 'promo1']);
  assert.equal(c.data.progress.bestElo, 2650);
  // a name that has never synced has nothing to bring down, and garbage is trimmed to nothing
  assert.equal((await post({ action: 'claim', name: 'Fresh One', pin: '6666' })).data.progress, null);
  const z = await post({ action: 'progress', name: 'Fresh One', pin: '6666', progress: 'rubbish' });
  assert.deepEqual(z.data.progress.ach, {}); assert.equal(z.data.progress.runs, 0);
});

await t('syncing trophies never disturbs the score or the leaderboard', async () => {
  const before = JSON.stringify((await get('?limit=50')).data);
  await post({ action: 'progress', name: 'Trophy', pin: '5555', progress: { ach: { d1000: 1 } } });
  assert.equal(JSON.stringify((await get('?limit=50')).data), before);
});

console.log(`\n${passed} tests passed`);
