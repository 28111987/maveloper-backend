/**
 * dropbox-upload.test.mjs — drives the REAL scheduler (dropbox-upload.js, the one
 * server.js imports) at width 3 and width 12.
 *
 * ★ WHAT THIS CAN AND CANNOT MEASURE. Read this before quoting a number from it.
 *
 * CAN, for real: the scheduler. Ordering, in-flight ceiling, the failure queue,
 * the one-shot retry, and whether a permanently failed image stops the order.
 * This is production code executing, not a mirror of it.
 *
 * CANNOT: Dropbox's response to twelve concurrent writes into one namespace.
 * That needs live credentials and a live account, and there are none here — a
 * fake uploadOne cannot tell you when Dropbox starts returning 429. Any latency
 * below is a MODEL, labelled as one, used to compare two schedulers under
 * identical conditions. It is not a prediction of wall-clock time at width 12.
 * The 429 question is answered by watching the first live orders, and nothing
 * in this file substitutes for that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadImagesWithConcurrency, readConcurrency } from "./dropbox-upload.js";

const silent = () => {};
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const imgs = (n) => Array.from({ length: n }, (_, i) => ({ filename: `img-${String(i).padStart(3, "0")}.png`, buffer: Buffer.from(`b${i}`) }));

/** An uploader whose behaviour is scripted per filename. Tracks in-flight peak. */
function fakeUploader({ failOnce = new Set(), failAlways = new Set(), latencyMs = () => 0 } = {}) {
  const seen = new Map();
  const st = { inFlight: 0, peak: 0, calls: 0, paths: [] };
  const uploadOne = async (path, _buf) => {
    const name = path.split("/").pop();
    st.calls++;
    st.paths.push(path);
    st.inFlight++;
    if (st.inFlight > st.peak) st.peak = st.inFlight;
    try {
      const ms = latencyMs(name);
      if (ms > 0) await nap(ms);
      const nth = (seen.get(name) || 0) + 1;
      seen.set(name, nth);
      if (failAlways.has(name)) throw new Error(`429 too_many_write_operations (${name})`);
      if (failOnce.has(name) && nth === 1) throw new Error(`429 too_many_requests (${name})`);
      return { directUrl: `https://dl.dropboxusercontent.com/${name}?raw=1`, sharedUrl: `https://www.dropbox.com/${name}?dl=0` };
    } finally {
      st.inFlight--;
    }
  };
  return { uploadOne, st };
}

const run = (images, concurrency, fake, opts = {}) =>
  uploadImagesWithConcurrency({
    images,
    folderPath: "/2026/08-2026/TESTORDER",
    uploadOne: fake.uploadOne,
    logFn: opts.logFn || silent,
    concurrency,
    retryDelayMs: 0,
    interRetryMs: 0,
    sleep: nap,
    orderId: "TESTORDER",
    ...opts,
  });

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE SPEC THE COMPILER RECEIVES. Key order is INPUT order at every width.
// ─────────────────────────────────────────────────────────────────────────────
for (const width of [3, 12]) {
  test(`key insertion order is input order at width ${width} (all succeed)`, async () => {
    const images = imgs(40);
    // random-ish latency so completion order is definitely NOT input order
    const fake = fakeUploader({ latencyMs: (n) => (Number(n.slice(4, 7)) * 7) % 23 });
    const map = await run(images, width, fake);
    assert.deepEqual(Object.keys(map), images.map((i) => i.filename));
    assert.equal(fake.st.peak <= width, true, `peak ${fake.st.peak} exceeded width ${width}`);
  });
}

