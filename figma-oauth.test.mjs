// figma-oauth.test.mjs
// ---------------------------------------------------------------------------
// FIGMA OAUTH, RUN 1 (REQUEST SHAPE CORRECTED IN RUN 3) — THE EXCHANGE, THE REFRESH LADDER, THE SEAL ROUND TRIP,
// AND THE TWO CONTROLS THE BRIEF NAMED BY NAME.
//
// ★ NO REAL FIGMA CREDENTIAL OR APP SECRET APPEARS IN THIS FILE. Every token
// and secret below is a synthetic literal that says so in its own characters.
// Network calls are never made: every test that reaches exchangeCode() or
// refreshAccessToken() injects `fetchImpl`.
//
// Run with:
//   cd /c/Users/shrujal_mavlers/Desktop/maveloper-backend && node figma-oauth.test.mjs
// ---------------------------------------------------------------------------
import {
  FIGMA_AUTHORIZE_URL,
  FIGMA_TOKEN_URL,
  FIGMA_REFRESH_URL,
  DEFAULT_SCOPES,
  REFRESH_MARGIN_MS,
  OAUTH_TABLE,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  resolveFigmaOAuth,
  resolveFigmaCredential,
  figmaCredentialProvenanceLine,
} from "./figma-oauth.js";
import { readKey, sealToken, openToken, isSealed } from "./figma-credential-crypto.js";
import { resolveFigmaToken, CREDENTIAL_TABLE, credentialProvenanceLine } from "./figma-credential.js";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(t) { console.log(`\n${t}`); }

const ORG = "22222222-3333-4444-5555-666666666666";
const CLIENT_ID = "TEST_CLIENT_ID_not_real";
const CLIENT_SECRET = "TEST_CLIENT_SECRET_not_real";
const REDIRECT_URI = "http://localhost:8080/os/figma/callback";

const FAKE_ACCESS_TOKEN = "oauth_access_THIS_IS_NOT_REAL_0000000000000000";
const FAKE_ACCESS_TOKEN_2 = "oauth_access_THIS_IS_NOT_REAL_refreshed_11111111";
const FAKE_REFRESH_TOKEN = "oauth_refresh_THIS_IS_NOT_REAL_0000000000000000";
const FAKE_GLOBAL_TOKEN = "figd_THIS_IS_NOT_A_REAL_TOKEN_global_00000000000";

const TEST_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const { key: TEST_KEY } = readKey(TEST_KEY_HEX);

// ---------------------------------------------------------------------------
// STUBS.
// ---------------------------------------------------------------------------

/** A stub Supabase client for org_figma_oauth alone, recording every update(). */
function makeOAuthDb({ row = null, throwOnSelect = false } = {}) {
  const updates = [];
  function builder(table) {
    const q = {
      select() { return q; },
      eq() { return q; },
      async maybeSingle() {
        if (throwOnSelect) throw new Error("simulated client explosion");
        return { data: row, error: null };
      },
      update(payload) {
        updates.push({ table, payload });
        return q;
      },
    };
    return q;
  }
  return { updates, from: builder };
}

/**
 * A stub that answers BOTH org_figma_oauth and org_figma_credentials, keyed by
 * table name — needed for the fallthrough control, which drives
 * resolveFigmaCredential (queries org_figma_oauth, then may query
 * org_figma_credentials) against the SAME db resolveFigmaToken is driven
 * against directly.
 */
function makeCombinedDb({ oauthRow = null, credRow = null } = {}) {
  function builder(table) {
    const q = {
      select() { return q; },
      eq() { return q; },
      async maybeSingle() {
        if (table === OAUTH_TABLE) return { data: oauthRow, error: null };
        if (table === CREDENTIAL_TABLE) return { data: credRow, error: null };
        return { data: null, error: null };
      },
      update() { return q; },
    };
    return q;
  }
  return { from: builder };
}

