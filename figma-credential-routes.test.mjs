/**
 * figma-credential-routes.test.mjs — THE WRITE PATH, THE READ SHAPE, AND THE
 * NEGATIVE AUTHORISATION CASE.
 * =============================================================================
 *
 * Run with:  node figma-credential-routes.test.mjs
 * No network, no Supabase, no credentials. The Figma call is injected.
 *
 * ★★ NO REAL TOKEN VALUE APPEARS IN THIS FILE. Every token-shaped string below
 * is a synthetic fixture built from a fixed alphabet. It is token-SHAPED on
 * purpose — a fixture that does not look like a secret cannot prove a detector
 * would have caught a secret — but it authenticates to nothing.
 *
 * ─── WHAT THIS SUITE IS FOR ────────────────────────────────────────────────
 * Three of this project's outages were an authorisation check that was written
 * correctly and READ incorrectly: maybeSingle() errored on a second row and
 * locked the owner out; limit(1) returned a truthy empty array and admitted
 * every Google account for a deploy; isOsAdmin fetched one arbitrary row and
 * broke when the owner reached six seats. Every one passed its positive test.
 *
 * So §2 is almost entirely NEGATIVE cases, and §2f feeds the gate the exact
 * empty array that caused the worst of the three.
 */

import assert from "node:assert";
import {
  createFigmaCredentialRoutes,
  createRequireSpaceAdmin,
  publicShape,
  sendSafe,
  parseFigmaFileKey,
  PUBLIC_COLUMNS,
  FIGMA_TEST_ENDPOINT,
  TEST_COOLDOWN_MS,
} from "./figma-credential-routes.js";
import { readKey, sealToken, openToken, isSealed, lastFour, SEAL_PREFIX } from "./figma-credential-crypto.js";
import { findTokenLeaks, looksLikeFigmaToken } from "./figma-credential.js";
import fs from "node:fs";

/**
 * ★ findTokenLeaks returns { ok, leaks }, NOT an array. Read as an array it
 * gives `undefined > 0` === false and `!== []` always — so BOTH possible
 * mistakes are silent, in opposite directions. It cost this suite a full red
 * run. Unwrapped ONCE, here, so no assertion below can repeat it.
 */
function leaksIn(text, secret) {
  return findTokenLeaks([text], { secrets: secret ? [secret] : [] }).leaks;
}

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS  " + name);
  } catch (err) {
    fail++;
    console.log("  FAIL  " + name + "\n        " + err.message);
  }
}
async function ta(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  PASS  " + name);
  } catch (err) {
    fail++;
    console.log("  FAIL  " + name + "\n        " + err.message);
  }
}

// ---------------------------------------------------------------------------
// FIXTURES — SYNTHETIC, AND SHAPED LIKE THE REAL THING ON PURPOSE.
// ---------------------------------------------------------------------------
const FAKE_TOKEN = "figd_" + "AbCdEf0123456789-_xyzQRSTUV0123456789abcd";
const FAKE_TOKEN_2 = "figd_" + "ZzYyXx9876543210-_lmnOPQRSTU9876543210wxyz";
// A 32-byte key, written as 64 hex characters. Not secret; it guards nothing.
const TEST_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const ORG = { id: "11111111-2222-3333-4444-555555555555", name: "Acme", slug: "acme", is_deleted: false };
const OTHER_ORG_ID = "99999999-8888-7777-6666-555555555555";

// ---------------------------------------------------------------------------
// A SUPABASE STUB THAT RECORDS WHAT IT WAS ASKED.
//
// ★ IT RECORDS THE SELECTED COLUMN LIST, because the single most dangerous
// mistake available on this table is select('*'), and a stub that only returns
// rows could not tell a correct query from that one.
// ---------------------------------------------------------------------------
function makeDb(handlers) {
  const calls = [];
  function builder(table, op, payload) {
    const state = { table, op, payload, cols: null, filters: {} };
    const b = {
      select(cols) {
        state.cols = cols;
        return b;
      },
      eq(k, v) {
        state.filters[k] = v;
        return b;
      },
      limit(n) {
        state.limit = n;
        return settle();
      },
      maybeSingle() {
        state.single = true;
        return settle();
      },
      then(resolve, reject) {
        return settle().then(resolve, reject);
      },
    };
    function settle() {
      calls.push({ ...state, filters: { ...state.filters } });
      const h = handlers[table + ":" + op] ?? handlers[table];
      const out = typeof h === "function" ? h(state) : h ?? { data: null, error: null };
      return Promise.resolve(out);
    }
    return b;
  }
  return {
    calls,
    from(table) {
      return {
        select: (cols) => builder(table, "select").select(cols),
        upsert: (row, opts) => builder(table, "upsert", { row, opts }),
        update: (row) => builder(table, "update", { row }),
      };
    },
  };
}

/** An express stand-in that records the handlers it was given. */
function makeApp() {
  const routes = {};
  const reg = (method) => (path, ...chain) => {
    routes[method + " " + path] = chain;
  };
  return { routes, get: reg("get"), put: reg("put"), delete: reg("delete"), post: reg("post") };
}

/** A res stand-in that records the status and the body. */
function makeRes() {
  const r = { statusCode: null, body: null };
  r.status = (s) => {
    r.statusCode = s;
    return r;
  };
  r.json = (b) => {
    r.body = b;
    return r;
  };
  return r;
}

/** A log stand-in that RECORDS EVERY CALL so §5 can scan them all for leaks. */
function makeLog() {
  const entries = [];
  const fn = (level, msg, extra) => entries.push({ level, msg, extra });
  fn.entries = entries;
  return fn;
}

/** Drive a middleware chain the way express would. */
async function run(chain, req, res) {
  for (const mw of chain) {
    let advanced = false;
    await mw(req, res, () => {
      advanced = true;
    });
    if (!advanced) return res;
  }
  return res;
}

/** Everything except requireAuth, which the tests stand in for directly. */
const passAuth = (req, res, next) => next();

function mount(handlers, { env = { FIGMA_CRED_KEY: TEST_KEY_HEX }, fetchImpl = null } = {}) {
  const app = makeApp();
  const db = makeDb(handlers);
  const log = makeLog();
  createFigmaCredentialRoutes({ app, supabaseAdmin: db, requireAuth: passAuth, log, env, fetchImpl });
  return { app, db, log };
}

