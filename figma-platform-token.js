/**
 * figma-platform-token.js - DO THE ORDERS THAT DEPEND ON MAVLOPER'S OWN FIGMA ACCOUNT WORK? (19 NOV 2026)
 * =============================================================================
 *
 * WHY THIS FILE WAS REWRITTEN THE SAME DAY IT WAS WRITTEN.
 * The first version asked Figma two questions every 15 minutes while Admin was
 * open: "who is this?" (GET /v1/me) and "can it still read a design?" (GET
 * /v1/files/:key?depth=1 on the last design an order read with this token).
 * Measured on the owner's screen, 19 NOV 20:57: the first is refused forever
 * (403 "Invalid scope": the token was made without the Current user
 * permission, which costs orders nothing), and the second was answered 429
 * "Rate limit exceeded". A design read counts against the same Figma allowance
 * the real orders draw on, so the check spent the allowance it reported on,
 * and then reported a working token as "Not working" in amber on every
 * space's Admin. The owner: "how this is actually going to be helpful".
 *
 * WHAT IT DOES NOW: NO CALL TO FIGMA AT ALL. It answers the one question the
 * owner acts on, "will the orders that depend on Mavloper's Figma account
 * work?", from what real orders already recorded:
 *
 *   using     the live spaces with no Figma account of their own that take
 *             orders (figma_required not true). Each carries:
 *               lastRead  the most recent DELIVERED order there whose job
 *                         recorded "Figma credential: global Mavlers token";
 *               refused   a FAILED order there, newer than lastRead, refused
 *                         by Figma for a reason about the ACCOUNT (too many
 *                         requests / plan limit, or the token rejected), not
 *                         about one file (a file not shared is the order's
 *                         own failure and the Queue already says so).
 *   waiting   new spaces (figma_required) with no account yet: their orders
 *             are refused until they connect one, so they never read with it.
 *   expiresOn the date the owner recorded in FIGMA_API_TOKEN_EXPIRES (Figma
 *             has no endpoint that reports a token's expiry), or null.
 *
 * Read by the platform owner only, on SuperAdmin. Space names and order ids,
 * never a token. Cached server-side for a minute; nothing polls it.
 *
 *   GET /os/platform/figma-token
 */

import { CREDENTIAL_TABLE } from "./figma-credential.js";
import { sendSafe } from "./figma-credential-routes.js";
import { OAUTH_TABLE } from "./figma-oauth.js";
import { platformOwners } from "./spaces.js";

export const CACHE_MS = 60 * 1000;
export const GLOBAL_LINE = "global Mavlers token";
const RECENT_ORDERS = 200;