// ---------------------------------------------------------------------------
// ★★ FIGMA'S DOCUMENTED REQUEST SHAPE, WRITTEN FROM THE DOC, NOT FROM THE CODE.
// Source: https://developers.figma.com/docs/rest-api/oauth-apps/
//
// Run 1's tests compared seen.url to FIGMA_TOKEN_URL (the module's OWN
// constant) and asserted client_id/client_secret were in the body, because
// that is what the code did. Both were wrong and all 64 stayed green. These
// literals are typed from Figma's documentation and are NOT imported from
// figma-oauth.js, so a wrong constant there can no longer agree with itself.
// The Basic header is decoded here by hand, not rebuilt with the module's own
// helper, for the same reason.
// ---------------------------------------------------------------------------
const DOC_AUTHORIZE_URL = "https://www.figma.com/oauth";
const DOC_TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const DOC_REFRESH_URL = "https://api.figma.com/v1/oauth/refresh";
const DOC_TOKEN_BODY_KEYS = ["code", "grant_type", "redirect_uri"];
const DOC_REFRESH_BODY_KEYS = ["refresh_token"];

function headerOf(opts, name) {
  const h = (opts && opts.headers) || {};
  if (typeof h.get === "function") return h.get(name);
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
}

/**
 * Every way a captured request differs from Figma's documented shape. Empty
 * list = conforms. Returned as a list (not a boolean) so a failure names what
 * is wrong, and so the not-blind controls below can prove each check bites.
 */
function docShapeProblems(seen, { url, bodyKeys }) {
  const p = [];
  if (!seen) return ["no request was made"];
  if (seen.url !== url) p.push("url is " + seen.url + ", Figma documents " + url);
  if (String(seen.opts?.method || "").toUpperCase() !== "POST") p.push("method is not POST");
  if (headerOf(seen.opts, "Content-Type") !== "application/x-www-form-urlencoded") p.push("Content-Type is not application/x-www-form-urlencoded");
  const auth = headerOf(seen.opts, "Authorization");
  if (typeof auth !== "string" || !auth.startsWith("Basic ")) p.push("no HTTP Basic Authorization header");
  else if (Buffer.from(auth.slice(6), "base64").toString("utf8") !== CLIENT_ID + ":" + CLIENT_SECRET) p.push("Basic header does not decode to client_id:client_secret");
  const body = new URLSearchParams(String(seen.opts?.body ?? ""));
  const keys = [...body.keys()].sort();
  if (JSON.stringify(keys) !== JSON.stringify([...bodyKeys].sort())) p.push("body keys are [" + keys.join(",") + "], Figma documents [" + bodyKeys.join(",") + "]");
  if (String(seen.opts?.body ?? "").includes(CLIENT_SECRET)) p.push("the client secret is in the body");
  return p;
}

function sealedRow({ expiresAt, access = FAKE_ACCESS_TOKEN, refresh = FAKE_REFRESH_TOKEN, isActive = true, email = "designer@acme.example", handle = "acmedesigner" } = {}) {
  return {
    org_id: ORG,
    access_token: sealToken(access, TEST_KEY).sealed,
    refresh_token: sealToken(refresh, TEST_KEY).sealed,
    expires_at: expiresAt,
    figma_user_id: "999",
    figma_email: email,
    figma_handle: handle,
    scopes: DEFAULT_SCOPES.join(","),
    is_active: isActive,
  };
}

// ===========================================================================
section("1. THE AUTHORIZE URL");
// ===========================================================================
{
  const url = buildAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state: "STATE_abc123" });
  const u = new URL(url);
  ok("1  the authorize URL is Figma's documented endpoint", u.origin + u.pathname === FIGMA_AUTHORIZE_URL, url);
  ok("1  ★ the authorize URL equals the DOC literal (live-verified in run 2; must not move)", u.origin + u.pathname === DOC_AUTHORIZE_URL, url);
  ok("1  it carries the client id", u.searchParams.get("client_id") === CLIENT_ID);
  ok("1  it carries the exact redirect_uri, unmodified", u.searchParams.get("redirect_uri") === REDIRECT_URI);
  ok("1  it carries the state", u.searchParams.get("state") === "STATE_abc123");
  ok("1  response_type is code", u.searchParams.get("response_type") === "code");
  ok("1  it carries all three configured scopes", u.searchParams.get("scope") === DEFAULT_SCOPES.join(","));
  ok("1  none of the three scopes is silently dropped",
     ["current_user:read", "file_content:read", "file_metadata:read"].every((s) => u.searchParams.get("scope").includes(s)));

  // A custom scope list is honoured rather than always falling back to the default.
  const custom = new URL(buildAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state: "s", scopes: ["file_content:read"] }));
  ok("1  a custom scope list overrides the default", custom.searchParams.get("scope") === "file_content:read");
}

