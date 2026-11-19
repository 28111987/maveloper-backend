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
import { createFigmaPlatformTokenRoutes, readExpiryDate } from "./figma-platform-token.js";
import { accountNameOf, figmaCannotOpenEither, plainReason, NO_SPACE_FIGMA } from "./order-words.js";

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
      const rows = () => (tables[table] || []).filter((r) => q.filters.every(([c, v]) => r[c] === v));
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
console.log("\nT  Mavloper's own Figma token, measured");
function mountToken(tables, env, fetchImpl, clock) {
  const app = makeApp();
  createFigmaPlatformTokenRoutes({ app, supabaseAdmin: makeDb(tables), requireAuth: passAuth, log: () => {}, env, fetchImpl, now: clock || (() => Date.now()) });
  return app.routes["get /os/platform/figma-token"];
}
const PAT = "figd_" + "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0";
await t("T1 working: Figma answered 200, the token never appears, the expiry is the recorded one", async () => {
  let calls = 0;
  const route = mountToken(world(), { FIGMA_API_TOKEN: PAT, FIGMA_API_TOKEN_EXPIRES: "2027-01-17" }, async () => { calls++; return { ok: true, status: 200, json: async () => ({ handle: "mavloper-production" }) }; });
  const res = await run(route, as("owner@mavlers.test", U1));
  ok(res.statusCode === 200 && res.body.working === true && res.body.expiresOn === "2027-01-17", JSON.stringify(res.body));
  ok(!JSON.stringify(res.body).includes(PAT), "token not returned");
  await run(route, as("owner@mavlers.test", U1));
  ok(calls === 1, "cached, asked Figma " + calls + " times");
});
await t("T2 refused: Figma answered 403, working false and a plain note", async () => {
  const route = mountToken(world(), { FIGMA_API_TOKEN: PAT }, async () => ({ ok: false, status: 403, json: async () => ({}) }));
  const res = await run(route, as("owner@mavlers.test", U1));
  ok(res.body.working === false && /expired, revoked or wrong/.test(res.body.note) && res.body.expiresOn === null, JSON.stringify(res.body));
});
await t("T3 Figma did not answer: working is null (unknown), never false", async () => {
  const route = mountToken(world(), { FIGMA_API_TOKEN: PAT }, async () => { throw new Error("net"); });
  ok((await run(route, as("owner@mavlers.test", U1))).body.working === null);
});
await t("T4 only the platform owner may read it", async () => {
  const route = mountToken(world({ platform_owners: [] }), { FIGMA_API_TOKEN: PAT }, async () => ({ ok: true, status: 200, json: async () => ({}) }));
  ok((await run(route, as("admin@acme.test", U1))).statusCode === 403);
});
await t("T5 it counts the live spaces that would read with it", async () => {
  const tables = world({ orgs: [{ ...SPACE }, { id: ORG_B, slug: "b", is_deleted: false }, { id: "33333333-3333-4333-8333-333333333333", slug: "c", is_deleted: true }] });
  const route = mountToken(tables, { FIGMA_API_TOKEN: PAT }, async () => ({ ok: true, status: 200, json: async () => ({}) }));
  ok((await run(route, as("owner@mavlers.test", U1))).body.spacesUsingIt === 1);
});
await t("T6 the recorded expiry must be a real date", async () => {
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
