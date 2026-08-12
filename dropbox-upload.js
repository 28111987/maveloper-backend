/**
 * dropbox-upload.js — the image-upload SCHEDULER, extracted so it can be
 * exercised without a live order.
 * -----------------------------------------------------------------------------
 * This is THE upload path, relocated — NOT a parallel one. server.js's
 * uploadImagesToDropbox() is now a thin wrapper that injects the real
 * uploadToDropbox as `uploadOne`. The bytes, the Dropbox paths and the returned
 * URLs are produced by exactly the same call as before; what moved here is only
 * the decision of HOW MANY run at once and WHAT HAPPENS WHEN ONE FAILS.
 *
 * WHY IT MOVED. The failure path is the gate on raising concurrency, and the
 * failure path had never been executed by anything but production. It could not
 * be: the scheduler closed over a module-level `dbx` inside a 392k-line file that
 * opens a listening socket on import. With `uploadOne` injected, the REAL
 * scheduler — this file, the one production runs — can be driven at any width
 * with any failure pattern. Same reason dropbox-prune.js and delivery-folder.js
 * were extracted: test the real code, not a mirror of it.
 *
 * ★ WHAT DID NOT CHANGE, AND WHY IT MATTERS
 *
 * The batch loop this replaces was `for (i += N) { await Promise.allSettled(
 * slice(i, i+N)) }` — a BARRIER, not a concurrency limit. Every group of N waited
 * for its own slowest member before the next group started, so one 8-second image
 * idled the other two for 8 seconds. This is a true worker pool: a worker that
 * finishes takes the next index immediately. At the same width of 3 that is
 * already strictly faster; it is not the reason the width is going up, but it is
 * why the width going up actually pays.
 *
 * A worker pool completes out of order, and completion order is where a silent
 * defect would live: `imageUrlMap` is an OBJECT, and Stage 2's prompt renders it
 * with Object.entries() into the === IMAGE ASSETS REFERENCE === block. Key
 * insertion order is therefore INPUT to the compiler. So results are buffered by
 * index and inserted afterwards in INPUT order — successes first, then
 * retry-recovered files, which is byte-for-byte the order the batch loop produced
 * (it inserted each batch in slice order and appended retries at the end). The
 * spec the compiler receives cannot tell the width changed.
 *
 * ★ THE RETRY BUDGET IS ONE ATTEMPT, AND IT DOES NOT HONOUR Retry-After.
 * That is unchanged from the batch loop on purpose — this run raises the width
 * and measures; it does not also rewrite the retry policy. It is the standing
 * risk of the raise and it is named in UPLOAD_SPEED_COMPLETE.md.
 */

/** Clamp an env integer; any unparseable/blank value falls back to `dflt`. */
export function readConcurrency(raw, dflt, min = 1, max = 32) {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * Upload every image to <folderPath>/images/<filename> with bounded concurrency.
 *
 * @param {Object}   o
 * @param {Array}    o.images        [{ filename, buffer }] — order is authoritative
 * @param {string}   o.folderPath    Dropbox folder for this order
 * @param {Function} o.uploadOne     (dropboxPath, buffer) => { directUrl, sharedUrl }
 * @param {Function} o.logFn         (level, msg, meta) => void
 * @param {number}   o.concurrency   workers in flight
 * @param {number}   o.retryDelayMs  pause before the serial retry sweep
 * @param {number}   o.interRetryMs  pause between serial retries
 * @param {Function} o.sleep         (ms) => Promise
 * @param {string}   [o.orderId]
 * @param {Function} [o.redact]      URL redactor for the log line
 * @param {Function} [o.now]         clock, injectable
 * @returns {Promise<Object>} imageUrlMap { filename: directUrl } — MISSING KEY = FAILED FILE
 */
export async function uploadImagesWithConcurrency({
  images,
  folderPath,
  uploadOne,
  logFn,
  concurrency,
  retryDelayMs,
  interRetryMs,
  sleep,
  orderId,
  redact = (u) => u,
  now = () => Date.now(),
}) {
  const imageUrlMap = {};
  const n = images.length;
  const direct = new Array(n).fill(null);
  const failedIdx = [];

  logFn("info", `Uploading ${n} images to Dropbox (parallel, batch size ${concurrency})`, { orderId });
  const t0 = now();

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= n) return;
      const img = images[i];
      try {
        const { directUrl, sharedUrl } = await uploadOne(`${folderPath}/images/${img.filename}`, img.buffer);
        direct[i] = directUrl;
        logFn("info", `Dropbox URL for ${img.filename}`, {
          sharedUrl: redact(sharedUrl),
          directUrl: redact(directUrl),
        });
      } catch (err) {
        logFn("warn", `Upload failed for ${img.filename}, queued for retry`, {
          error: err?.message || String(err),
        });
        failedIdx.push(i);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));

  // ★ INPUT-ORDER INSERTION — see the header. Completion order must not reach the spec.
  for (let i = 0; i < n; i++) {
    if (direct[i]) imageUrlMap[images[i].filename] = direct[i];
  }

  const firstPassMs = now() - t0;
  const firstPassOk = Object.keys(imageUrlMap).length;

  // Retry the failures one at a time, in INPUT order, after a delay.
  let recovered = 0;
  if (failedIdx.length > 0) {
    failedIdx.sort((a, b) => a - b);
    logFn("info", `Retrying ${failedIdx.length} failed uploads after ${retryDelayMs}ms delay`);
    await sleep(retryDelayMs);

    for (const i of failedIdx) {
      const img = images[i];
      try {
        const { directUrl } = await uploadOne(`${folderPath}/images/${img.filename}`, img.buffer);
        imageUrlMap[img.filename] = directUrl;
        recovered++;
        logFn("info", `Retry succeeded for ${img.filename}`);
      } catch (retryErr) {
        logFn("error", `Retry also failed for ${img.filename}`, { error: retryErr?.message || String(retryErr) });
      }
      await sleep(interRetryMs);
    }
  }

  const succeeded = Object.keys(imageUrlMap).length;
  // ★ MEASUREMENT. The owner has been reading the "batch size N" line for months
  // with no duration beside it; the durations in the brief were reconstructed by
  // subtracting log timestamps. uploadMs is the number, stated by the code that
  // did the work.
  logFn("info", `Dropbox upload complete: ${succeeded}/${n} succeeded`, {
    orderId,
    concurrency,
    uploadMs: now() - t0,
    firstPassMs,
    firstPassOk,
    retried: failedIdx.length,
    recovered,
    // > 0 means the delivered html will reference an image that is not in Dropbox.
    stillMissing: n - succeeded,
  });

  return imageUrlMap;
}
