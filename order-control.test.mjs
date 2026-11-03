// order-control.test.mjs
// ---------------------------------------------------------------------------
// RUN 17. EVERY ORDER CAN BE CONTROLLED, AND NO ORDER STAYS STUCK.
//
// Run (needs Docker, postgres:15 and postgrest/postgrest:v12.2.3 images, and the
// console repository for the access grid's database):
//   docker run -d --name mav-run17-pg -e POSTGRES_PASSWORD=<any local value> -p 55450:5432 postgres:15
//   bash order-control.db.sh start
//   node order-control.test.mjs S1 S2 S3 S4 S5 S6 S7      (any subset; exit 0 = every case passed)
//   bash order-control.db.sh stop ; docker rm -f mav-run17-pg
// Old arm (today's code): OC_ARM=old OC_BACKEND_DIR=<a checkout of a3aeea0 with node_modules>
//
// WHAT IT BOOTS. The REAL server.js (from OC_BACKEND_DIR, default this folder) as
// a child process, with dummy env values, against:
//   - the access grid's database (console repo supabase/tests/access-grid, the
//     15C migration and every later one applied), served by a local PostgREST;
//   - a local front for it that answers /auth/v1/user for the grid's people
//     from a JWT signed here with the local secret (dummy, never a real token);
//   - a FAKE ENGINE (order-control.fake-engine.mjs), never the real one;
//   - a fake Figma (served here), reached through order-control.net-guard.mjs,
//     which refuses every non-local request and counts it.
// Nothing reaches Supabase, Railway, Figma, Google, Dropbox or Cloud Run.
//
// EXPECTED VALUES COME FROM THE RULES OF THE RUN 17 BRIEF (K1-K9, L1-L5, T1-T4),
// written into `expectAction` and each scenario before the code was changed.
// ---------------------------------------------------------------------------
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeEngine } from "./order-control.fake-engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARM = process.env.OC_ARM === "old" ? "old" : "new";
const BACKEND_DIR = path.resolve(process.env.OC_BACKEND_DIR || HERE);
const REST_URL = process.env.OC_REST_URL || "http://127.0.0.1:55451";
const PG = process.env.OC_PG || "mav-run17-pg";
const DB = process.env.OC_DB || "oc_cur";
const SECRET = readFileSync(process.env.OC_SECRET_FILE || path.join(process.env.TMPDIR || os.tmpdir(), "order-control.secret"), "utf8").trim();
const RESULTS = process.env.OC_RESULTS || null;
const BRIDGE_SECRET = "oc-dummy-bridge-secret";

// ── the grid's people (supabase/tests/access-grid/seed.sql) ──────────────────
const SP = {
  I: "00000000-0000-4000-8000-00000000000a",
  A: "00000000-0000-4000-8000-000000000001", // closed
  B: "00000000-0000-4000-8000-000000000002",
  C: "00000000-0000-4000-8000-000000000003",
};
const uid = (n) => "10000000-0000-4000-8000-" + String(n).padStart(12, "0");
const PEOPLE = {
  owner:        { id: uid(1),  email: "owner@example.test",       cur: "I", name: "owner" },
  "admin-b":    { id: uid(3),  email: "admin-b@example.test",     cur: "B", name: "admin-b" },
  "dev-b":      { id: uid(4),  email: "dev-b@example.test",       cur: "B", name: "dev-b" },
  "admin-c":    { id: uid(5),  email: "admin-c@example.test",     cur: "C", name: "admin-c" },
  "dev-c":      { id: uid(6),  email: "dev-c@example.test",       cur: "C", name: "dev-c" },
  "multi-in-b": { id: uid(7),  email: "multi@example.test",       cur: "B", name: "multi" },
  "closed-only":{ id: uid(8),  email: "closed-only@example.test", cur: "A", name: "closed-only" },
  noseat:       { id: uid(9),  email: "noseat@example.test",      cur: "B", name: "noseat" },
  caps:         { id: uid(10), email: "caps@example.test",        cur: "B", name: "caps" },
};

