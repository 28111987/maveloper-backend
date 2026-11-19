/**
 * figma-platform-token.js - IS MAVLOPER'S OWN FIGMA TOKEN WORKING, MEASURED (19 NOV 2026).
 * =============================================================================
 *
 * WHY. The console's Engine panel printed "mavlers figma token EXPIRED 16 days
 * ago" from a date written in the console's code (osAdmin.ts
 * FIGMA_TOKEN_EXPIRY_ISO '2026-11-04'), which belonged to a token revoked on
 * 19 OCT. The live token was never re-dated, so the panel reported an outage
 * that did not exist, beside a space that reads with its own account anyway.
 * A date written in code is a count written down twice.
 *
 * WHAT IT DOES NOW. The backend, which holds the token, ASKS FIGMA: one
 * GET /v1/me with the token, answered from a cache for 15 minutes. The answer
 * is a fact with a time on it ("working, checked 3 min ago"). Figma has no
 * endpoint that reports a token's expiry, so the expiry is the date the owner
 * records in FIGMA_API_TOKEN_EXPIRES (YYYY-MM-DD, read off Figma's own token
 * screen). Absent, the console says "expiry not recorded" rather than guess.
 *
 * It also counts the live spaces that would read with this token today (no
 * space account of their own), so "does it matter if it lapses" has a number.
 *
 *   GET /os/platform/figma-token     platform owner only. Never the token.
 */

import { sendSafe } from "./figma-credential-routes.js";
import { CREDENTIAL_TABLE } from "./figma-credential.js";
import { OAUTH_TABLE } from "./figma-oauth.js";
import { platformOwners } from "./spaces.js";

export const PROBE_TTL_MS = 15 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 5000;

/** YYYY-MM-DD, a real calendar date, or null. */
export function readExpiryDate(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/** Ask Figma whether the token authenticates. Never throws; never returns the token. */
export async function probeFigmaToken({ token, fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS }) {
  if (!token) return { working: false, status: null, handle: null, note: "No platform Figma token is set on the backend." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl("https://api.figma.com/v1/me", { method: "GET", headers: { "X-Figma-Token": token }, signal: controller.signal });
    if (r && r.ok) {
      let me = {};
      try { me = await r.json(); } catch { me = {}; }
      return { working: true, status: r.status, handle: typeof me.handle === "string" ? me.handle : null, note: null };
    }
    const status = r ? r.status : null;
    return {
      working: false,
      status,
      handle: null,
      note: status === 401 || status === 403 ? "Figma refused the token: it is expired, revoked or wrong." : "Figma answered " + status + ".",
    };
  } catch {
    return { working: null, status: null, handle: null, note: "Figma did not answer, so the token could not be checked." };
  } finally {
    clearTimeout(timer);
  }
}

export function createFigmaPlatformTokenRoutes({ app, supabaseAdmin, requireAuth, log, env = process.env, fetchImpl = null, now = () => Date.now() }) {
  let cache = null;

  async function requirePlatformOwner(req, res, next) {
    const email = String(req.user?.email || "").toLowerCase().trim();
    if (!email) return sendSafe(res, 403, { error: "Not permitted" }, log);
    if (platformOwners(env).includes(email)) return next();
    try {
      const { data, error } = await supabaseAdmin.from("platform_owners").select("email").eq("email", email).limit(1);
      if (!error && Array.isArray(data) && data.length > 0) return next();
    } catch { /* deny below */ }
    return sendSafe(res, 403, { error: "Only the platform owner can read this" }, log);
  }

  async function spacesUsingIt() {
    try {
      const [orgs, oauth, pasted] = await Promise.all([
        supabaseAdmin.from("orgs").select("id,is_deleted"),
        supabaseAdmin.from(OAUTH_TABLE).select("org_id,is_active"),
        supabaseAdmin.from(CREDENTIAL_TABLE).select("org_id,is_active"),
      ]);
      if (orgs.error) return null;
      const own = new Set([
        ...((oauth.data || []).filter((r) => r.is_active !== false).map((r) => r.org_id)),
        ...((pasted.data || []).filter((r) => r.is_active !== false).map((r) => r.org_id)),
      ]);
      return (orgs.data || []).filter((o) => !o.is_deleted && !own.has(o.id)).length;
    } catch {
      return null;
    }
  }

  app.get("/os/platform/figma-token", requireAuth, requirePlatformOwner, async (req, res) => {
    const t = now();
    if (!cache || t - cache.at > PROBE_TTL_MS) {
      const probe = await probeFigmaToken({ token: env.FIGMA_API_TOKEN, fetchImpl: fetchImpl || globalThis.fetch });
      cache = { at: t, probe };
      log("info", "figma-platform-token: probed", { working: probe.working, status: probe.status });
    }
    return sendSafe(res, 200, {
      configured: Boolean(env.FIGMA_API_TOKEN),
      working: cache.probe.working,
      figmaHandle: cache.probe.handle,
      note: cache.probe.note,
      checkedAt: new Date(cache.at).toISOString(),
      expiresOn: readExpiryDate(env.FIGMA_API_TOKEN_EXPIRES),
      spacesUsingIt: await spacesUsingIt(),
    }, log);
  });
}

export default { createFigmaPlatformTokenRoutes, probeFigmaToken, readExpiryDate, PROBE_TTL_MS };