/** The handler set for "acme exists and <email> holds an admin seat in it". */
function seatedAs(email, extra = {}) {
  return {
    orgs: () => ({ data: ORG, error: null }),
    email_allowlist: (s) =>
      s.filters.email === email && s.filters.org_id === ORG.id && s.filters.is_owner === true
        ? { data: [{ email }], error: null }
        : { data: [], error: null },
    ...extra,
  };
}

const ADMIN = "admin@acme.example";
function reqAs(email, body = {}) {
  return { params: { slug: "acme" }, user: { email }, body };
}

console.log("\n=== 1. THE SEAL — MAKING log_statement IRRELEVANT ===\n");

t("1a  a sealed value does not contain the token", () => {
  const { key } = readKey(TEST_KEY_HEX);
  const s = sealToken(FAKE_TOKEN, key);
  assert.ok(s.ok, "seal failed: " + s.error);
  assert.ok(!s.sealed.includes(FAKE_TOKEN), "the sealed value contains the plaintext");
  // AND the shape detector must not see a token in it either — this is what a
  // Postgres statement log would hold.
  assert.equal(looksLikeFigmaToken(s.sealed), false, "the sealed value is still token-shaped");
});

t("1a  ...and findTokenLeaks is CLEAN on a log line carrying the sealed value", () => {
  const { key } = readKey(TEST_KEY_HEX);
  const s = sealToken(FAKE_TOKEN, key);
  const pgLogLine =
    "LOG:  execute <unnamed>: INSERT INTO org_figma_credentials ...\n" +
    "DETAIL:  parameters: $1 = '" + s.sealed + "', $2 = 'Acme design account'";
  assert.deepEqual(leaksIn(pgLogLine, FAKE_TOKEN), []);
});

t("1a  >>> FAILS FIRST: the same Postgres log line WITH the plaintext is RED", () => {
  // ★ THE CONTROL. Without this, the green above could mean the detector is
  // blind rather than the value is safe. This is the line Postgres WOULD write
  // under log_statement='mod' or 'all' if the token were bound unsealed.
  const pgLogLine =
    "LOG:  execute <unnamed>: INSERT INTO org_figma_credentials ...\n" +
    "DETAIL:  parameters: $1 = '" + FAKE_TOKEN + "', $2 = 'Acme design account'";
  const leaks = leaksIn(pgLogLine, FAKE_TOKEN);
  assert.ok(leaks.length > 0, "the detector did NOT see a plaintext token in a statement log line");
});

t("1b  a sealed value opens back to exactly the token", () => {
  const { key } = readKey(TEST_KEY_HEX);
  const s = sealToken(FAKE_TOKEN, key);
  const o = openToken(s.sealed, key);
  assert.ok(o.ok);
  assert.equal(o.token, FAKE_TOKEN);
  assert.equal(o.wasSealed, true);
});

t("1c  a DIFFERENT key cannot open it, and says so without saying why", () => {
  const { key } = readKey(TEST_KEY_HEX);
  const other = readKey("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff").key;
  const s = sealToken(FAKE_TOKEN, key);
  const o = openToken(s.sealed, other);
  assert.equal(o.ok, false);
  assert.equal(o.token, null);
  assert.ok(!o.error.includes(FAKE_TOKEN));
});

t("1d  a TAMPERED ciphertext fails to open rather than opening to garbage", () => {
  // Why GCM and not CBC: garbage that happens to begin figd_ would be SENT TO
  // FIGMA. The auth tag makes that impossible rather than unlikely.
  const { key } = readKey(TEST_KEY_HEX);
  const s = sealToken(FAKE_TOKEN, key);
  const parts = s.sealed.slice(SEAL_PREFIX.length).split(".");
  const ct = Buffer.from(parts[2], "base64url");
  ct[0] ^= 0xff;
  const tampered = SEAL_PREFIX + parts[0] + "." + parts[1] + "." + ct.toString("base64url");
  assert.equal(openToken(tampered, key).ok, false);
});

t("1e  two seals of the SAME token differ (the IV is per-call, never reused)", () => {
  const { key } = readKey(TEST_KEY_HEX);
  const a = sealToken(FAKE_TOKEN, key).sealed;
  const b = sealToken(FAKE_TOKEN, key).sealed;
  assert.notEqual(a, b, "IV REUSE: two seals of one value are identical under GCM");
});

t("1f  a PLAINTEXT row still opens (a row written before sealing existed)", () => {
  const { key } = readKey(TEST_KEY_HEX);
  const o = openToken(FAKE_TOKEN, key);
  assert.ok(o.ok);
  assert.equal(o.token, FAKE_TOKEN);
  assert.equal(o.wasSealed, false, "a plaintext value must report wasSealed=false, not guess");
});

t("1g  double-sealing is refused (it would be silent data loss, not a leak)", () => {
  const { key } = readKey(TEST_KEY_HEX);
  const once = sealToken(FAKE_TOKEN, key).sealed;
  assert.equal(sealToken(once, key).ok, false);
  assert.equal(isSealed(once), true);
});

t("1h  a missing or wrong-length key is REFUSED and the message names the env var", () => {
  assert.equal(readKey("").ok, false);
  assert.ok(readKey("").error.includes("FIGMA_CRED_KEY"));
  assert.equal(readKey("tooshort").ok, false);
  // ...and the refusal never echoes what it was given.
  assert.ok(!readKey("secretish-value").error.includes("secretish-value"));
});

t("1i  lastFour is four characters from the END, never the figd_ prefix", () => {
  assert.equal(lastFour(FAKE_TOKEN), FAKE_TOKEN.slice(-4));
  assert.equal(lastFour(FAKE_TOKEN).length, 4);
  assert.ok(!lastFour(FAKE_TOKEN).includes("figd"));
  assert.equal(lastFour("short"), null, "too short must be ABSENT, not padded");
});

console.log("\n=== 2. AUTHORISATION — THE NEGATIVE CASES FIRST ===\n");

async function gate(handlers, email) {
  const log = makeLog();
  const mw = createRequireSpaceAdmin({ supabaseAdmin: makeDb(handlers), log });
  const res = makeRes();
  let advanced = false;
  const req = reqAs(email);
  await mw(req, res, () => {
    advanced = true;
  });
  return { advanced, res, req, log };
}

await ta("2a  POSITIVE: an admin seat IN THIS SPACE is admitted", async () => {
  const g = await gate(seatedAs(ADMIN), ADMIN);
  assert.equal(g.advanced, true, "a genuine space admin was refused");
  assert.equal(g.req.space.id, ORG.id);
});

