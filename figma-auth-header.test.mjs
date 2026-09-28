// figma-auth-header.test.mjs
// ---------------------------------------------------------------------------
// RUN 8 - THE OAUTH TOKEN ON THE ORDER PATH.
//
// Asserts against FIGMA'S RULE, not against the code:
//   figu_ (OAuth)          -> Authorization: Bearer <token>, and NO X-Figma-Token
//   figd_ (personal/plan)  -> X-Figma-Token: <token>,        and NO Authorization
//   unprefixed (older)     -> X-Figma-Token: <token>,        and NO Authorization
// for the helper AND for every backend call an order reaches:
//   figma-parser.js        fetchFigmaNode         (GET /v1/files/:key/nodes)
//   figma-image-export.js  fetchRawImageRefUrls   (GET /v1/files/:key/images)
//   figma-image-export.js  renderFigmaNodes       (GET /v1/images/:key, first call)
//   figma-image-export.js  renderFigmaNodes       (GET /v1/images/:key, 429 retry)
//
// ★ NO REAL TOKEN. Every token below is a synthetic literal that says so. No
// network: every call injects fetchImpl. A failure message names HEADERS, never
// a token value.
//
// ★ PROVING THE TESTS CAN FAIL. RUN8_SRC points the imports at another copy of
// the source, so the same file runs against the pre-run-8 code:
//   RUN8_SRC=<dir with the old files>/ node figma-auth-header.test.mjs
//
// Run with:
//   cd /c/Users/shrujal_mavlers/Desktop/maveloper-backend && node figma-auth-header.test.mjs
// ---------------------------------------------------------------------------
import { pathToFileURL } from "node:url";
import path from "node:path";

const SRC = process.env.RUN8_SRC || path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")) + "/";
const load = (f) => import(pathToFileURL(path.join(SRC, f)).href);

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name + (detail ? " (" + detail + ")" : "")); console.log("  FAIL  " + name + (detail ? "  -- " + detail : "")); }
}

const DUMMY = {
  oauth: "figu_" + "DUMMY-NOT-A-REAL-OAUTH-TOKEN-000000",
  pat: "figd_" + "DUMMY-NOT-A-REAL-PERSONAL-TOKEN-000",
  bare: "DUMMY-NOT-A-REAL-UNPREFIXED-TOKEN-00",
};

// Header names are case-insensitive on the wire, so presence is checked that way.
function headerKeys(h) { return h ? Object.keys(h) : []; }
function has(h, name) { return headerKeys(h).some((k) => k.toLowerCase() === name.toLowerCase()); }
function get(h, name) { const k = headerKeys(h).find((x) => x.toLowerCase() === name.toLowerCase()); return k === undefined ? undefined : h[k]; }
function describe(h) { return "headers sent: [" + headerKeys(h).join(", ") + "]"; }

// THE RULE, written once, for every site.
function checkRule(site, kind, headers) {
  const token = DUMMY[kind];
  if (kind === "oauth") {
    ok(`${site} figu_ -> Authorization: Bearer <token>`, get(headers, "Authorization") === "Bearer " + token, describe(headers));
    ok(`${site} figu_ -> NO X-Figma-Token`, headers != null && !has(headers, "X-Figma-Token"), describe(headers));
  } else {
    const label = kind === "pat" ? "figd_" : "unprefixed";
    ok(`${site} ${label} -> X-Figma-Token: <token>`, get(headers, "X-Figma-Token") === token, describe(headers));
    ok(`${site} ${label} -> NO Authorization`, headers != null && !has(headers, "Authorization"), describe(headers));
  }
}

const KINDS = ["oauth", "pat", "bare"];

