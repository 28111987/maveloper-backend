/**
 * figma-member.test.mjs - EACH PERSON'S OWN FIGMA ACCOUNT, PER SPACE (19 NOV 2026).
 *
 * Run with:  node figma-member.test.mjs
 * No network, no Supabase, no real credential. Every token below is a synthetic
 * fixture; Figma is a stub.
 *
 * What it proves:
 *   P  the per-person resolver reads ONLY that person's row in that space
 *   D  the two order-path decisions (refuse a space that must connect; read
 *      again as the space when the person's account is refused)
 *   S  spaceRequiresFigma and the space-default description
 *   R  the six routes: who may call each, that a person only ever touches
 *      their own row, that a state is bound to one space AND one person, that
 *      tokens are sealed at rest and never returned
 *   W  server.js and queue-runner.js are wired to the above
 */

import fs from "node:fs";
import { resolveMemberFigmaOAuth, resolveFigmaOAuth, MEMBER_OAUTH_TABLE, normalisedUserId, shapeMemberOAuthResolution, figmaCredentialProvenanceLine } from "./figma-oauth.js";
import { createFigmaMemberRoutes, spaceRequiresFigma, describeSpaceDefault, refuseWithoutSpaceFigma, readAgainAsSpace, MEMBER_PUBLIC_COLUMNS } from "./figma-member-routes.js";
import { readKey, sealToken, isSealed, openToken } from "./figma-credential-crypto.js";
import { resealAll } from "./figma-credential-reseal.js";
import { createRequireSpaceAdmin } from "./figma-credential-routes.js";
import { createFigmaPlatformTokenRoutes, readExpiryDate, accountRefusal, spaceState } from "./figma-platform-token.js";
import { accountNameOf, figmaCannotOpenEither, plainReason, NO_SPACE_FIGMA, NO_FIGMA_ACCOUNT } from "./order-words.js";
import { checkFileAccess, decideFigmaAccess, refusedOne, refusedBoth, readsAsSpaceInstead, CHECK_URL, CHECK_TIMEOUT_MS } from "./figma-access-check.js";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  PASS  " + name); }
  catch (err) { fail++; console.log("  FAIL  " + name + "\n        " + err.message); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || "expected true"); }

const KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const KEY = readKey(KEY_HEX).key;
const seal = (v) => sealToken(v, KEY).sealed;
const ENV = { FIGMA_CRED_KEY: KEY_HEX, FIGMA_OAUTH_CLIENT_ID: "cid", FIGMA_OAUTH_CLIENT_SECRET: "csecret", FIGMA_OAUTH_REDIRECT_URI: "https://mavloper.dev/os/figma/callback" };

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC1 = "figu_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
const REF1 = "figur_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0";
const ACC2 = "figu_" + "B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1";
const REF2 = "figur_" + "Y8x7W6v5U4t3S2r1Q0p9O8n7M6l5K4j3I2h1G0f9";
const future = () => new Date(Date.now() + 30 * 864e5).toISOString();