await ta("2b  NEGATIVE: a stranger with no seat anywhere is 403", async () => {
  const g = await gate(seatedAs(ADMIN), "stranger@example.com");
  assert.equal(g.advanced, false);
  assert.equal(g.res.statusCode, 403);
});

await ta("2c  NEGATIVE: a MEMBER of this space (is_owner=false) is 403", async () => {
  const member = "member@acme.example";
  const handlers = {
    orgs: () => ({ data: ORG, error: null }),
    // The row exists, but not with is_owner=true, so the FILTERED query is empty.
    email_allowlist: (s) => (s.filters.is_owner === true ? { data: [], error: null } : { data: [{ email: member }], error: null }),
  };
  const g = await gate(handlers, member);
  assert.equal(g.advanced, false);
  assert.equal(g.res.statusCode, 403);
});

await ta("2d  ★ NEGATIVE: an ADMIN OF ANOTHER SPACE is 403 (the isOsAdmin bug)", async () => {
  // ★★ THIS IS THE CASE isOsAdmin WOULD HAVE ADMITTED. It asks "do you hold an
  // owner seat ANYWHERE", and this person does — in a different space. Reused
  // verbatim it would have let them install a credential on Acme.
  const foreign = "admin@other.example";
  const handlers = {
    orgs: () => ({ data: ORG, error: null }),
    email_allowlist: (s) =>
      // They hold an owner seat, but org_id is a DIFFERENT space.
      s.filters.org_id === OTHER_ORG_ID ? { data: [{ email: foreign }], error: null } : { data: [], error: null },
  };
  const g = await gate(handlers, foreign);
  assert.equal(g.advanced, false, "an admin of ANOTHER space was admitted to this one");
  assert.equal(g.res.statusCode, 403);
});

await ta("2e  ...and the gate PROVES it asked for org_id, not just for a seat", async () => {
  // A green on 2d could also mean the stub happened to return []. This asserts
  // the query SHAPE: all three filters present.
  const handlers = seatedAs(ADMIN);
  const db = makeDb(handlers);
  const mw = createRequireSpaceAdmin({ supabaseAdmin: db, log: makeLog() });
  await mw(reqAs(ADMIN), makeRes(), () => {});
  const seatQ = db.calls.find((c) => c.table === "email_allowlist");
  assert.ok(seatQ, "no email_allowlist query was made at all");
  assert.equal(seatQ.filters.org_id, ORG.id, "the seat query is NOT scoped to this space");
  assert.equal(seatQ.filters.is_owner, true, "the question is not in the filter");
  assert.equal(seatQ.filters.email, ADMIN);
  assert.equal(seatQ.single, undefined, "maybeSingle() on email_allowlist — the owner-lockout bug");
});

await ta("2f  ★ NEGATIVE: an EMPTY ARRAY denies (the truthy-[] bug, fed directly)", async () => {
  // limit(1) returns an ARRAY. `!!data` on [] is TRUE, and for one deploy that
  // admitted every signed-in Google account. Fed here verbatim.
  const handlers = { orgs: () => ({ data: ORG, error: null }), email_allowlist: () => ({ data: [], error: null }) };
  const g = await gate(handlers, ADMIN);
  assert.equal(g.advanced, false, "an empty array was read as a permission");
  assert.equal(g.res.statusCode, 403);
});

await ta("2g  NEGATIVE: a seat-lookup ERROR denies (no fail-open branch)", async () => {
  const handlers = {
    orgs: () => ({ data: ORG, error: null }),
    email_allowlist: () => ({ data: null, error: { message: "boom", code: "08006" } }),
  };
  const g = await gate(handlers, ADMIN);
  assert.equal(g.advanced, false);
  assert.equal(g.res.statusCode, 503);
});

await ta("2h  NEGATIVE: a missing is_owner column denies, and names the migration", async () => {
  const handlers = {
    orgs: () => ({ data: ORG, error: null }),
    email_allowlist: () => ({ data: null, error: { message: "column does not exist", code: "42703" } }),
  };
  const g = await gate(handlers, ADMIN);
  assert.equal(g.advanced, false);
  assert.equal(g.res.statusCode, 503);
  assert.ok(String(g.res.body.details).includes("20260808_0001_order_close.sql"));
});

await ta("2i  NEGATIVE: no email claim at all is 403", async () => {
  const g = await gate(seatedAs(ADMIN), "");
  assert.equal(g.advanced, false);
  assert.equal(g.res.statusCode, 403);
});

await ta("2j  NEGATIVE: an unknown space is 404, and a CLOSED space is 404 not 403", async () => {
  const none = await gate({ orgs: () => ({ data: null, error: null }) }, ADMIN);
  assert.equal(none.res.statusCode, 404);
  const closed = await gate({ orgs: () => ({ data: { ...ORG, is_deleted: true }, error: null }) }, ADMIN);
  assert.equal(closed.res.statusCode, 404, "a closed space must not read as a permission failure");
});

await ta("2k  a 403 body never contains a token-shaped value", async () => {
  const g = await gate(seatedAs(ADMIN), "stranger@example.com");
  assert.deepEqual(leaksIn(JSON.stringify(g.res.body), FAKE_TOKEN), []);
});

console.log("\n=== 3. WRITE-ONLY — ENFORCED BY THE SHAPE ===\n");

t("3a  PUBLIC_COLUMNS does not name `token`", () => {
  const cols = PUBLIC_COLUMNS.split(",").map((s) => s.trim());
  assert.ok(!cols.includes("token"), "PUBLIC_COLUMNS names the secret");
  assert.ok(cols.includes("token_last4"), "the masked hint is missing");
  assert.ok(cols.includes("expires_at"), "expiry is missing from the read shape");
});