test("width 3 and width 12 produce byte-identical maps", async () => {
  const images = imgs(60);
  const lat = (n) => (Number(n.slice(4, 7)) * 13) % 31;
  const a = await run(images, 3, fakeUploader({ latencyMs: lat }));
  const b = await run(images, 12, fakeUploader({ latencyMs: lat }));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("dropbox paths are unchanged and unique", async () => {
  const images = imgs(10);
  const fake = fakeUploader();
  await run(images, 12, fake);
  assert.deepEqual(fake.st.paths.sort(), images.map((i) => `/2026/08-2026/TESTORDER/images/${i.filename}`).sort());
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE FAILURE PATH — the gate.
// ─────────────────────────────────────────────────────────────────────────────
for (const width of [3, 12]) {
  test(`transient failure is recovered by the one retry at width ${width}`, async () => {
    const images = imgs(30);
    const failOnce = new Set(["img-004.png", "img-017.png", "img-029.png"]);
    const fake = fakeUploader({ failOnce });
    const map = await run(images, width, fake);
    assert.equal(Object.keys(map).length, 30, "all 30 should be present after retry");
    assert.equal(fake.st.calls, 33, "3 files uploaded twice");
    // recovered files land AFTER the first-pass successes — the batch loop did the same
    assert.deepEqual(Object.keys(map).slice(-3), ["img-004.png", "img-017.png", "img-029.png"]);
  });

  test(`★ a PERMANENT failure returns a SHORT map and does NOT throw (width ${width})`, async () => {
    const images = imgs(30);
    const fake = fakeUploader({ failAlways: new Set(["img-011.png"]) });
    const map = await run(images, width, fake);
    assert.equal(Object.keys(map).length, 29);
    assert.equal("img-011.png" in map, false);
    // THIS IS THE FINDING: the caller receives a map, not an error. Nothing in
    // this function stops an order whose image set is short by one.
  });

  test(`the retry budget is exactly ONE extra attempt (width ${width})`, async () => {
    const images = imgs(5);
    const fake = fakeUploader({ failAlways: new Set(["img-002.png"]) });
    await run(images, width, fake);
    assert.equal(fake.st.calls, 6, "5 first-pass + 1 retry — never a third attempt");
  });
}

test("total failure returns an EMPTY map rather than throwing", async () => {
  const images = imgs(6);
  const fake = fakeUploader({ failAlways: new Set(images.map((i) => i.filename)) });
  const map = await run(images, 12, fake);
  assert.deepEqual(map, {});
  assert.equal(fake.st.calls, 12);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SUCCESS / FAILURE COUNTS AT 3 AND AT 12, side by side.
// ─────────────────────────────────────────────────────────────────────────────
test("success and failure counts are IDENTICAL at 3 and at 12", async () => {
  const images = imgs(96);
  const failOnce = new Set(["img-007.png", "img-042.png", "img-088.png"]);
  const failAlways = new Set(["img-055.png"]);
  const rows = [];
  for (const width of [3, 12]) {
    // ★ latency is REQUIRED here, and the test found that out by failing: with a
    // zero-latency fake every uploadOne settles before the next worker is
    // scheduled, so the observed in-flight peak was 1 at BOTH widths and the
    // ceiling assertion was measuring the fixture rather than the scheduler.
    const fake = fakeUploader({ failOnce, failAlways, latencyMs: () => 3 });
    const map = await run(images, width, fake);
    rows.push({ width, ok: Object.keys(map).length, missing: 96 - Object.keys(map).length, calls: fake.st.calls, peak: fake.st.peak });
  }
  console.log("  counts:", JSON.stringify(rows));
  assert.equal(rows[0].ok, rows[1].ok);
  assert.equal(rows[0].missing, rows[1].missing);
  assert.equal(rows[0].calls, rows[1].calls);
  assert.equal(rows[0].peak, 3);
  assert.equal(rows[1].peak, 12);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE OLD BARRIER vs THE NEW POOL, under one MODEL. Not a Dropbox prediction.
//    The barrier below is the replaced code, quoted from the 4cc586e diff.
// ─────────────────────────────────────────────────────────────────────────────
async function oldBarrier(images, width, uploadOne, latency) {
  const map = {};
  for (let i = 0; i < images.length; i += width) {
    const batch = images.slice(i, i + width);
    const results = await Promise.allSettled(batch.map((img) => uploadOne(`/x/images/${img.filename}`, img.buffer)));
    for (let j = 0; j < results.length; j++) if (results[j].status === "fulfilled") map[batch[j].filename] = results[j].value.directUrl;
  }
  return map;
}

test("MODEL: pool beats barrier at the same width, and 12 beats 3", async () => {
  const images = imgs(96);
  // A MODEL of variance, not a measurement: a spread of per-upload latencies
  // around a common mean. Real Dropbox latency is not this distribution.
  const lat = (n) => 2 + ((Number(n.slice(4, 7)) * 37) % 18);
  const fake = () => fakeUploader({ latencyMs: lat });
  const timed = async (fn) => { const t = Date.now(); await fn(); return Date.now() - t; };

  const f1 = fake(), f2 = fake(), f3 = fake();
  const barrier3 = await timed(() => oldBarrier(images, 3, f1.uploadOne));
  const pool3 = await timed(() => run(images, 3, f2));
  const pool12 = await timed(() => run(images, 12, f3));
  console.log(`  MODEL ms — barrier@3 ${barrier3}, pool@3 ${pool3}, pool@12 ${pool12}`);
  console.log(`  MODEL ratio — pool@12 is ${(barrier3 / pool12).toFixed(2)}x the old barrier@3`);
  assert.ok(pool3 <= barrier3, "the pool must not be slower than the barrier at the same width");
  assert.ok(pool12 < pool3, "width 12 must be faster than width 3 under any latency");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE ENV VAR — the revert lever must actually work.
// ─────────────────────────────────────────────────────────────────────────────
test("readConcurrency: default, revert, clamp, garbage", () => {
  assert.equal(readConcurrency(undefined, 12), 12, "unset → default 12");
  assert.equal(readConcurrency("", 12), 12, "blank → default 12");
  assert.equal(readConcurrency("   ", 12), 12);
  assert.equal(readConcurrency("3", 12), 3, "★ the revert: DROPBOX_UPLOAD_CONCURRENCY=3");
  assert.equal(readConcurrency(" 8 ", 12), 8);
  assert.equal(readConcurrency("0", 12), 1, "clamped up — 0 would upload nothing, forever");
  assert.equal(readConcurrency("-5", 12), 1);
  assert.equal(readConcurrency("999", 12), 32, "clamped down");
  assert.equal(readConcurrency("banana", 12), 12, "garbage → default, never NaN");
  assert.equal(readConcurrency("12abc", 12), 12);
});

test("concurrency 1 is fully serial and still correct", async () => {
  const images = imgs(8);
  const fake = fakeUploader({ latencyMs: () => 1 });
  const map = await run(images, 1, fake);
  assert.equal(fake.st.peak, 1);
  assert.deepEqual(Object.keys(map), images.map((i) => i.filename));
});

test("empty image list does no work and returns an empty map", async () => {
  const fake = fakeUploader();
  assert.deepEqual(await run([], 12, fake), {});
  assert.equal(fake.st.calls, 0);
});