// ── small helpers ───────────────────────────────────────────────────────────
const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function jwt(claims) {
  const h = b64u({ alg: "HS256", typ: "JWT" });
  const p = b64u({ aud: "authenticated", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  const s = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
function verifyJwt(token) {
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) return null;
  const want = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  if (want !== s) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return null; }
}
const SERVICE_KEY = jwt({ role: "service_role", aud: undefined });
const tokenOf = (who) => jwt({ sub: PEOPLE[who].id, email: PEOPLE[who].email, role: "authenticated" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = Date.now() % 100000;
const nextN = () => ++seq;
const figmaUrlFor = (n) => `https://www.figma.com/design/OCfile${String(n).padStart(10, "0")}/x?node-id=1-2`;

function psql(sql) {
  return execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8" }).trim();
}

async function rest(method, pathAndQuery, { body, token = SERVICE_KEY, prefer } = {}) {
  const headers = { apikey: SERVICE_KEY, "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${REST_URL}/${pathAndQuery}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

// ── results ─────────────────────────────────────────────────────────────────
const results = [];
function record(scenario, kase, rule, expected, actual) {
  const pass = String(expected) === String(actual);
  const line = { arm: ARM, scenario, case: kase, rule, expected: String(expected), actual: String(actual), pass };
  results.push(line);
  const txt = `${pass ? "PASS" : "FAIL"} ${ARM} ${scenario} | ${kase} | ${rule} | expected: ${expected} | actual: ${actual}`;
  console.log(txt);
  if (RESULTS) appendFileSync(RESULTS, txt + "\n");
  return pass;
}

// ── the local front: /auth/v1/user from our JWT, /rest/v1 to PostgREST ───────
async function startFront() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (url.pathname === "/auth/v1/user") {
      const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || "");
      const claims = m && verifyJwt(m[1]);
      if (!claims || !claims.sub) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ code: 401, msg: "invalid JWT" })); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: claims.sub, aud: "authenticated", role: "authenticated", email: claims.email, app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" }));
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const to = REST_URL + url.pathname.slice("/rest/v1".length) + url.search;
      const headers = { ...req.headers };
      delete headers.host; delete headers["content-length"]; delete headers.connection;
      try {
        const r = await fetch(to, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
        const out = Buffer.from(await r.arrayBuffer());
        const h = {};
        r.headers.forEach((v, k) => { if (!["content-encoding", "transfer-encoding", "connection", "content-length"].includes(k)) h[k] = v; });
        res.writeHead(r.status, h);
        return res.end(out);
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "front: " + e.message }));
      }
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "front: no such path " + url.pathname }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// ── the fake Figma ──────────────────────────────────────────────────────────
function startFigma() {
  const state = { mode: "ok", calls: [] };
  const box = (x, y, w, h) => ({ x, y, width: w, height: h });
  const text = (id, y, s) => ({ id, name: "Text", type: "TEXT", visible: true, characters: s, absoluteBoundingBox: box(0, y, 600, 40), style: { fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeightPx: 24, textAlignHorizontal: "LEFT" }, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }] });
  const sec = (id, y, kids) => ({ id, name: "Section " + id, type: "FRAME", visible: true, absoluteBoundingBox: box(0, y, 600, 200), fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], children: kids });
  const doc = { id: "1:2", name: "Email", type: "FRAME", visible: true, absoluteBoundingBox: box(0, 0, 600, 400), fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], children: [sec("2:1", 0, [text("3:1", 20, "Hello there")]), sec("2:2", 200, [text("3:2", 220, "Second block of copy")])] };
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const url = new URL(req.url, "http://127.0.0.1");
    state.calls.push(url.pathname);
    const send = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (/^\/v1\/files\/[^/]+\/nodes$/.test(url.pathname)) {
      if (state.mode === "403") return send(403, { status: 403, err: "Forbidden" });
      const ids = url.searchParams.get("ids") || "1:2";
      return send(200, { name: "OC design", nodes: { [ids]: { document: doc, components: {}, styles: {} } } });
    }
    if (/^\/v1\/images\//.test(url.pathname)) return send(200, { err: null, images: {} });
    return send(404, { status: 404, err: "Not found" });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${server.address().port}`, state,
    close: () => new Promise((rr) => { server.closeAllConnections?.(); server.close(rr); }),
  })));
}

// ── the server under test ───────────────────────────────────────────────────
async function freePort() {
  const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port; await new Promise((r) => s.close(r)); return p;
}

async function startServer({ front, figma, engine, env = {}, port }) {
  port = port || await freePort();
  const lines = [];
  const refused = [];
  const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(HERE, "order-control.net-guard.mjs")).href, path.join(BACKEND_DIR, "server.js")], {
    cwd: BACKEND_DIR,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      PORT: String(port),
      SUPABASE_URL: front.url,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      SUPABASE_ANON_KEY: "oc-dummy-anon",
      SUPABASE_JWT_SECRET: "oc-dummy-not-used-for-verification",
      MAC_BRIDGE_URL: engine.url,
      MAC_BRIDGE_SECRET: BRIDGE_SECRET,
      PUBLIC_BACKEND_URL: `http://127.0.0.1:${port}`,
      PLATFORM_OWNERS: "owner@example.test",
      FIGMA_API_TOKEN: "figd_oc_dummy_global_token_for_tests",
      OC_FIGMA_URL: figma.url,
      HEARTBEAT_MS: "3600000",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onData = (buf, sink) => {
    for (const l of buf.toString().split(/\r?\n/)) {
      if (!l.trim()) continue;
      sink.push(l);
      if (l.includes("ocNetRefused")) refused.push(l);
      if (process.env.OC_VERBOSE) console.log("   [srv] " + l.slice(0, 300));
    }
  };
  child.stdout.on("data", (b) => onData(b, lines));
  child.stderr.on("data", (b) => onData(b, lines));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + "/health"); if (r.ok) break; } catch { /* starting */ }
    await sleep(100);
  }
  return {
    base, port, child, lines, refused,
    logs: () => lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean),
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

// ── data helpers ────────────────────────────────────────────────────────────
function parkSeedOrders() {
  // The seed holds pending orders in every space; a runner scenario must start
  // from a queue holding only its own orders. Test database only.
  psql(`update public.os_queue set status = 'failed', error_text = 'parked by order-control setup'
        where status in ('pending','processing');`);
}

async function insertOrder({ space, lead, status = "pending", uploadedAt, n = nextN(), errorText = null, jobId = null, startedAt = null, finishedAt = null, html = null, manualRank = null, engine, orderId }) {
  const p = PEOPLE[lead];
  const row = {
    order_id: orderId || `OC${ARM.toUpperCase()}-${n}`,
    figma_url: figmaUrlFor(n),
    tat_hours: 24,
    deadline: "2026-12-31T00:00:00Z",
    lead_email: p.email,
    lead_user_id: p.id,
    org_id: SP[space],
    status,
    uploaded_at: uploadedAt || new Date().toISOString(),
    error_text: errorText,
    job_id: jobId,
    started_at: startedAt,
    finished_at: finishedAt,
    html_content: html,
    manual_rank: manualRank,
  };
  // RUN 18: os_queue.engine only when the scenario names one, so every S1-S7
  // row is exactly the row it was (and still inserts on a database without it).
  if (engine !== undefined) row.engine = engine;
  const r = await rest("POST", "os_queue", { body: row, prefer: "return=representation" });
  if (r.status !== 201) throw new Error("insert os_queue failed: " + JSON.stringify(r.data));
  return r.data[0];
}

async function insertJob({ figmaUrl, orderId, status = "running", bridgeJobId = null }) {
  const row = { status, figma_url: figmaUrl, order_id: orderId, progress_message: bridgeJobId ? `Dispatched to bridge (bridgeJobId=${bridgeJobId})` : "Generation started", error_message: bridgeJobId ? `__BRIDGE__:${bridgeJobId}` : null };
  const r = await rest("POST", "maveloper_jobs", { body: row, prefer: "return=representation" });
  if (r.status !== 201) throw new Error("insert job failed: " + JSON.stringify(r.data));
  return r.data[0];
}

async function getOrder(id) {
  const r = await rest("GET", `os_queue?id=eq.${id}&select=*`);
  return (r.data && r.data[0]) || null;
}
async function getJob(id) {
  const r = await rest("GET", `maveloper_jobs?id=eq.${id}&select=*`);
  return (r.data && r.data[0]) || null;
}
async function jobsForOrder(orderId) {
  const r = await rest("GET", `maveloper_jobs?order_id=eq.${encodeURIComponent(orderId)}&select=*&order=created_at.asc`);
  return r.data || [];
}
async function auditFor(rowId) {
  const r = await rest("GET", `os_admin_audit?subject_row_id=eq.${rowId}&select=*&order=id.asc`);
  return r.data || [];
}
async function waitFor(fn, timeoutMs, stepMs = 500) {
  const end = Date.now() + timeoutMs;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return v;
}