/** YYYY-MM-DD, a real calendar date, or null. */
export function readExpiryDate(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/**
 * Is this failure about the ACCOUNT the design was read with, rather than about
 * one file? Returns the plain reason, or null. Keyed on the words the order
 * path writes into os_queue.error_text (order-words.js plainReason) and on the
 * raw codes, so an older wording still matches.
 */
export function accountRefusal(errorText) {
  const s = String(errorText || "");
  if (/plan limit|rate limit|too many requests|\b429\b|quota/i.test(s)) {
    return "Figma refused: too many requests on the plan that owns the file";
  }
  if (/\b401\b|invalid token|token (is |was )?(expired|revoked|invalid)/i.test(s)) {
    return "Figma rejected Mavloper's token";
  }
  return null;
}

/**
 * The per-space state, pure, so it is tested without a database.
 *   orders: finished os_queue rows of ONE space (any order), each with
 *           { order_id, status, error_text, finished_at, job_id }
 *   globalJobs: Set of job ids whose job recorded the global Mavlers token
 */
export function spaceState(orders, globalJobs) {
  const t = (r) => new Date(r.finished_at || 0).getTime() || 0;
  const rows = [...orders].sort((a, b) => t(b) - t(a));
  const read = rows.find((r) => r.status === "delivered" && r.job_id && globalJobs.has(r.job_id)) || null;
  const after = read ? t(read) : -Infinity;
  const fail = rows.find((r) => r.status === "failed" && t(r) > after && accountRefusal(r.error_text)) || null;
  return {
    lastRead: read ? { orderId: read.order_id, at: read.finished_at } : null,
    refused: fail ? { orderId: fail.order_id, at: fail.finished_at, why: accountRefusal(fail.error_text) } : null,
  };
}

export function createFigmaPlatformTokenRoutes({ app, supabaseAdmin, requireAuth, log, env = process.env, now = () => Date.now() }) {
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

  /** The live spaces with no account of their own, split by figma_required. Null when unreadable. */
  async function spacesWithoutOwnAccount() {
    let orgs = await supabaseAdmin.from("orgs").select("id,name,slug,is_deleted,figma_required");
    if (orgs.error) orgs = await supabaseAdmin.from("orgs").select("id,name,slug,is_deleted");
    if (orgs.error) return null;
    const [oauth, pasted] = await Promise.all([
      supabaseAdmin.from(OAUTH_TABLE).select("org_id,is_active"),
      supabaseAdmin.from(CREDENTIAL_TABLE).select("org_id,is_active"),
    ]);
    const own = new Set([
      ...((oauth.data || []).filter((r) => r.is_active !== false).map((r) => r.org_id)),
      ...((pasted.data || []).filter((r) => r.is_active !== false).map((r) => r.org_id)),
    ]);
    const without = (orgs.data || []).filter((o) => !o.is_deleted && !own.has(o.id));
    const nameOf = (o) => String(o.name || o.slug || "unnamed space");
    return {
      using: without.filter((o) => o.figma_required !== true).map((o) => ({ id: o.id, name: nameOf(o) })),
      waiting: without.filter((o) => o.figma_required === true).map(nameOf).sort((a, b) => a.localeCompare(b)),
    };
  }

  async function measure() {
    const w = await spacesWithoutOwnAccount();
    if (!w) return { using: null, waiting: null };
    const ids = w.using.map((s) => s.id);
    let orders = [];
    let globalJobs = new Set();
    if (ids.length) {
      const q = await supabaseAdmin
        .from("os_queue")
        .select("org_id,order_id,status,error_text,finished_at,job_id")
        .in("org_id", ids)
        .in("status", ["delivered", "failed"])
        .order("finished_at", { ascending: false })
        .limit(RECENT_ORDERS);
      orders = q.error ? [] : q.data || [];
      const jobIds = [...new Set(orders.filter((r) => r.status === "delivered" && r.job_id).map((r) => r.job_id))];
      if (jobIds.length) {
        const j = await supabaseAdmin.from("maveloper_jobs").select("id,progress_message").in("id", jobIds);
        globalJobs = new Set((j.error ? [] : j.data || []).filter((r) => String(r.progress_message || "").includes(GLOBAL_LINE)).map((r) => r.id));
      }
    }
    return {
      using: w.using
        .map((s) => ({ space: s.name, ...spaceState(orders.filter((r) => r.org_id === s.id), globalJobs) }))
        .sort((a, b) => a.space.localeCompare(b.space)),
      waiting: w.waiting,
    };
  }

  app.get("/os/platform/figma-token", requireAuth, requirePlatformOwner, async (req, res) => {
    const t = now();
    if (!cache || t - cache.at > CACHE_MS) {
      let m;
      try { m = await measure(); } catch (e) { m = { using: null, waiting: null }; log("warn", "figma-platform-token: read failed", { error: e.message }); }
      cache = { at: t, m };
    }
    return sendSafe(res, 200, {
      configured: Boolean(env.FIGMA_API_TOKEN),
      expiresOn: readExpiryDate(env.FIGMA_API_TOKEN_EXPIRES),
      using: cache.m.using,
      waiting: cache.m.waiting,
      checkedAt: new Date(cache.at).toISOString(),
    }, log);
  });
}

export default { createFigmaPlatformTokenRoutes, readExpiryDate, accountRefusal, spaceState, CACHE_MS };
