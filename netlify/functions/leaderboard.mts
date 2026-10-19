import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { handle } from "../lib/core.mjs";

export default async (req: Request, context: Context) => {
  // Strong consistency so a score is visible in the next leaderboard read.
  const players = getStore({ name: "pf-players", consistency: "strong" });
  const scores = getStore({ name: "pf-scores", consistency: "strong" });
  const secret = Netlify.env.get("LEADERBOARD_SECRET") ?? `fallback-${context.site.id}`;
  return handle(req, { players, scores, secret, now: () => Date.now() });
};

export const config: Config = {
  path: "/api/leaderboard",
  rateLimit: {
    action: "rate_limit",
    aggregateBy: ["ip", "domain"],
    windowSize: 60,
    windowLimit: 60,
  },
};
