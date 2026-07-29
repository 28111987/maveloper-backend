// =====================================================================
// APPROVE IDEMPOTENCY — the guard that stops one order being delivered twice.
//
// THE DEFECT. POST /approve re-runs the WHOLE delivery path every time it is
// called: it rebuilds the delivery folder (re-materialising every referenced
// image into Dropbox), re-creates the share link, re-writes os_queue.dropbox_url,
// re-runs the prune and the integrity gate, and — once ORDER_CONFIRMATION_ENABLED
// is on — SENDS A SECOND CONFIRMATION EMAIL TO THE LEAD. It is harmless today
// only because /approve is a deliberate manual click on a button the console
// disables while it is in flight. The day the server-side runner calls /approve
// itself (a planned direction), "harmless" stops being true: a runner that
// retries a slow request, or replays a queue entry, mails the lead twice and
// pays for the whole Dropbox pipeline twice.
//
// ★ WHY NO NEW COLUMN. EMAIL_NOTIFY_scope.md proposed `os_queue.notified_at`.
// The earlier run declined it because the brief forbids inventing columns, and
// that reasoning still holds — this repo cannot apply DDL (the owner holds the
// service-role key), so a guard that needs a migration is a guard that is off
// until someone runs SQL. The state lives instead in
// `maveloper_jobs.delivery_meta` — an EXISTING jsonb column that /approve
// ALREADY reads (resolveApproveJobMeta pulls .certificate and .provenance from
// it) and ALREADY writes (the order-confirmation block merges .confirmationEmail
// into it). A column that is absent yields `null` and the guard simply does not
// fire: it degrades to today's behaviour rather than failing an approve.
//
// ★ WHAT IT IS KEYED ON, AND WHY THAT IS NOT "ORDER ID".
// Keying on the order id alone would be wrong: TEST27-1800 needs a genuine
// re-approve after a re-compile, and so does every order whose first delivery
// was short. So the key is a FINGERPRINT of the bytes being delivered —
// sha256(orderId + the delivered html). A re-compile produces different html,
// therefore a different fingerprint, therefore a full re-run. A second click
// with the SAME html is, by definition, the same delivery, and there is nothing
// for the second run to add.
//
// ★ AND IT ONLY SUPPRESSES A DELIVERY THAT ACTUALLY SUCCEEDED. A prior run that
// shipped an incomplete folder (integrity gate red), that never got a share
// link, or whose confirmation email FAILED is recorded as incomplete, and a
// re-approve of identical bytes runs in full — because that re-approve is a
// repair, which is exactly the legitimate case the guard must not block.
//
// Pure: no I/O, no Express, no Supabase. server.js reads/writes the record; this
// decides. Same split as delivery-folder.js.
// =====================================================================
import { createHash } from "node:crypto";

/** The key inside delivery_meta. Sits beside `certificate`, `provenance`, `confirmationEmail`. */
export const APPROVE_RECORD_KEY = "approve";

/** Bumped only if the record's SHAPE changes. An unknown schema is ignored (→ full re-run). */
export const APPROVE_RECORD_SCHEMA = 1;

/**
 * The identity of a delivery: this order id + these exact delivered bytes.
 *
 * Not a timestamp and not the order id alone. Two approves of the same order id
 * with the same html ARE the same delivery; two approves with different html are
 * two different deliveries and both must run. Truncated to 32 hex chars — 128
 * bits, which is far beyond collision range for the number of approves this
 * product will ever perform, and short enough to read in a log line.
 */
export function approveFingerprint({ orderId, html }) {
  const h = createHash("sha256");
  h.update(String(orderId ?? ""), "utf8");
  h.update("\u0000", "utf8"); // separator: an id ending in the html's first bytes cannot alias
  h.update(String(html ?? ""), "utf8");
  return h.digest("hex").slice(0, 32);
}

/**
 * Pull the approve record out of a delivery_meta jsonb, tolerantly.
 * Anything unexpected — column absent, not an object, wrong schema, missing
 * fingerprint — yields null, which means "no prior approve is known", which
 * means the guard does not fire. The guard's failure mode is ALWAYS to deliver.
 */
export function readApproveRecord(deliveryMeta) {
  if (!deliveryMeta || typeof deliveryMeta !== "object") return null;
  const rec = deliveryMeta[APPROVE_RECORD_KEY];
  if (!rec || typeof rec !== "object") return null;
  if (rec.schema !== APPROVE_RECORD_SCHEMA) return null;
  if (typeof rec.fingerprint !== "string" || !rec.fingerprint) return null;
  return rec;
}

/**
 * Was a completed run good enough that repeating it would add nothing?
 *
 * Deliberately strict. Every "no" below means a re-approve of identical bytes is
 * a REPAIR and must be allowed to run:
 *   • no share link              → the delivery never finished
 *   • integrity gate red         → the folder shipped short (disclosed); a rebuild may fix it
 *   • integrity gate never ran   → we do not know the folder is complete, so we do not claim it
 *   • confirmation email failed  → the lead was not notified; a re-approve retries the send
 * `confirmationEmail: null` (the feature is OFF, the default) is NOT a failure.
 */
export function approveWasComplete({ dropboxUrl, folderIntegrity, confirmationEmail } = {}) {
  if (!dropboxUrl) return false;
  if (!folderIntegrity || folderIntegrity.ok !== true) return false;
  if (confirmationEmail && confirmationEmail.ok === false) return false;
  return true;
}