// -- an in-memory stand-in for the slice of supabase-js the code uses ---------
function makeDb(tables) {
  const calls = [];
  return {
    calls, tables,
    from(table) {
      const q = { table, op: "select", cols: null, filters: [], payload: null, opts: null, wantRows: false };
      const rows = () => (tables[table] || []).filter((r) => q.filters.every(([c, v]) => (v && v.re ? v.re.test(String(r[c] ?? "")) : v && v.in ? v.in.has(r[c]) : r[c] === v)));
      const run = async () => {
        calls.push({ table, op: q.op, cols: q.cols, filters: [...q.filters] });
        if (tables[table] === undefined) return { data: null, error: { code: "42P01", message: "relation does not exist" } };
        if (q.op === "select") return { data: rows().map((r) => ({ ...r })), error: null };
        if (q.op === "delete") {
          const hit = rows();
          tables[table] = tables[table].filter((r) => !hit.includes(r));
          return { data: q.wantRows ? hit.map((r) => ({ org_id: r.org_id })) : null, error: null };
        }
        if (q.op === "update") { const hit = rows(); for (const r of hit) Object.assign(r, q.payload); return { data: q.wantRows ? hit.map((r) => ({ org_id: r.org_id })) : null, error: null }; }
        if (q.op === "upsert") {
          const keys = String(q.opts?.onConflict || "").split(",");
          const i = tables[table].findIndex((r) => keys.every((k) => r[k] === q.payload[k]));
          if (i >= 0) tables[table][i] = { ...q.payload }; else tables[table].push({ ...q.payload });
          return { data: null, error: null };
        }
        return { data: null, error: null };
      };
      const b = {
        select(cols) { if (q.op === "select") q.cols = cols; else q.wantRows = true; return b; },
        update(p) { q.op = "update"; q.payload = p; return b; },
        upsert(p, o) { q.op = "upsert"; q.payload = p; q.opts = o; return b; },
        delete() { q.op = "delete"; return b; },
        eq(c, v) { q.filters.push([c, v]); return b; },
        in(c, vals) { q.filters.push([c, { in: new Set(vals) }]); return b; },
        ilike(c, v) { const re = new RegExp("^" + String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i"); q.filters.push([c, { re }]); return b; },
        order() { return b; },
        limit() { return b; },
        async maybeSingle() { const r = await run(); return { data: r.data && r.data[0] ? r.data[0] : null, error: r.error }; },
        then(res, rej) { return run().then(res, rej); },
      };
      return b;
    },
  };
}

function memberRow(org, user, email, acc, ref, extra = {}) {
  return { org_id: org, user_id: user, email, access_token: seal(acc), refresh_token: seal(ref), expires_at: future(), figma_user_id: "f" + email, figma_email: email.replace("@", "+figma@"), figma_handle: null, scopes: "x", is_active: true, connected_at: future(), updated_at: future(), last_refresh_at: null, last_refresh_ok: null, last_refresh_note: null, ...extra };
}

// -- P ------------------------------------------------------------------------
console.log("\nP  resolveMemberFigmaOAuth");
await t("P1 a person with a row in this space gets their own token", async () => {
  const db = makeDb({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U1, "one@x.test", ACC1, REF1)] });
  const r = await resolveMemberFigmaOAuth(ORG_A, U1, { db, key: KEY });
  ok(r && r.token === ACC1, "token");
});
await t("P2 another person's row in the same space is never used", async () => {
  const db = makeDb({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U2, "two@x.test", ACC2, REF2)] });
  ok((await resolveMemberFigmaOAuth(ORG_A, U1, { db, key: KEY })) === null);
});
await t("P3 the same person's row in ANOTHER space is never used", async () => {
  const db = makeDb({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_B, U1, "one@x.test", ACC1, REF1)] });
  ok((await resolveMemberFigmaOAuth(ORG_A, U1, { db, key: KEY })) === null);
});
await t("P4 the same Figma account in two spaces: each space reads its own row", async () => {
  const db = makeDb({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U1, "one@x.test", ACC1, REF1), memberRow(ORG_B, U1, "one@x.test", ACC2, REF2)] });
  ok((await resolveMemberFigmaOAuth(ORG_A, U1, { db, key: KEY })).token === ACC1);
  ok((await resolveMemberFigmaOAuth(ORG_B, U1, { db, key: KEY })).token === ACC2);
});
await t("P5 no person, a non-uuid person, no space: null without a query", async () => {
  const db = makeDb({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U1, "one@x.test", ACC1, REF1)] });
  ok((await resolveMemberFigmaOAuth(ORG_A, null, { db, key: KEY })) === null);
  ok((await resolveMemberFigmaOAuth(ORG_A, "not-a-uuid", { db, key: KEY })) === null);
  ok((await resolveMemberFigmaOAuth(null, U1, { db, key: KEY })) === null);
  ok(db.calls.length === 0, "queried " + db.calls.length);
});
await t("P6 the table not created yet: null, never a throw", async () => {
  const db = makeDb({});
  ok((await resolveMemberFigmaOAuth(ORG_A, U1, { db, key: KEY })) === null);
});
await t("P7 a failed renewal returns null and is written on THAT row only", async () => {
  const mine = memberRow(ORG_A, U1, "one@x.test", ACC1, REF1, { expires_at: new Date(Date.now() - 1000).toISOString() });
  const theirs = memberRow(ORG_A, U2, "two@x.test", ACC2, REF2, { expires_at: new Date(Date.now() - 1000).toISOString() });
  const db = makeDb({ [MEMBER_OAUTH_TABLE]: [mine, theirs] });
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
  const r = await resolveMemberFigmaOAuth(ORG_A, U1, { db, key: KEY, env: ENV, fetchImpl });
  ok(r === null, "null");
  ok(mine.last_refresh_ok === false && theirs.last_refresh_ok === null, "recorded on the right row");
});
await t("P8 the space resolver still reads org_figma_oauth by org_id alone (unchanged)", async () => {
  const db = makeDb({ org_figma_oauth: [{ org_id: ORG_A, access_token: seal(ACC2), refresh_token: seal(REF2), expires_at: future(), is_active: true }] });
  const r = await resolveFigmaOAuth(ORG_A, { db, key: KEY });
  ok(r && r.token === ACC2);
  const sel = db.calls.find((c) => c.op === "select");
  ok(JSON.stringify(sel.filters) === JSON.stringify([["org_id", ORG_A]]), JSON.stringify(sel.filters));
});
await t("P9 provenance names the orderer's own account, and the fallback says both", async () => {
  const line = figmaCredentialProvenanceLine(shapeMemberOAuthResolution({ token: ACC1, reason: "oauth-credential", expiresAt: null, figmaHandle: "Dhruv", figmaEmail: null }, ORG_A));
  ok(line === "Figma credential: the orderer's own connected Figma account (Dhruv)", line);
  const fb = figmaCredentialProvenanceLine({ source: "oauth", label: "design", memberRefused: { label: "Dhruv" } });
  ok(fb === "Figma credential: this space's connected Figma account (design). The orderer's own Figma account (Dhruv) could not open this file", fb);
  ok(!/[\u2014\u2013]/.test(line + fb), "no em or en dash");
});
await t("P10 normalisedUserId accepts a uuid only", async () => {
  ok(normalisedUserId(U1.toUpperCase()) === U1 && normalisedUserId("null") === null && normalisedUserId(12) === null);
});

// -- D ------------------------------------------------------------------------
console.log("\nD  the order path's two decisions");
await t("D1 a space that must connect, with only the Mavlers token or nothing: refused", async () => {
  ok(refuseWithoutSpaceFigma({ source: "global" }, true) && refuseWithoutSpaceFigma({ source: "none" }, true) && refuseWithoutSpaceFigma(null, true));
});
await t("D2 a space with its own OAuth or pasted token is never refused", async () => {
  ok(!refuseWithoutSpaceFigma({ source: "oauth" }, true) && !refuseWithoutSpaceFigma({ source: "org" }, true));
});
await t("D3 a space without the flag (every space before 19 NOV) is never refused", async () => {
  ok(!refuseWithoutSpaceFigma({ source: "global" }, false) && !refuseWithoutSpaceFigma({ source: "global" }, undefined));
});
await t("D4 the person's account refused (403, 404, 401): read again as the space", async () => {
  for (const m of ["Figma API rejected the token (401/403)", "Figma file not found (404)", "status 403"]) {
    ok(readAgainAsSpace({ usedMember: true, message: m, spaceToken: "s", usedToken: "m" }), m);
  }
});
await t("D5 not retried: no personal account, another error, no space token, the same token", async () => {
  ok(!readAgainAsSpace({ usedMember: false, message: "(401/403)", spaceToken: "s", usedToken: "m" }));
  ok(!readAgainAsSpace({ usedMember: true, message: "Invalid Figma URL", spaceToken: "s", usedToken: "m" }));
  ok(!readAgainAsSpace({ usedMember: true, message: "(401/403)", spaceToken: null, usedToken: "m" }));
  ok(!readAgainAsSpace({ usedMember: true, message: "(401/403)", spaceToken: "m", usedToken: "m" }));
});
await t("D6 the two new client sentences are recognised as ours and carry no dash", async () => {
  const either = figmaCannotOpenEither(accountNameOf({ source: "member-oauth", label: "dhruv@client.test" }), "design");
  ok(either.includes("(dhruv)") && !either.includes("@"), either);
  ok(plainReason("Figma fetch failed: " + either) === either, "either");
  ok(plainReason("Figma not connected: " + NO_SPACE_FIGMA) === NO_SPACE_FIGMA, "no space");
  ok(!/[\u2014\u2013]/.test(either + NO_SPACE_FIGMA));
});