// ===========================================================================
console.log("\n=== 1. THE HELPER ===\n");
// ===========================================================================
{
  let mod = null;
  try { mod = await load("figma-auth-header.js"); } catch { mod = null; }
  const fn = mod && mod.figmaAuthHeaders;
  for (const kind of KINDS) {
    let h = null;
    try { h = fn ? fn(DUMMY[kind]) : null; } catch { h = null; }
    checkRule("1 helper", kind, h);
  }
  // Would catch: a helper that also leaves the other header on, which Figma may read first.
  let h2 = null;
  try { h2 = fn ? fn(DUMMY.oauth) : null; } catch { h2 = null; }
  ok("1 helper sends exactly ONE auth header for figu_", headerKeys(h2).length === 1, describe(h2));
}

// ===========================================================================
console.log("\n=== 2. figma-parser.js fetchFigmaNode (ORDER: server.js figmaToDesignSpec) ===\n");
// ===========================================================================
{
  const { fetchFigmaNode } = await load("figma-parser.js");
  for (const kind of KINDS) {
    let seen = null;
    const fetchImpl = async (url, opts) => {
      seen = opts;
      return { ok: true, status: 200, json: async () => ({ nodes: { "1:2": { document: { id: "1:2" } } } }), text: async () => "" };
    };
    try { await fetchFigmaNode({ fileKey: "DUMMYKEY", nodeId: "1:2", token: DUMMY[kind], fetchImpl }); } catch { /* only the request matters */ }
    checkRule("2 fetchFigmaNode", kind, seen?.headers);
  }
}

// ===========================================================================
console.log("\n=== 3. figma-image-export.js fetchRawImageRefUrls (ORDER: server.js raw image refs) ===\n");
// ===========================================================================
{
  const { fetchRawImageRefUrls } = await load("figma-image-export.js");
  for (const kind of KINDS) {
    let seen = null;
    const fetchImpl = async (url, opts) => {
      seen = opts;
      return { ok: true, status: 200, json: async () => ({ meta: { images: {} } }) };
    };
    try { await fetchRawImageRefUrls({ fileKey: "DUMMYKEY", token: DUMMY[kind], fetchImpl }); } catch { /* only the request matters */ }
    checkRule("3 fetchRawImageRefUrls", kind, seen?.headers);
  }
}

// ===========================================================================
console.log("\n=== 4. figma-image-export.js renderFigmaNodes, FIRST call (ORDER: server.js node render) ===\n");
// ===========================================================================
{
  const { renderFigmaNodes } = await load("figma-image-export.js");
  for (const kind of KINDS) {
    let seen = null;
    const fetchImpl = async (url, opts) => {
      if (String(url).includes("api.figma.com")) seen = opts;
      return { ok: true, status: 200, json: async () => ({ images: {} }), text: async () => "" };
    };
    try { await renderFigmaNodes({ fileKey: "DUMMYKEY", nodeIds: ["1:2"], token: DUMMY[kind], fetchImpl }); } catch { /* only the request matters */ }
    checkRule("4 renderFigmaNodes first", kind, seen?.headers);
  }
}

// ===========================================================================
console.log("\n=== 5. figma-image-export.js renderFigmaNodes, 429 RETRY (waits 5s per token kind) ===\n");
// ===========================================================================
{
  const { renderFigmaNodes } = await load("figma-image-export.js");
  for (const kind of KINDS) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      if (!String(url).includes("api.figma.com")) return { ok: false, status: 404 };
      calls.push(opts);
      if (calls.length === 1) return { ok: false, status: 429, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ images: {} }), text: async () => "" };
    };
    try { await renderFigmaNodes({ fileKey: "DUMMYKEY", nodeIds: ["1:2"], token: DUMMY[kind], fetchImpl }); } catch { /* only the request matters */ }
    ok(`5 renderFigmaNodes the retry actually happened (${kind === "oauth" ? "figu_" : kind === "pat" ? "figd_" : "unprefixed"})`, calls.length === 2, "calls=" + calls.length);
    checkRule("5 renderFigmaNodes 429-retry", kind, calls[1]?.headers);
  }
}

console.log("");
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
