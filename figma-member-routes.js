/**
 * figma-member-routes.js - EACH PERSON'S OWN FIGMA ACCOUNT, PER SPACE (19 NOV 2026).
 * =============================================================================
 *
 * WHAT THE OWNER ASKED FOR. In one space, six developers may read Figma through
 * the space's account (for example email@mavlers.com) while four others read
 * through their own clients' accounts. So a connection now exists at two levels:
 *
 *   the SPACE's   org_figma_oauth / org_figma_credentials   (unchanged, admin-only)
 *   a PERSON's    member_figma_oauth, keyed (org_id, user_id) (this file)
 *
 * An order reads with the orderer's own connection in that space when they made
 * one, and with the space's otherwise (server.js, /generate-from-figma). The
 * same Figma account may be connected separately in each space a person sits in.
 *
 * ROUTES
 *   GET    /os/spaces/:slug/me/figma                 what MY orders read with      any seat in the space
 *   GET    /os/spaces/:slug/me/figma-oauth/start     mint state, authorize URL     any seat in the space
 *   POST   /os/spaces/:slug/me/figma-oauth/callback  exchange, seal, store         any seat in the space
 *   DELETE /os/spaces/:slug/me/figma-oauth           disconnect mine               any seat in the space
 *   POST   /os/spaces/:slug/me/figma-check           can my order open this file?  any seat in the space (20 NOV)
 *   GET    /os/spaces/:slug/figma-accounts           every member's account        space admin or platform owner
 *   DELETE /os/spaces/:slug/figma-accounts/:userId   remove a member's own one     space admin or platform owner
 *
 * THE SAFETY STRUCTURE IS figma-oauth-routes.js's, REUSED, NOT REBUILT: every
 * response goes through the same sendSafe leak gate, every SELECT names its
 * columns and never a token column, both tokens are sealed before the INSERT,
 * and a minted state is single-use, short-lived, bound to ONE space AND ONE
 * person. A disconnect DELETES the row: a person's connection has no audit
 * value worth keeping a sealed secret for.
 *
 * ★ A PERSON CAN ONLY EVER TOUCH THEIR OWN ROW through the /me routes: the row
 * key is req.user.id, never a value from the request. Only an Admin of the space
 * (or the platform owner) may remove somebody else's, and nobody can read one.
 */

import crypto from "node:crypto";
import { sendSafe, parseFigmaFileKey } from "./figma-credential-routes.js";
import { readKey, sealToken, KEY_ENV } from "./figma-credential-crypto.js";
import { CREDENTIAL_TABLE, resolveFigmaToken } from "./figma-credential.js";
import {
  buildAuthorizeUrl, exchangeCode, fetchFigmaIdentity, OAUTH_TABLE, MEMBER_OAUTH_TABLE, DEFAULT_SCOPES, normalisedUserId,
  resolveFigmaOAuth, resolveMemberFigmaOAuth, shapeOAuthResolution,
} from "./figma-oauth.js";
import { platformOwners } from "./spaces.js";
import { checkFileAccess, decideFigmaAccess, CHECK_CACHE_MS } from "./figma-access-check.js";
import { NO_SPACE_FIGMA, NO_FIGMA_ACCOUNT } from "./order-words.js";

/** Every column any response may be built from. NO token column. */
export const MEMBER_PUBLIC_COLUMNS =
  "org_id,user_id,email,expires_at,figma_user_id,figma_email,figma_handle,is_active,connected_at,updated_at,last_refresh_at,last_refresh_ok,last_refresh_note";

const PG_UNDEFINED_TABLE = "42P01";

/** Same lifetime as the space connection's state: long enough to approve a consent screen. */
export const MEMBER_STATE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// SHARED FACTS, ALSO READ BY THE ORDER PATH.
// ---------------------------------------------------------------------------

/**
 * Must this space connect its own Figma account before it takes orders?
 * orgs.figma_required, set on spaces created from 19 NOV. A missing column, a
 * missing row or a failed read all answer false: the space then behaves exactly
 * as every space did before this flag existed.
 */
