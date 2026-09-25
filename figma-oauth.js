/**
 * figma-oauth.js — A FIGMA OAUTH CONNECTION, PER SPACE, THAT REFRESHES ITSELF.
 * =============================================================================
 *
 * ★ WHY THIS EXISTS, AND WHY IT IS NOT A COLUMN ON org_figma_credentials.
 * figma-credential.js already lets a space paste a figd_ personal or plan
 * access token. That token has a hand-typed expiry and lapses; a client re-
 * pastes it by hand every time it does. Figma's OAuth2 flow returns an access
 * token, a refresh token and an expires_in, and this module refreshes without
 * asking the client again.
 *
 * figma-credential.js:107 validatePastedToken() DELIBERATELY REJECTS anything
 * not beginning `figd_` — figma-credential.js:175 asserts a `figu_` OAuth token
 * is rejected as a pasted credential, and that assertion is exactly why this
 * module exists as a SEPARATE table and a SEPARATE resolver rather than a new
 * write path into org_figma_credentials. Storing an OAuth token there would
 * make resolveFigmaToken() unseal it, hand it to validatePastedToken(), watch
 * it fail the `figd_` check, and fall back to the global Mavlers token — with
 * no error, no warning, and no visible difference. That is the exact failure
 * this run's brief names as having been live once already. See
 * figma-credential.js:39-55 for the same incident from the pasted-token side.
 *
 * ★★ THE SHAPE RULE. A Figma OAuth access token is NEVER run through
 * validatePastedToken anywhere in this file. This is enforced by construction,
 * not by discipline: this file does not import validatePastedToken at all, so
 * there is no line that could pass an OAuth token to it. If a shape check is
 * ever needed here, it must be a NEW, SEPARATE function — an OAuth access
 * token and a figd_ personal/plan token are different credential types issued
 * by different flows, and a single shape check that accepted both would be the
 * same silent-fallback risk in the other direction (a malformed pasted token
 * quietly accepted as if it were OAuth-shaped).
 *
 * ★ THE FAILURE STORY MATCHES figma-credential.js's. Every failure here — no
 * row, no key, unopenable, expired-and-unrefreshable, Figma unreachable —
 * resolves to `null`, and the caller (resolveFigmaCredential, at the foot of
 * this file) falls through to resolveFigmaToken() UNCHANGED. This module can
 * never make an order fail that would otherwise have succeeded, and it can
 * never turn INTO the silent failure it was written to avoid: a refresh
 * failure returns null rather than handing back a token past its expiry.
 *
 * ★ WHERE A REFRESH FAILURE'S REASON LIVES. resolveFigmaOAuth() returns null
 * on any failure, with no room in that contract for a "reason" field — a
 * caller that gets null has nothing to log a reason ONTO without also risking
 * building a parallel, undocumented shape next to figma-credential.js's
 * `reason` convention. Instead, org_figma_oauth's last_refresh_at /
 * last_refresh_ok / last_refresh_note columns exist FOR EXACTLY THIS: every
 * refresh attempt, successful or not, is recorded on the row itself, so "why
 * did this space's connection stop working" is answerable by reading the row,
 * not by threading a reason through a function that returns null.
 */

import { readKey, sealToken, openToken, KEY_ENV } from "./figma-credential-crypto.js";
import { normalisedOrgId, resolveFigmaToken, credentialProvenanceLine } from "./figma-credential.js";

// ---------------------------------------------------------------------------
// FIGMA'S OAUTH2 ENDPOINTS.
//
// ★ CORRECTED AFTER A LIVE CALL. The token and refresh URLs were first written
// as www.figma.com/api/oauth/..., and the live exchange answered HTTP 404
// "Not Found". Per https://developers.figma.com/docs/rest-api/oauth-apps/ they
// live on api.figma.com/v1/oauth/..., and the client authenticates with an
// HTTP Basic header, not body fields (see figmaBasicAuth below). The authorize
// URL was verified by a live consent screen and is unchanged. If Figma answers
// something other than the shape exchangeCode()/refreshAccessToken() expect,
// both functions report `ok:false` with Figma's own status code rather than
// throwing, so a wrong guess here degrades to "OAuth connect failed, try
// again" rather than a crash.
// ---------------------------------------------------------------------------
export const FIGMA_AUTHORIZE_URL = "https://www.figma.com/oauth";
export const FIGMA_TOKEN_URL = "https://api.figma.com/v1/oauth/token";
export const FIGMA_REFRESH_URL = "https://api.figma.com/v1/oauth/refresh";
/** Same value as FIGMA_TEST_ENDPOINT in the credential routes module — the same cheapest authenticated call. Not imported from there to keep this file's only cross-module import limited to the crypto and resolver helpers named in the header above. */
export const FIGMA_ME_URL = "https://api.figma.com/v1/me";

