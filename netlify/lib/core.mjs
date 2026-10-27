// Leaderboard logic for Pawn Force.
// Kept free of Netlify imports so it can be tested with in-memory stores.
//
// Stores
//   players: key = lowercase name key, value = { name, salt, hash, best, rankKey, lastAt, created }
//   scores:  key = "r/<inverted score>~<time>~<name key>", value = { name, score, dist, orbs, at }
// Each player only ever writes their own two records, so there is no cross-player write race.

const NAME_RE = /^[A-Za-z0-9 _-]{2,16}$/;
const PIN_RE = /^\d{6}$/;
const SCORE_BASE = 10_000_000;
const MAX_SCORE = 5_000_000;
const MIN_GAP_MS = 4000;
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_BODY = 4000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const CODE_TTL_MS = 15 * 60 * 1000;     // a reset code works for 15 minutes
const CODE_GAP_MS = 60 * 1000;          // one email a minute per name
const CODE_DAY_MAX = 5;                 // and five a day
const CODE_TRIES = 5;                   // five wrong guesses kills the code


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

function cleanEmail(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e === '') return '';
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

// p***@gmail.com, so the owner can see which address is saved without it being readable over a shoulder
function maskEmail(e) {
  if (!e) return null;
  const [u, dom] = e.split('@');
  return `${u[0]}${'*'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${dom}`;
}

// ---- trophies and stats, kept under their own key so a score submit can never overwrite them ----
const PROG_ID_RE = /^[a-z0-9_]{1,40}$/;
const progKey = (nk) => `~p/${nk}`;
const clampInt = (v, max) => Math.max(0, Math.min(Math.floor(Number(v)) || 0, max));
const idOr = (v, fallback) => (typeof v === 'string' && PROG_ID_RE.test(v) ? v : fallback);

// Anything the browser sends is trimmed to a known shape: trophy ids, bounded numbers, cosmetic names.
function cleanProgress(raw) {
  const out = { ach: {}, bestElo: 0, bestDist: 0, runs: 0, totalOrbs: 0, skin: 'ivory', trail: 'none', lookAt: 0 };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.ach && typeof raw.ach === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(raw.ach)) {
      if (n >= 60) break;
      if (!PROG_ID_RE.test(k)) continue;
      out.ach[k] = clampInt(v, 4_102_444_800_000) || 1; n++;
    }
  }
  out.bestElo = clampInt(raw.bestElo, 100_000); out.bestDist = clampInt(raw.bestDist, 10_000_000);
  out.runs = clampInt(raw.runs, 10_000_000); out.totalOrbs = clampInt(raw.totalOrbs, 1_000_000_000);
  out.skin = idOr(raw.skin, 'ivory'); out.trail = idOr(raw.trail, 'none'); out.lookAt = clampInt(raw.lookAt, 4_102_444_800_000);
  return out;
}

// Trophies are a union (earliest date wins), the counters keep the higher figure, and the cosmetic pick follows whichever device chose last.
function mergeProgress(old, inc) {
  const a = cleanProgress(old), b = cleanProgress(inc);
  const ach = { ...a.ach };
  for (const [k, v] of Object.entries(b.ach)) ach[k] = ach[k] ? Math.min(ach[k], v) : v;
  return {
    ach, bestElo: Math.max(a.bestElo, b.bestElo), bestDist: Math.max(a.bestDist, b.bestDist),
    runs: Math.max(a.runs, b.runs), totalOrbs: Math.max(a.totalOrbs, b.totalOrbs),
    ...lookWins(a, b),
  };
}

// The look (skin and trail) that was chosen most recently wins. Two untouched defaults never wipe a real choice.
function lookWins(a, b) {
  const isDefault = (x) => x.skin === 'ivory' && x.trail === 'none';
  const pick = b.lookAt > a.lookAt || (b.lookAt === a.lookAt && !(isDefault(b) && !isDefault(a))) ? b : a;
  return { skin: pick.skin, trail: pick.trail, lookAt: pick.lookAt };
}

async function readProgress(d, nk) { return (await d.players.get(progKey(nk), { type: 'json' })) || null; }

async function progress(d, body) {
  const name = cleanName(body.name);
  if (!name) return fail(400, 'Enter the name you play under.');
  if (typeof body.pin !== 'string' || !PIN_RE.test(body.pin)) return fail(400, 'PIN must be 6 digits.');
  const nk = nameKey(name);
  const p = await d.players.get(nk, { type: 'json' });
  if (!p) return fail(403, 'Unknown name. Set your name first.');
  if (!(await checkPin(p, body.pin, nk))) return fail(403, 'Wrong PIN for that name.');
  const merged = mergeProgress(await readProgress(d, nk), body.progress);
  await d.players.setJSON(progKey(nk), merged);
  return json({ ok: true, progress: merged });
}

async function checkPin(p, pin, nk) {
  return safeEqual(p.hash, await sha256(`${p.salt}:${pin}:${nk}`));
}