// -- S ------------------------------------------------------------------------
console.log("\nS  the space's own facts");
await t("S1 spaceRequiresFigma: true only when the column says true", async () => {
  ok(await spaceRequiresFigma(makeDb({ orgs: [{ id: ORG_A, figma_required: true }] }), ORG_A));
  ok(!(await spaceRequiresFigma(makeDb({ orgs: [{ id: ORG_A, figma_required: false }] }), ORG_A)));
  ok(!(await spaceRequiresFigma(makeDb({ orgs: [{ id: ORG_A }] }), ORG_A)), "column absent");
  ok(!(await spaceRequiresFigma(makeDb({}), ORG_A)), "read error");
  ok(!(await spaceRequiresFigma(makeDb({ orgs: [] }), null)), "no org");
});
await t("S2 the space default: OAuth first, then a pasted token, then Mavlers or none", async () => {
  const o = await describeSpaceDefault(makeDb({ org_figma_oauth: [{ org_id: ORG_A, figma_email: "design@mavlers.test", is_active: true }], org_figma_credentials: [] }), ORG_A, true);
  ok(o.kind === "oauth" && o.account === "design@mavlers.test", JSON.stringify(o));
  const p = await describeSpaceDefault(makeDb({ org_figma_oauth: [], org_figma_credentials: [{ org_id: ORG_A, label: "Team token", is_active: true, expires_at: null }] }), ORG_A, true);
  ok(p.kind === "token" && p.account === "Team token");
  ok((await describeSpaceDefault(makeDb({ org_figma_oauth: [], org_figma_credentials: [] }), ORG_A, false)).kind === "mavlers");
  ok((await describeSpaceDefault(makeDb({ org_figma_oauth: [], org_figma_credentials: [] }), ORG_A, true)).kind === "none");
});

// -- R ------------------------------------------------------------------------
console.log("\nR  the routes");
function makeApp() { const routes = {}; const reg = (m) => (p, ...c) => { routes[m + " " + p] = c; }; return { routes, get: reg("get"), post: reg("post"), delete: reg("delete"), put: reg("put") }; }
function makeRes() { const r = { statusCode: null, body: null }; r.status = (s) => { r.statusCode = s; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }
async function run(chain, req) {
  const res = makeRes();
  for (const mw of chain) { let next = false; await mw(req, res, () => { next = true; }); if (!next) break; }
  return res;
}
const passAuth = (req, res, next) => next();
const SPACE = { id: ORG_A, name: "Acme", slug: "acme", is_deleted: false };

function world(extra = {}) {
  return {
    orgs: [{ ...SPACE, figma_required: true }],
    email_allowlist: [
      { email: "admin@acme.test", org_id: ORG_A, is_owner: true },
      { email: "one@acme.test", org_id: ORG_A, is_owner: false },
      { email: "two@acme.test", org_id: ORG_A, is_owner: false },
    ],
    platform_owners: [{ email: "owner@mavlers.test" }],
    org_figma_oauth: [{ org_id: ORG_A, figma_email: "design@mavlers.test", is_active: true, last_refresh_ok: true }],
    org_figma_credentials: [],
    [MEMBER_OAUTH_TABLE]: [],
    ...extra,
  };
}
function mount(tables, { fetchImpl = null, env = ENV } = {}) {
  const app = makeApp(); const db = makeDb(tables); const logs = [];
  createFigmaMemberRoutes({ app, supabaseAdmin: db, requireAuth: passAuth, log: (...a) => logs.push(a), env, fetchImpl });
  return { app, db, logs };
}
const as = (email, id) => ({ user: { email, id }, params: { slug: "acme" }, body: {} });
const figmaStub = (acc, ref, me) => async (url) => {
  if (String(url).includes("/oauth/token")) return { ok: true, status: 200, json: async () => ({ access_token: acc, refresh_token: ref, expires_in: 7776000, user_id_string: "77" }) };
  if (String(url).includes("/v1/me")) return { ok: true, status: 200, json: async () => me };
  return { ok: false, status: 404, json: async () => ({}) };
};

await t("R1 me/figma: a person with no seat in this space is refused", async () => {
  const { app } = mount(world());
  const res = await run(app.routes["get /os/spaces/:slug/me/figma"], as("stranger@else.test", U1));
  ok(res.statusCode === 403, String(res.statusCode));
});
await t("R2 me/figma: a Dev with nothing of their own reads with the space default", async () => {
  const { app } = mount(world());
  const res = await run(app.routes["get /os/spaces/:slug/me/figma"], as("one@acme.test", U1));
  ok(res.statusCode === 200 && res.body.readsWith.kind === "space" && res.body.readsWith.account === "design@mavlers.test", JSON.stringify(res.body));
  ok(res.body.mine === null && res.body.figmaRequired === true);
});
await t("R3 connect: start, then callback, stores MY row, sealed, keyed on req.user (never the body)", async () => {
  const tables = world();
  const { app } = mount(tables, { fetchImpl: figmaStub(ACC1, REF1, { id: "77", email: "dhruv@client1.test", handle: "Dhruv" }) });
  const start = await run(app.routes["get /os/spaces/:slug/me/figma-oauth/start"], as("one@acme.test", U1));
  ok(start.statusCode === 200 && start.body.authorizeUrl.startsWith("https://www.figma.com/oauth?"), JSON.stringify(start.body));
  const req = as("one@acme.test", U1); req.body = { code: "c0de", state: start.body.state, userId: U2, orgId: ORG_B };
  const cb = await run(app.routes["post /os/spaces/:slug/me/figma-oauth/callback"], req);
  ok(cb.statusCode === 200, JSON.stringify(cb.body));
  const rows = tables[MEMBER_OAUTH_TABLE];
  ok(rows.length === 1 && rows[0].user_id === U1 && rows[0].org_id === ORG_A && rows[0].email === "one@acme.test", JSON.stringify(rows.map((r) => [r.user_id, r.org_id])));
  ok(isSealed(rows[0].access_token) && isSealed(rows[0].refresh_token), "sealed at rest");
  ok(!JSON.stringify(cb.body).includes(ACC1) && !JSON.stringify(cb.body).includes(REF1) && !JSON.stringify(cb.body).includes("figseal"), "nothing returned");
  ok(cb.body.mine.account === "dhruv@client1.test");
});
await t("R4 a state minted for one person cannot be spent by another in the same space", async () => {
  const tables = world();
  const { app } = mount(tables, { fetchImpl: figmaStub(ACC1, REF1, { email: "x@y.test" }) });
  const start = await run(app.routes["get /os/spaces/:slug/me/figma-oauth/start"], as("one@acme.test", U1));
  const req = as("two@acme.test", U2); req.body = { code: "c", state: start.body.state };
  const cb = await run(app.routes["post /os/spaces/:slug/me/figma-oauth/callback"], req);
  ok(cb.statusCode === 400 && tables[MEMBER_OAUTH_TABLE].length === 0, String(cb.statusCode));
});
await t("R5 a state is single use", async () => {
  const tables = world();
  const { app } = mount(tables, { fetchImpl: figmaStub(ACC1, REF1, { email: "x@y.test" }) });
  const start = await run(app.routes["get /os/spaces/:slug/me/figma-oauth/start"], as("one@acme.test", U1));
  const r1 = as("one@acme.test", U1); r1.body = { code: "c", state: start.body.state };
  await run(app.routes["post /os/spaces/:slug/me/figma-oauth/callback"], r1);
  const r2 = as("one@acme.test", U1); r2.body = { code: "c", state: start.body.state };
  ok((await run(app.routes["post /os/spaces/:slug/me/figma-oauth/callback"], r2)).statusCode === 400);
});
await t("R6 me/figma after connecting reads 'own'; a failed renewal falls back to 'space'", async () => {
  const tables = world({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U1, "one@acme.test", ACC1, REF1)] });
  const { app } = mount(tables);
  let res = await run(app.routes["get /os/spaces/:slug/me/figma"], as("one@acme.test", U1));
  ok(res.body.readsWith.kind === "own" && res.body.mine.status === "ok", JSON.stringify(res.body.readsWith));
  tables[MEMBER_OAUTH_TABLE][0].last_refresh_ok = false;
  res = await run(app.routes["get /os/spaces/:slug/me/figma"], as("one@acme.test", U1));
  ok(res.body.readsWith.kind === "space" && res.body.mine.status === "needs-reconnect", JSON.stringify(res.body));
});
await t("R7 disconnect removes MY row only", async () => {
  const tables = world({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U1, "one@acme.test", ACC1, REF1), memberRow(ORG_A, U2, "two@acme.test", ACC2, REF2)] });
  const { app } = mount(tables);
  const res = await run(app.routes["delete /os/spaces/:slug/me/figma-oauth"], as("one@acme.test", U1));
  ok(res.statusCode === 200 && tables[MEMBER_OAUTH_TABLE].length === 1 && tables[MEMBER_OAUTH_TABLE][0].user_id === U2);
  ok((await run(app.routes["delete /os/spaces/:slug/me/figma-oauth"], as("one@acme.test", U1))).statusCode === 404, "second time: nothing");
});
await t("R8 figma-accounts: a Dev is refused", async () => {
  const { app } = mount(world());
  ok((await run(app.routes["get /os/spaces/:slug/figma-accounts"], as("one@acme.test", U1))).statusCode === 403);
});
await t("R9 figma-accounts: an Admin sees every seat, own or default, and no token", async () => {
  const tables = world({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U1, "one@acme.test", ACC1, REF1)] });
  const { app, db } = mount(tables);
  const res = await run(app.routes["get /os/spaces/:slug/figma-accounts"], as("admin@acme.test", U2));
  ok(res.statusCode === 200, String(res.statusCode));
  const m = Object.fromEntries(res.body.members.map((x) => [x.email, x]));
  ok(m["one@acme.test"].kind === "own" && m["two@acme.test"].kind === "default" && m["two@acme.test"].account === "design@mavlers.test", JSON.stringify(res.body.members));
  const s = JSON.stringify(res.body);
  ok(!s.includes(ACC1) && !s.includes("figseal"), "no token");
  ok(db.calls.filter((c) => c.table === MEMBER_OAUTH_TABLE && c.op === "select").every((c) => c.cols === MEMBER_PUBLIC_COLUMNS), "named columns only");
  ok(!MEMBER_PUBLIC_COLUMNS.includes("token"), "no token column in the list");
});
await t("R10 figma-accounts: the platform owner may read it without an Admin seat", async () => {
  const { app } = mount(world());
  ok((await run(app.routes["get /os/spaces/:slug/figma-accounts"], as("owner@mavlers.test", U2))).statusCode === 200);
});
await t("R11 an Admin removes a member's own connection; a Dev cannot", async () => {
  const tables = world({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U1, "one@acme.test", ACC1, REF1)] });
  const { app } = mount(tables);
  const dev = as("two@acme.test", U2); dev.params.userId = U1;
  ok((await run(app.routes["delete /os/spaces/:slug/figma-accounts/:userId"], dev)).statusCode === 403 && tables[MEMBER_OAUTH_TABLE].length === 1);
  const adm = as("admin@acme.test", U2); adm.params.userId = U1;
  ok((await run(app.routes["delete /os/spaces/:slug/figma-accounts/:userId"], adm)).statusCode === 200 && tables[MEMBER_OAUTH_TABLE].length === 0);
});
await t("R12 the table not created yet: reads say so and still work, writes refuse in plain words", async () => {
  const tables = world(); delete tables[MEMBER_OAUTH_TABLE];
  const { app } = mount(tables);
  const res = await run(app.routes["get /os/spaces/:slug/me/figma"], as("one@acme.test", U1));
  ok(res.statusCode === 200 && res.body.personalAvailable === false && res.body.readsWith.kind === "space", JSON.stringify(res.body));
  ok((await run(app.routes["delete /os/spaces/:slug/me/figma-oauth"], as("one@acme.test", U1))).statusCode === 503);
});
await t("R13 a closed or unknown space is refused before any seat is read", async () => {
  const tables = world(); tables.orgs[0].is_deleted = true;
  const { app } = mount(tables);
  ok((await run(app.routes["get /os/spaces/:slug/me/figma"], as("one@acme.test", U1))).statusCode === 404);
});

