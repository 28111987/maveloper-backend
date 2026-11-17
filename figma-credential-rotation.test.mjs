// figma-credential-rotation.test.mjs - FIGMA_CRED_KEY rotation (17 NOV 2026).
//
// The rules, written before the code was run against them:
//   K  openTokenWithFallback opens with the current key, else (sealed values only)
//      with FIGMA_CRED_KEY_PREVIOUS; with no previous key it is openToken exactly.
//   R  resealAll moves every value that opens only with the previous key under the
//      current key; touches nothing else; is idempotent; loses nothing on a wrong
//      previous key; never overwrites a value that changed under it; never logs,
//      returns or throws a token, a sealed value or a key.
//   P  the two resolvers, keys read from env as production does: during the
//      rotation window (PREVIOUS set, rows not yet re-sealed) a space keeps its
//      own credential; with PREVIOUS absent nothing changes from today.
//   B  server.js boot: PREVIOUS absent -> no re-seal call, no re-seal log line;
//      PREVIOUS set -> /health answers at once (the deploy gate never waits) and
//      a failed re-seal logs a reason with no value in it.
//
// Run: node figma-credential-rotation.test.mjs

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  sealToken, openToken, openTokenWithFallback, readPreviousKey, KEY_ENV, PREVIOUS_KEY_ENV,
} from "./figma-credential-crypto.js";
import { resealAll } from "./figma-credential-reseal.js";
import { resolveFigmaToken } from "./figma-credential.js";
import { resolveFigmaOAuth } from "./figma-oauth.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

const OLD = crypto.randomBytes(32), NEW = crypto.randomBytes(32), WRONG = crypto.randomBytes(32);
const b64 = (k) => k.toString("base64");
const ORG = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777"];
const rnd = (n) => crypto.randomBytes(n).toString("hex").slice(0, n);
const access = ORG.map(() => "figu_" + rnd(40));
const refresh = ORG.map(() => "figur_" + rnd(40));
const pastedPlain = "figd_" + rnd(40);
const seal = (t, k) => { const s = sealToken(t, k); if (!s.ok) throw new Error("seal"); return s.sealed; };

// -- a fake of the slice of supabase-js the code uses -------------------------
function makeDb(tables, hooks = {}) {
  const calls = { reads: 0, writes: 0 };
  const db = {
    calls,
    tables,
    from(table) {
      const q = { table, filters: [], op: "select", patch: null, wantRows: false };
      const rows = () => (tables[table] || []).filter((r) => q.filters.every(([c, v]) => r[c] === v));
      const run = async () => {
        if (q.op === "select") { calls.reads++; return { data: rows().map((r) => ({ ...r })), error: null }; }
        calls.writes++;
        if (hooks.beforeUpdate) hooks.beforeUpdate(table, q);
        const hit = rows();
        for (const r of hit) Object.assign(r, q.patch);
        return { data: q.wantRows ? hit.map((r) => ({ org_id: r.org_id })) : null, error: null };
      };
      const b = {
        select() { if (q.op === "update") q.wantRows = true; return b; },
        update(patch) { q.op = "update"; q.patch = patch; return b; },
        eq(c, v) { q.filters.push([c, v]); return b; },
        async maybeSingle() { const r = await run(); return { data: r.data && r.data[0] ? r.data[0] : null, error: null }; },
        then(res, rej) { return run().then(res, rej); },
      };
      return b;
    },
  };
  return db;
}
// Production's shape: four OAuth connections sealed with OLD, two withdrawn pasted rows.
function productionLike() {
  return {
    org_figma_oauth: [0, 1, 2, 3].map((i) => ({
      org_id: ORG[i], access_token: seal(access[i], OLD), refresh_token: seal(refresh[i], OLD),
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(), is_active: true,
      figma_user_id: null, figma_email: null, figma_handle: null, scopes: null,
    })),
    org_figma_credentials: [
      { org_id: ORG[4], token: "revoked", is_active: false, label: "a", token_kind: "personal", expires_at: null },
      { org_id: ORG[5], token: "revoked", is_active: false, label: "b", token_kind: "personal", expires_at: null },
    ],
  };
}
const snapshot = (t) => JSON.stringify(t);
const secretsIn = (s) => {
  const hay = String(s);
  const needles = [...access, ...refresh, pastedPlain, b64(OLD), b64(NEW), b64(WRONG), OLD.toString("hex"), NEW.toString("hex")];
  return needles.some((n) => hay.includes(n)) || /figseal\.v1\./.test(hay);
};

