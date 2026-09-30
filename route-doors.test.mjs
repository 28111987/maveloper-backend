// route-doors.test.mjs
// ---------------------------------------------------------------------------
// THE DOORS. Run 14.
//
// Five routes must refuse anyone who is not signed in AND seated (live) in the
// space the request concerns: /generate-from-figma, /generate-from-figma-async,
// /approve, /job-status/:jobId, /os/provenance.
//
// HOW THIS RUNS. It boots the REAL server.js as a child process against a FAKE
// Supabase that this file serves on 127.0.0.1 (auth + PostgREST shapes, in
// memory). No network leaves the machine: Supabase, Dropbox, Figma and the
// engine are all unset or pointed at localhost. Tokens are dummy strings that
// authenticate only to the fake. No real credential appears anywhere here.
//
// WHY A CHILD PROCESS AND NOT A UNIT TEST OF THE MIDDLEWARE. The proof has to
// be able to fail against the OLD server.js. Point DOORS_SERVER at a copy of
// the pre-run-14 file (it also needs CLAUDE_API_KEY set to any placeholder,
// because that file refuses to start without one) and the cases that prove
// the doors are closed go red:
//
//   DOORS_SERVER=./server.ebdf33c.doors14.tmp.js CLAUDE_API_KEY=placeholder \
//     node route-doors.test.mjs
//
// Run normally:
//   cd /c/Users/shrujal_mavlers/Desktop/maveloper-backend && node route-doors.test.mjs
// ---------------------------------------------------------------------------
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_FILE = path.resolve(HERE, process.env.DOORS_SERVER || "server.js");

// ── fixtures ────────────────────────────────────────────────────────────────
const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a"; // live
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b"; // live
const ORG_C = "cccccccc-0000-4000-8000-00000000000c"; // CLOSED (is_deleted)
const JOB_A = "11111111-1111-4111-8111-111111111111"; // in space A
const JOB_B = "22222222-2222-4222-8222-222222222222"; // in space B
const JOB_LEGACY = "33333333-3333-4333-8333-333333333333"; // os_queue row with null org_id
const ORDER_A = "mav-1111-0001";
const ORDER_B = "mav-2222-0002";

// token -> user. Dummy strings; they mean nothing outside this process.
const USERS = {
  "tok-alice": { id: "u-alice", email: "alice@example.test" }, // live seat in A
  "tok-bob":   { id: "u-bob",   email: "bob@example.test" },   // seat ONLY in closed C
  "tok-carol": { id: "u-carol", email: "carol@example.test" }, // no seat anywhere
  "tok-dave":  { id: "u-dave",  email: "dave@example.test" },  // live seats in A and B
  "tok-owner": { id: "u-owner", email: "owner@example.test" }, // PLATFORM_OWNERS, no seat
};