/**
 * THE DECISION. Returns { run, reason, prior }.
 *
 *   run:false  → skip the entire delivery path and replay the prior response.
 *   run:true   → today's behaviour, unchanged, with `reason` naming why.
 *
 * `force` is the escape hatch (POST body { force: true }): a human who wants the
 * folder rebuilt from identical bytes can always have it. A guard with no way
 * past it is a guard that gets deleted the first time it is inconvenient.
 */
export function decideApprove({ record, fingerprint, force = false } = {}) {
  if (force === true) return { run: true, reason: "forced", prior: record || null };
  if (!record) return { run: true, reason: "no-prior-approve", prior: null };
  if (record.fingerprint !== fingerprint) {
    // ★ THE LEGITIMATE RE-APPROVE. Different delivered bytes = a different
    // delivery (a re-compile, an edited artifact). Always runs.
    return { run: true, reason: "delivered-html-changed", prior: record };
  }
  if (record.complete !== true) {
    // ★ THE REPAIR. Same bytes, but the prior run did not finish cleanly.
    return { run: true, reason: "prior-approve-incomplete", prior: record };
  }
  return { run: false, reason: "duplicate-approve", prior: record };
}

/**
 * The record written back into delivery_meta after a successful run. Holds
 * exactly the fields /approve's own response is built from, so a suppressed
 * duplicate can be answered with the SAME payload the first call returned rather
 * than a different-shaped "already done" object the frontend has never seen.
 */
export function buildApproveRecord({
  fingerprint, orderId, folderPath, dropboxUrl, imageCount, previewStatus,
  generatedBy, folderIntegrity, confirmationEmail, at, requestId,
} = {}) {
  const integrity = folderIntegrity
    ? {
        ok: folderIntegrity.ok ?? null,
        missingFiles: folderIntegrity.missingFiles || [],
        deadRefs: folderIntegrity.deadRefs || [],
        counts: folderIntegrity.counts || null,
        error: folderIntegrity.error || null,
      }
    : null;
  return {
    schema: APPROVE_RECORD_SCHEMA,
    fingerprint,
    at: at || new Date().toISOString(),
    requestId: requestId || null,
    orderId: orderId ?? null,
    folderPath: folderPath ?? null,
    dropboxUrl: dropboxUrl ?? null,
    imageCount: Number.isFinite(imageCount) ? imageCount : null,
    previewStatus: previewStatus ?? null,
    generatedBy: generatedBy ?? null,
    folderIntegrity: integrity,
    // Only the outcome, never the message body — this jsonb is not a mail spool.
    confirmationEmail: confirmationEmail
      ? { ok: confirmationEmail.ok ?? null, transport: confirmationEmail.transport ?? null, to: confirmationEmail.to ?? null }
      : null,
    complete: approveWasComplete({ dropboxUrl, folderIntegrity, confirmationEmail }),
  };
}

/**
 * The response body for a SUPPRESSED duplicate: the first call's payload,
 * replayed, plus a truthful marker.
 *
 * ★ It is the same shape and the same values, because the facts have not
 * changed — the folder, the link and the integrity verdict are all still
 * exactly what the first approve produced. The frontend needs no change to
 * handle it (it reads data.dropboxUrl and renders the link, as before).
 * `alreadyApproved: true` is additive, so a client that ignores it behaves
 * identically to today, and one that reads it can say "already delivered"
 * instead of "uploaded".
 *
 * ★ confirmationEmail is replayed as the RECORDED outcome with `replayed: true`
 * rather than as null: null means "the feature is off", and a duplicate approve
 * must not report a successful send as a disabled feature.
 */
export function replayApproveResponse(record, { requestId } = {}) {
  return {
    dropboxUrl: record.dropboxUrl,
    orderId: record.orderId,
    folderPath: record.folderPath,
    imageCount: record.imageCount,
    previewStatus: record.previewStatus,
    generatedBy: record.generatedBy,
    folderIntegrity: record.folderIntegrity || null,
    confirmationEmail: record.confirmationEmail
      ? { ...record.confirmationEmail, replayed: true }
      : null,
    alreadyApproved: true,
    approvedAt: record.at || null,
    requestId: requestId || null,
  };
}

// ── the CONCURRENT duplicate, which the durable record cannot see ────────────
// The record above is written at the END of a run, so two calls that arrive
// while the first is still in flight both read "no prior approve" and both
// deliver. That is not a theoretical window: /approve's own client budget is
// 600 seconds, and the failure mode of an automated caller is precisely a
// retry of a request it thinks has stalled.
//
// This is an in-PROCESS latch, and its limits are stated rather than implied:
// it is per Node process, so it does not cover two Railway replicas. It is a
// second line behind the durable record, not a replacement for it.
const inFlight = new Map(); // orderId -> { fingerprint, startedAt, requestId }

export function beginApprove(orderId, meta = {}) {
  if (!orderId) return { ok: true, release: () => {} };
  const held = inFlight.get(orderId);
  if (held) return { ok: false, held };
  inFlight.set(orderId, { startedAt: Date.now(), ...meta });
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      inFlight.delete(orderId);
    },
  };
}

/** Test seam only — the latch is process-global by design. */
export function _resetApproveLatch() {
  inFlight.clear();
}