// -- K ------------------------------------------------------------------------
console.log("\nK  openTokenWithFallback / readPreviousKey");
{
  const sOld = seal(access[0], OLD), sNew = seal(access[0], NEW);
  const a = openTokenWithFallback(sNew, NEW, OLD);
  check("K1 current key opens, usedPrevious false", a.ok && a.token === access[0] && a.usedPrevious === false);
  const b = openTokenWithFallback(sOld, NEW, OLD);
  check("K2 old-key value opens with the previous key, usedPrevious true", b.ok && b.token === access[0] && b.usedPrevious === true);
  const c = openTokenWithFallback(sOld, NEW, WRONG);
  const c0 = openToken(sOld, NEW);
  check("K3 neither key: fails with the current key's own error", !c.ok && c.error === c0.error && c.usedPrevious === false);
  const d = openTokenWithFallback(sOld, NEW, null), d0 = openToken(sOld, NEW);
  check("K4 no previous key: identical to openToken", d.ok === d0.ok && d.error === d0.error && d.token === d0.token);
  const e = openTokenWithFallback("revoked", NEW, OLD);
  check("K5 an unsealed value passes through untouched, previous never tried", e.ok && e.token === "revoked" && e.wasSealed === false && e.usedPrevious === false);
  const p0 = readPreviousKey(undefined), p1 = readPreviousKey(""), p2 = readPreviousKey(b64(OLD));
  check("K6 PREVIOUS absent or empty is not an error and is no key", p0.ok && p0.key === null && p1.ok && p1.key === null);
  check("K7 PREVIOUS valid reads as the key", p2.ok && Buffer.isBuffer(p2.key) && p2.key.equals(OLD));
  const bad = "not-a-key-" + rnd(8);
  const p3 = readPreviousKey(bad);
  check("K8 PREVIOUS malformed: refused, named by its variable, value not echoed", !p3.ok && p3.key === null && p3.error.includes(PREVIOUS_KEY_ENV) && !p3.error.includes(bad));
}