// -- G ------------------------------------------------------------------------
console.log("\nG  the space-admin gate admits the platform owner (19 NOV ruling)");
async function gate(email, tables, env = {}) {
  const mw = createRequireSpaceAdmin({ supabaseAdmin: makeDb(tables), log: () => {}, env });
  const req = { user: { email }, params: { slug: "acme" } };
  const res = makeRes(); let passed = false;
  await mw(req, res, () => { passed = true; });
  return { passed, res };
}
await t("G1 the platform owner by PLATFORM_OWNERS passes with only a member seat", async () => {
  const r = await gate("owner@mavlers.test", world(), { PLATFORM_OWNERS: "owner@mavlers.test" });
  ok(r.passed, JSON.stringify(r.res.body));
});
await t("G2 the platform owner by the platform_owners table passes with no seat at all", async () => {
  ok((await gate("owner@mavlers.test", world())).passed);
});
await t("G3 a Dev of the space is still refused, with the same words", async () => {
  const r = await gate("one@acme.test", world({ platform_owners: [] }));
  ok(!r.passed && r.res.statusCode === 403 && /do not hold an admin seat/.test(r.res.body.details || ""), JSON.stringify(r.res.body));
});
await t("G4 an Admin of the space passes, as before", async () => {
  ok((await gate("admin@acme.test", world({ platform_owners: [] }))).passed);
});
await t("G5 the owner table unreadable: no crash, a stranger still refused", async () => {
  const tables = world(); delete tables.platform_owners;
  const r = await gate("stranger@else.test", tables);
  ok(!r.passed && r.res.statusCode === 403);
});