t("3b  ★ THE SOURCE CONTAINS NO select('*') ANYWHERE", () => {
  // Run 1 named this as the one leak its gate could not catch for run 2. It is
  // caught textually, because it is a textual mistake.
  const src = fs.readFileSync(new URL("./figma-credential-routes.js", import.meta.url), "utf8");
  assert.ok(!/\.select\(\s*['"`]\*/.test(src), "a select('*') is present on the credential table");
});

t("3c  publicShape DROPS a token even when the row carries one", () => {
  // ★ THE CASE THAT MATTERS. If a future query does select a token, the shape
  // must still not publish it. This is the second of the four independent
  // structures, tested independently.
  const out = publicShape({ org_id: ORG.id, token: FAKE_TOKEN, label: "Acme", token_last4: "abcd", expires_at: null });
  assert.equal(out.token, undefined);
  assert.deepEqual(leaksIn(JSON.stringify(out), FAKE_TOKEN), []);
  assert.equal(out.hint, "abcd");
});

t("3d  ...and it is not vacuous: the ROW it was given DOES contain the token", () => {
  // Without this, 3c would be green if publicShape returned {}.
  const row = { org_id: ORG.id, token: FAKE_TOKEN, label: "Acme" };
  assert.ok(leaksIn(JSON.stringify(row), FAKE_TOKEN).length > 0);
  assert.equal(publicShape(row).label, "Acme", "publicShape returned nothing at all");
});

t("3e  ★ sendSafe BLOCKS a response carrying a token, with a 500", () => {
  const res = makeRes();
  const log = makeLog();
  sendSafe(res, 200, { credential: { label: "Acme", token: FAKE_TOKEN } }, log);
  assert.equal(res.statusCode, 500, "a token-carrying body was SENT");
  assert.deepEqual(leaksIn(JSON.stringify(res.body), FAKE_TOKEN), []);
});

t("3f  ...and sendSafe's own log line does not contain the token either", () => {
  const log = makeLog();
  sendSafe(makeRes(), 200, { token: FAKE_TOKEN }, log);
  const all = log.entries.map((e) => JSON.stringify(e)).join("\n");
  assert.deepEqual(leaksIn(all, FAKE_TOKEN), [], "the leak REPORT leaked the value");
  assert.ok(all.includes("BLOCKED"), "the block was not logged at all");
});

t("3g  sendSafe passes a clean body through unchanged", () => {
  const res = makeRes();
  sendSafe(res, 200, { credential: { label: "Acme", hint: "abcd" } }, makeLog());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.credential.hint, "abcd");
});

console.log("\n=== 4. THE ROUTES END TO END ===\n");

await ta("4a  GET states ABSENCE as absence, and says what happens instead", async () => {
  const { app, log } = mount(seatedAs(ADMIN, { [`org_figma_credentials:select`]: () => ({ data: null, error: null }) }));
  const res = await run(app.routes["get /os/spaces/:slug/figma-credential"], reqAs(ADMIN), makeRes());
  assert.equal(res.statusCode, 200, "absence answered " + res.statusCode + " instead of stating itself");
  assert.equal(res.body.credential, null);
  assert.ok(/Mavlers Figma token/.test(res.body.fallback), "the fallback is not stated");
});

await ta("4b  GET selects an EXPLICIT column list that omits token", async () => {
  const { app, db } = mount(seatedAs(ADMIN, { [`org_figma_credentials:select`]: () => ({ data: null, error: null }) }));
  await run(app.routes["get /os/spaces/:slug/figma-credential"], reqAs(ADMIN), makeRes());
  const q = db.calls.find((c) => c.table === "org_figma_credentials");
  assert.ok(q, "no read was made");
  assert.ok(!q.cols.includes("*"), "select('*')");
  assert.ok(!q.cols.split(",").includes("token"), "the read asked for the token column");
});

await ta("4c  ★ PUT REFUSES with 503 when no sealing key is set — it never downgrades", async () => {
  const { app } = mount(seatedAs(ADMIN), { env: {} });
  const res = await run(
    app.routes["put /os/spaces/:slug/figma-credential"],
    reqAs(ADMIN, { token: FAKE_TOKEN, label: "Acme design account" }),
    makeRes(),
  );
  assert.equal(res.statusCode, 503, "the write proceeded UNSEALED with no key configured");
  assert.ok(res.body.details.includes("FIGMA_CRED_KEY"));
});

await ta("4d  ★ PUT BINDS CIPHERTEXT, NOT THE TOKEN", async () => {
  let bound = null;
  const { app } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:upsert": (s) => {
        bound = s.payload.row;
        return { data: null, error: null };
      },
      "org_figma_credentials:select": () => ({ data: null, error: null }),
    }),
  );
  await run(
    app.routes["put /os/spaces/:slug/figma-credential"],
    reqAs(ADMIN, { token: FAKE_TOKEN, label: "Acme design account", tokenKind: "personal" }),
    makeRes(),
  );
  assert.ok(bound, "nothing was written");
  assert.notEqual(bound.token, FAKE_TOKEN, "THE PLAINTEXT TOKEN WAS BOUND INTO THE INSERT");
  assert.ok(isSealed(bound.token), "the bound value is not sealed");
  // ★ AND THE WHOLE BOUND ROW is clean — this is what a statement log would hold.
  assert.deepEqual(leaksIn(JSON.stringify(bound), FAKE_TOKEN), []);
  assert.equal(bound.token_last4, FAKE_TOKEN.slice(-4));
  assert.equal(bound.created_by, ADMIN);
});

await ta("4e  ...and what was bound OPENS back to the token (4d is not green by emptiness)", async () => {
  let bound = null;
  const { app } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:upsert": (s) => {
        bound = s.payload.row;
        return { data: null, error: null };
      },
      "org_figma_credentials:select": () => ({ data: null, error: null }),
    }),
  );
  await run(
    app.routes["put /os/spaces/:slug/figma-credential"],
    reqAs(ADMIN, { token: FAKE_TOKEN, label: "Acme design account" }),
    makeRes(),
  );
  const { key } = readKey(TEST_KEY_HEX);
  assert.equal(openToken(bound.token, key).token, FAKE_TOKEN, "the stored value does not round-trip");
});

await ta("4f  PUT's RESPONSE carries no token", async () => {
  const stored = { org_id: ORG.id, label: "Acme design account", token_last4: "abcd", expires_at: null, is_active: true };
  const { app } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:upsert": () => ({ data: null, error: null }),
      "org_figma_credentials:select": () => ({ data: stored, error: null }),
    }),
  );
  const res = await run(
    app.routes["put /os/spaces/:slug/figma-credential"],
    reqAs(ADMIN, { token: FAKE_TOKEN, label: "Acme design account" }),
    makeRes(),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(leaksIn(JSON.stringify(res.body), FAKE_TOKEN), []);
  assert.equal(res.body.credential.hint, "abcd");
});