async function claim(d, body) {
  const name = cleanName(body.name);
  if (!name) return fail(400, 'Use 2 to 16 letters, numbers, spaces, - or _.');
  if (typeof body.pin !== 'string' || !PIN_RE.test(body.pin)) return fail(400, 'PIN must be 6 digits.');
  const email = cleanEmail(body.email);
  if (email === null) return fail(400, 'That email address does not look right.');
  const nk = nameKey(name);

  let p = await d.players.get(nk, { type: 'json' });
  if (!p) {
    const salt = crypto.randomUUID();
    const rec = { name, salt, hash: await sha256(`${salt}:${body.pin}:${nk}`), best: null, rankKey: null, lastAt: 0, created: d.now(), email: email || null };
    const res = await d.players.setJSON(nk, rec, { onlyIfNew: true });
    if (res && res.modified === false) p = await d.players.get(nk, { type: 'json' });
    else return json({ ok: true, name, created: true, best: null, email: maskEmail(rec.email), progress: null });
  }
  if (!(await checkPin(p, body.pin, nk))) return fail(403, 'That name is taken. Enter its PIN to use it, or tap Forgot PIN.');
  // the right PIN can add or change the recovery email (leaving the box empty keeps the one already saved)
  if (email && email !== p.email) { p = { ...p, email }; await d.players.setJSON(nk, p); }
  return json({ ok: true, name: p.name, created: false, best: p.best ? p.best.score : null, email: maskEmail(p.email), progress: await readProgress(d, nk) });
}

// Forgot PIN: email a six digit code to the address saved against the name.
// The answer is the same whether or not the name exists or has an email, so nobody can use this to find out.
async function forgot(d, body) {
  const name = cleanName(body.name);
  if (!name) return fail(400, 'Enter the name you play under.');
  if (!d.sendEmail) return fail(503, 'PIN recovery is not switched on yet.');
  const generic = json({ ok: true, message: 'If that name has an email saved, a code is on its way. Check your inbox (and spam).' });
  const nk = nameKey(name);
  const p = await d.players.get(nk, { type: 'json' });
  if (!p || !p.email) return generic;
  const now = d.now(), r = p.reset || {};
  const day = Math.floor(now / 86_400_000);
  const sentToday = r.day === day ? r.sentToday || 0 : 0;
  if (now - (r.sentAt || 0) < CODE_GAP_MS) return fail(429, 'A code was just sent. Wait a minute before asking for another.');
  if (sentToday >= CODE_DAY_MAX) return fail(429, 'Too many codes today. Try again tomorrow.');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const reset = { hash: await hmac(d.secret, `reset:${nk}:${code}`), exp: now + CODE_TTL_MS, tries: 0, sentAt: now, day, sentToday: sentToday + 1 };
  await d.players.setJSON(nk, { ...p, reset });
  try {
    await d.sendEmail({
      to: p.email,
      subject: 'Your Pawn Force PIN reset code',
      text: `Your code to reset the PIN for ${p.name} is ${code}.\n\nIt works for 15 minutes. If you did not ask for this, you can ignore this email and nothing will change.`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#111"><p>Your code to reset the PIN for <b>${p.name}</b> is:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p><p>It works for 15 minutes. If you did not ask for this, you can ignore this email and nothing will change.</p><p style="color:#666;font-size:13px">Pawn Force</p></div>`,
    });
  } catch (err) {
    console.error('reset email failed', err);
    await d.players.setJSON(nk, { ...p, reset: { ...reset, hash: null } });
    return fail(502, 'The email could not be sent. Try again in a minute.');
  }
  return generic;
}

async function resetPin(d, body) {
  const name = cleanName(body.name);
  if (!name) return fail(400, 'Enter the name you play under.');
  if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code.trim())) return fail(400, 'The code is the six digits in the email.');
  if (typeof body.pin !== 'string' || !PIN_RE.test(body.pin)) return fail(400, 'New PIN must be 6 digits.');
  const nk = nameKey(name);
  const p = await d.players.get(nk, { type: 'json' });
  const r = p && p.reset;
  if (!r || !r.hash || d.now() > r.exp || r.tries >= CODE_TRIES) return fail(400, 'That code has expired. Ask for a new one.');
  if (!safeEqual(r.hash, await hmac(d.secret, `reset:${nk}:${body.code.trim()}`))) {
    await d.players.setJSON(nk, { ...p, reset: { ...r, tries: r.tries + 1 } });
    return fail(403, r.tries + 1 >= CODE_TRIES ? 'Too many wrong codes. Ask for a new one.' : 'That code is not right. Check the email and try again.');
  }
  const salt = crypto.randomUUID();
  await d.players.setJSON(nk, { ...p, salt, hash: await sha256(`${salt}:${body.pin}:${nk}`), reset: { sentAt: r.sentAt, day: r.day, sentToday: r.sentToday } });
  return json({ ok: true, name: p.name, best: p.best ? p.best.score : null, email: maskEmail(p.email), progress: await readProgress(d, nk) });
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
      case 'forgot': return await forgot(d, body);
      case 'reset': return await resetPin(d, body);
      case 'submit': return await submit(d, body);
      case 'progress': return await progress(d, body);
      default: return fail(400, 'Unknown action.');
    }
  } catch (err) {
    console.error('leaderboard error', err);
    return fail(500, 'The ledger hiccuped. Try again.');
  }
}
