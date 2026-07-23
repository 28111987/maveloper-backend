// approve-schema.test.mjs
// ---------------------------------------------------------------------------
// REAL SCHEMA round-trip for the /approve delivery path (TASK-5 hardening).
//
// The /approve loose-folder rewrite + bridge-callback were verified ONLY against
// compiler orders. They read/write a SET of DB columns; if any column name drifts
// from the real schema, the code degrades silently (a caught error, a null map, an
// "expected" 0-row) — exactly the class of defect that shipped a write to a
// NON-EXISTENT column (os_queue.image_url_map). This test asserts EVERY column the
// path depends on actually EXISTS, each mapped to the server.js line that uses it,
// so a schema drift is a LOUD, itemised failure instead of a silent no-op.
//
// READ-ONLY: it only SELECTs (limit 0/1). It never inserts, updates or deletes, so
// it is safe to run against production. It does NOT replace drafts-roundtrip.test.mjs
// (which mutates a throwaway row to prove the write LANDS) — it complements it by
// covering the columns that roundtrip test does not.
//
// >>> OWNER RUNS THIS. Needs LIVE service-role credentials (the agent had none). <<<
//   cd /c/Users/shrujal_mavlers/Desktop/maveloper-backend
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node approve-schema.test.mjs
//   (PowerShell: $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."; node approve-schema.test.mjs)
// ---------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("SKIP: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run the schema check.");
  process.exit(2);
}
const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// Each column the /approve + resolveApproveJobMeta + /bridge-callback paths touch,
// with the server.js reference and whether a MISSING column is fatal or migration-pending.
const REQUIRED = {
  os_queue: [
    { col: "order_id",    ref: "resolveApproveJobMeta .eq('order_id'), /approve folder key", pending: false },
    { col: "job_id",      ref: "resolveApproveJobMeta .select('job_id')",                    pending: false },
    { col: "esp",         ref: "resolveApproveJobMeta .select('esp') -> delivery-notes",     pending: false },
    { col: "dark_mode",   ref: "resolveApproveJobMeta .select('dark_mode')",                 pending: false },
    { col: "status",      ref: "/approve dropbox_url write-back .eq('status','delivered')",  pending: false },
    { col: "dropbox_url", ref: "/approve write-back .update({dropbox_url}) (spec §9)",       pending: false },
  ],
  maveloper_jobs: [
    { col: "id",            ref: "resolveApproveJobMeta loadJob('id'), delivery_meta .eq('id')", pending: false },
    { col: "order_id",      ref: "resolveApproveJobMeta loadJob('order_id')",                    pending: false },
    { col: "image_url_map", ref: "resolveApproveJobMeta .select('image_url_map')",               pending: false },
    { col: "created_at",    ref: "resolveApproveJobMeta .order('created_at')",                   pending: false },
    { col: "delivery_meta", ref: "certificate.txt source; /bridge-callback .update({delivery_meta})", pending: true },
  ],
  drafts: [
    { col: "order_id",      ref: "persistSliceMapToDrafts .eq('order_id')",     pending: false },
    { col: "image_url_map", ref: "persistSliceMapToDrafts .update({image_url_map})", pending: false },
  ],
};

let failures = 0, warns = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };

// A missing column surfaces as PostgREST 42703 (undefined_column) or a "column ... does not exist"
// message. A missing TABLE is 42P01. We probe each column individually to pinpoint the culprit.
async function columnExists(table, col) {
  const { error } = await db.from(table).select(col).limit(0);
  if (!error) return { exists: true };
  const code = error.code || "";
  const missing = code === "42703" || /column .* does not exist|does not exist/i.test(error.message || "");
  const tableMissing = code === "42P01";
  return { exists: false, missing, tableMissing, message: error.message, code };
}

console.log("SCHEMA — every column the /approve delivery path depends on must exist:\n");
for (const [table, cols] of Object.entries(REQUIRED)) {
  console.log(`Table ${table}:`);
  for (const { col, ref, pending } of cols) {
    const r = await columnExists(table, col);
    if (r.exists) { ok(true, `${table}.${col} exists  (${ref})`); continue; }
    if (r.tableMissing) { ok(false, `${table} TABLE missing — ${ref}`); continue; }
    if (pending && r.missing) {
      warns++;
      console.log(`  WARN  ${table}.${col} MISSING — migration pending. ${ref}. certificate.txt degrades to `
        + `"certificate not located" until this column is added (server.js guards it). Add it before relying on it.`);
      continue;
    }
    ok(false, `${table}.${col} MISSING (${r.code || "?"}) — ${ref}. This is a SILENT /approve degradation: `
      + `${r.message}`);
  }
  console.log("");
}

console.log("");
if (failures === 0) {
  console.log(`ALL REQUIRED /approve COLUMNS EXIST${warns ? ` (${warns} migration-pending warning(s) — see above)` : ""}`);
} else {
  console.error(`${failures} REQUIRED COLUMN(S) MISSING — /approve will silently degrade in production. Fix the schema.`);
  process.exit(1);
}