await ta("4g  PUT rejects a non-figd_ value WITHOUT echoing it", async () => {
  const notAToken = "sk-live-please-do-not-echo-me";
  const { app } = mount(seatedAs(ADMIN));
  const res = await run(
    app.routes["put /os/spaces/:slug/figma-credential"],
    reqAs(ADMIN, { token: notAToken, label: "Acme" }),
    makeRes(),
  );
  assert.equal(res.statusCode, 400);
  assert.ok(!JSON.stringify(res.body).includes(notAToken), "the rejected value was echoed back");
});

await ta("4h  PUT requires a label — the token is never shown again", async () => {
  const { app } = mount(seatedAs(ADMIN));
  const res = await run(
    app.routes["put /os/spaces/:slug/figma-credential"],
    reqAs(ADMIN, { token: FAKE_TOKEN, label: "   " }),
    makeRes(),
  );
  assert.equal(res.statusCode, 400);
});

await ta("4i  PUT refuses an expiry that has ALREADY passed", async () => {
  const { app } = mount(seatedAs(ADMIN));
  const res = await run(
    app.routes["put /os/spaces/:slug/figma-credential"],
    reqAs(ADMIN, { token: FAKE_TOKEN, label: "Acme", expiresAt: "2020-01-01" }),
    makeRes(),
  );
  assert.equal(res.statusCode, 400);
  assert.ok(/already passed/.test(res.body.error));
});

await ta("4j  PUT accepts NO expiry — null means none declared, not expired", async () => {
  let bound = null;
  const { app } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:upsert": (s) => {
        bound = s.payload.row;
        return { data: null, error: null };
      },
      "org_figma_credentials:select": () => ({ data: null, error: null }),
    }),
  );
  const res = await run(
    app.routes["put /os/spaces/:slug/figma-credential"],
    reqAs(ADMIN, { token: FAKE_TOKEN, label: "Acme" }),
    makeRes(),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(bound.expires_at, null);
});

await ta("4k  a NEW credential clears the previous test result", async () => {
  let bound = null;
  const { app } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:upsert": (s) => {
        bound = s.payload.row;
        return { data: null, error: null };
      },
      "org_figma_credentials:select": () => ({ data: null, error: null }),
    }),
  );
  await run(app.routes["put /os/spaces/:slug/figma-credential"], reqAs(ADMIN, { token: FAKE_TOKEN_2, label: "New" }), makeRes());
  assert.equal(bound.last_test_ok, null, "a new token inherited the old token's pass");
});

await ta("4l  a MISSING TABLE is a 503 naming the SQL files, not a 500", async () => {
  const { app } = mount(seatedAs(ADMIN, { "org_figma_credentials:select": () => ({ data: null, error: { code: "42P01", message: "relation does not exist" } }) }));
  const res = await run(app.routes["get /os/spaces/:slug/figma-credential"], reqAs(ADMIN), makeRes());
  assert.equal(res.statusCode, 503);
  assert.ok(res.body.details.includes("org_figma_credentials.sql"));
});

await ta("4m  a MISSING token_last4 column degrades: it stores, and SAYS the hint is missing", async () => {
  let attempts = 0;
  const { app } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:upsert": () => {
        attempts++;
        return attempts === 1 ? { data: null, error: { code: "42703", message: "token_last4 does not exist" } } : { data: null, error: null };
      },
      "org_figma_credentials:select": (s) =>
        s.cols.includes("token_last4")
          ? { data: null, error: { code: "42703", message: "no" } }
          : { data: { org_id: ORG.id, label: "Acme", is_active: true }, error: null },
    }),
  );
  const res = await run(app.routes["put /os/spaces/:slug/figma-credential"], reqAs(ADMIN, { token: FAKE_TOKEN, label: "Acme" }), makeRes());
  assert.equal(res.statusCode, 200, "a missing optional column broke the write");
  assert.equal(res.body.migrationPending, "org_figma_credentials_run2.sql");
  assert.equal(res.body.credential.hint, null, "a hint was invented for a column that does not exist");
});

await ta("4n  DELETE revokes by flag, overwrites the value, and reports the fallback", async () => {
  let updated = null;
  const { app } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:update": (s) => {
        updated = s.payload.row;
        return { data: [{ org_id: ORG.id, label: "Acme", is_active: false }], error: null };
      },
    }),
  );
  const res = await run(app.routes["delete /os/spaces/:slug/figma-credential"], reqAs(ADMIN), makeRes());
  assert.equal(res.statusCode, 200);
  assert.equal(updated.is_active, false);
  assert.notEqual(updated.token, undefined, "the token value was left in place on a revoked row");
  assert.ok(!isSealed(updated.token), "the revoked row still holds a sealed credential");
  assert.ok(/Mavlers Figma token/.test(res.body.fallback));
});

await ta("4o  ★ DELETE does NOT report success on a 200 with zero rows", async () => {
  // AdminConsole's rule: RLS filters rows before triggers fire, so a forbidden
  // UPDATE answers 200 with []. In a permissions table that reads as success.
  const { app } = mount(seatedAs(ADMIN, { "org_figma_credentials:update": () => ({ data: [], error: null }) }));
  const res = await run(app.routes["delete /os/spaces/:slug/figma-credential"], reqAs(ADMIN), makeRes());
  assert.equal(res.statusCode, 404, "an empty result was reported as a successful revoke");
});

console.log("\n=== 5. THE TEST BUTTON, AND ITS COST ===\n");

await ta("5a  the endpoint called is /v1/me, with the token in a HEADER not a query", async () => {
  let seen = null;
  const { app } = mount(seatedAs(ADMIN), {
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, json: async () => ({ email: "designer@acme.example", handle: "acme" }) };
    },
  });
  const res = await run(app.routes["post /os/spaces/:slug/figma-credential/test"], reqAs(ADMIN, { token: FAKE_TOKEN }), makeRes());
  assert.equal(seen.url, FIGMA_TEST_ENDPOINT);
  assert.equal(seen.url, "https://api.figma.com/v1/me");
  // ★ A URL IS A LOG SURFACE. A token in a query string lands in every proxy log
  // between here and Figma.
  assert.ok(!seen.url.includes(FAKE_TOKEN), "the token was put in the URL");
  assert.equal(seen.opts.headers["X-Figma-Token"], FAKE_TOKEN);
  assert.equal(res.body.auth.ok, true);
});

