/* Agnostic Solutions: season guard (drop-in, no changes to the game's own code).
   Makes a score wipe reach browsers and makes scores follow the account between devices.

     <script src="/season-guard.js" data-game="pawn-force" data-best-key="pawnforce_best"
             data-clear-keys="pawnforce_best" data-clear-prefixes="x_"></script>

   Put it first in <head>, before any script that uses fetch. It does three things:

   1. Season check. Asks the accounts service which season scores are in. When it has changed
      since this device last looked (a wipe), the saved scores listed in data-clear-keys (and
      any key starting with a data-clear-prefixes entry) are removed and the page reloads once.
   2. Season on every save. Adds the season to every POST /api/sync, so scores from a device that
      has not reset yet are refused by the service instead of bringing wiped scores back.
   3. Carry-over. When the service sends back the account's games (sign-in, register, reset,
      PIN change, /api/me) and the account's best is higher than the one saved on this device,
      it is written to data-best-key and the page reloads once so the game shows it.

   Offline, or if the service cannot be reached, nothing changes. */
(function () {
  'use strict';
  var me = document.currentScript, d = (me && me.dataset) || {};
  var GAME = d.game || '', BEST = d.bestKey || '';
  var CENTRAL = (d.central || 'https://agnostic.accounts.agnosticsolutions.co.uk').replace(/\/$/, '');
  var KEYS = (d.clearKeys || BEST).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var PREFIXES = (d.clearPrefixes || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var SEASONK = 'as.season', t0 = Date.now(), seasonVal = 1;
  var orig = window.fetch ? window.fetch.bind(window) : null;
  if (!orig || !GAME) return;

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function reloadSoon(tag, delay) {
    try {
      var k = 'as.reloaded.' + tag, last = Number(sessionStorage.getItem(k)) || 0;
      if (Date.now() - last < 30000) return;
      sessionStorage.setItem(k, String(Date.now()));
    } catch (e) {}
    setTimeout(function () { location.reload(); }, delay || 0);
  }
  function wipeLocal() {
    var any = false;
    KEYS.forEach(function (k) { if (ls(k) !== null) { any = true; ls(k, null); } });
    if (PREFIXES.length) {
      try {
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          if (k && PREFIXES.some(function (p) { return k.indexOf(p) === 0; })) { localStorage.removeItem(k); any = true; }
        }
      } catch (e) {}
    }
    return any;
  }
  // true: carry on. false: this device was just reset and the page is reloading.
  function checkSeason() {
    return orig(CENTRAL + '/api/season', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
      var cur = Number(s && s.season) || 1, had = Number(ls(SEASONK)) || 1;   // scores from before seasons existed are season 1
      seasonVal = cur; ls(SEASONK, String(cur));
      if (had !== cur && wipeLocal()) { reloadSoon('season', 0); return false; }
      return true;
    }).catch(function () { seasonVal = Number(ls(SEASONK)) || 1; return true; });
  }
  var gate = checkSeason();

  function pull(j, viaLogin) {
    if (!BEST || !j || !j.games) return;
    var g = j.games[GAME], sb = Math.floor(Number(g && g.best) || 0);
    if (sb <= 0) return;
    var lb = parseInt(ls(BEST) || '0', 10) || 0;
    if (sb <= lb) return;
    ls(BEST, String(sb));
    if ((parseInt(ls(BEST) || '0', 10) || 0) !== sb) return;               // storage not writable: do not loop
    // Reload so the game reads it before it can overwrite it. Only early in the visit or straight
    // after a sign-in, so a run that is under way is not thrown away by a background refresh.
    if (viaLogin || Date.now() - t0 < 20000) reloadSoon('pull', 500);
  }

  function pathOf(input) {
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    return u.indexOf(CENTRAL) === 0 ? u.slice(CENTRAL.length).split('?')[0] : null;
  }
  window.fetch = function (input, init) {
    var path = pathOf(input), args = arguments, self = this;
    if (path === null) return orig.apply(self, args);
    if (path === '/api/sync' && init && typeof init.body === 'string') {
      return gate.then(function (ok) {
        if (!ok) return new Promise(function () {});                       // page is reloading; drop the save
        var body; try { body = JSON.parse(init.body); } catch (e) { return orig.apply(self, args); }
        if (body && typeof body === 'object') body.season = seasonVal;
        var init2 = {}; for (var k in init) init2[k] = init[k]; init2.body = JSON.stringify(body);
        return orig(input, init2).then(function (r) { if (r.status === 409) gate = checkSeason(); return r; });
      });
    }
    var login = /^\/api\/auth\/(login|register|reset|change-pin)$/.test(path);
    if (login || path === '/api/me') {
      return orig.apply(self, args).then(function (r) {
        if (r && r.ok) { try { r.clone().json().then(function (j) { pull(j, login); }).catch(function () {}); } catch (e) {} }
        return r;
      });
    }
    return orig.apply(self, args);
  };
  window.SeasonGuard = { season: function () { return seasonVal; }, check: function () { gate = checkSeason(); return gate; } };
})();
