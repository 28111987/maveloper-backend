# UPLOAD_SPEED_COMPLETE

Staged, not committed, not pushed: `server.js`, `dropbox-upload.js` (new),
`dropbox-upload.test.mjs` (new), `UPLOAD_SPEED_STATE.md`.

## Why the batch size was 3

**A reason is recorded, and it is a belief rather than an incident.**

Commit `4cc586e` "fix: reduce Dropbox batch size + retry failed uploads (v1.3.6)", 14 Apr 2026,
moved `BATCH_SIZE` from 5 to 3 in the same diff that added the `failedImages` retry queue, and
rewrote the doc comment from *"batches of 5 for speed without hitting rate limits"* to
*"batches of 3 with retry logic for rate-limited requests"*. Introduced at 5 in `7512cf6`.

That is the whole record. **No 429 is quoted, no error text, no order id, no measurement, no
incident note** — in the commit body, the diff, or any comment. It is reported here and not
overridden silently: the raise is env-gated and reverting is a Railway setting.

Dropbox does **not** publish a requests-per-second figure for the endpoints this code names
(`filesUpload` → `/2/files/upload`, and `sharingCreateSharedLinkWithSettings`). What it documents is
429 `too_many_requests` with a `Retry-After` header, and 429 `too_many_write_operations` when
concurrent writes contend for a lock on the **same namespace** — which is exactly what N parallel
uploads into one order folder do. So there is no documented number that 3 was 3 *of*.

Every place the width is set: `server.js:187` (the sole definition, now env-read), used at
`server.js:504/506/507` (generation uploads) and `server.js:7467` (`/approve` materialisation).
Related and **not** changed: `IMAGE_DOWNLOAD_CONCURRENCY = 5` (`server.js:199`),
`FIGMA_BATCH_SIZE = 50` and `PNG_DOWNLOAD_CONCURRENCY = 5` (`figma-image-export.js:23,25`).

## The env var

**`DROPBOX_UPLOAD_CONCURRENCY`, default 12**, clamped 1–32, garbage falls back to 12.
Revert is `DROPBOX_UPLOAD_CONCURRENCY=3` in Railway plus a restart — no commit, by design.

## Do both uploads share the path

**Yes — and there are three call sites, not two.** All three call the same
`uploadImagesToDropbox()`, so one setting moves all of them:

- `server.js:4497` — PDF/`/generate`
- `server.js:5994` — Figma Phase B, **before** Stage 2
- `server.js:6927` — `/bridge-callback`, compiler slices, **after** the callback

`/approve` (`server.js:7467`) is a **fourth** consumer of the constant, but through
`mapWithConcurrency` — same width, different code (server-side copy, not upload).

**One change beyond the width.** The old loop was `for (i += N) await Promise.allSettled(slice)` — a
**barrier**, not a concurrency limit: each group of N waited for its own slowest member, so one slow
image idled the other two. It is now a worker pool. This matters for a reason that is not speed:
a pool completes out of order, and `imageUrlMap` is an object whose **key order is rendered into
Stage 2's `=== IMAGE ASSETS REFERENCE ===` block**. Results are therefore buffered by index and
inserted in **input** order, successes then retry-recovered — byte-for-byte the order the batch loop
produced. A test pins that width 3 and width 12 produce identical maps. Paths, bytes and URLs are
produced by the same `uploadToDropbox` call as before.

## Retry behaviour, and whether an order can deliver with a missing image

**Yes. It can, and it does so quietly.**

- **Attempts: one first pass + exactly one serial retry** (2000 ms delay, 500 ms between files).
  Never a third. Pinned by test.
- `uploadToDropbox` (`server.js:445`) has **no 429 handling**, and the Dropbox SDK (v10.37.1) does
  not auto-retry. The retry **does not read `Retry-After`**. `dropbox-prune.js` on the delete path
  *does* honour it — the upload path never got the same treatment.
- If both attempts fail, the filename is simply **absent from the returned map**. The function
  returns normally. The delivered html then references an image that is not in Dropbox.