await ta("5b  ONE call when no file URL is given — the cheapest possible test", async () => {
  let calls = 0;
  const { app } = mount(seatedAs(ADMIN), {
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await run(app.routes["post /os/spaces/:slug/figma-credential/test"], reqAs(ADMIN, { token: FAKE_TOKEN }), makeRes());
  assert.equal(calls, 1, "the test button spent " + calls + " of the client's rate limit, not 1");
});

await ta("5c  the file check uses depth=1, and is reported SEPARATELY from auth", async () => {
  const urls = [];
  const { app } = mount(seatedAs(ADMIN), {
    fetchImpl: async (url) => {
      urls.push(url);
      // Auth passes; the FILE is not visible to this token.
      if (url.includes("/v1/me")) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  const res = await run(
    app.routes["post /os/spaces/:slug/figma-credential/test"],
    reqAs(ADMIN, { token: FAKE_TOKEN, figmaUrl: "https://www.figma.com/design/AbCdEfGhIjKl1234/Spec" }),
    makeRes(),
  );
  assert.ok(urls[1].includes("depth=1"), "the file read is not the cheapest form");
  // ★ THE ANSWER THAT ACTUALLY HELPS: valid token, invisible file. A merged
  // pass/fail would destroy exactly this distinction.
  assert.equal(res.body.auth.ok, true);
  assert.equal(res.body.file.ok, false);
  assert.ok(/not visible/.test(res.body.file.note));
});

// ★ RUN 8. Both test-route calls now pick their header through figmaAuthHeaders.
// A pasted figd_ token must send EXACTLY what it sent before: X-Figma-Token, and
// NO Authorization header. REGRESSION GUARDS: these pass on the old code too.
await ta("5c2 ★ run 8: figd_ on /v1/me -> X-Figma-Token, and NO Authorization", async () => {
  let seen = null;
  const { app } = mount(seatedAs(ADMIN), {
    fetchImpl: async (url, opts) => { seen = opts; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  await run(app.routes["post /os/spaces/:slug/figma-credential/test"], reqAs(ADMIN, { token: FAKE_TOKEN }), makeRes());
  assert.equal(seen.headers["X-Figma-Token"], FAKE_TOKEN);
  assert.ok(!Object.keys(seen.headers).some((k) => k.toLowerCase() === "authorization"), "an Authorization header was added to a pasted token");
});

await ta("5c3 ★ run 8: figd_ on the /v1/files check -> X-Figma-Token, and NO Authorization", async () => {
  const calls = [];
  const { app } = mount(seatedAs(ADMIN), {
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; },
  });
  await run(
    app.routes["post /os/spaces/:slug/figma-credential/test"],
    reqAs(ADMIN, { token: FAKE_TOKEN, figmaUrl: "https://www.figma.com/design/AbCdEfGhIjKl1234/Spec" }),
    makeRes(),
  );
  const fileCall = calls.find((c) => c.url.includes("/v1/files/"));
  assert.ok(fileCall, "the file check did not run");
  assert.equal(fileCall.opts.headers["X-Figma-Token"], FAKE_TOKEN);
  assert.ok(!Object.keys(fileCall.opts.headers).some((k) => k.toLowerCase() === "authorization"), "an Authorization header was added to a pasted token");
});

await ta("5dFigma's response body is never echoed into ours", async () => {
  const { app } = mount(seatedAs(ADMIN), {
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ err: "Invalid token " + FAKE_TOKEN }),
    }),
  });
  const res = await run(app.routes["post /os/spaces/:slug/figma-credential/test"], reqAs(ADMIN, { token: FAKE_TOKEN }), makeRes());
  assert.deepEqual(leaksIn(JSON.stringify(res.body), FAKE_TOKEN), [], "Figma's error text carried the token into our response");
  assert.ok(/refused/.test(res.body.auth.note));
});

await ta("5e  the COOLDOWN is enforced server-side, not only in the UI", async () => {
  const { key } = readKey(TEST_KEY_HEX);
  const sealed = sealToken(FAKE_TOKEN, key).sealed;
  let calls = 0;
  const { app } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:select": () => ({
        data: { token: sealed, is_active: true, last_test_at: new Date().toISOString() },
        error: null,
      }),
    }),
    {
      fetchImpl: async () => {
        calls++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
  );
  const res = await run(app.routes["post /os/spaces/:slug/figma-credential/test"], reqAs(ADMIN, {}), makeRes());
  assert.equal(res.statusCode, 429);
  assert.equal(calls, 0, "the cooldown did not stop the call — the client's quota was spent");
  assert.ok(TEST_COOLDOWN_MS >= 30_000);
});

await ta("5f  testing the STORED credential never returns it", async () => {
  const { key } = readKey(TEST_KEY_HEX);
  const sealed = sealToken(FAKE_TOKEN, key).sealed;
  const { app } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:select": () => ({ data: { token: sealed, is_active: true, last_test_at: null }, error: null }),
      "org_figma_credentials:update": () => ({ data: [], error: null }),
    }),
    { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  );
  const res = await run(app.routes["post /os/spaces/:slug/figma-credential/test"], reqAs(ADMIN, {}), makeRes());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.testing, "stored");
  assert.deepEqual(leaksIn(JSON.stringify(res.body), FAKE_TOKEN), []);
});

await ta("5g  nothing to test is 404 with a sentence, not a crash", async () => {
  const { app } = mount(seatedAs(ADMIN, { "org_figma_credentials:select": () => ({ data: null, error: null }) }));
  const res = await run(app.routes["post /os/spaces/:slug/figma-credential/test"], reqAs(ADMIN, {}), makeRes());
  assert.equal(res.statusCode, 404);
});

t("5h  parseFigmaFileKey reads both /file/ and /design/, and rejects junk", () => {
  assert.equal(parseFigmaFileKey("https://www.figma.com/design/AbCdEfGhIjKl1234/X"), "AbCdEfGhIjKl1234");
  assert.equal(parseFigmaFileKey("https://www.figma.com/file/AbCdEfGhIjKl1234/X"), "AbCdEfGhIjKl1234");
  assert.equal(parseFigmaFileKey("https://example.com/nope"), null);
  assert.equal(parseFigmaFileKey(null), null);
});

console.log("\n=== 6. log() — THE NAMED LEAK POINT AT server.js:4365 ===\n");

// ★★ THE BRIEF'S REQUIREMENT. log() JSON-stringifies its extras with NO
// REDACTION, so ANY call handed the token writes it to Railway verbatim. These
// tests capture EVERY log call this module makes across every route and scan the
// lot — rather than reasoning about each call site by eye.