/** The scopes this app was registered with. Comma-joined in the authorize URL, per Figma's current granular-scope format. */
export const DEFAULT_SCOPES = ["current_user:read", "file_content:read", "file_metadata:read"];

/** Refresh when less than this much time remains. 10 minutes, per the brief. */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export const OAUTH_TABLE = "org_figma_oauth";

/**
 * The Authorization header Figma's token and refresh endpoints require:
 * `Basic base64(client_id + ":" + client_secret)`. The secret travels ONLY
 * here, never in the form body. This header carries the secret, so nothing
 * that logs a request may print it.
 */
export function figmaBasicAuth(clientId, clientSecret) {
  return "Basic " + Buffer.from(String(clientId) + ":" + String(clientSecret), "utf8").toString("base64");
}

// ---------------------------------------------------------------------------
// THE AUTHORIZE URL.
// ---------------------------------------------------------------------------

/**
 * Build the URL that starts a Figma OAuth connection. Pure string building —
 * no network call, so it cannot fail. The caller (figma-oauth-routes.js)
 * validates that clientId/redirectUri are configured before calling this.
 */
export function buildAuthorizeUrl({ clientId, redirectUri, state, scopes = DEFAULT_SCOPES }) {
  const params = new URLSearchParams({
    client_id: String(clientId ?? ""),
    redirect_uri: String(redirectUri ?? ""),
    scope: (Array.isArray(scopes) ? scopes : DEFAULT_SCOPES).join(","),
    state: String(state ?? ""),
    response_type: "code",
  });
  return FIGMA_AUTHORIZE_URL + "?" + params.toString();
}

// ---------------------------------------------------------------------------
// THE EXCHANGE.
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for an access token + refresh token.
 *
 * ★ NEVER THROWS. A network failure, a non-JSON body or a Figma error body all
 * land on `{ ok: false, error }` — the route handler turns that into a 400 or
 * 502 with a sentence, never a 500 from an uncaught rejection.
 */
export async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetchImpl = null }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const empty = { ok: false, accessToken: null, refreshToken: null, expiresIn: null, userId: null, error: null };

  if (!code || typeof code !== "string") {
    return { ...empty, error: "No authorization code was supplied." };
  }
  if (!clientId || !clientSecret || !redirectUri) {
    return { ...empty, error: "The Figma OAuth app is not fully configured on this backend." };
  }

  let r;
  try {
    r = await doFetch(FIGMA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: figmaBasicAuth(clientId, clientSecret),
      },
      body: new URLSearchParams({
        redirect_uri: redirectUri,
        code,
        grant_type: "authorization_code",
      }),
    });
  } catch {
    return { ...empty, error: "Could not reach Figma to exchange that code." };
  }

  let body = {};
  try {
    body = await r.json();
  } catch {
    body = {};
  }

  if (!r.ok || !body || typeof body.access_token !== "string" || !body.access_token) {
    const detail = (body && (body.message || body.error)) || null;
    return {
      ...empty,
      error: detail ? "Figma refused that code: " + String(detail).slice(0, 200) : "Figma answered " + r.status + ".",
    };
  }

  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
    userId: body.user_id != null ? String(body.user_id) : null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// THE REFRESH.
// ---------------------------------------------------------------------------

/**
 * Refresh an access token. Figma's refresh response does not reliably include
 * a new refresh_token (the original stays valid), so `refreshToken` is only
 * set here when Figma's response actually carries one; the caller keeps the
 * previous value otherwise.
 *
 * ★ NEVER THROWS, same contract as exchangeCode.
 */
export async function refreshAccessToken({ refreshToken, clientId, clientSecret, fetchImpl = null }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const empty = { ok: false, accessToken: null, refreshToken: null, expiresIn: null, error: null };

  if (!refreshToken || typeof refreshToken !== "string") {
    return { ...empty, error: "No refresh token on file." };
  }
  if (!clientId || !clientSecret) {
    return { ...empty, error: "The Figma OAuth app is not fully configured on this backend." };
  }

  let r;
  try {
    r = await doFetch(FIGMA_REFRESH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: figmaBasicAuth(clientId, clientSecret),
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
      }),
    });
  } catch {
    return { ...empty, error: "Could not reach Figma to refresh that token." };
  }

  let body = {};
  try {
    body = await r.json();
  } catch {
    body = {};
  }

  if (!r.ok || !body || typeof body.access_token !== "string" || !body.access_token) {
    const detail = (body && (body.message || body.error)) || null;
    return {
      ...empty,
      error: detail ? "Figma refused the refresh: " + String(detail).slice(0, 200) : "Figma answered " + r.status + ".",
    };
  }

  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// THE RESOLVER.