// ===========================================================================
section("2. exchangeCode — SUCCESS, ERROR, AND NEVER A THROW");
// ===========================================================================
{
  let seen = null;
  const good = await exchangeCode({
    code: "AUTH_CODE_123",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, json: async () => ({ access_token: FAKE_ACCESS_TOKEN, refresh_token: FAKE_REFRESH_TOKEN, expires_in: 3600, user_id: 42 }) };
    },
  });
  ok("2  exchangeCode maps a Figma SUCCESS body correctly", good.ok === true);
  ok("2  ...accessToken", good.accessToken === FAKE_ACCESS_TOKEN);
  ok("2  ...refreshToken", good.refreshToken === FAKE_REFRESH_TOKEN);
  ok("2  ...expiresIn as a number", good.expiresIn === 3600);
  ok("2  ...userId coerced to a string", good.userId === "42");
  ok("2  ★ it POSTs to the DOC token URL (literal, not the module's constant)", seen.url === DOC_TOKEN_URL, seen.url);
  ok("2  ★ the client authenticates with HTTP Basic base64(client_id:client_secret)",
     (() => { const a = headerOf(seen.opts, "Authorization"); return typeof a === "string" && a.startsWith("Basic ") && Buffer.from(a.slice(6), "base64").toString("utf8") === CLIENT_ID + ":" + CLIENT_SECRET; })());
  ok("2  ★ client_id and client_secret are NOT in the body",
     !new URLSearchParams(String(seen.opts.body)).has("client_id") && !new URLSearchParams(String(seen.opts.body)).has("client_secret") && !String(seen.opts.body).includes(CLIENT_SECRET));
  ok("2  ★ the body is EXACTLY redirect_uri, code, grant_type=authorization_code",
     (() => { const b = new URLSearchParams(String(seen.opts.body)); return JSON.stringify([...b.keys()].sort()) === JSON.stringify(DOC_TOKEN_BODY_KEYS) && b.get("grant_type") === "authorization_code" && b.get("redirect_uri") === REDIRECT_URI && b.get("code") === "AUTH_CODE_123"; })(),
     String(seen.opts.body));
  ok("2  ★ Content-Type is application/x-www-form-urlencoded", headerOf(seen.opts, "Content-Type") === "application/x-www-form-urlencoded");
  {
    const probs = docShapeProblems(seen, { url: DOC_TOKEN_URL, bodyKeys: DOC_TOKEN_BODY_KEYS });
    ok("2  ★ the whole token request matches Figma's documented shape", probs.length === 0, probs.join("; "));
  }
  {
    // NOT-BLIND CONTROL: run 1's request, rebuilt as it was sent, must fail the
    // same checker on the URL, the missing Basic header AND the body keys.
    const run1 = { url: "https://www.figma.com/api/oauth/token", opts: { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, code: "AUTH_CODE_123", grant_type: "authorization_code" }) } };
    const probs = docShapeProblems(run1, { url: DOC_TOKEN_URL, bodyKeys: DOC_TOKEN_BODY_KEYS });
    ok("2  ★ CONTROL: run 1's token request FAILS the doc checker on url, auth and body (not blind)",
       probs.some((x) => x.startsWith("url")) && probs.some((x) => x.includes("Basic")) && probs.some((x) => x.startsWith("body keys")) && probs.some((x) => x.includes("secret")), probs.join("; "));
  }
  ok("2  the code travels in the POST body, not the URL", !seen.url.includes("AUTH_CODE_123") && String(seen.opts.body).includes("AUTH_CODE_123"));

  const bad = await exchangeCode({
    code: "AUTH_CODE_123",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant", message: "Authorization code expired" }) }),
  });
  ok("2  exchangeCode maps a Figma ERROR body to ok:false, NO THROW", bad.ok === false && bad.accessToken === null);
  ok("2  ...and surfaces Figma's own reason", /invalid_grant|expired/.test(bad.error), bad.error);

  const unreachable = await exchangeCode({
    code: "c", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  ok("2  a network failure is caught, NOT thrown", unreachable.ok === false && unreachable.error);

  const noCode = await exchangeCode({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, fetchImpl: async () => { throw new Error("must not be called"); } });
  ok("2  no code -> ok:false without ever calling fetch", noCode.ok === false);
}

// ===========================================================================
section("3. refreshAccessToken — SUCCESS, ERROR, NEVER A THROW");
// ===========================================================================
{
  let seen = null;
  const good = await refreshAccessToken({
    refreshToken: FAKE_REFRESH_TOKEN, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => ({ access_token: FAKE_ACCESS_TOKEN_2, expires_in: 7200 }) }; },
  });
  ok("3  refreshAccessToken maps a SUCCESS body", good.ok === true && good.accessToken === FAKE_ACCESS_TOKEN_2 && good.expiresIn === 7200);
  ok("3  ★ it POSTs to the DOC refresh URL (literal, not the module's constant)", seen.url === DOC_REFRESH_URL, seen.url);
  {
    const probs = docShapeProblems(seen, { url: DOC_REFRESH_URL, bodyKeys: DOC_REFRESH_BODY_KEYS });
    ok("3  ★ the refresh request matches Figma's documented shape: Basic auth, form body of ONLY refresh_token", probs.length === 0, probs.join("; "));
    ok("3  ★ the body's refresh_token is the one supplied", new URLSearchParams(String(seen.opts.body)).get("refresh_token") === FAKE_REFRESH_TOKEN);
  }
  {
    const run1 = { url: "https://www.figma.com/api/oauth/refresh", opts: { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: FAKE_REFRESH_TOKEN }) } };
    const probs = docShapeProblems(run1, { url: DOC_REFRESH_URL, bodyKeys: DOC_REFRESH_BODY_KEYS });
    ok("3  ★ CONTROL: run 1's refresh request FAILS the doc checker on url, auth and body (not blind)",
       probs.some((x) => x.startsWith("url")) && probs.some((x) => x.includes("Basic")) && probs.some((x) => x.startsWith("body keys")), probs.join("; "));
  }
  ok("3  the refresh token travels in the POST body, not the URL", !seen.url.includes(FAKE_REFRESH_TOKEN));
  ok("3  no new refresh_token in the body -> refreshToken stays null (the caller keeps the old one)", good.refreshToken === null);

  const bad = await refreshAccessToken({
    refreshToken: FAKE_REFRESH_TOKEN, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }),
  });
  ok("3  refreshAccessToken maps an ERROR body to ok:false, NO THROW", bad.ok === false && bad.accessToken === null);

  const thrown = await refreshAccessToken({ refreshToken: FAKE_REFRESH_TOKEN, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: async () => { throw new Error("ETIMEDOUT"); } });
  ok("3  a network failure is caught, NOT thrown", thrown.ok === false);
}