// the order the runner will build next in a space, by the runner's own comparator
function cmpFifo(a, b) {
  const am = a.manual_rank ?? null, bm = b.manual_rank ?? null;
  if (am != null && bm != null && am !== bm) return am - bm;
  if (am != null && bm == null) return -1;
  if (am == null && bm != null) return 1;
  const au = Date.parse(a.uploaded_at), bu = Date.parse(b.uploaded_at);
  if (au !== bu) return au - bu;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ── the environment every scenario shares ───────────────────────────────────
async function env0() {
  const front = await startFront();
  const figma = await startFigma();
  const engine = createFakeEngine({ secret: BRIDGE_SECRET, log: process.env.OC_VERBOSE ? console.log : () => {} });
  engine.url = await engine.listen();
  return {
    front, figma, engine,
    async close() { await engine.close(); await figma.close(); await front.close(); },
  };
}

function stageLines(srv) {
  return srv.logs().filter((l) => l.msg === "order stage");
}
const PLAIN = /\b(bridge|Bridge|BRIDGE|token|TOKEN|FIGMA_API_TOKEN|env var|MAC_BRIDGE|ngrok|cc-runner|Claude|exitCode|stderr|maveloper_jobs|__BRIDGE__|Runner|runner|Auto-cleared|self-heal|shrujal@)\b/;
const NO_EM_DASH = (s) => !/—/.test(String(s || ""));

// ══════════════════════════════════════════════════════════════════════════
// S1  THE ENGINE STARTS IN 58 s (and a second case at 65 s, past the old 60 s
//     dispatch limit, the TEST16-2115 shape): the order delivers, ONE build.
//     Rules L3 (never failed by the dispatch limit while the engine starts),
//     T3 (the credential line), T4 (one timing line per stage), L4.
// ══════════════════════════════════════════════════════════════════════════
async function S1() {
  for (const startupMs of [58000, 65000]) {
    execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
    parkSeedOrders();
    const E = await env0();
    E.engine.set({ startupMs, buildMs: 1500 });
    const srv = await startServer({ ...E, env: { RUNNER_ENABLED: "true", RUNNER_POLL_MS: "2000" } });
    const kase = `start-up ${startupMs / 1000} s`;
    try {
      const o = await insertOrder({ space: "B", lead: "dev-b" });
      const done = await waitFor(async () => {
        const r = await getOrder(o.id);
        return r && (r.status === "delivered" || r.status === "failed") ? r : null;
      }, startupMs + 150000, 1000);
      record("S1", kase, "L3 the order delivers", "delivered", done ? done.status : "still " + ((await getOrder(o.id))?.status));
      // late callbacks for a failed dispatch arrive after the build; give them time
      await sleep(4000);
      const after = await getOrder(o.id);
      record("S1", kase, "L4 final state after every callback", "delivered", after?.status);
      record("S1", kase, "L3/L4 engine builds for this order", 1, E.engine.builds.length);
      const jobs = await jobsForOrder(o.order_id);
      const last = jobs.filter((j) => j.status === "completed").pop();
      record("S1", kase, "T3 the delivered job names its Figma credential", true, Boolean(last && /Figma credential:/.test(last.progress_message || "")));
      const st = stageLines(srv);
      const stages = new Set(st.map((l) => l.stage));
      for (const s of ["claim", "dispatch", "accepted", "callback", "asset-upload", "write", "settle"]) {
        record("S1", kase, `T4 a timed '${s}' line`, true, stages.has(s) && st.filter((l) => l.stage === s).every((l) => Number.isFinite(l.ms)));
      }
      const leaky = st.filter((l) => /@|figd_|Bearer|eyJ/.test(JSON.stringify(l)));
      record("S1", kase, "T4 no email, token or secret in a stage line", 0, leaky.length);
      record("S1", kase, "no request left this machine", 0, srv.refused.length);
    } finally {
      await srv.stop();
      await E.close();
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// S2  THE ENGINE ACCEPTS, THEN DIES (never calls back; asked, it does not know
//     the job): the order fails by itself within 3 minutes (L1), in plain words,
//     and the next order of that space runs. Production intervals (runner poll
//     10 s, probe defaults). The new arm switches the liveness check on, because
//     it only works against an engine that answers GET /jobs/:id (the fake does,
//     as the engine spec says).
// ══════════════════════════════════════════════════════════════════════════
async function S2() {
  execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
  parkSeedOrders();
  const E = await env0();
  E.engine.set({ dieAfterAccept: true });
  const srv = await startServer({ ...E, env: { RUNNER_ENABLED: "true", ENGINE_JOB_PROBE: "true" } });
  try {
    const t0 = Date.now();
    const o1 = await insertOrder({ space: "B", lead: "dev-b", uploadedAt: new Date(t0 - 2000).toISOString() });
    const o2 = await insertOrder({ space: "B", lead: "admin-b", uploadedAt: new Date(t0 - 1000).toISOString() });
    const accepted = await waitFor(async () => E.engine.builds.length >= 1, 60000, 500);
    record("S2", "engine accepted then died", "setup: the engine accepted the first order", true, Boolean(accepted));
    const tAccepted = Date.now();
    const failed = await waitFor(async () => {
      const r = await getOrder(o1.id);
      return r && r.status === "failed" ? r : null;
    }, 180000, 2000);
    const took = Math.round((Date.now() - tAccepted) / 1000);
    record("S2", "engine accepted then died", "L1 failed by itself within 3 minutes", "failed", failed ? "failed" : `still ${(await getOrder(o1.id))?.status} after ${took} s`);
    record("S2", "engine accepted then died", "L1 the reason, word for word", "The build stopped on our side. Please resubmit.", failed ? failed.error_text : "(none)");
    const next = await waitFor(async () => {
      const r = await getOrder(o2.id);
      return r && r.status !== "pending" ? r : null;
    }, 30000, 1000);
    record("S2", "engine accepted then died", "L1 the next order of that space runs", true, Boolean(next));
    record("S2", "engine accepted then died", "no request left this machine", 0, srv.refused.length);
  } finally {
    await srv.stop();
    await E.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// S3  THE DISPATCH GIVES UP, THE ENGINE ACCEPTS ANYWAY AND CALLS BACK.
//     a) nobody re-runs it: exactly one build, the result is DELIVERED (L4).
//     b) a person retries after the failure: the late result of the first build
//        is recorded as discarded (never silently dropped), the retry delivers,
//        and there are exactly two builds, the second asked for by a person.
//     The engine holds the dispatch past the backend's dispatch limit (65 s on
//     the old arm, whose limit is a fixed 60 s; the new arm's limit is shortened
//     by its own env value so the case still happens).
// ══════════════════════════════════════════════════════════════════════════
async function S3() {
  for (const variant of ["a: not re-run", "b: a person retries"]) {
    execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
    parkSeedOrders();
    const E = await env0();
    const hold = ARM === "old" ? 65000 : 8000;
    E.engine.set({ acceptDelayMs: hold, buildMs: variant.startsWith("b") ? 20000 : 2000 });
    const srv = await startServer({ ...E, env: { RUNNER_ENABLED: "true", RUNNER_POLL_MS: "2000", BRIDGE_DISPATCH_TIMEOUT_MS: "4000" } });
    try {
      const o = await insertOrder({ space: "B", lead: "dev-b" });
      const failed = await waitFor(async () => {
        const r = await getOrder(o.id);
        return r && r.status === "failed" ? r : null;
      }, hold + 60000, 1000);
      record("S3", variant, "setup: the dispatch limit failed the order", "failed", failed ? "failed" : (await getOrder(o.id))?.status);
      if (failed) {
        record("S3", variant, "T2 the dispatch failure is plain words", true, !PLAIN.test(failed.error_text || "") && NO_EM_DASH(failed.error_text));
      }
      if (variant.startsWith("b") && failed) {
        // the person's retry, the way each arm offers it; only the FIRST dispatch is slow
        E.engine.set({ acceptDelayMs: 0 });
        if (ARM === "old") {
          await rest("PATCH", `os_queue?id=eq.${o.id}`, { token: tokenOf("dev-b"), body: { status: "pending", error_text: null, job_id: null, started_at: null, finished_at: null } });
        } else {
          await fetch(`${srv.base}/os/orders/${o.id}/retry`, { method: "POST", headers: { authorization: `Bearer ${tokenOf("dev-b")}` } });
        }
      }
      const settled = await waitFor(async () => {
        const r = await getOrder(o.id);
        const cbDone = E.engine.callbacks.length >= E.engine.builds.length && E.engine.builds.length >= (variant.startsWith("b") ? 2 : 1);
        return r && r.status === "delivered" && cbDone ? r : null;
      }, hold + 120000, 1000);
      await sleep(3000);
      const final = await getOrder(o.id);
      record("S3", variant, "L4 the order ends delivered", "delivered", final?.status);
      record("S3", variant, "L4 builds", variant.startsWith("b") ? 2 : 1, E.engine.builds.length);
      const jobs = await jobsForOrder(o.order_id);
      if (variant.startsWith("a")) {
        const delivered = jobs.some((j) => j.status === "completed");
        record("S3", variant, "L4 the late result is delivered, not dropped", true, delivered && final?.status === "delivered" && /FAKE BUILD/.test(final?.html_content || ""));
      } else {
        const first = jobs[0];
        const noted = first && /late result arrived at .* and was discarded because/i.test(`${first.progress_message || ""}`);
        record("S3", variant, "L4 the first build's late result is recorded as discarded", true, Boolean(noted));
      }
      record("S3", variant, "no request left this machine", 0, srv.refused.length);
      void settled;
    } finally {
      await srv.stop();
      await E.close();
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// S4  THE BACKEND RESTARTS MID-BUILD.
//     a) after the engine accepted: the result reaches the order through the
//        durable path and the delivered job names its credential (L5, T3).
//     b) before anything was sent to the engine (the backend dies while it is
//        still reading Figma): the order is failed in plain words within 3
//        minutes of the restart, never left processing (L5).
// ══════════════════════════════════════════════════════════════════════════
async function S4() {
  // a
  {
    execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
    parkSeedOrders();
    const E = await env0();
    E.engine.set({ buildMs: 12000 });
    let srv = await startServer({ ...E, env: { RUNNER_ENABLED: "true", RUNNER_POLL_MS: "2000" } });
    const port = srv.port;
    try {
      const o = await insertOrder({ space: "B", lead: "dev-b" });
      await waitFor(async () => E.engine.builds.length >= 1, 60000, 300);
      await srv.stop();
      srv = await startServer({ ...E, port, env: { RUNNER_ENABLED: "true", RUNNER_POLL_MS: "2000" } });
      const done = await waitFor(async () => {
        const r = await getOrder(o.id);
        return r && (r.status === "delivered" || r.status === "failed") ? r : null;
      }, 120000, 1000);
      record("S4", "a: restart after the engine accepted", "L5 recovered through the durable path", "delivered", done?.status ?? (await getOrder(o.id))?.status);
      const jobs = await jobsForOrder(o.order_id);
      const last = jobs.filter((j) => j.status === "completed").pop();
      record("S4", "a: restart after the engine accepted", "T3 the delivered job names its Figma credential", true, Boolean(last && /Figma credential:/.test(last.progress_message || "")));
      record("S4", "a: restart after the engine accepted", "builds", 1, E.engine.builds.length);
    } finally {
      await srv.stop();
      await E.close();
    }
  }
  // b
  {
    execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
    parkSeedOrders();
    const E = await env0();
    E.engine.set({ startupMs: 300000 }); // the engine never becomes ready while the first process lives
    let srv = await startServer({ ...E, env: { RUNNER_ENABLED: "true" } });
    const port = srv.port;
    try {
      const o = await insertOrder({ space: "B", lead: "dev-b" });
      await waitFor(async () => (await getOrder(o.id))?.status === "processing", 30000, 300);
      await sleep(1500);
      await srv.stop();
      E.engine.set({ startupMs: 0 });
      E.engine.cold();
      const tRestart = Date.now();
      srv = await startServer({ ...E, port, env: { RUNNER_ENABLED: "true" } });
      const failed = await waitFor(async () => {
        const r = await getOrder(o.id);
        return r && r.status === "failed" ? r : null;
      }, 180000, 2000);
      const took = Math.round((Date.now() - tRestart) / 1000);
      record("S4", "b: restart before dispatch", "L5 failed within 3 minutes of the restart", "failed", failed ? "failed" : `still ${(await getOrder(o.id))?.status} after ${took} s`);
      record("S4", "b: restart before dispatch", "L5 the reason, word for word", "The build stopped on our side. Please resubmit.", failed ? failed.error_text : "(none)");
      record("S4", "b: restart before dispatch", "builds", 0, E.engine.builds.length);
    } finally {
      await srv.stop();
      await E.close();
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// S5  EVERY ACTION x EVERY ROLE x EVERY STATE, in the order's space and from
//     another space. Expected values from K1-K8 only.
// ══════════════════════════════════════════════════════════════════════════
const ACTIONS = ["cancel", "stop", "remove", "run-next", "retry"];
const STATES = ["pending", "processing", "failed", "cancelled", "delivered"];
const VALID = {
  cancel: ["pending"],
  stop: ["processing"],
  remove: ["pending", "failed", "cancelled"],
  "run-next": ["pending"],
  retry: ["failed", "cancelled"],
};
const ACTORS = ["owner", "admin-b", "dev-b", "multi-in-b", "admin-c", "closed-only", "noseat", "anon"];
// orders: in B led by dev-b, in B led by caps (another Dev of B), in C led by dev-c
const ORDERS = [
  { key: "B/dev-b", space: "B", lead: "dev-b" },
  { key: "B/caps", space: "B", lead: "caps" },
  { key: "C/dev-c", space: "C", lead: "dev-c" },
];

// THE RULES, AS A FUNCTION (K1-K4, K6). Nothing here reads the code.
function expectAction(actor, action, order, state) {
  if (!VALID[action].includes(state)) return "refused";
  if (actor === "owner") return "done";                                          // K1
  const p = PEOPLE[actor];
  if (!p) return "refused";                                                      // K4 anon
  if (["closed-only", "noseat"].includes(actor)) return "refused";               // K4
  const adminOfCurrent = { "admin-b": "B", "admin-c": "C" }[actor];              // multi stands in B as a Dev
  if (adminOfCurrent) return order.space === adminOfCurrent ? "done" : "refused"; // K2
  // K3, AS MAPPED FROM TODAY'S CODE (run 17 step 1b, confirmed by the old arm):
  // a Dev, in their current space, on their OWN order: cancel a pending one
  // (the brief's own words), retry a failed or cancelled one (Resubmit; RLS
  // queue_update_owner_or_self allows their own row), and move a pending one to
  // the front (the drag: RLS lets a Dev rank their own row, nobody else's).
  // Nothing else: Remove is refused to a Dev by queue_delete_owner_only, and
  // Mark failed is offered to nobody.
  const own = order.lead === actor || (actor === "multi-in-b" && order.lead === "multi");
  if (order.space === p.cur && own && (action === "cancel" || action === "retry" || action === "run-next")) return "done";
  return "refused";
}

const NAME_OF = { owner: "owner", "admin-b": "admin-b" };

async function makeState(order, state, n) {
  if (state === "processing") {
    const url = figmaUrlFor(n);
    const job = await insertJob({ figmaUrl: url, orderId: `OC${ARM.toUpperCase()}-${n}`, bridgeJobId: `bj_oc_${n}` });
    return insertOrder({ space: order.space, lead: order.lead, status: "processing", n, jobId: job.id, startedAt: new Date().toISOString() });
  }
  if (state === "failed") return insertOrder({ space: order.space, lead: order.lead, status: "failed", n, errorText: "The build stopped on our side. Please resubmit." });
  if (state === "cancelled") return insertOrder({ space: order.space, lead: order.lead, status: "failed", n, errorText: "Cancelled by grid before it started. It never ran.", finishedAt: new Date().toISOString() });
  if (state === "delivered") return insertOrder({ space: order.space, lead: order.lead, status: "delivered", n, html: "<html>oc</html>", startedAt: new Date(Date.now() - 60000).toISOString(), finishedAt: new Date().toISOString() });
  return insertOrder({ space: order.space, lead: order.lead, status: "pending", n });
}

// did the action take effect, judged on the database alone
async function effectOf(action, before, head) {
  const after = await getOrder(before.id);
  switch (action) {
    case "cancel":
      if (before.status !== "pending") return after && after.status === before.status ? "refused" : "changed-wrongly";
      // today's console cancels by deleting the row; run 17 marks it cancelled. Either way it never runs.
      if (!after) return "done";
      return after.status === "failed" && /^Cancelled by /.test(after.error_text || "") ? "done" : after.status === "pending" ? "refused" : "changed-wrongly";
    case "stop":
      if (!after) return "changed-wrongly";
      return after.status === "failed" && before.status === "processing" && /^Stopped by .+ \(Admin\)\.$/.test(after.error_text || "") ? "done"
        : after.status === before.status ? "refused" : "changed-wrongly";
    case "remove":
      return after ? (after.status === before.status ? "refused" : "changed-wrongly") : "done";
    case "run-next": {
      if (!after) return "changed-wrongly";
      if (before.status !== "pending") return after.manual_rank === before.manual_rank && after.status === before.status ? "refused" : "changed-wrongly";
      const h = await getOrder(head.id);
      return cmpFifo(after, h) < 0 ? "done" : "refused";
    }
    case "retry":
      if (!after) return "changed-wrongly";
      return after.status === "pending" && ["failed"].includes(before.status) ? "done"
        : after.status === before.status ? "refused" : "changed-wrongly";
  }
  return "?";
}

// TODAY'S CONSOLE (f256541), as QueueConsole.tsx offers and writes each action.
async function oldConsoleAct(actor, action, row, head) {
  if (actor === "anon") return { offered: false };
  const p = PEOPLE[actor];
  const tok = tokenOf(actor);
  const mine = row.lead_user_id === p.id;
  // the console reads only the rows RLS gives it; a row it cannot read has no control
  const vis = await rest("GET", `os_queue?id=eq.${row.id}&select=id`, { token: tok });
  if (!Array.isArray(vis.data) || vis.data.length === 0) return { offered: false };
  if (action === "cancel") {
    if (!(mine && row.status === "pending")) return { offered: false };
    const r = await rest("DELETE", `os_queue?id=eq.${row.id}`, { token: tok, prefer: "return=representation" });
    return { offered: true, proves: Array.isArray(r.data) && r.data.length > 0 };
  }
  if (action === "remove") {
    const shown = mine && (row.status === "pending" || row.status === "failed");
    if (!shown) return { offered: false };
    const r = await rest("DELETE", `os_queue?id=eq.${row.id}`, { token: tok, prefer: "return=representation" });
    return { offered: true, proves: Array.isArray(r.data) && r.data.length > 0 };
  }
  if (action === "stop") return { offered: false }; // the Mark failed dialog is never opened
  if (action === "retry") {
    if (row.status !== "failed") return { offered: false };
    await rest("PATCH", `os_queue?id=eq.${row.id}`, { token: tok, body: { status: "pending", error_text: null, job_id: null, started_at: null, finished_at: null } });
    return { offered: true, proves: false }; // the toast is green whatever happened
  }
  if (action === "run-next") {
    if (row.status !== "pending") return { offered: false };
    // the drag: every visible pending row renumbered, the dragged row first
    const vis2 = await rest("GET", `os_queue?status=eq.pending&select=*`, { token: tok });
    const list = (vis2.data || []).sort(cmpFifo).map((r) => r.id).filter((id) => id !== row.id);
    list.unshift(row.id);
    for (let i = 0; i < list.length; i++) {
      await rest("PATCH", `os_queue?id=eq.${list[i]}`, { token: tok, body: { manual_rank: (i + 1) * 1000 } });
    }
    return { offered: true, proves: false };
  }
  return { offered: false };
}

async function S5() {
  execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
  parkSeedOrders();
  const E = await env0();
  const srv = ARM === "new" ? await startServer({ ...E, env: { RUNNER_ENABLED: "false" } }) : null;
  let n = 0;
  try {
    for (const actor of ACTORS) {
      for (const order of ORDERS) {
        for (const state of STATES) {
          for (const action of ACTIONS) {
            n++;
            // run-next needs an order ahead of it in the same space
            const head = action === "run-next"
              ? await insertOrder({ space: order.space, lead: order.lead === "caps" ? "dev-b" : order.lead === "dev-b" ? "caps" : "dev-c", uploadedAt: new Date(Date.now() - 3600000).toISOString() })
              : null;
            const row = await makeState(order, state, nextN());
            const exp = expectAction(actor, action, order, state);
            const kase = `${actor} ${action} ${order.key} ${state}`;
            let routeChanged = null, httpStatus = null, offered = true, proves = null, body = null;
            if (ARM === "new") {
              const headers = actor === "anon" ? {} : { authorization: `Bearer ${tokenOf(actor)}` };
              const r = await fetch(`${srv.base}/os/orders/${row.id}/${action}`, { method: "POST", headers });
              httpStatus = r.status;
              body = await r.json().catch(() => null);
              routeChanged = body && Array.isArray(body.changed) ? body.changed : [];
            } else {
              const o = await oldConsoleAct(actor, action, row, head);
              offered = o.offered;
              proves = o.proves ?? null;
            }
            const eff = await effectOf(action, row, head);
            record("S5", kase, "K1-K4/K6 the action's effect", exp, eff);
            if (ARM === "new") {
              const k7 = exp === "done"
                ? (httpStatus === 200 && routeChanged.includes(row.id) && body?.order?.status !== undefined)
                : (httpStatus >= 400 && routeChanged.length === 0 && typeof body?.reason === "string" && body.reason.length > 0);
              record("S5", kase, "K7 the route proves itself (ids and state; a refusal changes nothing and says why)", true, Boolean(k7));
              if (body?.reason) record("S5", kase, "T2 the refusal reason has no em dash", true, NO_EM_DASH(body.reason));
            } else {
              const k7 = exp === "done" ? (offered && proves === true) : true;
              record("S5", kase, "K7 the console's action proves itself", true, k7);
            }
            const audit = (await auditFor(row.id)).filter((a) => /^order_(cancelled|stopped|removed|run_next|retried)$/.test(a.action));
            const k8want = exp === "done" ? 1 : 0;
            const k8ok = audit.length === k8want && (k8want === 0 || (audit[0].org_id === SP[order.space] && audit[0].actor_email === PEOPLE[actor].email && audit[0].detail && audit[0].detail.before && audit[0].detail.after));
            record("S5", kase, "K8 one audit row naming who, which order, which space, before and after", k8want, k8ok ? k8want : audit.length + (audit.length ? " (incomplete)" : ""));
            // each case starts from a queue holding only its own rows
            await rest("DELETE", `os_queue?id=in.(${[row.id, head && head.id].filter(Boolean).join(",")})`);
          }
        }
      }
    }
  } finally {
    if (srv) await srv.stop();
    await E.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// S6  TWO SPACES IN PARALLEL. PER_SPACE_QUEUE as the code defaults it (unset =
//     the single global lock, queue-runner.js:50) and, as a second case, true.
//     B's in-flight order is stuck (the engine died); C has a pending order.
//     Rule: one space's stuck order never blocks another space, and stopping it
//     releases its own space.
// ══════════════════════════════════════════════════════════════════════════
async function S6() {
  for (const perSpace of [null, "true"]) {
    execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
    parkSeedOrders();
    const E = await env0();
    E.engine.set({ dieAfterAccept: true });
    const env = { RUNNER_ENABLED: "true", RUNNER_POLL_MS: "2000" };
    if (perSpace) env.PER_SPACE_QUEUE = perSpace;
    const srv = await startServer({ ...E, env });
    const kase = `PER_SPACE_QUEUE ${perSpace ? "true" : "unset (code default)"}`;
    try {
      const t0 = Date.now();
      const b1 = await insertOrder({ space: "B", lead: "dev-b", uploadedAt: new Date(t0 - 3000).toISOString() });
      await waitFor(async () => E.engine.builds.length >= 1, 60000, 300);
      E.engine.set({ dieAfterAccept: false, buildMs: 1000 });
      const b2 = await insertOrder({ space: "B", lead: "caps", uploadedAt: new Date(t0 - 2000).toISOString() });
      const c1 = await insertOrder({ space: "C", lead: "dev-c", uploadedAt: new Date(t0 - 1000).toISOString() });
      const cRan = await waitFor(async () => (await getOrder(c1.id))?.status !== "pending", 20000, 1000);
      record("S6", kase, "C's order is not blocked by B's stuck order (20 s, ten polls)", true, Boolean(cRan));
      // stop B's stuck order the way each arm offers it
      if (ARM === "new") {
        await fetch(`${srv.base}/os/orders/${b1.id}/stop`, { method: "POST", headers: { authorization: `Bearer ${tokenOf("admin-b")}` } });
      }
      const bReleased = await waitFor(async () => (await getOrder(b2.id))?.status !== "pending", 20000, 1000);
      record("S6", kase, "an Admin of B stops it and B's next order runs", true, Boolean(bReleased));
    } finally {
      await srv.stop();
      await E.close();
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// S7  A FIGMA FILE THE SPACE'S ACCOUNT CANNOT OPEN: plain words naming the
//     account (T2), on the order the client sees.
// ══════════════════════════════════════════════════════════════════════════
async function S7() {
  execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
  parkSeedOrders();
  const E = await env0();
  E.figma.state.mode = "403";
  const srv = await startServer({ ...E, env: { RUNNER_ENABLED: "true", RUNNER_POLL_MS: "2000" } });
  try {
    const o = await insertOrder({ space: "B", lead: "dev-b" });
    const failed = await waitFor(async () => {
      const r = await getOrder(o.id);
      return r && r.status === "failed" ? r : null;
    }, 60000, 1000);
    const text = failed ? failed.error_text : "(not failed)";
    // space B's credential in the seed: OAuth row (sealed with a key this
    // server does not hold) and a pasted token labelled "grid B"; the resolver
    // decides which one read the design, and the sentence must name it.
    const want = /^Mavloper could not open this Figma file with the Figma account connected to this space \((.+)\)\. Make sure that account can open the file: it needs a Dev or Full seat in the team that owns it\.$/;
    record("S7", "space B, Figma answers 403", "T2 the exact sentence, naming the account", true, want.test(text || ""));
    record("S7", "space B, Figma answers 403", "T2 no internal names", true, !PLAIN.test(text || "") && NO_EM_DASH(text));
    record("S7", "space B, Figma answers 403", "seen text", "(recorded)", "(recorded)");
    console.log("   S7 text: " + text);
    record("S7", "space B, Figma answers 403", "builds", 0, E.engine.builds.length);
  } finally {
    await srv.stop();
    await E.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// RUN 18. THE ENGINE AN ORDER ASKED FOR, CARRIED TO THE ENGINE (V4, V5).
// Expected values from the run 18 brief's rules, never from the code:
//   V4  payload.engine is present ONLY as the exact string "TOPAZ" or
//       "DIAMOND", taken from the row (runner) or the body (the async route);
//       anything else sends no field and is logged once as ignored.
//   E3  a row with no choice (null) sends NO engine key, and its body is,
//       byte for byte, the body the previous arm sent for the same row.
//   V5  a retried order keeps its own engine.
// The database for E1, E2, E3 and E5 carries os_queue.engine (the run 18
// migration); the old arm is today's backend on that database.
// Bodies go to $OC_BODIES (secrets masked) when it is set.
// ══════════════════════════════════════════════════════════════════════════
const BODIES = process.env.OC_BODIES || null;
// Fields that differ on every dispatch by construction, masked before a
// byte comparison. figmaToken is masked ALWAYS: it is a credential, even a dummy.
const MASK_RANDOM = ["bridgeJobId", "maveloperJobId", "callbackUrl", "requestId"];
const MASK_SECRET = ["figmaToken"];
function maskBody(raw) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        out[k] = MASK_SECRET.includes(k) ? "<masked:secret>" : MASK_RANDOM.includes(k) ? "<masked:per-run>" : walk(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(JSON.parse(raw)));
}
function saveBody(name, raw) {
  if (!BODIES || raw == null) return;
  const masked = maskBody(raw);
  writeFileSync(path.join(BODIES, `${name}-${ARM}.json`), masked);
  writeFileSync(path.join(BODIES, `${name}-${ARM}.pretty.json`), JSON.stringify(JSON.parse(masked), null, 2));
}
const hasKey = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const showEngine = (p) => (hasKey(p, "engine") ? JSON.stringify(p.engine) : "(no engine key)");
const buildFor = (E, fileKey) => E.engine.builds.filter((b) => b.raw && b.raw.includes(fileKey));

// E1 'TOPAZ', E2 'DIAMOND', E3 null: the SERVER RUNNER dispatches each row.
async function E123() {
  execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
  parkSeedOrders();
  const E = await env0();
  const srv = await startServer({ ...E, env: { RUNNER_ENABLED: "true", RUNNER_POLL_MS: "2000" } });
  try {
    const cases = [
      { s: "E1", engine: "TOPAZ", n: 900001, want: '"TOPAZ"' },
      { s: "E2", engine: "DIAMOND", n: 900002, want: '"DIAMOND"' },
      { s: "E3", engine: null, n: 900003, want: "(no engine key)" },
    ];
    for (const c of cases) {
      const o = await insertOrder({ space: "B", lead: "dev-b", n: c.n, orderId: `${c.s}-ROW`, engine: c.engine });
      const done = await waitFor(async () => {
        const r = await getOrder(o.id);
        return r && (r.status === "delivered" || r.status === "failed") ? r : null;
      }, 90000, 1000);
      const fileKey = `OCfile${String(c.n).padStart(10, "0")}`;
      const b = buildFor(E, fileKey);
      record(c.s, `runner, row engine ${c.engine === null ? "null" : `'${c.engine}'`}`, "setup: the row delivered on one build", "delivered, 1", `${done?.status}, ${b.length}`);
      record(c.s, `runner, row engine ${c.engine === null ? "null" : `'${c.engine}'`}`, "V4 payload.engine as received by the engine", c.want, b[0] ? showEngine(b[0].payload) : "(no request)");
      if (b[0]) saveBody(`${c.s}-runner`, b[0].raw);
      if (c.s === "E3" && b[0]) {
        // byte for byte against the reference arm's body for the same row
        const ref = process.env.OC_E3_REF ? readFileSync(process.env.OC_E3_REF, "utf8") : null;
        if (ref) {
          const mine = maskBody(b[0].raw);
          record("E3", "runner, row engine null", `E3 the body equals the reference arm's byte for byte (masked: ${[...MASK_SECRET, ...MASK_RANDOM].join(", ")})`, "identical", mine === ref ? "identical" : `differs (${mine.length} vs ${ref.length} bytes)`);
        }
      }
    }
    record("E1-E3", "runner", "no request left this machine", 0, srv.refused.length);
  } finally {
    await srv.stop();
    await E.close();
  }
}

// E4 POST /generate-from-figma-async with body.engine in seven shapes.
async function E4() {
  execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
  parkSeedOrders();
  const E = await env0();
  const srv = await startServer({ ...E, env: { RUNNER_ENABLED: "false" } });
  const ABSENT = Symbol("absent");
  const cases = [
    { name: '"TOPAZ"', v: "TOPAZ", want: '"TOPAZ"', ignored: 0 },
    { name: '"DIAMOND"', v: "DIAMOND", want: '"DIAMOND"', ignored: 0 },
    { name: "absent", v: ABSENT, want: "(no engine key)", ignored: 1 },
    { name: '"topaz"', v: "topaz", want: "(no engine key)", ignored: 1 },
    { name: '" TOPAZ"', v: " TOPAZ", want: "(no engine key)", ignored: 1 },
    { name: "7", v: 7, want: "(no engine key)", ignored: 1 },
    { name: "null", v: null, want: "(no engine key)", ignored: 1 },
  ];
  try {
    let i = 0;
    for (const c of cases) {
      i++;
      const n = 910000 + i;
      const orderId = `E4-${i}`;
      const body = { figmaUrl: figmaUrlFor(n), orderId, darkMode: false, tatHours: 24 };
      if (c.v !== ABSENT) body.engine = c.v;
      const r = await fetch(`${srv.base}/generate-from-figma-async`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenOf("dev-b")}` },
        body: JSON.stringify(body),
      });
      const fileKey = `OCfile${String(n).padStart(10, "0")}`;
      await waitFor(async () => buildFor(E, fileKey).length >= 1, 60000, 300);
      const b = buildFor(E, fileKey);
      record("E4", `async route, body.engine ${c.name}`, "setup: the route accepted (202) and the engine got one request", "202, 1", `${r.status}, ${b.length}`);
      record("E4", `async route, body.engine ${c.name}`, "V4 payload.engine as received by the engine", c.want, b[0] ? showEngine(b[0].payload) : "(no request)");
      const ign = srv.logs().filter((l) => l.msg === "Engine choice ignored" && l.orderId === orderId);
      record("E4", `async route, body.engine ${c.name}`, "V4 an ignored value is logged once as ignored", c.ignored, ign.length);
      if (b[0]) saveBody(`E4-${i}-${c.name.replace(/[^A-Za-z0-9]+/g, "_")}`, b[0].raw);
    }
    record("E4", "async route", "no request left this machine", 0, srv.refused.length);
  } finally {
    await srv.stop();
    await E.close();
  }
}

// E5 RUN 17's RETRY of a failed 'TOPAZ' row: the second dispatch carries TOPAZ too.
async function E5() {
  execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
  parkSeedOrders();
  const E = await env0();
  E.engine.set({ dieAfterAccept: true });
  const srv = await startServer({ ...E, env: { RUNNER_ENABLED: "true", RUNNER_POLL_MS: "2000" } });
  try {
    const n = 920001;
    const fileKey = `OCfile${String(n).padStart(10, "0")}`;
    const o = await insertOrder({ space: "B", lead: "dev-b", n, orderId: "E5-ROW", engine: "TOPAZ" });
    await waitFor(async () => buildFor(E, fileKey).length >= 1, 60000, 300);
    // the build is lost; the space's Admin stops it, so the order is failed
    E.engine.set({ dieAfterAccept: false, buildMs: 300 });
    const st = await fetch(`${srv.base}/os/orders/${o.id}/stop`, { method: "POST", headers: { authorization: `Bearer ${tokenOf("admin-b")}` } });
    const failed = await waitFor(async () => ((await getOrder(o.id))?.status === "failed" ? true : null), 20000, 500);
    record("E5", "retry of a failed 'TOPAZ' row", "setup: stopped, the order is failed", "200, failed", `${st.status}, ${failed ? "failed" : (await getOrder(o.id))?.status}`);
    const rt = await fetch(`${srv.base}/os/orders/${o.id}/retry`, { method: "POST", headers: { authorization: `Bearer ${tokenOf("admin-b")}` } });
    const done = await waitFor(async () => ((await getOrder(o.id))?.status === "delivered" ? true : null), 90000, 1000);
    const b = buildFor(E, fileKey);
    record("E5", "retry of a failed 'TOPAZ' row", "setup: retried (200), delivered, two dispatches", "200, delivered, 2", `${rt.status}, ${done ? "delivered" : (await getOrder(o.id))?.status}, ${b.length}`);
    record("E5", "retry of a failed 'TOPAZ' row", "V4 the first dispatch's payload.engine", '"TOPAZ"', b[0] ? showEngine(b[0].payload) : "(no request)");
    record("E5", "retry of a failed 'TOPAZ' row", "V5 the retried dispatch's payload.engine", '"TOPAZ"', b[1] ? showEngine(b[1].payload) : "(no request)");
    record("E5", "retry of a failed 'TOPAZ' row", "V5 the row still reads 'TOPAZ'", "TOPAZ", (await getOrder(o.id))?.engine);
    if (b[0]) saveBody("E5-first", b[0].raw);
    if (b[1]) saveBody("E5-retry", b[1].raw);
    record("E5", "retry", "no request left this machine", 0, srv.refused.length);
  } finally {
    await srv.stop();
    await E.close();
  }
}

// R1 THE REVERT MATRIX: this backend on a database WITHOUT os_queue.engine
// (template built with OC_EXCLUDE=20261103_0001_engine_choice.sql). Rule: the
// queue keeps running; an order dispatches as an order with no choice (no
// engine field) and delivers; the runner says once that the column is absent.
async function R1() {
  execFileSync("bash", [path.join(HERE, "order-control.db.sh"), "reset"], { cwd: HERE, stdio: "ignore" });
  const hasColumn = psql("select count(*) from information_schema.columns where table_name = 'os_queue' and column_name = 'engine'");
  record("R1", "database without the column", "setup: os_queue has no engine column", "0", hasColumn);
  parkSeedOrders();
  const E = await env0();
  const srv = await startServer({ ...E, env: { RUNNER_ENABLED: "true", RUNNER_POLL_MS: "2000" } });
  try {
    const n = 930001;
    const o = await insertOrder({ space: "B", lead: "dev-b", n, orderId: "R1-ROW" });
    const done = await waitFor(async () => ((await getOrder(o.id))?.status === "delivered" ? true : null), 90000, 1000);
    const b = buildFor(E, `OCfile${String(n).padStart(10, "0")}`);
    record("R1", "database without the column", "the order delivers on one build", "delivered, 1", `${done ? "delivered" : (await getOrder(o.id))?.status}, ${b.length}`);
    record("R1", "database without the column", "payload.engine", "(no engine key)", b[0] ? showEngine(b[0].payload) : "(no request)");
    const warned = srv.logs().filter((l) => /no engine column/.test(l.msg || ""));
    record("R1", "database without the column", "the runner says once that the column is absent", 1, warned.length);
    if (b[0]) saveBody("R1-nocolumn", b[0].raw);
  } finally {
    await srv.stop();
    await E.close();
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const ALL = { S1, S2, S3, S4, S5, S6, S7, E123, E4, E5, R1 };
const want = process.argv.slice(2).filter((a) => ALL[a]);
const run = want.length ? want : Object.keys(ALL);
console.log(`order-control: arm ${ARM}, backend ${BACKEND_DIR}, scenarios ${run.join(" ")}`);
for (const s of run) {
  const t = Date.now();
  try { await ALL[s](); }
  catch (e) { record(s, "harness", "the scenario ran", "ran", "threw: " + e.message); }
  console.log(`-- ${s} took ${Math.round((Date.now() - t) / 1000)} s`);
}
const fail = results.filter((r) => !r.pass).length;
console.log(`order-control: ${results.length - fail} passed, ${fail} failed (${ARM} arm)`);
process.exit(fail ? 1 : 0);