// -- R ------------------------------------------------------------------------
console.log("\nR  resealAll");
{
  const t = productionLike(), db = makeDb(t);
  const r = await resealAll({ db, env: { [KEY_ENV]: b64(NEW) } });
  check("R0 PREVIOUS absent: does not run, reads nothing, writes nothing", r.ran === false && db.calls.reads === 0 && db.calls.writes === 0, JSON.stringify(r));
}
{
  const t = productionLike(), db = makeDb(t);
  const before = JSON.parse(snapshot(t));
  const logs = [];
  const r = await resealAll({ db, env: { [KEY_ENV]: b64(NEW), [PREVIOUS_KEY_ENV]: b64(OLD) }, log: (...a) => logs.push(JSON.stringify(a)) });
  check("R1 production's shape: 4 OAuth connections re-sealed, 0 unopenable, 2 withdrawn rows skipped",
    r.ran && r.oauth.rows === 4 && r.oauth.resealed === 4 && r.oauth.unopenable === 0 && r.pasted.inactiveSkipped === 2 && r.pasted.resealed === 0, JSON.stringify(r));
  const allNew = t.org_figma_oauth.every((row, i) =>
    openToken(row.access_token, NEW).token === access[i] && openToken(row.refresh_token, NEW).token === refresh[i]);
  const noneOld = t.org_figma_oauth.every((row) => !openToken(row.access_token, OLD).ok && !openToken(row.refresh_token, OLD).ok);
  check("R1b afterwards every OAuth value opens with the NEW key alone, to the same token", allNew);
  check("R1c ...and no longer opens with the OLD key", noneOld);
  check("R1d the withdrawn rows are byte for byte unchanged", JSON.stringify(t.org_figma_credentials) === JSON.stringify(before.org_figma_credentials));
  check("R1e no token, sealed value or key in the summary or the log", !secretsIn(JSON.stringify(r)) && !secretsIn(logs.join("\n")), logs.join(" | ").slice(0, 200));

  const writesBefore = db.calls.writes;
  const r2 = await resealAll({ db, env: { [KEY_ENV]: b64(NEW), [PREVIOUS_KEY_ENV]: b64(OLD) } });
  check("R2 idempotent: a second run finds 4 current, re-seals 0, writes nothing", r2.ran && r2.oauth.current === 4 && r2.oauth.resealed === 0 && db.calls.writes === writesBefore, JSON.stringify(r2));
}
{
  const t = productionLike(), db = makeDb(t), before = snapshot(t);
  const r = await resealAll({ db, env: { [KEY_ENV]: b64(NEW), [PREVIOUS_KEY_ENV]: b64(WRONG) } });
  check("R3 a WRONG previous key: 4 unopenable, nothing written, every row unchanged", r.ran && r.oauth.unopenable === 4 && r.oauth.resealed === 0 && db.calls.writes === 0 && snapshot(t) === before, JSON.stringify(r));
}
{
  const t = productionLike();
  const raced = seal("figu_" + rnd(40), NEW);
  const db = makeDb(t, { beforeUpdate: (table, q) => { if (table === "org_figma_oauth" && q.filters.some(([c, v]) => c === "org_id" && v === ORG[0])) t.org_figma_oauth[0].access_token = raced; } });
  const r = await resealAll({ db, env: { [KEY_ENV]: b64(NEW), [PREVIOUS_KEY_ENV]: b64(OLD) } });
  check("R4 a refresh racing the re-seal wins: counted raceSkipped, its value kept", r.oauth.raceSkipped === 1 && r.oauth.resealed === 3 && t.org_figma_oauth[0].access_token === raced, JSON.stringify(r));
}
{
  const t = productionLike(), db = makeDb(t);
  const r = await resealAll({ db, env: { [KEY_ENV]: b64(NEW), [PREVIOUS_KEY_ENV]: b64(NEW) } });
  check("R5 PREVIOUS equal to the current key: does not run, writes nothing", r.ran === false && db.calls.writes === 0 && db.calls.reads === 0);
  const r2 = await resealAll({ db, env: { [KEY_ENV]: b64(NEW), [PREVIOUS_KEY_ENV]: "short" } });
  check("R6 PREVIOUS malformed: does not run, reason carries no value", r2.ran === false && !r2.reason.includes("short") && db.calls.reads === 0);
  const r3 = await resealAll({ db, env: { [PREVIOUS_KEY_ENV]: b64(OLD) } });
  check("R6b current key missing: does not run, reads nothing", r3.ran === false && db.calls.reads === 0);
}
{
  const t = productionLike();
  t.org_figma_credentials.push({ org_id: ORG[6], token: seal(pastedPlain, OLD), is_active: true, label: "c", token_kind: "personal", expires_at: null });
  t.org_figma_credentials.push({ org_id: ORG[3].replace("4444-4444", "4444-4445"), token: pastedPlain, is_active: true, label: "d", token_kind: "personal", expires_at: null });
  const db = makeDb(t);
  const r = await resealAll({ db, env: { [KEY_ENV]: b64(NEW), [PREVIOUS_KEY_ENV]: b64(OLD) } });
  check("R7 an active pasted token sealed with OLD is re-sealed; an active plain one is counted, left as is",
    r.pasted.resealed === 1 && r.pasted.plainActive === 1 && openToken(t.org_figma_credentials[2].token, NEW).token === pastedPlain && t.org_figma_credentials[3].token === pastedPlain, JSON.stringify(r));
}

