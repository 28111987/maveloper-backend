// =====================================================================
// DROPBOX PRUNE — delete the /approve images/ folder's UNREFERENCED files in a
// rate-limit-safe way. Split out of server.js so the delete discipline is
// unit-testable with a FAKE Dropbox client (no live credentials): server.js
// injects the real `dbx` + a `sleep` fn; this module owns the retry/backoff,
// the ONE-call batch delete, its async-job polling, and the serialised fallback.
//
// Why this exists: the first images/ trim fired all N `filesDeleteV2` calls in a
// concurrent burst right after ~25 shared-link metadata calls. Dropbox rate-
// limited the burst — EVERY delete came back 429 ("Response failed with a 429
// code") and was logged-and-abandoned, so the folder kept its unreferenced files.
// The fix: ONE filesDeleteBatch call instead of N, and honest 429 retry/backoff
// (respecting Retry-After) around the batch, its poll, and the per-file fallback.
//
// CONTRACT: pruning is BEST-EFFORT and NEVER fatal. Any failure that survives the
// retries is returned as a `failed` count (+ logged by the caller), never thrown
// past pruneImages(). A referenced file is NEVER passed in here — the keep-set is
// decided upstream by planDeliveredImagesFolder(); this module only deletes the
// exact `names` it is given.
// =====================================================================

// ── rate-limit / transient classification ────────────────────────────
// A Dropbox rate limit surfaces as HTTP 429 (too_many_requests /
// too_many_write_operations). We also retry the 5xx transient class, matching the
// upload path's retriable set. Anything else (403/404/409 …) is permanent — do
// not spin on it.
export function isRateLimited(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  const summary = dropboxErrorSummary(err);
  return /too_many_requests|too_many_write_operations|rate[_\s-]?limit/i.test(summary);
}

export function isRetriable(err) {
  if (!err) return false;
  if (isRateLimited(err)) return true;
  const s = err.status;
  return s === 500 || s === 502 || s === 503 || s === 504;
}

function dropboxErrorSummary(err) {
  return (
    err?.error?.error_summary ||
    err?.error_summary ||
    (typeof err?.error === "string" ? err.error : "") ||
    err?.message ||
    ""
  );
}

// ── Retry-After ───────────────────────────────────────────────────────
// Prefer Dropbox's explicit hint. It arrives EITHER as the standard `Retry-After`
// HTTP header (seconds) OR as a `retry_after` field on the parsed rate-limit body
// (RateLimitError.retry_after, seconds). Returns milliseconds, or null when no
// hint is present so the caller falls back to exponential backoff.
export function retryAfterMs(err) {
  if (!err) return null;
  // header form — SDK exposes a fetch Headers object (has .get) or a plain object
  const h = err.headers;
  let raw;
  if (h && typeof h.get === "function") raw = h.get("retry-after") ?? h.get("Retry-After");
  else if (h && typeof h === "object") raw = h["retry-after"] ?? h["Retry-After"];
  // body form
  if (raw == null) raw = err?.error?.retry_after ?? err?.error?.error?.retry_after ?? err?.retry_after;
  if (raw == null) return null;
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.round(secs * 1000);
}

