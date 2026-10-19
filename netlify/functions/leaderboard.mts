import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { handle } from "../lib/core.mjs";

export default async (req: Request, context: Context) => {
  // Strong consistency so a score is visible in the next leaderboard read.
  const players = getStore({ name: "pf-players", consistency: "strong" });
  const scores = getStore({ name: "pf-scores", consistency: "strong" });
  const secret = Netlify.env.get("LEADERBOARD_SECRET") ?? `fallback-${context.site.id}`;
  // PIN recovery emails go through Resend. Without RESEND_API_KEY and RESEND_FROM set, recovery is simply switched off.
  const resendKey = Netlify.env.get("RESEND_API_KEY");
  const from = Netlify.env.get("RESEND_FROM");
  const sendEmail = resendKey && from ? async (msg: { to: string; subject: string; text: string; html: string }) => {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  } : undefined;
  return handle(req, { players, scores, secret, now: () => Date.now(), sendEmail });
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