export async function spaceRequiresFigma(db, orgId) {
  if (!db || typeof db.from !== "function" || orgId == null || orgId === "") return false;
  try {
    const { data, error } = await db.from("orgs").select("figma_required").eq("id", String(orgId)).maybeSingle();
    if (error || !data) return false;
    return data.figma_required === true;
  } catch {
    return false;
  }
}

/**
 * THE ORDER PATH'S TWO DECISIONS, named so they can be tested on their own.
 *
 * refuseWithoutSpaceFigma: a space that must connect its own Figma account and
 * has not (its credential came back as the Mavlers token or as nothing) takes
 * no order. A space with its own OAuth connection ("oauth") or pasted token
 * ("org") is never refused here, and neither is any space without the flag.
 */
export function refuseWithoutSpaceFigma(spaceCred, figmaRequired) {
  if (figmaRequired !== true) return false;
  const src = spaceCred && spaceCred.source;
  return src !== "oauth" && src !== "org";
}

/**
 * readAgainAsSpace: the orderer's own account was used, Figma refused it
 * (401, 403 or 404 in the parser's message), and the space has a DIFFERENT
 * token to try. Anything else (a bad link, a network error, no space token, the
 * same token) is not retried: the original error stands.
 */
export function readAgainAsSpace({ usedMember, message, spaceToken, usedToken }) {
  if (!usedMember) return false;
  if (!/\((401\/403|404)\)|\b40[134]\b/.test(String(message || ""))) return false;
  return Boolean(spaceToken) && spaceToken !== usedToken;
}

/** The Figma account a connection names, in the words the console shows: the email Figma reported, else the handle. */
function accountOf(row) {
  return (row && (row.figma_email || row.figma_handle)) || null;
}

/** ok, or needs-reconnect when its last renewal failed. A connection that never needed renewing is ok. */
function statusOf(row) {
  return row && row.last_refresh_ok === false ? "needs-reconnect" : "ok";
}

/**
 * The space's own default, described without a token:
 *   kind "oauth"   a connected Figma account       account = its email or handle
 *   kind "token"   a pasted token                  account = the label the space gave it
 *   kind "mavlers" no space account; orders read with Mavloper's own (older spaces)
 *   kind "none"    no space account and this space must connect one first
 */
export async function describeSpaceDefault(db, orgId, figmaRequired) {
  try {
    const { data: o, error: oe } = await db
      .from(OAUTH_TABLE)
      .select("figma_email,figma_handle,is_active,last_refresh_ok")
      .eq("org_id", orgId)
      .maybeSingle();
    if (!oe && o && o.is_active !== false) {
      return { kind: "oauth", account: accountOf(o), status: statusOf(o) };
    }
  } catch { /* fall through to the pasted token */ }
  try {
    const { data: t, error: te } = await db
      .from(CREDENTIAL_TABLE)
      .select("label,is_active,expires_at")
      .eq("org_id", orgId)
      .maybeSingle();
    if (!te && t && t.is_active !== false) {
      const expired = t.expires_at != null && new Date(t.expires_at).getTime() <= Date.now();
      return { kind: "token", account: t.label || null, status: expired ? "needs-reconnect" : "ok" };
    }
  } catch { /* fall through */ }
  return figmaRequired ? { kind: "none", account: null, status: "ok" } : { kind: "mavlers", account: null, status: "ok" };
}

/** The read shape of a person's own connection. Field by field; no spread of the row. */
export function memberPublicShape(row) {
  if (!row) return null;
  return {
    userId: row.user_id ?? null,
    email: row.email ?? null,
    figmaEmail: row.figma_email ?? null,
    figmaHandle: row.figma_handle ?? null,
    account: accountOf(row),
    status: statusOf(row),
    connectedAt: row.connected_at ?? null,
    expiresAt: row.expires_at ?? null,
    lastRefreshAt: row.last_refresh_at ?? null,
    lastRefreshNote: row.last_refresh_note ?? null,
  };
}

// ---------------------------------------------------------------------------
// THE ROUTES.
// ---------------------------------------------------------------------------