// -- T ------------------------------------------------------------------------
console.log("\nT  Mavloper's own Figma account: read from orders, never asked of Figma");
function mountToken(tables, env, clock) {
  const app = makeApp();
  createFigmaPlatformTokenRoutes({ app, supabaseAdmin: makeDb(tables), requireAuth: passAuth, log: () => {}, env, now: clock || (() => Date.now()) });
  return app.routes["get /os/platform/figma-token"];
}
const PAT = "figd_" + "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0";
const LEAD = "55555555-5555-4555-8555-555555555555";
const RND = "44444444-4444-4444-8444-444444444444";
const ORGS = [
  { ...SPACE },
  { id: LEAD, slug: "leadership", name: "Leadership", is_deleted: false, figma_required: false },
  { id: RND, slug: "r-d", name: "R&D", is_deleted: false, figma_required: true },
  { id: "33333333-3333-4333-8333-333333333333", slug: "gone", name: "Gone", is_deleted: true },
];
const GLOBAL = "Generation complete in 120s | Figma credential: global Mavlers token (reason: no-row-for-org)";
const OWN = "Generation complete in 120s | Figma credential: this space's connected Figma account (design)";
const PAYWALL = "Figma refused to send this design because the Figma plan that owns the file has reached its plan limit.";
const NOTSHARED = "Figma could not open this file (404). Share it with the account that reads your files.";
const order = (id, status, at, job, err = null) => ({ org_id: LEAD, order_id: id, status, finished_at: at, job_id: job, error_text: err });

await t("T1 NO CALL TO FIGMA, ever: the route never touches the network, and never returns the token", async () => {
  const real = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const route = mountToken(world({ orgs: ORGS, os_queue: [], maveloper_jobs: [] }), { FIGMA_API_TOKEN: PAT, FIGMA_API_TOKEN_EXPIRES: "2027-01-17" });
    const res = await run(route, as("owner@mavlers.test", U1));
    ok(res.statusCode === 200 && res.body.configured === true && res.body.expiresOn === "2027-01-17", JSON.stringify(res.body));
    ok(!JSON.stringify(res.body).includes(PAT), "token not returned");
    ok(calls === 0, "fetch called " + calls + " times");
  } finally { globalThis.fetch = real; }
});
await t("T2 names the spaces that read with it, and lists a new space apart, never as reading with it", async () => {
  const route = mountToken(world({ orgs: ORGS, os_queue: [], maveloper_jobs: [] }), { FIGMA_API_TOKEN: PAT });
  const b = (await run(route, as("owner@mavlers.test", U1))).body;
  ok(JSON.stringify(b.using.map((u) => u.space)) === JSON.stringify(["Leadership"]), JSON.stringify(b.using));
  ok(JSON.stringify(b.waiting) === JSON.stringify(["R&D"]), JSON.stringify(b.waiting));
  ok(b.using[0].lastRead === null && b.using[0].refused === null, "no orders, no claims");
});
await t("T3 last read: the newest DELIVERED order whose job recorded the global token, not one read with another account", async () => {
  const tables = world({ orgs: ORGS,
    os_queue: [order("L-1", "delivered", "2026-11-18T10:00:00Z", "j1"), order("L-2", "delivered", "2026-11-19T10:00:00Z", "j2")],
    maveloper_jobs: [{ id: "j1", progress_message: GLOBAL }, { id: "j2", progress_message: OWN }] });
  const b = (await run(mountToken(tables, { FIGMA_API_TOKEN: PAT }), as("owner@mavlers.test", U1))).body;
  ok(b.using[0].lastRead && b.using[0].lastRead.orderId === "L-1", JSON.stringify(b.using[0]));
});
await t("T4 refused: an ACCOUNT-level refusal newer than the last read is reported; a file not shared is not", async () => {
  const tables = world({ orgs: ORGS,
    os_queue: [order("L-1", "delivered", "2026-11-18T10:00:00Z", "j1"), order("L-3", "failed", "2026-11-19T11:00:00Z", null, NOTSHARED), order("L-4", "failed", "2026-11-19T12:00:00Z", null, PAYWALL)],
    maveloper_jobs: [{ id: "j1", progress_message: GLOBAL }] });
  const u = (await run(mountToken(tables, { FIGMA_API_TOKEN: PAT }), as("owner@mavlers.test", U1))).body.using[0];
  ok(u.refused && u.refused.orderId === "L-4" && /too many requests/.test(u.refused.why), JSON.stringify(u));
});
await t("T5 a refusal OLDER than the last successful read is history, not a warning", async () => {
  const tables = world({ orgs: ORGS,
    os_queue: [order("L-4", "failed", "2026-11-17T12:00:00Z", null, PAYWALL), order("L-1", "delivered", "2026-11-18T10:00:00Z", "j1")],
    maveloper_jobs: [{ id: "j1", progress_message: GLOBAL }] });
  const u = (await run(mountToken(tables, { FIGMA_API_TOKEN: PAT }), as("owner@mavlers.test", U1))).body.using[0];
  ok(u.refused === null && u.lastRead.orderId === "L-1", JSON.stringify(u));
});
await t("T6 only the platform owner may read it", async () => {
  const route = mountToken(world({ platform_owners: [], orgs: ORGS }), { FIGMA_API_TOKEN: PAT });
  ok((await run(route, as("admin@acme.test", U1))).statusCode === 403);
});
await t("T7 cached a minute on the server: a second read inside it does not ask the database again", async () => {
  let clock = 1_000_000;
  const tables = world({ orgs: ORGS, os_queue: [], maveloper_jobs: [] });
  const db = makeDb(tables);
  const app = makeApp();
  createFigmaPlatformTokenRoutes({ app, supabaseAdmin: db, requireAuth: passAuth, log: () => {}, env: { FIGMA_API_TOKEN: PAT }, now: () => clock });
  const route = app.routes["get /os/platform/figma-token"];
  await run(route, as("owner@mavlers.test", U1));
  const n = db.calls.filter((c) => c.table === "orgs").length;
  clock += 30_000; await run(route, as("owner@mavlers.test", U1));
  ok(db.calls.filter((c) => c.table === "orgs").length === n, "re-read inside the minute");
  clock += 61_000; await run(route, as("owner@mavlers.test", U1));
  ok(db.calls.filter((c) => c.table === "orgs").length > n, "not re-read after the minute");
});
await t("T8 the account-refusal words: plan limit and 429 and a rejected token match; a file not shared does not", async () => {
  ok(/too many requests/.test(accountRefusal(PAYWALL)) && /too many requests/.test(accountRefusal("Figma returned 429")));
  ok(/rejected/.test(accountRefusal("Figma returned 401: invalid token")));
  ok(accountRefusal(NOTSHARED) === null && accountRefusal(null) === null);
  ok(!/[\u2014\u2013]/.test(accountRefusal(PAYWALL) + accountRefusal("401")));
});
await t("T9 spaceState is pure: no orders, no claims", async () => {
  const s = spaceState([], new Set());
  ok(s.lastRead === null && s.refused === null);
});
await t("T10 the recorded expiry must be a real date", async () => {
  ok(readExpiryDate("2027-01-17") === "2027-01-17" && readExpiryDate("2027-02-30") === null && readExpiryDate("17 Jan") === null && readExpiryDate(undefined) === null);
});

