// Unit test for dropbox-prune.js — the images/ trim delete discipline, exercised
// against a FAKE Dropbox client (no live credentials). Proves the batch-delete
// path is invoked with the right entries and that a simulated 429 is RETRIED with
// backoff rather than logged-and-abandoned (the defect the owner hit).
// Run: node dropbox-prune.test.mjs   (exit 0 = all pass)
import {
  isRateLimited,
  isRetriable,
  retryAfterMs,
  callWithRetry,
  pruneImages,
} from "./dropbox-prune.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ FAIL:", msg); } };

// A sleep that never actually waits but RECORDS every requested delay, so the
// tests can assert backoff happened without slowing the suite.
function makeSleep() {
  const delays = [];
  const sleep = (ms) => { delays.push(ms); return Promise.resolve(); };
  return { sleep, delays };
}

// A Dropbox 429 shaped like the SDK's DropboxResponseError: numeric .status, an
// error_summary, and a fetch-style Headers object carrying Retry-After.
function make429({ retryAfterSecs } = {}) {
  const headers = new Map();
  if (retryAfterSecs != null) headers.set("retry-after", String(retryAfterSecs));
  return {
    status: 429,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) },
    error: { error_summary: "too_many_requests/...", error: { ".tag": "too_many_requests" } },
    message: "Response failed with a 429 code",
  };
}

const IMAGES = "/Apps/maveloper/2026/07-2026/OF999/images";

// ── classification ────────────────────────────────────────────────────
ok(isRateLimited(make429()) === true, "429 is a rate limit");
ok(isRateLimited({ status: 429 }) === true, "bare 429 status is a rate limit");
ok(isRateLimited({ error_summary: "too_many_write_operations/.." }) === true, "too_many_write_operations is a rate limit");
ok(isRateLimited({ status: 409 }) === false, "409 conflict is NOT a rate limit");
ok(isRetriable({ status: 503 }) === true, "503 is retriable (transient)");
ok(isRetriable({ status: 404 }) === false, "404 is NOT retriable");
ok(isRetriable(null) === false, "null is not retriable");

// ── retryAfterMs ──────────────────────────────────────────────────────
ok(retryAfterMs(make429({ retryAfterSecs: 3 })) === 3000, "reads Retry-After header (seconds → ms)");
ok(retryAfterMs({ error: { retry_after: 5 } }) === 5000, "reads body retry_after");
ok(retryAfterMs({ headers: { "retry-after": "2" } }) === 2000, "reads plain-object header");
ok(retryAfterMs(make429()) === null, "no hint → null (caller uses backoff)");

// ── callWithRetry: a 429 is retried, then succeeds ───────────────────
{
  const { sleep, delays } = makeSleep();
  let calls = 0;
  const result = await callWithRetry(
    () => { calls++; if (calls === 1) throw make429({ retryAfterSecs: 4 }); return Promise.resolve("ok"); },
    { label: "t", baseDelayMs: 2000, sleep },
  );
  ok(result === "ok", "callWithRetry returns the eventual success value");
  ok(calls === 2, "callWithRetry retried exactly once after the 429");
  ok(delays.length === 1 && delays[0] === 4000, "callWithRetry honoured Retry-After (4000ms), not blind backoff");
}

// ── callWithRetry: exponential backoff when no Retry-After hint ───────
{
  const { sleep, delays } = makeSleep();
  let calls = 0;
  await callWithRetry(
    () => { calls++; if (calls < 3) throw make429(); return Promise.resolve("ok"); },
    { label: "t", baseDelayMs: 1000, sleep },
  );
  ok(calls === 3, "retries until success");
  ok(delays[0] === 1000 && delays[1] === 2000, "exponential backoff 1000 → 2000 when no Retry-After");
}

// ── callWithRetry: a non-retriable error is thrown immediately ───────
{
  const { sleep, delays } = makeSleep();
  let calls = 0;
  let threw = false;
  try {
    await callWithRetry(() => { calls++; throw { status: 409, message: "conflict" }; }, { sleep });
  } catch { threw = true; }
  ok(threw && calls === 1 && delays.length === 0, "non-retriable 409 thrown at once, no retry, no sleep");
}