await ta("6a  EVERY log() call on the WRITE path is clean", async () => {
  const { app, log } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:upsert": () => ({ data: null, error: null }),
      "org_figma_credentials:select": () => ({ data: { org_id: ORG.id, label: "Acme", token_last4: "abcd" }, error: null }),
    }),
  );
  await run(
    app.routes["put /os/spaces/:slug/figma-credential"],
    reqAs(ADMIN, { token: FAKE_TOKEN, label: "Acme design account", expiresAt: "2099-01-01" }),
    makeRes(),
  );
  assert.ok(log.entries.length > 0, "no log call was made at all — this test would pass vacuously");
  // The extras are stringified exactly as server.js:4365 does it.
  const asRailwayWouldWriteIt = log.entries.map((e) => JSON.stringify({ level: e.level, msg: e.msg, ...e.extra })).join("\n");
  assert.deepEqual(leaksIn(asRailwayWouldWriteIt, FAKE_TOKEN), [], "a token reached log()");
});

await ta("6b  ★ the FAILING write logs a Postgres error containing the SEALED value — still clean", async () => {
  // The realistic hazard: a Postgres error message quotes the failing value, and
  // that message goes straight into log() extras. Because the bound value is
  // ciphertext, the quoted value is ciphertext.
  const { key } = readKey(TEST_KEY_HEX);
  let sealedSeen = null;
  const { app, log } = mount(
    seatedAs(ADMIN, {
      "org_figma_credentials:upsert": (s) => {
        sealedSeen = s.payload.row.token;
        return { data: null, error: { code: "23505", message: 'duplicate key value: (token)=(' + s.payload.row.token + ")" } };
      },
    }),
  );
  const res = await run(
    app.routes["put /os/spaces/:slug/figma-credential"],
    reqAs(ADMIN, { token: FAKE_TOKEN, label: "Acme" }),
    makeRes(),
  );
  assert.equal(res.statusCode, 500);
  assert.ok(isSealed(sealedSeen), "the value quoted in the error was not sealed");
  const asRailwayWouldWriteIt = log.entries.map((e) => JSON.stringify({ level: e.level, msg: e.msg, ...e.extra })).join("\n");
  assert.deepEqual(leaksIn(asRailwayWouldWriteIt, FAKE_TOKEN), []);
  // ...and it reached the response body too, still clean.
  assert.deepEqual(leaksIn(JSON.stringify(res.body), FAKE_TOKEN), []);
});

await ta("6c  EVERY log() call on the TEST path is clean", async () => {
  const { app, log } = mount(seatedAs(ADMIN), {
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ err: FAKE_TOKEN }) }),
  });
  await run(app.routes["post /os/spaces/:slug/figma-credential/test"], reqAs(ADMIN, { token: FAKE_TOKEN }), makeRes());
  assert.ok(log.entries.length > 0);
  const asRailwayWouldWriteIt = log.entries.map((e) => JSON.stringify({ level: e.level, msg: e.msg, ...e.extra })).join("\n");
  assert.deepEqual(leaksIn(asRailwayWouldWriteIt, FAKE_TOKEN), []);
});

await ta("6d  >>> FAILS FIRST: the same capture-and-scan IS red on a planted token", async () => {
  // ★ THE CONTROL FOR ALL OF §6. Without it, 6a-6c could be green because the
  // scan is pointed at nothing. A deliberately bad log call is made and caught.
  const log = makeLog();
  log("info", "figma-credential: stored", { slug: "acme", token: FAKE_TOKEN });
  const asRailwayWouldWriteIt = log.entries.map((e) => JSON.stringify({ level: e.level, msg: e.msg, ...e.extra })).join("\n");
  assert.ok(
    leaksIn(asRailwayWouldWriteIt, FAKE_TOKEN).length > 0,
    "the log scanner is BLIND — every green in section 6 is vacuous",
  );
});

console.log("\n=== 7. THE WIRING - WHAT ACTUALLY MOUNTS AND CALLS THIS ===\n");

