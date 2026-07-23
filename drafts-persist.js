// drafts-persist.js
// ---------------------------------------------------------------------------
// Persist a compiler slice-image map to the `drafts` table — the row the
// /approve ZIP builder actually reads its imageUrlMap from.
//
// WHY THIS EXISTS (root cause of the "ZIP has HTML only, no images/ folder" defect):
//   The /approve endpoint (server.js) does NOT query any table for its imageUrlMap —
//   it takes it from the POST body. The frontend loads that map from `drafts`
//   (drafts.image_url_map, keyed by order_id) before POSTing. The backend previously
//   only ever wrote image_url_map to `maveloper_jobs` (read by /job-status), and NEVER
//   to `drafts`, so the compiler slice map never reached the table /approve reads.
//   The earlier report also mislabelled the target as `os_queue.image_url_map`, a
//   column that DOES NOT EXIST on os_queue (its only /approve-related write is
//   dropbox_url). This module writes to the correct table+column.
//
// SCHEMA CONTRACT (verified by the owner against LIVE project ddndmeaiopkastapbexq,
// 2026-07-23 — re-verify with drafts-roundtrip.test.mjs before trusting):
//   drafts:         id, order_id, html_content, image_url_map   <- the table /approve reads
//   maveloper_jobs: id, order_id, image_url_map                 <- read by /job-status (kept)
//   os_queue:       NO image_url_map column                     <- must NOT be targeted
//
// This is an in-code schema assertion: if drafts.image_url_map is ever renamed or
// dropped, the UPDATE below returns a PostgREST error and we log at ERROR. A wrong
// target column can therefore never silently "succeed" the way the os_queue mistake did.
//
// ADDITIVE + INERT on the LLM path: callers gate the call on a NON-EMPTY compiler slice
// map, and this function itself short-circuits (without touching Supabase) on an empty
// map / missing order_id. So an LLM-path order never reaches `.from("drafts")` here and
// the frontend keeps sole ownership of those draft rows exactly as today.
//
// UPDATE-only (never insert/upsert): we do not know the drafts row lifecycle or whether
// order_id carries a unique constraint, so we never create a partial/orphan draft row
// and never clobber a not-yet-created one. If no row exists at write time we log LOUDLY
// and return { ok:false, reason:"no-row" } instead of silently succeeding.
// ---------------------------------------------------------------------------

/**
 * @param {object|null} supabaseAdmin  service-role Supabase client (null in unconfigured envs)
 * @param {(level:string,msg:string,meta?:object)=>void} log  structured logger
 * @param {string|null|undefined} orderId  the REAL order_id (never the bridgeJobId fallback)
 * @param {Record<string,string>|null|undefined} sliceMap  { basename: dropboxUrl } to persist
 * @param {string} [requestId]
 * @returns {Promise<{ok:boolean, reason?:string, rows?:number, error?:any}>}
 */
export async function persistSliceMapToDrafts(supabaseAdmin, log, orderId, sliceMap, requestId) {
  if (!supabaseAdmin) return { ok: false, reason: "no-supabase" };
  if (!orderId) return { ok: false, reason: "no-order-id" };
  if (!sliceMap || typeof sliceMap !== "object" || Object.keys(sliceMap).length === 0) {
    return { ok: false, reason: "empty-map" };
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("drafts")
      .update({ image_url_map: sliceMap })
      .eq("order_id", orderId)
      .select("id");

    if (error) {
      // A missing column/table (schema drift) surfaces here as a PostgREST error
      // (e.g. code 42703 undefined_column, 42P01 undefined_table, or PGRST204).
      // Log at ERROR so a wrong target can never masquerade as success again.
      log("error", "Approve-ZIP: drafts.image_url_map write FAILED (slices will NOT localise in ZIP)", {
        requestId, orderId,
        error: error.message, code: error.code, details: error.details, hint: error.hint,
      });
      return { ok: false, reason: "db-error", error };
    }

    const rows = Array.isArray(data) ? data.length : 0;
    if (rows === 0) {
      // DOWNGRADED warn -> info (TASK-6c): /approve now resolves the delivery folder
      // SERVER-SIDE from the delivered HTML (the authority) and reads
      // maveloper_jobs.image_url_map — it does NOT read drafts.image_url_map. Compiler
      // orders are created via os_queue/maveloper_jobs and typically have NO drafts row,
      // so a 0-row match here is EXPECTED, not a fault: the delivery is unaffected (the
      // drafts map is only a redundant preferred-filename hint the frontend may load).
      // Logged at info so it stops burying real problems (the ERROR branch above still
      // fires loudly on a genuine schema-drift write failure).
      log("info", "Approve: drafts.image_url_map not persisted (no drafts row for this order) — expected for compiler orders; /approve resolves from the delivered HTML server-side, so this is not a fault", {
        requestId, orderId, keys: Object.keys(sliceMap).length,
      });
      return { ok: false, reason: "no-row", rows: 0 };
    }

    log("info", "Approve-ZIP: persisted compiler slice map to drafts.image_url_map", {
      requestId, orderId, rows, keys: Object.keys(sliceMap).length,
    });
    return { ok: true, rows };
  } catch (e) {
    log("warn", "Approve-ZIP: drafts.image_url_map write threw (non-fatal)", {
      requestId, orderId, error: e.message,
    });
    return { ok: false, reason: "throw", error: e };
  }
}