// ── callWithRetry: gives up after maxAttempts ────────────────────────
{
  const { sleep, delays } = makeSleep();
  let calls = 0;
  let threw = false;
  try {
    await callWithRetry(() => { calls++; throw make429(); }, { maxAttempts: 3, baseDelayMs: 500, sleep });
  } catch { threw = true; }
  ok(threw && calls === 3 && delays.length === 2, "exhausts maxAttempts (3 tries, 2 sleeps) then rethrows");
}

// ── pruneImages: BATCH path invoked with the RIGHT entries; 429 RETRIED ─
// This is the core proof the owner's defect is fixed: ONE filesDeleteBatch call,
// carrying exactly the unreferenced names, and a 429 on that call is retried
// (not abandoned as before).
{
  const { sleep, delays } = makeSleep();
  const remove = ["group-3.png", "vector-2.png", "layer-1.png"];
  const seenEntries = [];
  let batchCalls = 0;
  let deleteV2Calls = 0;
  const dbx = {
    filesDeleteBatch: (arg) => {
      batchCalls++;
      seenEntries.push(arg.entries);
      if (batchCalls === 1) throw make429({ retryAfterSecs: 2 }); // first burst is 429'd
      return Promise.resolve({ result: { ".tag": "complete", entries: arg.entries.map(() => ({ ".tag": "success" })) } });
    },
    filesDeleteBatchCheck: () => { throw new Error("should not poll — batch returned complete"); },
    filesDeleteV2: () => { deleteV2Calls++; return Promise.resolve({}); },
  };

  const res = await pruneImages(dbx, IMAGES, remove, { sleep, baseDelayMs: 1000 });

  ok(res.mode === "batch", "used the batch path (not the per-file fallback)");
  ok(batchCalls === 2, "filesDeleteBatch was RETRIED after the 429 (2 calls), not abandoned");
  ok(deleteV2Calls === 0, "did NOT fall back to per-file filesDeleteV2 (batch recovered)");
  ok(delays.length === 1 && delays[0] === 2000, "the 429 retry honoured Retry-After (2000ms) with backoff");
  ok(res.pruned === 3 && res.failed === 0, "all 3 unreferenced files pruned");
  // the entries passed carried EXACTLY the unreferenced names as full paths
  const paths = seenEntries[0].map((e) => e.path);
  ok(paths.length === 3, "batch was called with all 3 entries in ONE call");
  ok(paths.includes(`${IMAGES}/group-3.png`), "entry path is the full images/ path for group-3.png");
  ok(paths.includes(`${IMAGES}/vector-2.png`) && paths.includes(`${IMAGES}/layer-1.png`), "all unreferenced names present");
  ok(!paths.some((p) => /slice_/.test(p)), "NO referenced slice was ever a delete target (keep-set upstream)");
}

// ── pruneImages: async-job polling path ───────────────────────────────
{
  const { sleep } = makeSleep();
  let checkCalls = 0;
  const dbx = {
    filesDeleteBatch: (arg) => Promise.resolve({ result: { ".tag": "async_job_id", async_job_id: "job-1" } }),
    filesDeleteBatchCheck: () => {
      checkCalls++;
      if (checkCalls < 2) return Promise.resolve({ result: { ".tag": "in_progress" } });
      return Promise.resolve({ result: { ".tag": "complete", entries: [{ ".tag": "success" }, { ".tag": "success" }] } });
    },
    filesDeleteV2: () => Promise.resolve({}),
  };
  const res = await pruneImages(dbx, IMAGES, ["a.png", "b.png"], { sleep, pollIntervalMs: 10 });
  ok(res.mode === "batch" && res.pruned === 2, "polls filesDeleteBatchCheck until complete, counts successes");
  ok(checkCalls === 2, "kept polling while in_progress");
}