- The only hard stop is for a **completely empty** map, and only on the PDF path
  (`server.js:4519` → 502). A partial map logs `warn` and proceeds — on all three call sites.
  `/bridge-callback` logs *"partial compiler-slice upload — some delivered images may be broken"*
  and ships.
- Downstream this is **disclosed but not blocked**: `/approve`'s integrity gate writes
  `!!!-FOLDER-INCOMPLETE-READ-ME.txt` into the folder and logs loudly, by explicit design
  ("ON FAILURE THIS SHIPS, LOUDLY. IT DOES NOT BLOCK").

**This is the standing risk of the raise:** width 12 increases the chance of
`too_many_write_operations`, and the budget against it is one un-paced retry.

### Exercising it without a live order

Partly possible, and I want to be exact about which part.

The scheduler could not be exercised at all before — it closed over a module-level `dbx` inside a
file that opens a socket on import. It is now `dropbox-upload.js` with `uploadOne` injected, the
same extraction `dropbox-prune.js` and `delivery-folder.js` already got. **16 tests, 16 pass**,
driving the real production scheduler at both widths. Counts, 96 images, 3 transient failures and
1 permanent:

| width | succeeded | missing | upload calls | peak in flight |
|---|---|---|---|---|
| 3  | 95 | 1 | 100 | 3 |
| 12 | 95 | 1 | 100 | 12 |

Identical outcomes; only the ceiling differs.

**What this cannot measure: Dropbox's actual response to twelve concurrent writes.** That needs live
credentials, and `.env` here holds only `FIGMA_API_TOKEN`. A fake uploader cannot produce a real
429. Any timing in that file is a labelled *model* comparing two schedulers under identical
synthetic latency (it reports pool@12 at ~4x barrier@3), **not** a prediction of wall-clock time.

**The first live orders must be watched.** The lines to watch are
`Dropbox upload complete: X/Y succeeded` — now carrying `uploadMs`, `concurrency`, `retried`,
`recovered` and `stillMissing` — and any `Upload failed for …, queued for retry`. If `retried`
climbs or `stillMissing` is ever non-zero, set `DROPBOX_UPLOAD_CONCURRENCY` back to 3 and restart.

## What was instrumented, and where

Nothing in this section was optimised. All three are measurement only.

1. **Callback POST transfer** — a middleware pair around `express.json` (`server.js:~4299` and
   `~4329`), plus `"/bridge-callback payload received"` in the route (`~6906`) logging `recvMs`,
   `bytes`, `mb`, `mbPerSec`, `limitBytes`, `assetCount`, `assetBytesBase64`, `htmlBytes`.
   It must be measured there, not in the handler: by the time the handler runs the body is already
   buffered and parsed. **`recvMs` is tunnel transfer *and* JSON parse together** — they are not
   separated, and the comment says so rather than implying a clean split.
2. **Figma render phase** — what the logs already showed was `"Phase B: image export complete"`
   with a `durationMs` covering the **whole** phase (render + download + Dropbox upload + patch +
   preview) in one number, which is why "how long does Figma take" was unanswerable. Added
   `"Phase B: Figma render + PNG download complete"` with `renderMs`, `requested`, `returned`,
   `missing`, `bytes` — and `uploadMs` alongside it, so the phase now splits three ways.
3. **`/approve`** — see the falsified premise below. Added
   `"Approve: route complete (end to end)"` with `totalMs`, `imagesMs`, `shareLinkMs`, `pruneMs`,
   `gateMs`, `unaccountedMs`, `concurrency`, `afterFinishedAt: true`.

## The poll

**Falsified premise: `RUNNER_POLL_MS` is already configurable.** `queue-runner.js:36` reads
`Number(env.RUNNER_POLL_MS) || 10000`. 10000 is the *default*, not a hardcode. **I left the file
byte-identical** — there was nothing to make configurable.

**Lowering it is safe**, on the claim query's own terms. The claim is a conditional update —
`.eq('id').eq('status','pending').is('job_id', null).select()` — so a lost race returns zero rows
and the tick reports `claim lost (raced)`; it cannot double-dispatch at any interval. Two further
guards are independent of the interval: `isTicking` makes an overlapping tick a no-op, and §B
returns early if any row is `processing`. None of that is interval-sensitive, and I changed none of
it.

