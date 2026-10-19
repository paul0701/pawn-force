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

## Test locally

```
npm install
npm test                       # leaderboard logic
node test/dev-server.mjs       # http://localhost:8788 with the real leaderboard code, in memory
```

Add `#debug` to the URL to get `window.__pf` for poking at the game from the console.

## Notes

The leaderboard ranks by score. The server cannot replay a run, so it checks the numbers a run sends against what
the game can actually produce (speed range, orbs per second, score per metre and per second) and requires a signed
run token that proves enough real time passed. If you change speeds or scoring in the game, update the constants at
the top of `netlify/lib/core.mjs` to match.