export function createFigmaMemberRoutes({ app, supabaseAdmin, requireAuth, log, env = process.env, fetchImpl = null, now = () => Date.now() }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const states = new Map();

  function mintState(orgId, userId) {
    const t = now();
    for (const [k, v] of states) if (v.expiresAt <= t) states.delete(k);
    const state = crypto.randomBytes(24).toString("base64url");
    states.set(state, { orgId, userId, expiresAt: t + MEMBER_STATE_TTL_MS });
    return state;
  }
  function consumeState(state) {
    const entry = states.get(state);
    states.delete(state);
    if (!entry || entry.expiresAt <= now()) return null;
    return entry;
  }

  function tableMissing(res) {
    return sendSafe(res, 503, {
      error: "Personal Figma connections are not set up yet",
      details: "member_figma_oauth has not been created. Until it is, every order reads with its space's Figma account, as before.",
    }, log);
  }

  function oauthAppConfigured() {
    return Boolean(env.FIGMA_OAUTH_CLIENT_ID && env.FIGMA_OAUTH_CLIENT_SECRET && env.FIGMA_OAUTH_REDIRECT_URI);
  }

  async function loadSpace(req, res) {
    const slug = String(req.params.slug || "").toLowerCase();
    try {
      const { data, error } = await supabaseAdmin.from("orgs").select("id,name,slug,is_deleted").eq("slug", slug).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) { sendSafe(res, 404, { error: "No space with that name" }, log); return null; }
      if (data.is_deleted) { sendSafe(res, 404, { error: "That space is closed" }, log); return null; }
      return data;
    } catch (err) {
      log("error", "figma-member: space lookup failed", { slug, error: err.message });
      sendSafe(res, 503, { error: "Could not check that space", details: "The space directory did not answer. Nothing was changed." }, log);
      return null;
    }
  }

  async function seatsOf(email, orgId) {
    const { data, error } = await supabaseAdmin
      .from("email_allowlist")
      .select("email,is_owner")
      .eq("org_id", orgId)
      .eq("email", email)
      .limit(5);
    if (error) throw new Error(error.message);
    return data || [];
  }

  async function isPlatformOwner(email) {
    if (platformOwners(env).includes(email)) return true;
    const { data, error } = await supabaseAdmin.from("platform_owners").select("email").eq("email", email).limit(1);
    if (error) throw new Error(error.message);
    return Array.isArray(data) && data.length > 0;
  }

  /** Any seat in THIS space. Sets req.space. Every uncertainty denies. */
  async function requireSpaceSeat(req, res, next) {
    const email = String(req.user?.email || "").toLowerCase().trim();
    const userId = normalisedUserId(req.user?.id);
    if (!email || !userId) {
      return sendSafe(res, 403, { error: "Not permitted", details: "Your sign-in carries no email address or user id." }, log);
    }
    const space = await loadSpace(req, res);
    if (!space) return undefined;
    try {
      const seats = await seatsOf(email, space.id);
      if (seats.length === 0) {
        return sendSafe(res, 403, { error: "No seat in this space", details: "You are signed in as " + email + " and you do not hold a seat in this space." }, log);
      }
    } catch (err) {
      log("error", "figma-member: seat lookup failed", { slug: space.slug, error: err.message });
      return sendSafe(res, 503, { error: "Could not check your access", details: "The seat directory did not answer. Nothing was changed." }, log);
    }
    req.space = { id: space.id, name: space.name, slug: space.slug };
    req.me = { email, userId };
    return next();
  }

  /** An Admin seat in THIS space, or the platform owner. Sets req.space. */
  async function requireSpaceAdminOrOwner(req, res, next) {
    const email = String(req.user?.email || "").toLowerCase().trim();
    if (!email) return sendSafe(res, 403, { error: "Not permitted", details: "Your sign-in carries no email address." }, log);
    const space = await loadSpace(req, res);
    if (!space) return undefined;
    try {
      const seats = await seatsOf(email, space.id);
      const admin = seats.some((s) => s.is_owner === true) || (await isPlatformOwner(email));
      if (!admin) {
        return sendSafe(res, 403, { error: "Only an Admin of this space can do this", details: "You are signed in as " + email + " and you do not hold an Admin seat in this space." }, log);
      }
    } catch (err) {
      log("error", "figma-member: admin lookup failed", { slug: space.slug, error: err.message });
      return sendSafe(res, 503, { error: "Could not check your access", details: "The seat directory did not answer. Nothing was changed." }, log);
    }
    req.space = { id: space.id, name: space.name, slug: space.slug };
    return next();
  }

  async function readMine(orgId, userId) {
    const { data, error } = await supabaseAdmin
      .from(MEMBER_OAUTH_TABLE)
      .select(MEMBER_PUBLIC_COLUMNS)
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) { const e = new Error(error.message); e.code = error.code; throw e; }
    return data && data.is_active !== false ? data : null;
  }

  // =========================================================================
  // GET /me/figma - WHAT MY ORDERS IN THIS SPACE READ WITH.
  // =========================================================================
  app.get("/os/spaces/:slug/me/figma", requireAuth, requireSpaceSeat, async (req, res) => {
    try {
      const figmaRequired = await spaceRequiresFigma(supabaseAdmin, req.space.id);
      const spaceDefault = await describeSpaceDefault(supabaseAdmin, req.space.id, figmaRequired);
      let mine = null;
      let personalAvailable = true;
      try {
        mine = await readMine(req.space.id, req.me.userId);
      } catch (err) {
        if (err.code !== PG_UNDEFINED_TABLE) throw err;
        personalAvailable = false;
      }
      const readsWith = mine && mine.last_refresh_ok !== false
        ? { kind: "own", account: accountOf(mine) }
        : spaceDefault.kind === "oauth" || spaceDefault.kind === "token"
          ? { kind: "space", account: spaceDefault.account }
          : { kind: spaceDefault.kind, account: null };
      return sendSafe(res, 200, {
        space: req.space,
        figmaRequired,
        personalAvailable,
        mine: memberPublicShape(mine),
        spaceDefault,
        readsWith,
      }, log);
    } catch (err) {
      log("error", "figma-member: read failed", { slug: req.space.slug, error: err.message });
      return sendSafe(res, 500, { error: "Could not read your Figma account for this space", details: err.message }, log);
    }
  });

  // =========================================================================
  // GET /me/figma-oauth/start - MINT STATE FOR THIS PERSON IN THIS SPACE.
  // =========================================================================
  app.get("/os/spaces/:slug/me/figma-oauth/start", requireAuth, requireSpaceSeat, async (req, res) => {
    if (!oauthAppConfigured()) {
      return sendSafe(res, 503, { error: "Figma sign-in is not configured on this backend", details: "FIGMA_OAUTH_CLIENT_ID, FIGMA_OAUTH_CLIENT_SECRET and FIGMA_OAUTH_REDIRECT_URI must all be set." }, log);
    }
    const state = mintState(req.space.id, req.me.userId);
    const authorizeUrl = buildAuthorizeUrl({ clientId: env.FIGMA_OAUTH_CLIENT_ID, redirectUri: env.FIGMA_OAUTH_REDIRECT_URI, state });
    log("info", "figma-member: start", { slug: req.space.slug });
    return sendSafe(res, 200, { space: req.space, authorizeUrl, state, expiresInMs: MEMBER_STATE_TTL_MS }, log);
  });

  // =========================================================================
  // POST /me/figma-oauth/callback - EXCHANGE, SEAL, STORE AS MINE.
  // =========================================================================
  app.post("/os/spaces/:slug/me/figma-oauth/callback", requireAuth, requireSpaceSeat, async (req, res) => {
    const { code, state } = req.body ?? {};
    if (!code || typeof code !== "string") {
      return sendSafe(res, 400, { error: "Missing authorization code", details: "Figma did not return a code on the redirect." }, log);
    }
    if (!state || typeof state !== "string") {
      return sendSafe(res, 400, { error: "Missing state", details: "This connection attempt cannot be verified without the state Figma echoed back." }, log);
    }
    const entry = consumeState(state);
    if (!entry) {
      return sendSafe(res, 400, { error: "Could not verify this connection attempt", details: "This attempt is unknown or has expired. Start it again from the Generate page." }, log);
    }
    if (entry.orgId !== req.space.id || entry.userId !== req.me.userId) {
      return sendSafe(res, 400, { error: "This connection attempt was started for a different space or person", details: "Start it again from the Generate page of the space you want it for." }, log);
    }
    if (!oauthAppConfigured()) {
      return sendSafe(res, 503, { error: "Figma sign-in is not configured on this backend", details: "FIGMA_OAUTH_CLIENT_ID, FIGMA_OAUTH_CLIENT_SECRET and FIGMA_OAUTH_REDIRECT_URI must all be set." }, log);
    }

    const exchange = await exchangeCode({
      code,
      clientId: env.FIGMA_OAUTH_CLIENT_ID,
      clientSecret: env.FIGMA_OAUTH_CLIENT_SECRET,
      redirectUri: env.FIGMA_OAUTH_REDIRECT_URI,
      fetchImpl: doFetch,
    });
    if (!exchange.ok) return sendSafe(res, 400, { error: "Could not connect that Figma account", details: exchange.error }, log);
    if (!exchange.refreshToken) {
      return sendSafe(res, 502, { error: "Figma did not return a refresh token", details: "Remove Mavloper from your Figma account's connected apps, then connect again." }, log);
    }

    const keyRead = readKey(env[KEY_ENV]);
    if (!keyRead.ok) {
      log("error", "figma-member: write refused, no sealing key", { slug: req.space.slug });
      return sendSafe(res, 503, { error: "This connection cannot be stored yet", details: keyRead.error }, log);
    }
    const sealedAccess = sealToken(exchange.accessToken, keyRead.key);
    const sealedRefresh = sealToken(exchange.refreshToken, keyRead.key);
    if (!sealedAccess.ok || !sealedRefresh.ok) {
      return sendSafe(res, 500, { error: "Could not store that connection", details: sealedAccess.error || sealedRefresh.error }, log);
    }

    const identity = await fetchFigmaIdentity({ accessToken: exchange.accessToken, fetchImpl: doFetch });
    const t = now();
    const nowIso = new Date(t).toISOString();
    const row = {
      org_id: req.space.id,
      user_id: req.me.userId,
      email: req.me.email,
      access_token: sealedAccess.sealed,
      refresh_token: sealedRefresh.sealed,
      expires_at: new Date(t + (exchange.expiresIn || 0) * 1000).toISOString(),
      figma_user_id: identity.id || exchange.userId,
      figma_email: identity.email,
      figma_handle: identity.handle,
      scopes: DEFAULT_SCOPES.join(","),
      is_active: true,
      connected_at: nowIso,
      updated_at: nowIso,
      last_refresh_at: null,
      last_refresh_ok: null,
      last_refresh_note: identity.ok ? null : "Connected, but the Figma account was not named. " + identity.note,
    };
    try {
      const { error } = await supabaseAdmin.from(MEMBER_OAUTH_TABLE).upsert(row, { onConflict: "org_id,user_id" });
      if (error) {
        if (error.code === PG_UNDEFINED_TABLE) return tableMissing(res);
        throw new Error(error.message);
      }
    } catch (err) {
      log("error", "figma-member: write failed", { slug: req.space.slug, error: err.message });
      return sendSafe(res, 500, { error: "Could not store that connection", details: err.message }, log);
    }
    log("info", "figma-member: connected", { slug: req.space.slug, named: Boolean(identity.email || identity.handle) });
    return sendSafe(res, 200, { space: req.space, connected: true, mine: memberPublicShape(row) }, log);
  });

  // =========================================================================
  // DELETE /me/figma-oauth - DISCONNECT MINE. THE ROW GOES.
  // =========================================================================
  app.delete("/os/spaces/:slug/me/figma-oauth", requireAuth, requireSpaceSeat, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from(MEMBER_OAUTH_TABLE)
        .delete()
        .eq("org_id", req.space.id)
        .eq("user_id", req.me.userId)
        .select("org_id");
      if (error) {
        if (error.code === PG_UNDEFINED_TABLE) return tableMissing(res);
        throw new Error(error.message);
      }
      if ((data?.length ?? 0) === 0) {
        return sendSafe(res, 404, { error: "Nothing to disconnect", details: "You have no Figma account of your own connected in this space." }, log);
      }
      log("info", "figma-member: disconnected", { slug: req.space.slug });
      return sendSafe(res, 200, { space: req.space, disconnected: true }, log);
    } catch (err) {
      log("error", "figma-member: disconnect failed", { slug: req.space.slug, error: err.message });
      return sendSafe(res, 500, { error: "Could not disconnect that Figma account", details: err.message }, log);
    }
  });

  // =========================================================================
  // POST /me/figma-check - CAN THE ACCOUNT MY ORDER WILL READ WITH OPEN THIS FILE?
  // =========================================================================
  // 20 NOV, THE OWNER: refuse a file at submission when the account the order
  // will read with cannot open it, instead of failing the order minutes later.
  // The credentials are resolved by the SAME calls, in the SAME order, as
  // server.js /generate-from-figma; figma-access-check.js holds the decision.
  // One Tier 3 call per account asked (GET /v1/files/:key/meta), cached.
  // Never returns a token: the body is built field by field from the verdict.
  const checks = new Map();
  const RECHECK_REFUSED_MS = 30 * 1000;
  const CHECKS_MAX = 500;
  function cachedAsk(fileKey) {
    return async (token) => {
      const k = crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 24) + ":" + fileKey;
      const t = now();
      const hit = checks.get(k);
      if (hit && hit.until > t) return hit.answer;
      const answer = await checkFileAccess({ token, fileKey, fetchImpl: doFetch });
      const ttl = answer.verdict === "open" ? CHECK_CACHE_MS : answer.verdict === "refused" ? RECHECK_REFUSED_MS : 0;
      if (ttl > 0) {
        if (checks.size >= CHECKS_MAX) for (const [key, v] of checks) if (v.until <= t || checks.size >= CHECKS_MAX) checks.delete(key);
        checks.set(k, { until: t + ttl, answer });
      }
      return answer;
    };
  }

  app.post("/os/spaces/:slug/me/figma-check", requireAuth, requireSpaceSeat, async (req, res) => {
    const figmaUrl = typeof req.body?.figmaUrl === "string" ? req.body.figmaUrl.trim() : "";
    const fileKey = parseFigmaFileKey(figmaUrl);
    if (!fileKey) {
      return sendSafe(res, 400, { error: "Not a Figma file link", details: "Paste a figma.com/design or /file link to one email frame." }, log);
    }
    try {
      const orgId = req.space.id;
      // env is process.env in production (server.js mounts with it), which is
      // what the order path's resolvers read when they are given none.
      const oauthCred = await resolveFigmaOAuth(orgId, { db: supabaseAdmin, env, fetchImpl: doFetch });
      const spaceCred = oauthCred
        ? shapeOAuthResolution(oauthCred, orgId)
        : await resolveFigmaToken(orgId, { db: supabaseAdmin, globalToken: env.FIGMA_API_TOKEN, env });
      const memberCred = await resolveMemberFigmaOAuth(orgId, req.me.userId, { db: supabaseAdmin, env, fetchImpl: doFetch });
      const figmaRequired = await spaceRequiresFigma(supabaseAdmin, orgId);
      const spaceKind = spaceCred && (spaceCred.source === "oauth" || spaceCred.source === "org") ? "space" : "mavlers";
      const words = {
        mine: memberCred ? memberCred.figmaEmail || memberCred.figmaHandle || "your own Figma account" : null,
        space: spaceKind === "mavlers"
          ? "Mavloper's Figma account"
          : (oauthCred && (oauthCred.figmaEmail || oauthCred.figmaHandle)) || (spaceCred && spaceCred.label) || "this space's Figma account",
        spaceKind,
      };
      const d = await decideFigmaAccess({
        refuseForSpace: refuseWithoutSpaceFigma(spaceCred, figmaRequired),
        noAccountWords: { space: NO_SPACE_FIGMA, none: NO_FIGMA_ACCOUNT },
        spaceCred,
        memberCred,
        words,
        ask: cachedAsk(fileKey),
      });
      log("info", "figma-check", { slug: req.space.slug, verdict: d.verdict, reads: d.readsWith.kind, why: d.why });
      return sendSafe(res, 200, {
        verdict: d.verdict,
        readsWith: { kind: d.readsWith.kind, account: d.readsWith.account },
        fileName: d.fileName,
        message: d.message,
        why: d.why,
      }, log);
    } catch (err) {
      // Our own failure is never a refusal: the order is accepted as before.
      log("warn", "figma-check failed", { slug: req.space.slug, error: err.message });
      return sendSafe(res, 200, { verdict: "unknown", readsWith: { kind: "none", account: null }, fileName: null, message: null, why: "check-failed" }, log);
    }
  });

  // =========================================================================
  // GET /figma-accounts - EVERY MEMBER, AND THE ACCOUNT THEIR ORDERS READ WITH.
  // =========================================================================
  app.get("/os/spaces/:slug/figma-accounts", requireAuth, requireSpaceAdminOrOwner, async (req, res) => {
    try {
      const figmaRequired = await spaceRequiresFigma(supabaseAdmin, req.space.id);
      const spaceDefault = await describeSpaceDefault(supabaseAdmin, req.space.id, figmaRequired);
      const { data: seats, error: seatErr } = await supabaseAdmin.from("email_allowlist").select("email").eq("org_id", req.space.id);
      if (seatErr) throw new Error(seatErr.message);
      let own = [];
      let personalAvailable = true;
      const { data: rows, error: rowErr } = await supabaseAdmin.from(MEMBER_OAUTH_TABLE).select(MEMBER_PUBLIC_COLUMNS).eq("org_id", req.space.id);
      if (rowErr) {
        if (rowErr.code !== PG_UNDEFINED_TABLE) throw new Error(rowErr.message);
        personalAvailable = false;
      } else {
        own = (rows || []).filter((r) => r.is_active !== false);
      }
      const byEmail = new Map(own.map((r) => [String(r.email || "").toLowerCase(), r]));
      const members = (seats || []).map((s) => {
        const email = String(s.email || "").toLowerCase();
        const r = byEmail.get(email);
        return r
          ? { email, userId: r.user_id, kind: "own", account: accountOf(r), status: statusOf(r) }
          : { email, userId: null, kind: "default", account: spaceDefault.account, status: spaceDefault.status };
      });
      return sendSafe(res, 200, { space: req.space, figmaRequired, personalAvailable, spaceDefault, members }, log);
    } catch (err) {
      log("error", "figma-member: list failed", { slug: req.space.slug, error: err.message });
      return sendSafe(res, 500, { error: "Could not read this space's Figma accounts", details: err.message }, log);
    }
  });

  // =========================================================================
  // DELETE /figma-accounts/:userId - AN ADMIN REMOVES A MEMBER'S OWN CONNECTION.
  // =========================================================================
  app.delete("/os/spaces/:slug/figma-accounts/:userId", requireAuth, requireSpaceAdminOrOwner, async (req, res) => {
    const userId = normalisedUserId(req.params.userId);
    if (!userId) return sendSafe(res, 400, { error: "Not a member id" }, log);
    try {
      const { data, error } = await supabaseAdmin
        .from(MEMBER_OAUTH_TABLE)
        .delete()
        .eq("org_id", req.space.id)
        .eq("user_id", userId)
        .select("org_id");
      if (error) {
        if (error.code === PG_UNDEFINED_TABLE) return tableMissing(res);
        throw new Error(error.message);
      }
      if ((data?.length ?? 0) === 0) {
        return sendSafe(res, 404, { error: "Nothing to remove", details: "That member has no Figma account of their own connected in this space." }, log);
      }
      log("info", "figma-member: removed by admin", { slug: req.space.slug, by: String(req.user?.email || "").toLowerCase() });
      return sendSafe(res, 200, { space: req.space, removed: true }, log);
    } catch (err) {
      log("error", "figma-member: admin remove failed", { slug: req.space.slug, error: err.message });
      return sendSafe(res, 500, { error: "Could not remove that Figma account", details: err.message }, log);
    }
  });
}

export default { createFigmaMemberRoutes, spaceRequiresFigma, refuseWithoutSpaceFigma, readAgainAsSpace, describeSpaceDefault, memberPublicShape, MEMBER_PUBLIC_COLUMNS, MEMBER_STATE_TTL_MS };