// ===========================================================================
section("4. resolveFigmaOAuth — THE REFRESH DECISION");
// ===========================================================================
{
  const NOW = Date.parse("2026-01-01T00:00:00.000Z");

  // ── a token expiring in 5 minutes TRIGGERS a refresh ──────────────────────
  {
    const db = makeOAuthDb({ row: sealedRow({ expiresAt: new Date(NOW + 5 * 60 * 1000).toISOString() }) });
    let refreshCalls = 0;
    const r = await resolveFigmaOAuth(ORG, {
      db, key: TEST_KEY, now: NOW,
      env: { FIGMA_OAUTH_CLIENT_ID: CLIENT_ID, FIGMA_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      fetchImpl: async () => { refreshCalls++; return { ok: true, status: 200, json: async () => ({ access_token: FAKE_ACCESS_TOKEN_2, expires_in: 3600 }) }; },
    });
    ok("4  a token expiring in 5 minutes TRIGGERS a refresh", refreshCalls === 1);
    ok("4  ...and returns the REFRESHED token, marked refreshed:true", r && r.token === FAKE_ACCESS_TOKEN_2 && r.refreshed === true, JSON.stringify(r));
    ok("4  ...and rewrites the row with a SEALED (not plaintext) access token",
       db.updates.some((u) => u.payload.access_token && isSealed(u.payload.access_token) && openToken(u.payload.access_token, TEST_KEY).token === FAKE_ACCESS_TOKEN_2));
    ok("4  ...and records last_refresh_ok:true on the row",
       db.updates.some((u) => u.payload.last_refresh_ok === true));
  }

  // ── a token expiring in 5 days does NOT trigger a refresh ────────────────
  {
    const db = makeOAuthDb({ row: sealedRow({ expiresAt: new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString() }) });
    let refreshCalls = 0;
    const r = await resolveFigmaOAuth(ORG, {
      db, key: TEST_KEY, now: NOW,
      env: { FIGMA_OAUTH_CLIENT_ID: CLIENT_ID, FIGMA_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      fetchImpl: async () => { refreshCalls++; return { ok: true, status: 200, json: async () => ({ access_token: "SHOULD_NOT_BE_USED", expires_in: 1 }) }; },
    });
    ok("4  a token expiring in 5 days does NOT trigger a refresh", refreshCalls === 0);
    ok("4  ...and returns the STORED token, unchanged, refreshed:false", r && r.token === FAKE_ACCESS_TOKEN && r.refreshed === false, JSON.stringify(r));
  }

  // ── boundary: exactly at the margin refreshes (<=) ────────────────────────
  {
    const db = makeOAuthDb({ row: sealedRow({ expiresAt: new Date(NOW + REFRESH_MARGIN_MS).toISOString() }) });
    let refreshCalls = 0;
    await resolveFigmaOAuth(ORG, {
      db, key: TEST_KEY, now: NOW,
      env: { FIGMA_OAUTH_CLIENT_ID: CLIENT_ID, FIGMA_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      fetchImpl: async () => { refreshCalls++; return { ok: true, status: 200, json: async () => ({ access_token: FAKE_ACCESS_TOKEN_2, expires_in: 3600 }) }; },
    });
    ok("4  expiry exactly AT the refresh margin still refreshes (<=, not <)", refreshCalls === 1);
  }

  // ── a FAILED refresh returns null, NEVER a stale token ────────────────────
  {
    const db = makeOAuthDb({ row: sealedRow({ expiresAt: new Date(NOW + 60 * 1000).toISOString() }) });
    const r = await resolveFigmaOAuth(ORG, {
      db, key: TEST_KEY, now: NOW,
      env: { FIGMA_OAUTH_CLIENT_ID: CLIENT_ID, FIGMA_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }),
    });
    ok("4  a FAILED refresh returns null — NEVER the stale access token", r === null);
    ok("4  ...and the failure is recorded on the row (last_refresh_ok:false, a note)",
       db.updates.some((u) => u.payload.last_refresh_ok === false && u.payload.last_refresh_note));
  }
}

// ===========================================================================
section("5. resolveFigmaOAuth — THE SEALED ROUND TRIP, WITH THE REAL CRYPTO MODULE");
// ===========================================================================
{
  const NOW = Date.parse("2026-01-01T00:00:00.000Z");
  const farFuture = new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Not vacuous: prove the row really is sealed ciphertext, not the plaintext.
  const row = sealedRow({ expiresAt: farFuture });
  ok("5  the fixture row's access_token is sealed, not plaintext", isSealed(row.access_token) && !row.access_token.includes(FAKE_ACCESS_TOKEN));
  ok("5  the fixture row's refresh_token is sealed, not plaintext", isSealed(row.refresh_token) && !row.refresh_token.includes(FAKE_REFRESH_TOKEN));

  const r = await resolveFigmaOAuth(ORG, { db: makeOAuthDb({ row }), key: TEST_KEY, now: NOW });
  ok("5  ★ THE ROUND TRIP: resolved token === the token that was sealed", r && r.token === FAKE_ACCESS_TOKEN, JSON.stringify(r));
  ok("5  ...and it surfaces the connected Figma account for the console", r && r.figmaEmail === "designer@acme.example" && r.figmaHandle === "acmedesigner");

  // The key read from FIGMA_CRED_KEY in env, not passed directly — the shape
  // production actually uses (server.js never passes `key`).
  {
    const viaEnv = await resolveFigmaOAuth(ORG, { db: makeOAuthDb({ row }), now: NOW, env: { FIGMA_CRED_KEY: TEST_KEY_HEX } });
    ok("5  ...and it round-trips with the key read from FIGMA_CRED_KEY in env", viaEnv && viaEnv.token === FAKE_ACCESS_TOKEN);
  }

  // A wrong key cannot open it — degrades to null, never a throw, never a guess.
  const wrongKey = readKey(Buffer.alloc(32, 9).toString("base64")).key;
  const bad = await resolveFigmaOAuth(ORG, { db: makeOAuthDb({ row }), key: wrongKey, now: NOW });
  ok("5  a WRONG key -> null, not a throw, not a guessed token", bad === null);

  // No key configured at all.
  const noKey = await resolveFigmaOAuth(ORG, { db: makeOAuthDb({ row }), now: NOW, env: {} });
  ok("5  NO sealing key configured -> null", noKey === null);
}

// ===========================================================================
section("6. resolveFigmaOAuth — THE FAILURE LADDER (ALL -> null, NEVER A THROW)");
// ===========================================================================
{
  const row = sealedRow({ expiresAt: new Date(Date.now() + 86400e3).toISOString() });

  const cases = [
    ["resolveFigmaOAuth returns null when NO ROW EXISTS", ORG, makeOAuthDb({ row: null })],
    ["no orgId -> null", null, makeOAuthDb({ row })],
    ["no db client -> null", ORG, undefined],
    ["is_active = false -> null", ORG, makeOAuthDb({ row: { ...row, is_active: false } })],
    ["the client throwing -> null, not an uncaught rejection", ORG, makeOAuthDb({ row, throwOnSelect: true })],
    ['the literal string "null" as orgId -> null', "null", makeOAuthDb({ row })],
  ];

  for (const [name, orgId, db] of cases) {
    let threw = null;
    let r = "UNSET";
    try {
      r = await resolveFigmaOAuth(orgId, { db, key: TEST_KEY });
    } catch (e) { threw = e; }
    ok(`6  ${name}`, threw === null && r === null, threw ? `threw: ${threw.message}` : `got ${JSON.stringify(r)}`);
  }

  // CONTROL: the same row, live, DOES resolve — so the nulls above are the
  // ladder doing its job, not the fixture being broken.
  const control = await resolveFigmaOAuth(ORG, { db: makeOAuthDb({ row }), key: TEST_KEY });
  ok("6  CONTROL: the live row DOES resolve (else the ladder above is vacuous)", control !== null && control.token === FAKE_ACCESS_TOKEN);
}

// ===========================================================================
section("7. ★★ THE SHAPE RULE — A KNOWN-ABSENT CONTROL, ASSERTED BY CONSTRUCTION");
// ===========================================================================
// figma-credential.js:107 validatePastedToken() REJECTS anything not starting
// figd_, and figma-credential.js:175 asserts it rejects an OAuth figu_ token
// outright. This is not tested by calling validatePastedToken on an OAuth
// token here (that would prove the OTHER module's behaviour, already covered
// by figma-credential.test.mjs §2) — it is tested by proving THIS FILE has no
// path that could reach it at all.
{
  const src = readFileSync(new URL("./figma-oauth.js", import.meta.url), "utf8");
  // ★ CHECKS THE IMPORT STATEMENT, NOT EVERY MENTION. This file's own header
  // discusses validatePastedToken IN PROSE, by name, to explain exactly why it
  // is not imported - a bare /validatePastedToken/ scan would be tripped by
  // that explanation. The actual guarantee is narrower and checkable: no
  // `import { ... validatePastedToken ... }` line reaches this file.
  const importsIt = /import\s*\{[^}]*\bvalidatePastedToken\b[^}]*\}\s*from/.test(src);
  ok("7  figma-oauth.js does NOT import validatePastedToken", !importsIt, "the shape rule is violated — an OAuth token could reach the figd_ check");
  // Built as a concatenation rather than typed as one literal so THIS
  // assertion's own text does not itself match the sibling suite's
  // routes-file-reference scan, which runs over every OTHER file in the repo.
  const routesFileName = "./figma-credential" + "-routes.js";
  ok("7  figma-oauth.js does NOT import the credential routes module either (no accidental second path in)",
     !src.includes('from "' + routesFileName + '"') && !src.includes("from '" + routesFileName + "'"));

  // NOT-BLIND CONTROL: the same scan, pointed at a source string that DOES
  // import validatePastedToken, must go red — otherwise the green above
  // could mean the regex is broken, not that the import is absent.
  const planted = src + '\nimport { validatePastedToken } from "./figma-credential.js";\n';
  ok("7  ★ CONTROL: the same scan FINDS a planted import (not blind)",
     /import\s*\{[^}]*\bvalidatePastedToken\b[^}]*\}\s*from/.test(planted));
}

