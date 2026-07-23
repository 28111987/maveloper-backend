// drafts-persist.test.mjs
// ---------------------------------------------------------------------------
// UNIT test (NO database). Proves two things about persistSliceMapToDrafts:
//   (A) INERTNESS on the LLM path — with an empty/absent slice map or missing
//       order_id it returns early WITHOUT ever touching Supabase (the spy client
//       THROWS if .from() is called, so any DB touch fails the test hard).
//   (B) On the compiler path it issues EXACTLY the intended query:
//       .from("drafts").update({ image_url_map: <sliceMap> }).eq("order_id", <id>).select("id")
//
// NOTE (read the round-trip test too): this test uses a spy client, so it proves the
// QUERY SHAPE and inertness — it does NOT prove the map lands in the real column. The
// real DB round-trip is drafts-roundtrip.test.mjs (owner-run, needs live creds). This
// separation is deliberate: the previous defect shipped because a function test with a
// mock passed while the real column did not exist.
// ---------------------------------------------------------------------------
import { persistSliceMapToDrafts } from "./drafts-persist.js";

let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log(`  PASS  ${msg}`); }
  else { console.error(`  FAIL  ${msg}`); failures++; }
}
const silentLog = () => {};

// A spy Supabase client that records the query chain. If `shouldThrowOnFrom` is set it
// throws the instant .from() is called — used to PROVE the inert paths never touch it.
function makeSpy({ shouldThrowOnFrom = false, returnData = [{ id: "row-1" }], returnError = null } = {}) {
  const calls = { from: null, updatePayload: null, eqCol: null, eqVal: null, selectCol: null };
  const chain = {
    update(payload) { calls.updatePayload = payload; return chain; },
    eq(col, val) { calls.eqCol = col; calls.eqVal = val; return chain; },
    async select(col) { calls.selectCol = col; return { data: returnData, error: returnError }; },
  };
  const client = {
    from(table) {
      if (shouldThrowOnFrom) throw new Error(`SPY: .from(${table}) must NOT be called on the inert path`);
      calls.from = table;
      return chain;
    },
  };
  return { client, calls };
}

console.log("TEST A — inert paths never touch Supabase:");
{
  // A1: no supabase client
  const r = await persistSliceMapToDrafts(null, silentLog, "OID123", { "slice_1_90@2x.png": "https://x" });
  ok(r.ok === false && r.reason === "no-supabase", "null client → {ok:false, no-supabase}");
}
{
  // A2: empty map (the LLM path: compilerImageUrlMap is null → callers gate off, but prove the guard too)
  const { client, calls } = makeSpy({ shouldThrowOnFrom: true });
  const r = await persistSliceMapToDrafts(client, silentLog, "OID123", {});
  ok(r.ok === false && r.reason === "empty-map", "empty map → {ok:false, empty-map}");
  ok(calls.from === null, "empty map → .from() NEVER called (INERT)");
}
{
  // A3: null map
  const { client, calls } = makeSpy({ shouldThrowOnFrom: true });
  const r = await persistSliceMapToDrafts(client, silentLog, "OID123", null);
  ok(r.ok === false && r.reason === "empty-map", "null map → {ok:false, empty-map}");
  ok(calls.from === null, "null map → .from() NEVER called (INERT)");
}
{
  // A4: missing order_id (durable route with no real order_id → compilerOrderId null)
  const { client, calls } = makeSpy({ shouldThrowOnFrom: true });
  const r = await persistSliceMapToDrafts(client, silentLog, null, { "slice_1_90@2x.png": "https://x" });
  ok(r.ok === false && r.reason === "no-order-id", "null order_id → {ok:false, no-order-id}");
  ok(calls.from === null, "null order_id → .from() NEVER called (INERT)");
}

console.log("TEST B — compiler path issues the exact drafts query:");
{
  const sliceMap = { "slice_1_90@2x.png": "https://dl.dropboxusercontent.com/x/slice_1_90@2x.png" };
  const { client, calls } = makeSpy({ returnData: [{ id: "row-9" }] });
  const r = await persistSliceMapToDrafts(client, silentLog, "OID20260723", sliceMap, "req-1");
  ok(calls.from === "drafts", 'targets .from("drafts") — NOT os_queue, NOT maveloper_jobs');
  ok(calls.updatePayload && calls.updatePayload.image_url_map === sliceMap, "updates { image_url_map: <sliceMap> }");
  ok(Object.keys(calls.updatePayload).length === 1, "update payload has ONLY image_url_map (additive, no other columns touched)");
  ok(calls.eqCol === "order_id" && calls.eqVal === "OID20260723", 'keyed by .eq("order_id", <id>)');
  ok(calls.selectCol === "id", ".select('id') so affected-row count is observable");
  ok(r.ok === true && r.rows === 1, "row updated → {ok:true, rows:1}");
  ok("slice_1_90@2x.png" in calls.updatePayload.image_url_map, "the slice_ key is in the persisted map");
}

console.log("TEST C — no-row and db-error are reported, not swallowed:");
{
  const { client } = makeSpy({ returnData: [] }); // update matched 0 rows
  const r = await persistSliceMapToDrafts(client, silentLog, "OID-missing", { "slice_x.png": "https://x" });
  ok(r.ok === false && r.reason === "no-row", "0 rows updated → {ok:false, no-row} (loud, not silent success)");
}
{
  const { client } = makeSpy({ returnError: { message: "column drafts.image_url_map does not exist", code: "42703" } });
  const r = await persistSliceMapToDrafts(client, silentLog, "OID-schemadrift", { "slice_x.png": "https://x" });
  ok(r.ok === false && r.reason === "db-error", "PostgREST error (schema drift) → {ok:false, db-error} (surfaced, not success)");
}

console.log("");
if (failures === 0) console.log("ALL ASSERTIONS PASSED");
else { console.error(`${failures} ASSERTION(S) FAILED`); process.exit(1); }