// -- P ------------------------------------------------------------------------
console.log("\nP  the resolvers during and outside the rotation window (keys from env)");
{
  const t = productionLike(), db = makeDb(t);
  const during = await resolveFigmaOAuth(ORG[0], { db, env: { [KEY_ENV]: b64(NEW), [PREVIOUS_KEY_ENV]: b64(OLD) } });
  check("P1 OAuth row still on OLD, PREVIOUS set: the space keeps its own connection", during && during.token === access[0]);
  const swapOnly = await resolveFigmaOAuth(ORG[0], { db, env: { [KEY_ENV]: b64(NEW) } });
  check("P2 control: a bare key swap (no PREVIOUS) loses the connection, as before this change", swapOnly === null);
  const today = await resolveFigmaOAuth(ORG[0], { db, env: { [KEY_ENV]: b64(OLD) } });
  check("P3 PREVIOUS absent, current key unchanged: exactly today's result", today && today.token === access[0]);
}
{
  const cred = { org_id: ORG[6], token: seal(pastedPlain, OLD), is_active: true, label: "c", token_kind: "personal", expires_at: null };
  const db = makeDb({ org_figma_credentials: [cred] });
  const g = "figd_" + rnd(40);
  const during = await resolveFigmaToken(ORG[6], { db, globalToken: g, env: { [KEY_ENV]: b64(NEW), [PREVIOUS_KEY_ENV]: b64(OLD) } });
  check("P4 pasted token still on OLD, PREVIOUS set: the space's own token, not the Mavlers one", during.source === "org" && during.token === pastedPlain, during.source + " " + during.reason);
  const swapOnly = await resolveFigmaToken(ORG[6], { db, globalToken: g, env: { [KEY_ENV]: b64(NEW) } });
  check("P5 control: a bare key swap silently falls back to the global token", swapOnly.source === "global" && swapOnly.reason === "unopenable");
  const today = await resolveFigmaToken(ORG[6], { db, globalToken: g, env: { [KEY_ENV]: b64(OLD) } });
  check("P6 PREVIOUS absent, current key unchanged: exactly today's result", today.source === "org" && today.token === pastedPlain && today.reason === "org-credential");
}

// -- B ------------------------------------------------------------------------
console.log("\nB  server.js boot");
async function boot(extraEnv) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
    PORT: String(port), RUNNER_ENABLED: "false",
    SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "dummy", SUPABASE_JWT_SECRET: "dummy",
    PLATFORM_OWNERS: "owner@example.test", ...extraEnv,
  };
  const child = spawn(process.execPath, [path.join(HERE, "server.js")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const t0 = Date.now();
  let ms = null;
  while (Date.now() - t0 < 20000) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { ms = Date.now() - t0; break; } } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 2500));
  child.kill();
  return { out, ms };
}
{
  const a = await boot({ [KEY_ENV]: b64(NEW) });
  check("B1 PREVIOUS absent: /health answers, no re-seal line at all", a.ms !== null && !/re-seal/.test(a.out), a.out.slice(-300));
  const b = await boot({ [KEY_ENV]: b64(NEW), [PREVIOUS_KEY_ENV]: b64(OLD) });
  check("B2 PREVIOUS set, database unreachable: /health still answers at boot", b.ms !== null, String(b.ms));
  check("B3 ...and the re-seal reports that it stopped, with a reason", /figma credential re-seal (stopped|did not run)/.test(b.out), b.out.slice(-400));
  check("B4 ...and no key appears anywhere in the output", !secretsIn(b.out));
}

console.log(`\nfigma-credential-rotation.test.mjs: ${pass} passed, ${fail} failed`);
if (fail) { console.log("failed: " + failures.join(" | ")); process.exit(1); }