// -- K ------------------------------------------------------------------------
console.log("\nK  key rotation covers personal connections");
await t("K1 rows sealed with the previous key are re-sealed with the current one; the table absent is skipped", async () => {
  const OLD_HEX = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
  const OLD = readKey(OLD_HEX).key;
  const row = { org_id: ORG_A, user_id: U1, access_token: sealToken(ACC1, OLD).sealed, refresh_token: sealToken(REF1, OLD).sealed };
  const db = makeDb({ org_figma_oauth: [], org_figma_credentials: [], [MEMBER_OAUTH_TABLE]: [row] });
  const r = await resealAll({ db, env: { FIGMA_CRED_KEY: KEY_HEX, FIGMA_CRED_KEY_PREVIOUS: OLD_HEX } });
  ok(r.ran && r.member.resealed === 1, JSON.stringify(r));
  ok(openToken(row.access_token, KEY).token === ACC1 && openToken(row.refresh_token, KEY).token === REF1, "opens with the current key");
  const r2 = await resealAll({ db: makeDb({ org_figma_oauth: [], org_figma_credentials: [] }), env: { FIGMA_CRED_KEY: KEY_HEX, FIGMA_CRED_KEY_PREVIOUS: OLD_HEX } });
  ok(r2.ran && r2.member.tableAbsent === true, JSON.stringify(r2));
});

// -- C ------------------------------------------------------------------------
// 20 NOV, THE OWNER: refuse a file at submission when the account the order
// will read with cannot open it. Expected values are Figma's documented
// answers for GET /v1/files/:key/meta (200 the file, 404 not found, 403 an
// invalid token or a missing scope, 429 too many requests), never the code's.
console.log("\nC  can my order open this file? (POST /me/figma-check)");
const FILE = "AbCdEfGhIjKlMnOp";
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
await t("C1 one call, to /v1/files/:key/meta, in the header the token's kind needs", async () => {
  const seen = [];
  const f = async (url, init) => { seen.push({ url: String(url), h: init.headers }); return answer(200, { file: { name: "Spring sale" } }); };
  const a = await checkFileAccess({ token: ACC1, fileKey: FILE, fetchImpl: f });
  const b = await checkFileAccess({ token: "figd_" + "x".repeat(30), fileKey: FILE, fetchImpl: f });
  ok(seen.length === 2 && seen[0].url === "https://api.figma.com/v1/files/" + FILE + "/meta" && CHECK_URL(FILE) === seen[0].url, JSON.stringify(seen.map((x) => x.url)));
  ok(seen[0].h.Authorization === "Bearer " + ACC1 && !seen[0].h["X-Figma-Token"], "OAuth token as Bearer");
  ok(seen[1].h["X-Figma-Token"] && !seen[1].h.Authorization, "personal token as X-Figma-Token");
  ok(a.verdict === "open" && a.fileName === "Spring sale" && b.verdict === "open", JSON.stringify(a));
});
await t("C2 only a definite refusal refuses: 404, and a 403 that is not about scope", async () => {
  const v = async (status, body) => (await checkFileAccess({ token: ACC1, fileKey: FILE, fetchImpl: async () => answer(status, body) })).verdict;
  ok((await v(404, { status: 404, err: "Not found" })) === "refused", "404");
  ok((await v(403, { status: 403, err: "Forbidden" })) === "refused", "403 forbidden");
  ok((await v(403, { status: 403, err: "Invalid scope(s): file_content:read. This endpoint requires the file_metadata:read scope" })) === "unknown", "403 scope");
  ok((await v(429, { status: 429, err: "Rate limit exceeded" })) === "unknown", "429");
  ok((await v(500, {})) === "unknown", "500");
  ok((await checkFileAccess({ token: ACC1, fileKey: FILE, fetchImpl: async () => { throw new Error("ECONNRESET"); } })).verdict === "unknown", "no answer");
  ok((await checkFileAccess({ token: null, fileKey: FILE, fetchImpl: async () => answer(200, {}) })).verdict === "unknown", "no token");
});
const ASK = (map) => async (tok) => map[tok] || { verdict: "unknown", why: "other" };
const W = { mine: "dhruv@client.test", space: "design@mavlers.test", spaceKind: "space" };
const NOACC = { space: NO_SPACE_FIGMA, none: NO_FIGMA_ACCOUNT };
await t("C3 the decision follows the order path: blocked, own, read-again-as-space, refused", async () => {
  const sp = { token: "S", source: "oauth" }, me = { token: "M" };
  const d0 = await decideFigmaAccess({ refuseForSpace: true, noAccountWords: NOACC, spaceCred: sp, memberCred: me, words: W, ask: ASK({}) });
  ok(d0.verdict === "blocked" && d0.message === NO_SPACE_FIGMA, "figma_required with no space account");
  const d1 = await decideFigmaAccess({ refuseForSpace: false, noAccountWords: NOACC, spaceCred: sp, memberCred: me, words: W, ask: ASK({ M: { verdict: "open", fileName: "F" } }) });
  ok(d1.verdict === "open" && d1.readsWith.kind === "own" && d1.readsWith.account === W.mine && d1.message === null, JSON.stringify(d1));
  const d2 = await decideFigmaAccess({ refuseForSpace: false, noAccountWords: NOACC, spaceCred: sp, memberCred: me, words: W, ask: ASK({ M: { verdict: "refused" }, S: { verdict: "open", fileName: "F" } }) });
  ok(d2.verdict === "open" && d2.readsWith.kind === "space" && d2.message === readsAsSpaceInstead(W.mine, W.space), JSON.stringify(d2));
  const d3 = await decideFigmaAccess({ refuseForSpace: false, noAccountWords: NOACC, spaceCred: sp, memberCred: me, words: W, ask: ASK({ M: { verdict: "refused" }, S: { verdict: "refused" } }) });
  ok(d3.verdict === "refused" && d3.message === refusedBoth(W.mine, W.space), JSON.stringify(d3));
  const d4 = await decideFigmaAccess({ refuseForSpace: false, noAccountWords: NOACC, spaceCred: { token: "M", source: "oauth" }, memberCred: me, words: W, ask: ASK({ M: { verdict: "refused" } }) });
  ok(d4.verdict === "refused" && d4.message === refusedOne(W.mine), "same token: no second account to try");
  const d5 = await decideFigmaAccess({ refuseForSpace: false, noAccountWords: NOACC, spaceCred: sp, memberCred: null, words: W, ask: ASK({ S: { verdict: "refused" } }) });
  ok(d5.verdict === "refused" && d5.readsWith.kind === "space" && d5.message === refusedOne(W.space), JSON.stringify(d5));
  const d6 = await decideFigmaAccess({ refuseForSpace: false, noAccountWords: NOACC, spaceCred: { token: null, source: "none" }, memberCred: null, words: W, ask: ASK({}) });
  ok(d6.verdict === "blocked" && d6.message === NO_FIGMA_ACCOUNT, "no credential at all");
});
await t("C4 our own uncertainty never refuses: unknown on either account is unknown", async () => {
  const sp = { token: "S", source: "oauth" }, me = { token: "M" };
  const a = await decideFigmaAccess({ refuseForSpace: false, noAccountWords: NOACC, spaceCred: sp, memberCred: me, words: W, ask: ASK({ M: { verdict: "unknown", why: "rate-limited" } }) });
  const b = await decideFigmaAccess({ refuseForSpace: false, noAccountWords: NOACC, spaceCred: sp, memberCred: me, words: W, ask: ASK({ M: { verdict: "refused" }, S: { verdict: "unknown", why: "scope" } }) });
  const c = await decideFigmaAccess({ refuseForSpace: false, noAccountWords: NOACC, spaceCred: { token: "G", source: "global" }, memberCred: null, words: { ...W, spaceKind: "mavlers" }, ask: ASK({ G: { verdict: "unknown", why: "scope" } }) });
  ok(a.verdict === "unknown" && b.verdict === "unknown" && c.verdict === "unknown" && c.readsWith.kind === "mavlers", JSON.stringify([a, b, c]));
});
await t("C5 the sentences name the full account, say both ways out, and carry no dash", async () => {
  const all = [refusedOne(W.space), refusedBoth(W.mine, W.space), refusedOne(null, { mavlers: true }), readsAsSpaceInstead(W.mine, W.space)];
  // 17:04, the owner: connect first, then share; and the button is named as it reads.
  ok(all[0] === "design@mavlers.test can't open this file. Connect the Figma account that owns it, or share the file with design@mavlers.test (Dev or Full seat).", all[0]);
  ok(all.slice(0, 3).every((x) => x.indexOf("Connect the Figma account that owns it") > -1 && (x.indexOf("share") === -1 || x.indexOf("Connect the Figma account") < x.indexOf("share"))), "connect comes before share in every refusal");
  ok(all[1].includes("dhruv@client.test") && all[1].includes("design@mavlers.test"), all[1]);
  // 17:31, the owner: short. No refusal on Generate runs past two sentences or 200 characters (with two full addresses in it).
  ok(all.every((x) => x.split(". ").length <= 2 && x.length <= 200), all.map((x) => x.length).join(","));
  ok(!all.some((x) => /[\u2014\u2013]/.test(x)), "no em or en dash");
});

