// drafts-roundtrip.test.mjs
// ---------------------------------------------------------------------------
// REAL DATABASE round-trip. This is the test the previous work was missing: it
// proves a slice_ map actually LANDS in the column /approve reads and is retrieved
// by re-reading that column — NOT a mocked object.
//
// >>> OWNER RUNS THIS. It needs LIVE service-role credentials and mutates a throwaway
//     row in the real `drafts` table (then deletes it). The agent that wrote this
//     could NOT run it (no DB credentials in its environment). <<<
//
// Run:
//   cd /c/Users/shrujal_mavlers/Desktop/maveloper-backend
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node drafts-roundtrip.test.mjs
//   (PowerShell: $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."; node drafts-roundtrip.test.mjs)
//
// What it verifies against the LIVE project (ddndmeaiopkastapbexq):
//   1. SCHEMA: drafts.image_url_map exists and is writable/readable.
//   2. SCHEMA: os_queue has NO image_url_map column (the mislabelled target) — a
//      read of it must ERROR. This is the schema assertion the owner asked for.
//   3. ROUND-TRIP: seed a draft row with an LLM-style node-export map, then call the
//      SAME persistSliceMapToDrafts server.js uses, then re-read the row and prove the
//      slice_ keys are present in the column.
//   4. INERTNESS: an LLM-style row (empty compiler map) is left byte-identical — the
//      helper never overwrites a node-export draft.
//   The throwaway row is deleted in a finally block regardless of outcome.
// ---------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";
import { persistSliceMapToDrafts } from "./drafts-persist.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("SKIP: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run the real round-trip.");
  process.exit(2);
}

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const log = (lvl, msg, meta) => console.log(`    [${lvl}] ${msg}`, meta ? JSON.stringify(meta) : "");

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };

// Unique throwaway key so we never collide with a real order.
const TEST_ORDER_ID = `__ZIPTEST_${Date.now()}`;
const NODE_MAP = { "in.png": "https://dl.dropboxusercontent.com/x/in.png", "icon.png": "https://dl.dropboxusercontent.com/x/icon.png" };
const SLICE_MAP = { "slice_1_90@2x.png": "https://dl.dropboxusercontent.com/x/slice_1_90@2x.png", "slice_1_4@2x.png": "https://dl.dropboxusercontent.com/x/slice_1_4@2x.png" };

async function main() {
  // ---- 1. SCHEMA: os_queue must NOT have image_url_map ----
  console.log("SCHEMA — os_queue.image_url_map must not exist:");
  {
    const { error } = await db.from("os_queue").select("image_url_map").limit(1);
    ok(!!error, `reading os_queue.image_url_map ERRORS as expected (${error ? error.code || error.message : "NO ERROR — column unexpectedly exists!"})`);
  }

  // ---- 2. SCHEMA: drafts.image_url_map must exist ----
  console.log("SCHEMA — drafts.image_url_map must exist:");
  {
    const { error } = await db.from("drafts").select("id, order_id, image_url_map").limit(1);
    ok(!error, `reading drafts.image_url_map succeeds${error ? " — ERROR: " + error.message : ""}`);
  }

  // ---- 3. Seed a throwaway LLM-style draft row ----
  console.log("ROUND-TRIP — seed LLM-style draft, then persist slice map:");
  const { error: insErr } = await db.from("drafts").insert({ order_id: TEST_ORDER_ID, image_url_map: NODE_MAP });
  if (insErr) {
    // If drafts requires NOT NULL columns we don't know about, surface it clearly.
    ok(false, `INSERT throwaway draft failed — the drafts row shape needs a column this test omits: ${insErr.message}`);
    return;
  }
  ok(true, "seeded throwaway draft row with node-export map");

  // ---- 3b. INERTNESS: empty compiler map must not overwrite the node-export map ----
  const inert = await persistSliceMapToDrafts(db, log, TEST_ORDER_ID, {}, "rt-inert");
  ok(inert.ok === false && inert.reason === "empty-map", "empty map → helper no-ops");
  {
    const { data } = await db.from("drafts").select("image_url_map").eq("order_id", TEST_ORDER_ID).single();
    ok(JSON.stringify(data.image_url_map) === JSON.stringify(NODE_MAP), "node-export map UNCHANGED after inert call (LLM path preserved)");
  }

  // ---- 3c. Persist the slice map (what a compiler order does) ----
  const res = await persistSliceMapToDrafts(db, log, TEST_ORDER_ID, SLICE_MAP, "rt-slice");
  ok(res.ok === true && res.rows === 1, `persist returned {ok:true, rows:1} (got ${JSON.stringify(res)})`);

  // ---- 3d. RE-READ the column /approve reads and prove the slice keys landed ----
  const { data: after, error: readErr } = await db.from("drafts").select("image_url_map").eq("order_id", TEST_ORDER_ID).single();
  ok(!readErr, "re-read drafts.image_url_map after persist");
  ok(after && after.image_url_map && "slice_1_90@2x.png" in after.image_url_map, "slice_1_90@2x.png IS present in the persisted column");
  ok(after && after.image_url_map && after.image_url_map["slice_1_4@2x.png"] === SLICE_MAP["slice_1_4@2x.png"], "slice URL round-tripped EXACTLY");
  ok(after && JSON.stringify(after.image_url_map) === JSON.stringify(SLICE_MAP), "the whole slice map landed byte-for-byte");
}

try {
  await main();
} catch (e) {
  console.error("  FAIL  unexpected throw:", e.message);
  failures++;
} finally {
  // Always clean up the throwaway row.
  const { error: delErr } = await db.from("drafts").delete().eq("order_id", TEST_ORDER_ID);
  console.log(delErr ? `  WARN  cleanup delete failed for ${TEST_ORDER_ID}: ${delErr.message}` : `  (cleaned up ${TEST_ORDER_ID})`);
}

console.log("");
if (failures === 0) console.log("ALL ROUND-TRIP ASSERTIONS PASSED");
else { console.error(`${failures} ROUND-TRIP ASSERTION(S) FAILED`); process.exit(1); }
