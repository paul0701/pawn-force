# Pawn Force

Endless chess runner PWA with a Netlify Blobs name and PIN leaderboard.

```
public/                 the game (index.html), manifest, service worker, icons
netlify/functions/      leaderboard.mts, the /api/leaderboard endpoint
netlify/lib/core.mjs    leaderboard logic (validation, ranking, plausibility checks)
test/                   unit tests and a local dev server
netlify.toml            publishes public/, functions from netlify/functions
```

## Deploy

1. Push this folder to a GitHub repo (leave node_modules out; .gitignore covers it).
2. In Netlify choose Add new project, Import from Git, pick the repo. Leave the build command empty. The publish
   directory and functions folder come from `netlify.toml`.
3. Site configuration, Environment variables, add `LEADERBOARD_SECRET` with any long random string (it signs run
   tokens), then redeploy once.

Dragging only the `public` folder into Netlify deploys the game but not the leaderboard function.

## PIN recovery by email (Resend)

Players can add an optional email when they pick a name and PIN. If they forget the PIN, "Forgot PIN?" emails them a
six digit code that sets a new one, so nobody loses their name or their best score. It needs two more environment
variables in Netlify (the same Resend key you use for your other games is fine):

* `RESEND_API_KEY`: your Resend API key.
* `RESEND_FROM`: the sender, on a domain you have verified in Resend, for example `Pawn Force <noreply@yourdomain.com>`.

Without them the game and leaderboard still work and "Forgot PIN?" simply says recovery is not switched on yet.

Emails are stored against the player record only and never returned by the leaderboard. The answer to "Forgot PIN?" is
the same whether or not a name exists or has an email. Codes are stored hashed, last 15 minutes, die after five wrong
guesses and cannot be reused, and a name can be sent at most one code a minute and five a day. Only the right PIN can
add or change the email on a name.

## Test locally

```
npm install
npm test                       # leaderboard logic
node test/dev-server.mjs       # http://localhost:8788 with the real leaderboard code, in memory
                               # reset emails are printed in the terminal instead of sent
```

Add `#debug` to the URL to get `window.__pf` for poking at the game from the console.

## Notes

The leaderboard ranks by score. The server cannot replay a run, so it checks the numbers a run sends against what
the game can actually produce (speed range, orbs per second, score per metre and per second) and requires a signed
run token that proves enough real time passed. If you change speeds or scoring in the game, update the constants at
the top of `netlify/lib/core.mjs` to match.

## Trophies and stats

Trophies, skins, trails and stats sync to the name and PIN (stored under a separate key in the pf-players store, so they can never interfere with scores). Signing in on a new device or address brings them down, and each finished run sends new ones up. Trophies join together across devices, counters keep the higher figure, and the skin and trail you chose most recently on any device is the one every device uses.