// ---------------------------------------------------------------------------

/**
 * Best-effort write of a refresh attempt's outcome onto the row. NEVER throws
 * and never affects the caller's return value — a diagnostic that could itself
 * fail the request it is trying to explain would be worse than no diagnostic.
 */
async function recordRefreshOutcome(db, orgId, ok, note, nowIso) {
  try {
    await db
      .from(OAUTH_TABLE)
      .update({ last_refresh_at: nowIso, last_refresh_ok: ok, last_refresh_note: note ? String(note).slice(0, 300) : null })
      .eq("org_id", orgId);
  } catch {
    // Best effort. The caller already has its answer (null, or a fresh token).
  }
}

/**
 * resolveFigmaOAuth(orgId, { db, key, now, env, fetchImpl })
 *
 * Returns { token, source: 'oauth', reason, expiresAt, refreshed, figmaEmail,
 * figmaHandle } when this space has a usable, connected Figma OAuth account —
 * refreshing first if the access token expires within REFRESH_MARGIN_MS.
 *
 * Returns null for EVERY failure mode, including "no row for this org", which
 * is the normal case for every space that has not connected OAuth. NULL IS
 * NOT AN ERROR — the caller falls through to resolveFigmaToken() untouched.
 *
 * ★ IT NEVER THROWS AND IT NEVER RETURNS A TOKEN PAST ITS EXPIRY. A refresh
 * failure is recorded on the row (see recordRefreshOutcome) and this function
 * returns null rather than handing back the stale access token.
 */
export async function resolveFigmaOAuth(orgId, { db = null, key = null, now = null, env = null, fetchImpl = null } = {}) {
  const nowMs = now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  orgId = normalisedOrgId(orgId);
  if (!orgId) return null;
  if (!db || typeof db.from !== "function") return null;

  let row = null;
  try {
    const { data, error } = await db
      .from(OAUTH_TABLE)
      .select("org_id,access_token,refresh_token,expires_at,figma_user_id,figma_email,figma_handle,scopes,is_active")
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) return null;
    row = data;
  } catch {
    return null;
  }

  if (!row) return null;
  if (row.is_active === false) return null;

  let sealingKey = key;
  if (!sealingKey) {
    const keyRead = readKey(env ? env[KEY_ENV] : process.env[KEY_ENV]);
    if (!keyRead.ok) return null;
    sealingKey = keyRead.key;
  }

  const openedAccess = openToken(row.access_token, sealingKey);
  const openedRefresh = openToken(row.refresh_token, sealingKey);
  if (!openedAccess.ok || !openedRefresh.ok) return null;

  let accessToken = openedAccess.token;
  let refreshTokenVal = openedRefresh.token;
  let expiresAt = row.expires_at;
  let refreshed = false;

  const msLeft = new Date(expiresAt).getTime() - nowMs;
  if (!Number.isFinite(msLeft) || msLeft <= REFRESH_MARGIN_MS) {
    const clientId = (env ? env.FIGMA_OAUTH_CLIENT_ID : process.env.FIGMA_OAUTH_CLIENT_ID) || null;
    const clientSecret = (env ? env.FIGMA_OAUTH_CLIENT_SECRET : process.env.FIGMA_OAUTH_CLIENT_SECRET) || null;

    const r = await refreshAccessToken({ refreshToken: refreshTokenVal, clientId, clientSecret, fetchImpl });
    if (!r.ok) {
      await recordRefreshOutcome(db, orgId, false, r.error, nowIso);
      return null;
    }

    accessToken = r.accessToken;
    if (r.refreshToken) refreshTokenVal = r.refreshToken;
    expiresAt = new Date(nowMs + (r.expiresIn || 0) * 1000).toISOString();
    refreshed = true;

    const sealedAccess = sealToken(accessToken, sealingKey);
    const sealedRefresh = sealToken(refreshTokenVal, sealingKey);
    if (sealedAccess.ok && sealedRefresh.ok) {
      try {
        await db
          .from(OAUTH_TABLE)
          .update({
            access_token: sealedAccess.sealed,
            refresh_token: sealedRefresh.sealed,
            expires_at: expiresAt,
            updated_at: nowIso,
            last_refresh_at: nowIso,
            last_refresh_ok: true,
            last_refresh_note: null,
          })
          .eq("org_id", orgId);
      } catch {
        // The refreshed token is still valid for THIS call even if the
        // rewrite fails; the next call will just refresh again.
      }
    }
  }

  return {
    token: accessToken,
    source: "oauth",
    reason: refreshed ? "oauth-refreshed" : "oauth-credential",
    expiresAt,
    refreshed,
    figmaEmail: row.figma_email ?? null,
    figmaHandle: row.figma_handle ?? null,
  };
}