// ── generic retry wrapper ─────────────────────────────────────────────
// Run a Dropbox thunk; on a retriable error wait (Retry-After if given, else
// exponential backoff off baseDelayMs, capped) and try again, up to maxAttempts.
// A non-retriable error is rethrown immediately. The last error is rethrown when
// attempts are exhausted so the caller can decide the fallback / give up.
export async function callWithRetry(fn, opts = {}) {
  const {
    label = "dropbox call",
    maxAttempts = 5,
    baseDelayMs = 2000,
    maxDelayMs = 30000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriable(err) || attempt === maxAttempts) throw err;
      // Honor Dropbox's Retry-After when present; otherwise exponential backoff
      // off baseDelayMs, capped at maxDelayMs.
      const hinted = retryAfterMs(err);
      const backoff = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const delay = hinted != null ? hinted : backoff;
      log("warn", `${label}: rate-limited/transient (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`, {
        status: err?.status, retryAfterMs: hinted, summary: dropboxErrorSummary(err).slice(0, 200),
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ── one-call batch delete, with async-job polling ─────────────────────
// filesDeleteBatch removes ALL entries in a single API call. It returns EITHER an
// immediate `complete` result OR an `async_job_id` that must be polled via
// filesDeleteBatchCheck until it reports `complete` (or `failed`). Each entry then
// carries its own success/failure — a per-entry failure is a SKIPPED file, not a
// thrown error. Returns { pruned, failed } or throws if the batch could not run
// at all (so pruneImages can fall back to per-file deletes).
async function batchDelete(dbx, imagesFolder, names, opts) {
  const {
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
    maxAttempts = 5,
    baseDelayMs = 2000,
    pollIntervalMs = 1000,
    pollTimeoutMs = 60000,
  } = opts;

  const entries = names.map((name) => ({ path: `${imagesFolder}/${name}` }));
  const launch = await callWithRetry(() => dbx.filesDeleteBatch({ entries }), {
    label: "filesDeleteBatch", maxAttempts, baseDelayMs, sleep, log,
  });

  let status = launch?.result;
  if (status && status[".tag"] === "async_job_id") {
    const jobId = status.async_job_id;
    let waited = 0;
    for (;;) {
      const checkResp = await callWithRetry(() => dbx.filesDeleteBatchCheck({ async_job_id: jobId }), {
        label: "filesDeleteBatchCheck", maxAttempts, baseDelayMs, sleep, log,
      });
      status = checkResp?.result;
      if (!status || status[".tag"] !== "in_progress") break;
      if (waited >= pollTimeoutMs) {
        throw new Error(`filesDeleteBatch async job ${jobId} still in_progress after ${pollTimeoutMs}ms`);
      }
      await sleep(pollIntervalMs);
      waited += pollIntervalMs;
    }
  }

  if (!status || status[".tag"] !== "complete" || !Array.isArray(status.entries)) {
    throw new Error(`filesDeleteBatch did not complete (tag=${status?.[".tag"] || "none"})`);
  }

  let pruned = 0;
  let failed = 0;
  for (const e of status.entries) {
    if (e && e[".tag"] === "success") pruned++;
    else failed++;
  }
  if (failed > 0) {
    log("warn", `filesDeleteBatch: ${failed}/${status.entries.length} entries could not be deleted (skipped, not fatal)`, {});
  }
  return { pruned, failed, mode: "batch" };
}

// ── serialised per-file fallback ──────────────────────────────────────
// Used only when the batch path is unavailable (older SDK) or fails wholesale.
// SERIALISED (one at a time) with the SAME retry/backoff — never a burst, which is
// what triggered the 429 storm in the first place. Each file's failure is counted
// and skipped, never thrown.
async function serialDelete(dbx, imagesFolder, names, opts) {
  const {
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
    maxAttempts = 5,
    baseDelayMs = 2000,
    interFileMs = 0,
  } = opts;

  let pruned = 0;
  let failed = 0;
  for (const name of names) {
    try {
      await callWithRetry(() => dbx.filesDeleteV2({ path: `${imagesFolder}/${name}` }), {
        label: `filesDeleteV2 ${name}`, maxAttempts, baseDelayMs, sleep, log,
      });
      pruned++;
    } catch (delErr) {
      failed++;
      log("warn", `Approve: could not prune unreferenced image ${name} (skipped, not fatal)`, {
        status: delErr?.status, error: delErr?.message,
      });
    }
    if (interFileMs > 0) await sleep(interFileMs);
  }
  return { pruned, failed, mode: "serial" };
}

// ── public entry point ────────────────────────────────────────────────
// Delete every name in `names` under `imagesFolder`. Tries ONE filesDeleteBatch
// call (with retry + async-job polling); if that path is unavailable or fails
// wholesale, falls back to SERIALISED per-file deletes (also retried). Never
// throws — a wholesale failure returns { pruned: 0, failed: names.length }. The
// caller logs the counts and delivers the folder regardless.
export async function pruneImages(dbx, imagesFolder, names, opts = {}) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (list.length === 0) return { pruned: 0, failed: 0, mode: "noop" };
  const { log = () => {} } = opts;

  const canBatch = dbx && typeof dbx.filesDeleteBatch === "function" && typeof dbx.filesDeleteBatchCheck === "function";
  if (canBatch) {
    try {
      return await batchDelete(dbx, imagesFolder, list, opts);
    } catch (batchErr) {
      log("warn", "Approve: filesDeleteBatch failed wholesale — falling back to serialised per-file deletes", {
        status: batchErr?.status, error: batchErr?.message,
      });
    }
  }

  try {
    return await serialDelete(dbx, imagesFolder, list, opts);
  } catch (serialErr) {
    // serialDelete already swallows per-file errors; this only fires on an
    // unexpected structural error. Best-effort: report all as failed, never throw.
    log("warn", "Approve: serialised prune fallback failed wholesale — folder delivered with extra files", {
      error: serialErr?.message,
    });
    return { pruned: 0, failed: list.length, mode: "failed" };
  }
}

export default { isRateLimited, isRetriable, retryAfterMs, callWithRetry, pruneImages };