function freshTables() {
  return {
    email_allowlist: [
      { email: "alice@example.test", org_id: ORG_A, is_owner: false },
      { email: "bob@example.test",   org_id: ORG_C, is_owner: true },
      { email: "dave@example.test",  org_id: ORG_A, is_owner: false },
      { email: "dave@example.test",  org_id: ORG_B, is_owner: true },
    ],
    orgs: [
      { id: ORG_A, slug: "space-a", name: "Space A", is_deleted: false },
      { id: ORG_B, slug: "space-b", name: "Space B", is_deleted: false },
      { id: ORG_C, slug: "space-c", name: "Space C", is_deleted: true },
    ],
    os_queue: [
      { id: randomUUID(), order_id: ORDER_A, job_id: JOB_A, org_id: ORG_A, status: "delivered", esp: "none", dark_mode: false },
      { id: randomUUID(), order_id: ORDER_B, job_id: JOB_B, org_id: ORG_B, status: "delivered", esp: "none", dark_mode: false },
      { id: randomUUID(), order_id: "mav-3333-0003", job_id: JOB_LEGACY, org_id: null, status: "delivered", esp: "none", dark_mode: false },
    ],
    maveloper_jobs: [
      { id: JOB_A, status: "completed", result_html: "<html>STORED-HTML-SPACE-A</html>", order_id: ORDER_A, engine_used: "claude-code", delivery_meta: { generatedBy: "engine", provenance: { engine: "compiler" } }, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", completed_at: "2026-09-01T00:10:00Z" },
      { id: JOB_B, status: "completed", result_html: "<html>STORED-HTML-SPACE-B</html>", order_id: ORDER_B, engine_used: "claude-code", delivery_meta: { generatedBy: "engine" }, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", completed_at: "2026-09-01T00:10:00Z" },
      { id: JOB_LEGACY, status: "completed", result_html: "<html>LEGACY</html>", order_id: "mav-3333-0003", engine_used: null, delivery_meta: null, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", completed_at: "2026-08-01T00:10:00Z" },
    ],
    org_figma_oauth: [],
    org_figma_credentials: [],
    drafts: [],
    profiles: [],
  };
}

// ── the fake Supabase (auth + PostgREST, in memory) ─────────────────────────
function startFakeSupabase() {
  const tables = freshTables();
  const seen = []; // every REST request, for assertions

  function matches(row, key, raw) {
    const dot = raw.indexOf(".");
    let op = dot === -1 ? "eq" : raw.slice(0, dot);
    let val = dot === -1 ? raw : raw.slice(dot + 1);
    let negate = false;
    if (op === "not") { negate = true; const d2 = val.indexOf("."); op = val.slice(0, d2); val = val.slice(d2 + 1); }
    const cell = row[key];
    let r;
    switch (op) {
      case "eq": r = String(cell) === val && cell !== undefined && cell !== null; break;
      case "neq": r = String(cell) !== val; break;
      case "in": {
        const list = val.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, ""));
        r = list.includes(String(cell)); break;
      }
      case "is": r = val === "null" ? cell == null : String(cell) === val; break;
      case "gte": r = cell != null && String(cell) >= val; break;
      case "lte": r = cell != null && String(cell) <= val; break;
      case "gt": r = cell != null && String(cell) > val; break;
      case "lt": r = cell != null && String(cell) < val; break;
      case "ilike": {
        const re = new RegExp("^" + val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$", "i");
        r = re.test(String(cell)); break;
      }
      default: r = false;
    }
    return negate ? !r : r;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };

    // AUTH: GET /auth/v1/user
    if (url.pathname === "/auth/v1/user") {
      const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || "");
      const u = m && USERS[m[1]];
      if (!u) return send(401, { code: 401, msg: "invalid JWT: dummy token not known to the fake" });
      return send(200, { id: u.id, aud: "authenticated", role: "authenticated", email: u.email, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
    }

    // REST: /rest/v1/<table>
    const rm = /^\/rest\/v1\/([A-Za-z_]+)$/.exec(url.pathname);
    if (!rm) return send(404, { message: "fake supabase: no such path " + url.pathname });
    const table = rm[1];
    if (!(table in tables)) return send(404, { code: "42P01", message: `relation "public.${table}" does not exist` });
    const filters = [];
    let limit = null;
    for (const [k, v] of url.searchParams) {
      if (k === "select" || k === "order" || k === "offset" || k === "on_conflict" || k === "columns") continue;
      if (k === "limit") { limit = Number(v); continue; }
      filters.push([k, v]);
    }
    seen.push({ method: req.method, table, filters, accept: req.headers.accept || "" });

    const wantsObject = String(req.headers.accept || "").includes("application/vnd.pgrst.object+json");
    let rows = tables[table].filter((row) => filters.every(([k, v]) => matches(row, k, v)));

    if (req.method === "POST") {
      const payload = JSON.parse(body || "null");
      const arr = Array.isArray(payload) ? payload : [payload];
      const inserted = arr.map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r }));
      tables[table].push(...inserted);
      rows = inserted;
    } else if (req.method === "PATCH") {
      const patch = JSON.parse(body || "{}");
      for (const r of rows) Object.assign(r, patch);
    } else if (req.method === "DELETE") {
      tables[table] = tables[table].filter((r) => !rows.includes(r));
    } else if (req.method === "HEAD") {
      res.writeHead(200, { "content-range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` });
      return res.end();
    }

    if (limit != null) rows = rows.slice(0, limit);
    if (wantsObject) {
      if (rows.length === 1) return send(200, rows[0]);
      return send(406, { code: "PGRST116", details: `The result contains ${rows.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" });
    }
    return send(200, rows);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, tables, seen }));
  });
}

// ── boot the real server.js against the fake ────────────────────────────────
async function startBackend(fakePort) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    // keep only what node itself needs to run on this OS
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH, COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
    HOME: process.env.HOME,
    // dummy backend configuration: everything points at localhost or is unset
    PORT: String(port),
    RUNNER_ENABLED: "false",
    SUPABASE_URL: `http://127.0.0.1:${fakePort}`,
    SUPABASE_SERVICE_ROLE_KEY: "dummy-service-role-key-for-the-fake",
    SUPABASE_JWT_SECRET: "dummy-jwt-secret-for-the-fake",
    PLATFORM_OWNERS: "owner@example.test",
    PUBLIC_BACKEND_URL: `http://127.0.0.1:${port}`,
  };
  // The OLD server refuses to start without CLAUDE_API_KEY; pass a placeholder
  // through ONLY when the caller set one (never for the new server by default).
  if (process.env.CLAUDE_API_KEY) env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

  const child = spawn(process.execPath, [SERVER_FILE], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error("backend exited early:\n" + out.slice(0, 2000));
    try {
      const r = await fetch(base + "/health");
      if (r.ok) return { child, base, log: () => out };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error("backend did not answer /health in 30s:\n" + out.slice(0, 2000));
}

// ── tiny harness ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

let ipCounter = 1;
async function call(base, method, pathname, { token, body, query } = {}) {
  const headers = {
    "content-type": "application/json",
    // each call gets its own client address so the shared 10/min limiter never trips
    "x-forwarded-for": `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`,
  };
  if (token) headers.authorization = "Bearer " + token;
  const url = base + pathname + (query ? "?" + new URLSearchParams(query).toString() : "");
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// ── the cases ───────────────────────────────────────────────────────────────
const fake = await startFakeSupabase();
let backend;
try {
  backend = await startBackend(fake.port);
} catch (err) {
  console.error(String(err.message || err));
  fake.server.close();
  process.exit(2);
}
const B = backend.base;
console.log(`route-doors: server=${path.basename(SERVER_FILE)}  fake-supabase=127.0.0.1:${fake.port}  backend=${B}`);

try {
  const genBody = { figmaUrl: "https://www.figma.com/design/ABCDEFGHIJKLMNOPQRSTUV/x?node-id=1-2" };

  // ── /generate-from-figma ──────────────────────────────────────────────
  {
    console.log("\n/generate-from-figma");
    let r = await call(B, "POST", "/generate-from-figma", { body: genBody });
    check("1a unauthenticated -> 401", r.status === 401, "got " + r.status);
    r = await call(B, "POST", "/generate-from-figma", { token: "tok-carol", body: genBody });
    check("1b signed in, no seat anywhere -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "POST", "/generate-from-figma", { token: "tok-bob", body: genBody });
    check("1c seat only in a CLOSED space -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "POST", "/generate-from-figma", { token: "tok-alice", body: { ...genBody, orgId: ORG_B } });
    check("1d body orgId of a space the caller is NOT seated in -> 403", r.status === 403, "got " + r.status);
    check("1d ...and the foreign space's credential was never looked up",
      !fake.seen.some((s) => (s.table === "org_figma_oauth" || s.table === "org_figma_credentials") && s.filters.some(([k, v]) => k === "org_id" && v.includes(ORG_B))),
      "credential tables were queried for ORG_B");
    const before = fake.seen.length;
    r = await call(B, "POST", "/generate-from-figma", { token: "tok-alice", body: genBody });
    check("1e seated (live) -> reaches the handler (503 'Figma not configured', no credential, no network)",
      r.status === 503 && /Figma not configured/.test(r.json?.error || ""), "got " + r.status + " " + JSON.stringify(r.json).slice(0, 120));
    const credLookups = fake.seen.slice(before).filter((s) => s.table === "org_figma_oauth" || s.table === "org_figma_credentials");
    check("1f ...and the space it resolved the credential for is the CALLER'S seat, not the request's",
      credLookups.length > 0 && credLookups.every((s) => s.filters.some(([k, v]) => k === "org_id" && v.includes(ORG_A))),
      JSON.stringify(credLookups.map((s) => s.filters)).slice(0, 200));
    r = await call(B, "POST", "/generate-from-figma", { token: "tok-dave", body: genBody });
    check("1g seats in TWO spaces, no orgId -> 403 (must say which)", r.status === 403, "got " + r.status);
    r = await call(B, "POST", "/generate-from-figma", { token: "tok-dave", body: { ...genBody, orgId: ORG_B } });
    check("1h seats in TWO spaces, orgId of one of them -> reaches the handler", r.status === 503 && /Figma not configured/.test(r.json?.error || ""), "got " + r.status);
    r = await call(B, "POST", "/generate-from-figma", { token: "tok-owner", body: { ...genBody, orgId: ORG_B } });
    check("1i platform owner -> reaches the handler", r.status === 503, "got " + r.status);
  }

  // ── /generate-from-figma-async ────────────────────────────────────────
  {
    console.log("\n/generate-from-figma-async");
    let r = await call(B, "POST", "/generate-from-figma-async", { body: genBody });
    check("2a unauthenticated -> 401", r.status === 401, "got " + r.status);
    r = await call(B, "POST", "/generate-from-figma-async", { token: "tok-carol", body: genBody });
    check("2b signed in, no seat anywhere -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "POST", "/generate-from-figma-async", { token: "tok-bob", body: genBody });
    check("2c seat only in a CLOSED space -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "POST", "/generate-from-figma-async", { token: "tok-alice", body: { ...genBody, orgId: ORG_B } });
    check("2d body orgId of a space the caller is NOT seated in -> 403", r.status === 403, "got " + r.status);
    check("2d ...and no job row was created for it", !fake.seen.some((s) => s.method === "POST" && s.table === "maveloper_jobs"), "a maveloper_jobs insert happened");
    r = await call(B, "POST", "/generate-from-figma-async", { token: "tok-alice", body: { ...genBody, figmaUrl: genBody.figmaUrl + "&async=1" } });
    check("2e seated (live) -> reaches the handler (202 + jobId)", r.status === 202 && typeof r.json?.jobId === "string", "got " + r.status + " " + JSON.stringify(r.json).slice(0, 120));
    // the background worker runs the generation handler; with no credential it fails fast, no network
    await new Promise((res) => setTimeout(res, 1500));
    const jobRow = fake.tables.maveloper_jobs.find((j) => j.id === r.json?.jobId);
    check("2f ...background worker ran and settled the job without a credential (failed, 'Figma not configured')",
      Boolean(jobRow) && jobRow.status === "failed" && /Figma not configured/.test(jobRow.error_message || ""),
      JSON.stringify(jobRow || null).slice(0, 160));
  }

  // ── /job-status/:jobId ────────────────────────────────────────────────
  {
    console.log("\n/job-status/:jobId");
    let r = await call(B, "GET", "/job-status/" + JOB_A, {});
    check("3a unauthenticated -> 401 (no stored HTML in the answer)", r.status === 401 && !JSON.stringify(r.json).includes("STORED-HTML"), "got " + r.status);
    r = await call(B, "GET", "/job-status/" + JOB_A, { token: "tok-carol" });
    check("3b signed in, no seat anywhere -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "GET", "/job-status/" + JOB_A, { token: "tok-bob" });
    check("3c seat only in a CLOSED space -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "GET", "/job-status/" + JOB_B, { token: "tok-alice" });
    check("3d seated in A, asking for space B's job -> 403 and no HTML", r.status === 403 && !JSON.stringify(r.json).includes("STORED-HTML"), "got " + r.status);
    r = await call(B, "GET", "/job-status/" + JOB_A, { token: "tok-alice" });
    check("3e seated (live) in the job's space -> 200 with the job", r.status === 200 && r.json?.status === "completed" && /STORED-HTML-SPACE-A/.test(r.json?.html || ""), "got " + r.status);
    r = await call(B, "GET", "/job-status/" + JOB_LEGACY, { token: "tok-alice" });
    check("3f a job whose queue row has no space -> 403 for a seated user", r.status === 403, "got " + r.status);
    r = await call(B, "GET", "/job-status/" + JOB_LEGACY, { token: "tok-owner" });
    check("3g ...but a platform owner may read it", r.status === 200, "got " + r.status);
    r = await call(B, "GET", "/job-status/not-a-uuid", { token: "tok-alice" });
    check("3h malformed id -> the handler's own 400 still applies", r.status === 400, "got " + r.status);
  }

  // ── /approve ──────────────────────────────────────────────────────────
  {
    console.log("\n/approve");
    const approveBody = { orderId: ORDER_A, html: "<html><body>x</body></html>", imageUrlMap: {} };
    let r = await call(B, "POST", "/approve", { body: approveBody });
    check("4a unauthenticated -> 401", r.status === 401, "got " + r.status);
    r = await call(B, "POST", "/approve", { token: "tok-carol", body: approveBody });
    check("4b signed in, no seat anywhere -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "POST", "/approve", { token: "tok-bob", body: approveBody });
    check("4c seat only in a CLOSED space -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "POST", "/approve", { token: "tok-alice", body: { ...approveBody, orderId: ORDER_B } });
    check("4d seated in A, approving space B's order -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "POST", "/approve", { token: "tok-alice", body: approveBody });
    check("4e seated (live) in the order's space -> reaches the handler (503 'Dropbox not configured')", r.status === 503 && /Dropbox not configured/.test(r.json?.error || ""), "got " + r.status + " " + JSON.stringify(r.json).slice(0, 120));
    r = await call(B, "POST", "/approve", { token: "tok-alice", body: { html: "<html></html>" } });
    check("4f no orderId -> the handler's own 400 still applies", r.status === 400, "got " + r.status);
  }

  // ── /os/provenance ────────────────────────────────────────────────────
  {
    console.log("\n/os/provenance");
    let r = await call(B, "GET", "/os/provenance", { query: { jobIds: JOB_A } });
    check("5a unauthenticated -> 401", r.status === 401, "got " + r.status);
    r = await call(B, "GET", "/os/provenance", { token: "tok-carol", query: { jobIds: JOB_A } });
    check("5b signed in, no seat anywhere -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "GET", "/os/provenance", { token: "tok-bob", query: { jobIds: JOB_A } });
    check("5c seat only in a CLOSED space -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "GET", "/os/provenance", { token: "tok-alice", query: { jobIds: JOB_B } });
    check("5d seated in A, asking only for space B's job -> 403", r.status === 403, "got " + r.status);
    r = await call(B, "GET", "/os/provenance", { token: "tok-alice", query: { jobIds: JOB_A } });
    check("5e seated (live) -> 200 with that job's record", r.status === 200 && Boolean(r.json?.jobs?.[JOB_A]), "got " + r.status + " " + JSON.stringify(r.json).slice(0, 120));
    r = await call(B, "GET", "/os/provenance", { token: "tok-alice", query: { jobIds: [JOB_A, JOB_B].join(",") } });
    check("5f mixed batch -> 200 with ONLY the caller's space's job", r.status === 200 && Boolean(r.json?.jobs?.[JOB_A]) && !r.json?.jobs?.[JOB_B], "got " + r.status + " " + JSON.stringify(Object.keys(r.json?.jobs || {})));
    r = await call(B, "GET", "/os/provenance", { token: "tok-alice", query: { jobIds: JOB_LEGACY } });
    check("5g a batch of only space-less (older) jobs -> 200, empty, not 403 (console keeps working)", r.status === 200 && Object.keys(r.json?.jobs || {}).length === 0, "got " + r.status + " " + JSON.stringify(r.json).slice(0, 120));
    r = await call(B, "GET", "/os/provenance", { token: "tok-dave", query: { jobIds: [JOB_A, JOB_B].join(",") } });
    check("5h seated in both -> both records", r.status === 200 && Boolean(r.json?.jobs?.[JOB_A]) && Boolean(r.json?.jobs?.[JOB_B]), "got " + r.status);
  }

  // ── the queue runner's path is untouched: no door runs in-process ─────
  {
    console.log("\nin-process path (queue runner)");
    // /health still answers without any token, and reports no AI key field.
    const r = await fetch(B + "/health").then((x) => x.json());
    check("6a /health is open and carries no apiKeyConfigured / aiEngine.default", r.status === "ok" && !("apiKeyConfigured" in r) && !(r.aiEngine && "default" in r.aiEngine), JSON.stringify(r).slice(0, 200));
  }
} finally {
  backend.child.kill();
  fake.server.close();
}

console.log(`\nPASS ${pass}   FAIL ${fail}`);
if (fail) console.log("failed: " + failures.join(" | "));
process.exit(fail === 0 ? 0 : 1);
