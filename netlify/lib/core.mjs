// Leaderboard logic for Pawn Force.
// Kept free of Netlify imports so it can be tested with in-memory stores.
//
// Stores
//   players: key = lowercase name key, value = { name, salt, hash, best, rankKey, lastAt, created }
//   scores:  key = "r/<inverted score>~<time>~<name key>", value = { name, score, dist, orbs, at }
// Each player only ever writes their own two records, so there is no cross-player write race.

const NAME_RE = /^[A-Za-z0-9 _-]{2,16}$/;
const PIN_RE = /^\d{4,8}$/;
const SCORE_BASE = 10_000_000;
const MAX_SCORE = 5_000_000;
const MIN_GAP_MS = 4000;
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_BODY = 4000;

// Plausibility limits, derived from the game's own maths (see update() in public/index.html).
// Speed eases from about 14 m/s towards 34 m/s over a run (x1.25 while promoted to Rook), the score gains
// distance x multiplier (1 to 5), orbs are worth 10 each, and bosses and tournaments pay lump sums.
// The run token proves a run of that length really took place; these bounds catch invented numbers.
// Change them only together with the constants in the game.
const MIN_RUN_SECONDS = 5;
const MIN_SPEED = 8;
const MAX_SPEED = 44;
const MAX_ORBS_PER_SEC = 8;
const MAX_SCORE_PER_SEC = 400;
const MAX_MULT = 5;
const SCORE_SLACK = 6000;

const enc = new TextEncoder();

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

const fail = (status, message) => json({ message }, status);

const nameKey = (n) => n.toLowerCase().replace(/ /g, '_');

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function sha256(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function makeToken(d) {
  const issued = d.now();
  const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const body = `${issued}.${nonce}`;
  return `${body}.${await hmac(d.secret, body)}`;
}

// Returns the issue time in ms, or null when the token is not valid.
async function readToken(d, token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [issued, nonce, sig] = parts;
  if (!safeEqual(sig, await hmac(d.secret, `${issued}.${nonce}`))) return null;
  const at = Number(issued);
  if (!Number.isFinite(at)) return null;
  const age = d.now() - at;
  if (age < 0 || age > TOKEN_TTL_MS) return null;
  return at;
}

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.trim().replace(/\s+/g, ' ');
  return NAME_RE.test(n) ? n : null;
}

async function listKeys(d) {
  const { blobs } = await d.scores.list({ prefix: 'r/' });
  return blobs.map((b) => b.key).sort();
}

async function topEntries(d, limit) {
  const keys = (await listKeys(d)).slice(0, limit);
  const rows = await Promise.all(keys.map((k) => d.scores.get(k, { type: 'json' })));
  return rows.filter(Boolean).map((r) => ({ name: r.name, score: r.score, dist: r.dist, orbs: r.orbs }));
}

async function checkPin(p, pin, nk) {
  return safeEqual(p.hash, await sha256(`${p.salt}:${pin}:${nk}`));
}

async function claim(d, body) {
  const name = cleanName(body.name);
  if (!name) return fail(400, 'Use 2 to 16 letters, numbers, spaces, - or _.');
  if (typeof body.pin !== 'string' || !PIN_RE.test(body.pin)) return fail(400, 'PIN must be 4 to 8 digits.');
  const nk = nameKey(name);

  let p = await d.players.get(nk, { type: 'json' });
  if (!p) {
    const salt = crypto.randomUUID();
    const rec = { name, salt, hash: await sha256(`${salt}:${body.pin}:${nk}`), best: null, rankKey: null, lastAt: 0, created: d.now() };
    const res = await d.players.setJSON(nk, rec, { onlyIfNew: true });
    if (res && res.modified === false) p = await d.players.get(nk, { type: 'json' });
    else return json({ ok: true, name, created: true, best: null });
  }
  if (!(await checkPin(p, body.pin, nk))) return fail(403, 'That name is taken. Enter its PIN to use it.');
  return json({ ok: true, name: p.name, created: false, best: p.best ? p.best.score : null });
}

function isInt(n) {
  return typeof n === 'number' && Number.isInteger(n);
}

async function submit(d, body) {
  const name = cleanName(body.name);
  if (!name || typeof body.pin !== 'string' || !PIN_RE.test(body.pin)) return fail(400, 'Set your name and PIN first.');
  const nk = nameKey(name);
  const p = await d.players.get(nk, { type: 'json' });
  if (!p) return fail(403, 'Unknown name. Set your name first.');
  if (!(await checkPin(p, body.pin, nk))) return fail(403, 'Wrong PIN for that name.');

  const now = d.now();
  if (now - (p.lastAt || 0) < MIN_GAP_MS) return fail(429, 'Slow down a moment, then try again.');

  const { score, dist, orbs, time } = body;
  if (!isInt(score) || !isInt(dist) || !isInt(orbs) || typeof time !== 'number' || !Number.isFinite(time)) {
    return fail(400, 'That score did not look right.');
  }

  const issued = await readToken(d, body.token);
  if (issued === null) return fail(400, 'That run could not be verified. Play another one.');
  const elapsed = (now - issued) / 1000;

  const plausible =
    score > 0 && score <= MAX_SCORE &&
    dist >= 0 && orbs >= 0 &&
    time >= MIN_RUN_SECONDS && time <= elapsed + 2 &&
    dist >= MIN_SPEED * time - 30 && dist <= MAX_SPEED * time + 30 &&
    orbs <= MAX_ORBS_PER_SEC * time + 30 &&
    score >= dist + 10 * orbs - 5 &&
    score <= MAX_MULT * dist + MAX_SCORE_PER_SEC * time + SCORE_SLACK;
  if (!plausible) return fail(400, 'That run could not be verified.');

  const prevBest = p.best ? p.best.score : 0;
  const improved = score > prevBest;
  let rankKey = p.rankKey;
  let best = p.best;

  if (improved) {
    const inv = String(SCORE_BASE - score).padStart(8, '0');
    const at = String(now).padStart(13, '0');
    const newKey = `r/${inv}~${at}~${nk}`;
    best = { score, dist, orbs, at: now };
    await d.scores.setJSON(newKey, { name: p.name, score, dist, orbs, at: now });
    if (p.rankKey && p.rankKey !== newKey) await d.scores.delete(p.rankKey);
    rankKey = newKey;
  }
  await d.players.setJSON(nk, { ...p, best, rankKey, lastAt: now });

  const rank = rankKey ? (await listKeys(d)).indexOf(rankKey) + 1 : 0;
  return json({ ok: true, improved, best: best ? best.score : score, rank });
}

export async function handle(req, d) {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '25', 10) || 25));
      return json({ entries: await topEntries(d, limit) }, 200, { 'cache-control': 'public, max-age=10' });
    }
    if (req.method !== 'POST') return fail(405, 'Method not allowed.');

    const text = await req.text();
    if (text.length > MAX_BODY) return fail(413, 'Request too large.');
    let body;
    try { body = JSON.parse(text); } catch { return fail(400, 'Bad request.'); }
    if (!body || typeof body !== 'object') return fail(400, 'Bad request.');

    switch (body.action) {
      case 'start': return json({ token: await makeToken(d) });
      case 'claim': return await claim(d, body);
      case 'submit': return await submit(d, body);
      default: return fail(400, 'Unknown action.');
    }
  } catch (err) {
    console.error('leaderboard error', err);
    return fail(500, 'The ledger hiccuped. Try again.');
  }
}