// ★★ INVERTED BY RUN 4, FOR THE REASON 7b WAS INVERTED BY RUN 3.
// Runs 1-3 left this reading "NOTHING imports figma-credential-routes", which was
// true and was the whole problem: four routes, a console field, a test button and
// a sealing layer were all unreachable because no line mounted them. That line now
// exists, so the assertion is turned around rather than removed - it is the thing
// that goes red if anyone ever unmounts it again.
//
// ★ IT CHECKS THE CALL, NOT THE IMPORT. An import alone registers no route. The
// factory takes the app as an argument, so an `import` with no matching call is a
// dead reference that would leave every route 404 while this test read green.
await ta("7a  server.js MOUNTS the credential routes (import AND call)", async () => {
  const src = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");

  assert.ok(
    /import \{[^}]*createFigmaCredentialRoutes[^}]*\} from "\.\/figma-credential-routes\.js";/.test(src),
    "server.js no longer imports createFigmaCredentialRoutes - all four routes are 404 again",
  );

  // THE MOUNT ITSELF. Same argument shape as createSpacesRoutes, which is the
  // module this one was matched to.
  const mount = src.split(/\r?\n/).find((l) => /^createFigmaCredentialRoutes\(\{/.test(l.trim()));
  assert.ok(mount, "server.js imports the factory but never calls it - a dead reference, every route still 404");
  for (const arg of ["app", "supabaseAdmin", "requireAuth", "log"]) {
    assert.ok(
      new RegExp("\\b" + arg + "\\b").test(mount),
      `the mount does not pass ${arg}: ${mount.trim()}`,
    );
  }

  // NON-VACUITY: the same scan must FIND the module it was modelled on. If this
  // ever stopped matching, the checks above would be testing a regex, not a file.
  assert.ok(
    /^createSpacesRoutes\(\{/.test((src.split(/\r?\n/).find((l) => /^createSpacesRoutes\(\{/.test(l.trim())) || "").trim()),
    "the scan cannot even find createSpacesRoutes - every assertion above is vacuous",
  );
});

// The module must still be MOUNTED by ONE file and no other. A second mount
// would register all four routes twice, and the duplicate would answer some
// requests.
//
// ★ FIGMA OAUTH RUN 1 adds a SECOND, NON-MOUNTING importer: figma-oauth-
// routes.js reuses createRequireSpaceAdmin and sendSafe from this file (the
// SAME space-admin gate and the SAME response leak gate, rather than a second
// copy of either) but never calls createFigmaCredentialRoutes itself, so it
// cannot double-register these four routes. The two questions - "who reaches
// this file's exports" and "who mounts its routes" - are now different
// questions, and are asserted separately rather than collapsed back into one
// deepEqual that a legitimate reuse would fail.
await ta("7a2 figma-credential-routes is reached only by server.js (mounts it) and figma-oauth-routes.js (reuses its helpers)", async () => {
  const dir = new URL("./", import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => /\.(js|mjs)$/.test(f) && !/^figma-credential/.test(f));
  const importers = files.filter((f) =>
    /figma-credential-routes/.test(fs.readFileSync(new URL("./" + f, import.meta.url), "utf8")),
  );
  assert.deepEqual(
    importers.slice().sort(),
    ["figma-oauth-routes.js", "server.js"],
    "expected exactly server.js and figma-oauth-routes.js to reach this file, got: " + importers.join(", "),
  );
  assert.ok(files.length > 10, "only " + files.length + " files scanned - the scan is not reaching the repo");
});

await ta("7a3 figma-oauth-routes.js reuses createRequireSpaceAdmin/sendSafe but does NOT mount a second copy of these routes", async () => {
  let src = "";
  try {
    src = fs.readFileSync(new URL("./figma-oauth-routes.js", import.meta.url), "utf8");
  } catch { /* reported below */ }
  assert.ok(src.length > 0, "figma-oauth-routes.js could not be read - this check is vacuous");
  assert.ok(/createRequireSpaceAdmin/.test(src), "figma-oauth-routes.js no longer reuses createRequireSpaceAdmin");
  assert.ok(/\bsendSafe\b/.test(src), "figma-oauth-routes.js no longer reuses sendSafe");
  assert.ok(!/createFigmaCredentialRoutes\(/.test(src), "figma-oauth-routes.js calls createFigmaCredentialRoutes(...) - that would double-mount these four routes");
});

// ★★ INVERTED BY RUN 3. Runs 1 and 2 asserted server.js did not mention the
// credential modules, because it did not: the subsystem was built dark on
// purpose and this check recorded that. RUN 3 MOUNTS IT, so the assertion is now
// exactly backwards. It is restated rather than deleted, and it is restated in
// the STRONGEST form the wiring allows: not merely "server.js imports it", but
// "the resolver is what the three Figma call sites actually use". A file can
// import a module and still never call it - that is precisely the shape of a
// wiring that looks done and changes nothing.
await ta("7b  server.js IS wired to the resolver, at all three Figma call sites", async () => {
  const src = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
  assert.ok(/figma-credential/.test(src), "server.js no longer imports the credential modules - orders are back on the Mavlers token");
  assert.ok(/resolveFigmaToken\(/.test(src), "server.js imports the module but never calls resolveFigmaToken");

  // The global is still a module-scope constant, because it is still the
  // FALLBACK. It must now be passed AS the fallback, not used directly.
  assert.ok(/const FIGMA_API_TOKEN\s*=\s*process\.env\.FIGMA_API_TOKEN/.test(src), "FIGMA_API_TOKEN is no longer a module-scope constant");
  assert.ok(/globalToken:\s*FIGMA_API_TOKEN/.test(src), "the global token is no longer passed to the resolver as the fallback");

  // ★ THE CHECK THAT MATTERS. The three call sites named in run 1 - :5817
  // figmaToDesignSpec, :5981 renderFigmaNodes, :6006 fetchRawImageRefUrls -
  // must take the RESOLVED token. If any still takes FIGMA_API_TOKEN directly,
  // that call reads the client's design with the Mavlers account and the whole
  // feature is half-wired in a way nothing else here would catch.
  const directUses = src.split(/\r?\n/)
    .map((l, i) => ({ n: i + 1, t: l.trim() }))
    .filter((s) => /token:\s*FIGMA_API_TOKEN\b/.test(s.t));
  assert.deepEqual(directUses.map((s) => s.n), [],
    "these call sites still pass the GLOBAL token directly: " + directUses.map((s) => `:${s.n} ${s.t}`).join(" | "));

  const resolvedUses = src.split(/\r?\n/).filter((l) => /token:\s*figmaToken\b/.test(l));
  assert.ok(resolvedUses.length >= 3,
    `expected at least 3 call sites on the resolved token, found ${resolvedUses.length} - the scan may be vacuous`);
});

await ta("7c  queue-runner.js joins org_id onto the dispatch body", async () => {
  const src = fs.readFileSync(new URL("./queue-runner.js", import.meta.url), "utf8");
  assert.ok(/jobBody\.orgId\s*=/.test(src), "queue-runner.js no longer puts orgId on the dispatch body");

  // ★ AND IT MUST NOT DO IT THE WAY THE LOCK BUG DID IT.
  // ★★ SCAN CODE, NOT PROSE. The first version of this check read the raw file
  // and went RED on the COMMENT that documents the bug it is guarding against -
  // a check that punishes you for explaining the defect. Comments are stripped
  // first, and the strip is then proven non-vacuous below.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert.ok(code.length > 1000 && code.length < src.length,
    "the comment strip produced nothing usable - this check would be vacuous");
  assert.ok(!/String\(\s*pick\.org_id\s*\?\?/.test(code),
    "queue-runner.js stringifies a possibly-null org_id - that is the per-space lock bug verbatim");
  assert.ok(/normaliseOrgId|normalisedOrgId/.test(code), "the org id is not passed through the shared normaliser");

  // ★ CONTROL: the stripped-code scanner must still FIND the bug if it is real.
  assert.ok(/String\(\s*pick\.org_id\s*\?\?/.test(code + "\njobBody.orgId = String(pick.org_id ?? 'null');"),
    "the lock-bug detector is BLIND - the green above is vacuous");
});

await ta("7d  the credential travels to the bridge in the BODY, never as a flag", async () => {
  const src = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
  assert.ok(/payload\.figmaToken\s*=\s*figmaToken/.test(src), "the token is no longer threaded to the bridge payload");
  // It must NOT be folded into payload.figma, which the bridge logs by name.
  const figmaObj = src.match(/payload\.figma\s*=\s*\{[\s\S]{0,320}?\};/);
  assert.ok(figmaObj, "payload.figma assignment not found - this check would be vacuous");
  assert.ok(!/token/i.test(figmaObj[0]),
    "the token was folded into payload.figma, which bridge-server.mjs PRINTS BY NAME on the next line");
});

console.log("\n" + "=".repeat(70));
console.log("  " + pass + " PASS   " + fail + " FAIL");
console.log("=".repeat(70) + "\n");
process.exit(fail === 0 ? 0 : 1);