// ── pruneImages: a per-entry failure is a SKIP, not a throw ───────────
{
  const { sleep } = makeSleep();
  const dbx = {
    filesDeleteBatch: (arg) => Promise.resolve({
      result: { ".tag": "complete", entries: [{ ".tag": "success" }, { ".tag": "failure", failure: { ".tag": "path_lookup" } }] },
    }),
    filesDeleteBatchCheck: () => Promise.resolve({ result: { ".tag": "complete", entries: [] } }),
    filesDeleteV2: () => Promise.resolve({}),
  };
  const res = await pruneImages(dbx, IMAGES, ["ok.png", "gone.png"], { sleep });
  ok(res.pruned === 1 && res.failed === 1, "per-entry failure counted as skipped, not fatal");
}

// ── pruneImages: falls back to SERIALISED per-file deletes ────────────
// When the batch method is absent (older SDK), delete one-at-a-time with retry —
// never a concurrent burst.
{
  const { sleep, delays } = makeSleep();
  const order = [];
  const dbx = {
    // no filesDeleteBatch / filesDeleteBatchCheck → forces the fallback
    filesDeleteV2: ({ path }) => { order.push(path); return Promise.resolve({}); },
  };
  const res = await pruneImages(dbx, IMAGES, ["x.png", "y.png"], { sleep, interFileMs: 500 });
  ok(res.mode === "serial" && res.pruned === 2, "fell back to serialised filesDeleteV2 for all files");
  ok(order.length === 2 && order[0].endsWith("/x.png") && order[1].endsWith("/y.png"), "deleted serially in order");
}

// ── pruneImages: serialised fallback RETRIES a 429 too ────────────────
{
  const { sleep, delays } = makeSleep();
  let calls = 0;
  const dbx = {
    filesDeleteV2: () => { calls++; if (calls === 1) throw make429({ retryAfterSecs: 1 }); return Promise.resolve({}); },
  };
  const res = await pruneImages(dbx, IMAGES, ["only.png"], { sleep, baseDelayMs: 1000 });
  ok(res.pruned === 1 && calls === 2, "serial fallback retried the 429 (2 calls) rather than abandoning the file");
  ok(delays.includes(1000), "serial fallback honoured Retry-After (1000ms)");
}

// ── pruneImages: batch fails wholesale → fall back to serial ──────────
{
  const { sleep } = makeSleep();
  let deleteV2 = 0;
  const dbx = {
    filesDeleteBatch: () => { throw { status: 403, message: "insufficient_scope" }; }, // non-retriable, wholesale fail
    filesDeleteBatchCheck: () => Promise.resolve({ result: { ".tag": "complete", entries: [] } }),
    filesDeleteV2: () => { deleteV2++; return Promise.resolve({}); },
  };
  const res = await pruneImages(dbx, IMAGES, ["a.png", "b.png"], { sleep });
  ok(res.mode === "serial" && res.pruned === 2 && deleteV2 === 2, "batch wholesale failure falls back to per-file serial deletes");
}

// ── pruneImages: NEVER throws, even if every delete fails ─────────────
{
  const { sleep } = makeSleep();
  const dbx = {
    filesDeleteV2: () => { throw { status: 500, message: "server error" }; },
  };
  let threw = false;
  let res;
  try {
    res = await pruneImages(dbx, IMAGES, ["a.png"], { sleep, maxAttempts: 2, baseDelayMs: 1 });
  } catch { threw = true; }
  ok(!threw, "pruneImages never throws (best-effort, delivery continues)");
  ok(res.failed === 1 && res.pruned === 0, "unrecoverable delete reported as failed, not crashed");
}

// ── pruneImages: empty list is a no-op ────────────────────────────────
{
  const dbx = { filesDeleteBatch: () => { throw new Error("should not be called"); } };
  const res = await pruneImages(dbx, IMAGES, [], {});
  ok(res.mode === "noop" && res.pruned === 0 && res.failed === 0, "empty remove list → no API call, no-op");
}

// ── summary ───────────────────────────────────────────────────────────
console.log(`\ndropbox-prune.test.mjs: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