// ---------------------------------------------------------------------------
// THE ONE CALLER CHANGE. Everything server.js's order path needs, in one call.
// ---------------------------------------------------------------------------

/**
 * Reshape a resolveFigmaOAuth() success into the same shape resolveFigmaToken()
 * returns, so describeResolution() and figmaCredentialProvenanceLine() (both
 * below) can read either without a branch of their own. Extracted as its own
 * function so server.js's call site (which must keep a literal, real call to
 * resolveFigmaToken() in its own text — see the note at that call site) and
 * resolveFigmaCredential() below share ONE implementation of the mapping
 * rather than two copies that could drift apart.
 */
export function shapeOAuthResolution(oauth, orgId) {
  return {
    token: oauth.token,
    source: "oauth",
    reason: oauth.reason,
    orgId: normalisedOrgId(orgId),
    label: oauth.figmaHandle || oauth.figmaEmail || null,
    expiresAt: oauth.expiresAt,
    expired: false,
    tokenKind: "oauth",
    wasSealed: true,
  };
}

/**
 * resolveFigmaCredential(orgId, opts) — tries this space's OAuth connection
 * first; falls through to resolveFigmaToken() UNCHANGED when there is none.
 *
 * ★ THE FALLTHROUGH IS BYTE-IDENTICAL BY CONSTRUCTION. When resolveFigmaOAuth
 * returns null, this function's return value IS resolveFigmaToken(orgId, ...)
 * — not a re-shaped copy of it — so a space with no OAuth connection behaves
 * exactly as it does today, including every field describeResolution() and
 * credentialProvenanceLine() read from it.
 *
 * `opts` accepts every option resolveFigmaToken() does (db, globalToken, now,
 * key, env) plus `fetchImpl`, used only by the OAuth refresh path.
 *
 * ★ server.js DOES NOT CALL THIS FUNCTION. See the note at its call site: the
 * existing test suite asserts server.js's own text contains a real call to
 * resolveFigmaToken(), so server.js inlines the same two-step composition
 * this function performs, sharing shapeOAuthResolution() so there is exactly
 * one place the OAuth-to-resolution mapping is written. This function exists
 * so that composition has a name and a direct, isolated test — see
 * figma-oauth.test.mjs's fallthrough control.
 */
export async function resolveFigmaCredential(orgId, { db, globalToken, now, key, env, fetchImpl } = {}) {
  const oauth = await resolveFigmaOAuth(orgId, { db, key, now, env, fetchImpl });
  if (oauth) return shapeOAuthResolution(oauth, orgId);
  return resolveFigmaToken(orgId, { db, globalToken, now, key, env });
}

/**
 * ★★ THE PROVENANCE LINE THAT KNOWS ABOUT OAUTH.
 *
 * credentialProvenanceLine() (figma-credential.js:395) has no `oauth` branch
 * and cannot be given one without editing that file, which this run does not
 * touch. This wraps it: an `oauth` resolution gets its own sentence, and every
 * other resolution is handed to the ORIGINAL, UNMODIFIED function — so the
 * wording for a pasted token or the global fallback is byte-identical to
 * today, satisfying the brief's "existing wording must be unchanged when
 * OAuth is absent."
 *
 * ASCII only, no em dash — same osVoice constraint credentialProvenanceLine
 * itself is written to.
 */
export function figmaCredentialProvenanceLine(r) {
  if (r && r.source === "oauth") {
    return "Figma credential: this space's connected Figma account" + (r.label ? " (" + String(r.label).slice(0, 60) + ")" : "");
  }
  return credentialProvenanceLine(r);
}

export default {
  FIGMA_AUTHORIZE_URL,
  FIGMA_TOKEN_URL,
  FIGMA_REFRESH_URL,
  FIGMA_ME_URL,
  DEFAULT_SCOPES,
  REFRESH_MARGIN_MS,
  OAUTH_TABLE,
  figmaBasicAuth,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  resolveFigmaOAuth,
  shapeOAuthResolution,
  resolveFigmaCredential,
  figmaCredentialProvenanceLine,
};