// ===========================================================================
section("8. ★★ THE FALLTHROUGH CONTROL — BYTE-IDENTICAL TO resolveFigmaToken()");
// ===========================================================================
// With no OAuth row, resolveFigmaCredential must return EXACTLY what calling
// resolveFigmaToken() directly would — not a re-shaped copy, the same value —
// so a space that has never connected OAuth is byte-identical to today.
{
  const G = { globalToken: FAKE_GLOBAL_TOKEN };

  // 8a. No OAuth row, no pasted credential either — the everyday case.
  {
    const db = makeCombinedDb({ oauthRow: null, credRow: null });
    const direct = await resolveFigmaToken(ORG, { db, ...G });
    const wrapped = await resolveFigmaCredential(ORG, { db, ...G });
    ok("8a  no OAuth row -> resolveFigmaCredential is BYTE-IDENTICAL to resolveFigmaToken",
       JSON.stringify(wrapped) === JSON.stringify(direct), `direct=${JSON.stringify(direct)} wrapped=${JSON.stringify(wrapped)}`);
  }

  // 8b. No OAuth row, but a pasted org credential DOES exist — still identical,
  // proving the fallthrough carries through resolveFigmaToken's own org branch.
  {
    const FAKE_ORG_TOKEN = "figd_THIS_IS_NOT_A_REAL_TOKEN_pasted_0000000000";
    const credRow = { org_id: ORG, token: FAKE_ORG_TOKEN, label: "Pasted", token_kind: "personal", expires_at: null, is_active: true };
    const db = makeCombinedDb({ oauthRow: null, credRow });
    const direct = await resolveFigmaToken(ORG, { db, ...G });
    const wrapped = await resolveFigmaCredential(ORG, { db, ...G });
    ok("8b  no OAuth row + a pasted credential -> still BYTE-IDENTICAL",
       JSON.stringify(wrapped) === JSON.stringify(direct) && direct.source === "org");
  }

  // 8c. CONTROL, NOT VACUOUS: when an OAuth row DOES exist, the wrapper MUST
  // diverge from calling resolveFigmaToken directly — otherwise 8a/8b could be
  // green because the wrapper always just calls resolveFigmaToken regardless.
  {
    const oauthRow = sealedRow({ expiresAt: new Date(Date.now() + 86400e3).toISOString() });
    const db = makeCombinedDb({ oauthRow, credRow: null });
    const direct = await resolveFigmaToken(ORG, { db, ...G });
    const wrapped = await resolveFigmaCredential(ORG, { db, key: TEST_KEY, ...G });
    ok("8c  ★ CONTROL: an OAuth row present makes the wrapper DIVERGE from resolveFigmaToken (not vacuous)",
       JSON.stringify(wrapped) !== JSON.stringify(direct) && wrapped.source === "oauth" && direct.source === "global");
  }
}