**The cost is Supabase request volume, not correctness:** an idle tick issues **4 selects**
(processing scan, stale-pending scan, re-read processing, active rows). At 10 s that is 24/min; at
2 s it is 120/min. The heartbeat is on its own 30 s timer and is unaffected.

**But it is worth at most 10 seconds of the 205.** The poll only governs how quickly `os_queue`
flips to `delivered`. It does not touch `/approve`, which is where the ~108-file delivery folder is
built. One foot-gun if you do lower it: `|| 10000` means `RUNNER_POLL_MS=0` silently becomes 10000.

## Falsified premises

1. **"the second upload in /approve … is invisible to every measurement so far"** — false.
   `/approve` already logged `imagesMs`, `shareLinkMs`, `msFromApproveStart`, `housekeepingMs`,
   `pruneMs` and `gateMs`. What was missing is a single line holding the route and its parts
   together, so reading it meant subtracting timestamps across six lines and hoping none were
   interleaved with another order's. The real gap is smaller than assumed — and it sits somewhere
   the brief did not name: the **confirmation email** (an extra share link, a preview.png download,
   an SMTP send) runs after the last timed stage and has never been on a clock. That is now
   `unaccountedMs`, named as unaccounted rather than attributed.
2. **"TWO uploads per order"** — true for a Figma/compiler order, but the shared function has
   **three** call sites; the PDF path is the third.
3. **"RUNNER_POLL_MS defaults to 10000 … make it configurable too"** — it already is.
4. **The `/approve` reuse of `DROPBOX_BATCH_SIZE` is not an upload.** Raising the constant also
   widens `/approve`'s copy/metadata concurrency from 3 to 12. That is a real, intended consequence
   of one setting, but it is a different Dropbox operation mix than `filesUpload`, so it carries its
   own 429 exposure and was not part of the evidence in the brief.

## Verification

- `node --check` clean on both files. Server boots to `"Maveloper backend running on port 39999"`
  with the new middleware registered.
- Suite: **26/28**. Both reds print `SKIP: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`
  (`approve-schema`, `drafts-roundtrip`) — credential-gated, red before this run began.
- New suite: 16/16. One of its own tests failed first and was right to: with a zero-latency fake,
  every upload settled before the next worker was scheduled, so the in-flight peak read 1 at **both**
  widths — the assertion had been measuring the fixture, not the scheduler.
- `queue-runner.js` unmodified. No `started_at`/`finished_at` or FIFO change. The other two
  repositories were not opened.

## WHAT REMAINS UNCERTAIN

- **Whether 12 draws 429s from Dropbox.** Not knowable offline and not simulated. It is the whole
  question, and it is open until the first live orders are watched.
- **Whether the retry budget survives 12.** One un-paced attempt that ignores `Retry-After` was
  sized for a width of 3. If width 12 produces correlated 429s across a burst, all of them get their
  single retry inside the same hot window and can fail together. I did not change the retry policy —
  raising the width and rewriting the failure handling in one run would make the next log
  unreadable — but this is the most likely thing to need a second run.
- **The 205 seconds are still unattributed.** This run instruments three phases; it measures none of
  them. Until an order runs, the split between callback transfer, Figma render, the two uploads and
  `/approve` is still inference — including mine.
- **`unaccountedMs` has no owner yet.** I know it contains the confirmation email; I do not know
  whether that is most of it, and `ORDER_CONFIRMATION_ENABLED` is off by default, in which case the
  block short-circuits and the number should be near zero. If it is not, something else is in there.
- **Whether the upload is even the largest term.** Every duration in the brief was reconstructed by
  subtracting log timestamps. `uploadMs` is now stated by the code that did the work; the first live
  order may disagree with the reconstruction.
- **The Dropbox limits above are from documented behaviour, not from a fetch of the docs in this
  run.** The absence of a published QPS figure for these endpoints is the load-bearing claim, and it
  is worth one minute of confirmation before it is used to justify a further raise.
- **Width 12 was chosen because it was asked for**, not derived. Nothing here says 12 is better than
  8 or 20; the env var exists so that question can be answered by moving it.
