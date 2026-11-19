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

import { CREDENTIAL_TABLE, redactTokens } from "./figma-credential.js";
import { sendSafe, parseFigmaFileKey } from "./figma-credential-routes.js";
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

/** Figma's own error text from a response body, short, never containing a token. */
async function figmaWords(r) {
  try {
    const b = await r.json();
    const w = (b && (b.err || b.message || b.error)) || "";
    return redactTokens(String(w)).slice(0, 160) || null;
  } catch {
    return null;
  }
}

/**
 * Ask Figma about the token, in two questions, and report Figma's own words.
 *
 *   1. GET /v1/me: "who is this?". Needs the token's "Current user" permission.
 *   2. Only when 1 is refused and a file this token read before is known:
 *      GET /v1/files/:key?depth=1, "can it still read a design?". This is the
 *      job the token actually does for orders.
 *
 * 19 NOV: the first version asked only question 1 and, on a refusal, printed
 * its own guess ("expired, revoked or wrong") while the same token had read
 * designs the evening before. A token made without "Current user" fails 1 and
 * passes 2. Never throws; never returns the token.
 *
 * working: true  = a question succeeded (canName says which)
 *          false = both were refused, or only 1 was asked and it was refused
 *          null  = Figma did not answer
 */
export async function probeFigmaToken({ token, fileKey = null, fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS }) {
  const none = { working: null, canName: false, readsDesigns: null, status: null, handle: null, figmaSaid: null, fileStatus: null, note: null };
  if (!token) return { ...none, working: false, note: "No platform Figma token is set on the backend." };
  const ask = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { method: "GET", headers: { "X-Figma-Token": token }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  let me;
  try {
    me = await ask("https://api.figma.com/v1/me");
  } catch {
    return { ...none, note: "Figma did not answer, so the token could not be checked." };
  }
  if (me && me.ok) {
    let body = {};
    try { body = await me.json(); } catch { body = {}; }
    return { ...none, working: true, canName: true, readsDesigns: null, status: me.status, handle: typeof body.handle === "string" ? body.handle : null, note: null };
  }
  const status = me ? me.status : null;
  const figmaSaid = me ? await figmaWords(me) : null;
  if (!fileKey) {
    return {
      ...none, working: false, status, figmaSaid,
      note: "Figma answered " + status + (figmaSaid ? ' ("' + figmaSaid + '")' : "") + " to who-is-this, and no recent design was known to test a read. The token may only lack the Current user permission.",
    };
  }
  let file;
  try {
    file = await ask("https://api.figma.com/v1/files/" + encodeURIComponent(fileKey) + "?depth=1");
  } catch {
    return { ...none, working: null, status, figmaSaid, note: "Figma answered " + status + " to who-is-this and did not answer the design read." };
  }
  if (file && file.ok) {
    return {
      ...none, working: true, canName: false, readsDesigns: true, status, figmaSaid, fileStatus: file.status,
      note: "Reads designs. It cannot say whose account it is (Figma answered " + status + (figmaSaid ? ' "' + figmaSaid + '"' : "") + " to who-is-this), so it was most likely made without the Current user permission.",
    };
  }
  const fileSaid = file ? await figmaWords(file) : null;
  return {
    ...none, working: false, readsDesigns: false, status, figmaSaid, fileStatus: file ? file.status : null,
    note: "Figma refused both questions: who-is-this " + status + (figmaSaid ? ' "' + figmaSaid + '"' : "") + ", design read " + (file ? file.status : "no answer") + (fileSaid ? ' "' + fileSaid + '"' : "") + ".",
  };
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

  /** The file of the most recent order that read with Mavloper's own token. */
  async function recentFileKey() {
    try {
      const { data, error } = await supabaseAdmin
        .from("maveloper_jobs")
        .select("figma_url,progress_message,created_at")
        .eq("status", "completed")
        .ilike("progress_message", "%global Mavlers token%")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error || !data || !data[0]) return null;
      return parseFigmaFileKey(data[0].figma_url);
    } catch {
      return null;
    }
  }

  app.get("/os/platform/figma-token", requireAuth, requirePlatformOwner, async (req, res) => {
    const t = now();
    if (!cache || t - cache.at > PROBE_TTL_MS) {
      const probe = await probeFigmaToken({ token: env.FIGMA_API_TOKEN, fileKey: await recentFileKey(), fetchImpl: fetchImpl || globalThis.fetch });
      cache = { at: t, probe };
      log("info", "figma-platform-token: probed", { working: probe.working, status: probe.status });
    }
    return sendSafe(res, 200, {
      configured: Boolean(env.FIGMA_API_TOKEN),
      working: cache.probe.working,
      canName: cache.probe.canName,
      readsDesigns: cache.probe.readsDesigns,
      figmaStatus: cache.probe.status,
      figmaSaid: cache.probe.figmaSaid,
      figmaHandle: cache.probe.handle,
      note: cache.probe.note,
      checkedAt: new Date(cache.at).toISOString(),
      expiresOn: readExpiryDate(env.FIGMA_API_TOKEN_EXPIRES),
      spacesUsingIt: await spacesUsingIt(),
    }, log);
  });
}

export default { createFigmaPlatformTokenRoutes, probeFigmaToken, readExpiryDate, PROBE_TTL_MS };