// ===========================================================================
section("9. THE PROVENANCE LINE — OAUTH GETS ITS OWN SENTENCE, EVERYTHING ELSE IS UNCHANGED");
// ===========================================================================
{
  // 9a. A pasted-token / global resolution is handed to the ORIGINAL function
  // untouched — assert byte-identical output, not just "similar wording".
  const globalRes = await resolveFigmaToken(null, { globalToken: FAKE_GLOBAL_TOKEN });
  ok("9a  a non-oauth resolution's line is BYTE-IDENTICAL to credentialProvenanceLine() itself",
     figmaCredentialProvenanceLine(globalRes) === credentialProvenanceLine(globalRes));

  // 9b. An oauth resolution gets a distinct sentence naming the connected account.
  const oauthRes = { source: "oauth", label: "acmedesigner", token: FAKE_ACCESS_TOKEN };
  const line = figmaCredentialProvenanceLine(oauthRes);
  console.log(`       oauth  -> ${line}`);
  ok("9b  the oauth line names the space's CONNECTED account", /this space's connected Figma account/.test(line) && line.includes("acmedesigner"));
  ok("9b  the oauth line does not read as a pasted token or the global fallback",
     !/this space's own token/.test(line) && !/global Mavlers token/.test(line));

  // 9c. Absence stated as absence: no label, still a readable sentence.
  const noLabel = figmaCredentialProvenanceLine({ source: "oauth", label: null });
  ok("9c  no figma handle/email on file -> still readable, no dangling punctuation", noLabel === "Figma credential: this space's connected Figma account");

  // 9d. osVoice: no em dash, pure ASCII, and never carries the token.
  for (const l of [line, noLabel]) {
    ok("9d  no em dash (osVoice house rule)", !l.includes("—"), l);
    ok("9d  pure ASCII", /^[\x20-\x7E]*$/.test(l), l);
    ok("9d  never carries the token", !l.includes(FAKE_ACCESS_TOKEN));
  }
}

console.log(`\n${"=".repeat(64)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