function checkWorld(extra = {}) {
  return world({
    org_figma_oauth: [{ org_id: ORG_A, access_token: seal(ACC2), refresh_token: seal(REF2), expires_at: future(), figma_email: "design@mavlers.test", figma_handle: "design", is_active: true, last_refresh_ok: true }],
    ...extra,
  });
}
// Figma, as a stub: which token may open the file.
const figmaFiles = (opens, calls) => async (url, init) => {
  const h = init && init.headers ? init.headers : {};
  const tok = String(h.Authorization || "").replace(/^Bearer /, "") || h["X-Figma-Token"];
  calls.push({ url: String(url), tok });
  return opens.has(tok) ? answer(200, { file: { name: "Spring sale" } }) : answer(404, { status: 404, err: "Not found" });
};
const checkReq = (email, id, figmaUrl) => ({ user: { email, id }, params: { slug: "acme" }, body: { figmaUrl } });
const LINK = "https://www.figma.com/design/" + FILE + "/Spring?node-id=1-2";
await t("C6 the route: the space's account cannot open it -> refused, naming design@mavlers.test, no token in the body", async () => {
  const calls = [];
  const { app } = mount(checkWorld(), { fetchImpl: figmaFiles(new Set(), calls) });
  const r = await run(app.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  ok(r.statusCode === 200 && r.body.verdict === "refused", JSON.stringify(r.body));
  ok(r.body.readsWith.kind === "space" && r.body.readsWith.account === "design@mavlers.test", JSON.stringify(r.body.readsWith));
  ok(r.body.message === refusedOne("design@mavlers.test"), r.body.message);
  ok(calls.length === 1 && calls[0].tok === ACC2 && calls[0].url.endsWith("/v1/files/" + FILE + "/meta"), JSON.stringify(calls.map((c) => c.url)));
  ok(!JSON.stringify(r.body).includes("figu_") && !JSON.stringify(r.body).includes("figur_"), "no token");
});
await t("C7 the route: my own account opens it -> open as mine; the space is never asked", async () => {
  const calls = [];
  const tables = checkWorld({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U1, "one@acme.test", ACC1, REF1)] });
  const { app } = mount(tables, { fetchImpl: figmaFiles(new Set([ACC1]), calls) });
  const r = await run(app.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  ok(r.body.verdict === "open" && r.body.readsWith.kind === "own" && r.body.readsWith.account === "one+figma@acme.test" && r.body.fileName === "Spring sale", JSON.stringify(r.body));
  ok(calls.length === 1 && calls[0].tok === ACC1, "asked once, with my account");
});
await t("C8 the route: my account refused, the space's opens -> open, and it says the order reads as the space", async () => {
  const calls = [];
  const tables = checkWorld({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U1, "one@acme.test", ACC1, REF1)] });
  const { app } = mount(tables, { fetchImpl: figmaFiles(new Set([ACC2]), calls) });
  const r = await run(app.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  ok(r.body.verdict === "open" && r.body.readsWith.account === "design@mavlers.test" && /can't open this file, so design@mavlers\.test will read it/.test(r.body.message || ""), JSON.stringify(r.body));
  ok(calls.map((c) => c.tok).join(",") === ACC1 + "," + ACC2, "mine, then the space's");
});
await t("C9 the route: a colleague's own account is never asked for me", async () => {
  const calls = [];
  const tables = checkWorld({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U2, "two@acme.test", ACC1, REF1)] });
  const { app } = mount(tables, { fetchImpl: figmaFiles(new Set([ACC1]), calls) });
  const r = await run(app.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  ok(r.body.verdict === "refused" && calls.every((c) => c.tok !== ACC1), JSON.stringify(r.body));
});
await t("C10 the route: a space that must connect and has not -> blocked, without asking Figma", async () => {
  const calls = [];
  const { app } = mount(world({ org_figma_oauth: [] }), { fetchImpl: figmaFiles(new Set(), calls), env: { ...ENV, FIGMA_API_TOKEN: "figd_" + "g".repeat(30) } });
  const r = await run(app.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  ok(r.body.verdict === "blocked" && r.body.message === NO_SPACE_FIGMA && calls.length === 0, JSON.stringify(r.body));
});
await t("C11 the route: an older space on Mavloper's token, whose token lacks the scope -> unknown, never refused", async () => {
  const G = "figd_" + "g".repeat(30);
  const f = async () => answer(403, { status: 403, err: "Invalid scope(s): file_content:read" });
  const { app } = mount(world({ orgs: [{ ...SPACE, figma_required: false }], org_figma_oauth: [] }), { fetchImpl: f, env: { ...ENV, FIGMA_API_TOKEN: G } });
  const r = await run(app.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  ok(r.body.verdict === "unknown" && r.body.why === "scope" && r.body.readsWith.kind === "mavlers" && !JSON.stringify(r.body).includes(G), JSON.stringify(r.body));
});
await t("C12 the route: who may ask, and what is not a Figma link", async () => {
  const { app } = mount(checkWorld(), { fetchImpl: figmaFiles(new Set(), []) });
  const out = await run(app.routes["post /os/spaces/:slug/me/figma-check"], checkReq("stranger@else.test", U1, LINK));
  ok(out.statusCode === 403, "no seat in the space: " + out.statusCode);
  const bad = await run(app.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, "https://example.com/x"));
  ok(bad.statusCode === 400, "not a link: " + bad.statusCode);
});
await t("C13 the route: an open answer is cached per account and file; a refusal is asked again after 30 s", async () => {
  const calls = [];
  let clock = Date.now();
  const tables = checkWorld({ [MEMBER_OAUTH_TABLE]: [memberRow(ORG_A, U1, "one@acme.test", ACC1, REF1)] });
  const app = makeApp();
  createFigmaMemberRoutes({ app, supabaseAdmin: makeDb(tables), requireAuth: passAuth, log: () => {}, env: ENV, fetchImpl: figmaFiles(new Set([ACC1]), calls), now: () => clock });
  for (let i = 0; i < 3; i++) await run(app.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  ok(calls.length === 1, "three checks of one file, one call: " + calls.length);
  const calls2 = [];
  const app2 = makeApp();
  createFigmaMemberRoutes({ app: app2, supabaseAdmin: makeDb(checkWorld()), requireAuth: passAuth, log: () => {}, env: ENV, fetchImpl: figmaFiles(new Set(), calls2), now: () => clock });
  await run(app2.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  await run(app2.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  ok(calls2.length === 1, "refusal cached inside 30 s");
  clock += 31 * 1000;
  await run(app2.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  ok(calls2.length === 2, "asked again after 30 s: " + calls2.length);
});
await t("C14 the route: our own failure answers unknown, never an error the console would read as a refusal", async () => {
  const env = { ...ENV };
  Object.defineProperty(env, "FIGMA_API_TOKEN", { get() { throw new Error("boom"); }, enumerable: true });
  const app = makeApp();
  createFigmaMemberRoutes({ app, supabaseAdmin: makeDb(world({ org_figma_oauth: [] })), requireAuth: passAuth, log: () => {}, env, fetchImpl: figmaFiles(new Set(), []) });
  const r = await run(app.routes["post /os/spaces/:slug/me/figma-check"], checkReq("one@acme.test", U1, LINK));
  ok(r.statusCode === 200 && r.body.verdict === "unknown" && r.body.why === "check-failed", JSON.stringify(r.body));
});
await t("C15 the failure sentence an order still gets says both ways out, and is passed through as ours", async () => {
  const either = figmaCannotOpenEither("dhruv", "design");
  ok(either.indexOf("Connect the Figma account that owns it on Generate") > -1 && either.indexOf("Connect") < either.indexOf("share the file with either"), either);
  ok(plainReason("Figma fetch failed: " + either) === either);
});

await t("C16 never slower than 3 s: Figma that does not answer is unknown when the clock runs out", async () => {
  ok(CHECK_TIMEOUT_MS === 3000, "timeout " + CHECK_TIMEOUT_MS);
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const t0 = Date.now();
  const a = await checkFileAccess({ token: ACC1, fileKey: FILE, fetchImpl: hang, timeoutMs: 150 });
  ok(a.verdict === "unknown" && a.why === "no-answer" && Date.now() - t0 < 1000, JSON.stringify(a));
});

// -- W ------------------------------------------------------------------------
console.log("\nW  wiring");
const server = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
const runner = fs.readFileSync(new URL("./queue-runner.js", import.meta.url), "utf8");
await t("W1 server.js mounts the routes", async () => ok(/createFigmaMemberRoutes\(\{ app, supabaseAdmin, requireAuth, log, env: process\.env \}\)/.test(server)));
await t("W2 server.js: a signed-in caller's own id, never a body field, picks the personal account", async () => {
  ok(/const ordererId = req\.user \? req\.user\.id : req\.body\?\.leadUserId;/.test(server));
  ok(/resolveMemberFigmaOAuth\(req\.body\?\.orgId, ordererId,/.test(server));
});
await t("W3 server.js: the refusal and the read-again use the tested decisions", async () => {
  ok(/refuseWithoutSpaceFigma\(spaceCred, await spaceRequiresFigma\(/.test(server) && /readAgainAsSpace\(\{ usedMember: Boolean\(memberCred\)/.test(server));
});
await t("W4 queue-runner.js sends the orderer only with a real space and a real uuid", async () => {
  ok(/const leadUserId = normalisedUserId\(pick\.lead_user_id\);\s+if \(orgId !== null && leadUserId !== null\) jobBody\.leadUserId = leadUserId;/.test(runner));
});

console.log("\n================================================================");
console.log("PASS " + pass + "   FAIL " + fail);
console.log("================================================================");
process.exit(fail ? 1 : 0);
