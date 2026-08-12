# UPLOAD_SPEED_STATE

Repo: `C:\Users\shrujal_mavlers\Desktop\maveloper-backend` only. No compiler, no tag, no freeze.

## TASK ONE — why is it 3 (DONE, reading)

Every place the concurrency is set:

| file:line | constant | consumer |
|---|---|---|
| `server.js:187` | `const DROPBOX_BATCH_SIZE = 3;` | the single definition |
| `server.js:504` | log line `batch size ${DROPBOX_BATCH_SIZE}` | the log the owner has been reading |
| `server.js:506-507` | `for (i += DROPBOX_BATCH_SIZE)` / `slice` | generation image upload loop |
| `server.js:7467` | `mapWithConcurrency(urlList, DROPBOX_BATCH_SIZE, …)` | **/approve** delivery-folder materialisation (copy/download), a DIFFERENT code path reusing the SAME constant |

Related but separate, NOT changed by this run:
- `server.js:199` `IMAGE_DOWNLOAD_CONCURRENCY = 5` (CDN downloads)
- `figma-image-export.js:23` `FIGMA_BATCH_SIZE = 50`, `:25` `PNG_DOWNLOAD_CONCURRENCY = 5`

### The recorded reason — FOUND

Commit `4cc586e` "fix: reduce Dropbox batch size + retry failed uploads (v1.3.6)", 14 Apr 2026.
It did two things in one diff:
- `const BATCH_SIZE = 5;` → `3`
- added the `failedImages` queue + one serial retry

and rewrote the doc comment:
- before: `Uploads in parallel batches of 5 for speed without hitting rate limits.`
- after:  `Uploads in parallel batches of 3 with retry logic for rate-limited requests.`

Introduced at 5 in `7512cf6` "perf: parallel uploads + timeout increase (v1.3.1)".

So the reason is **rate limits, asserted in a comment, with no measurement, no error text, no incident
note and no 429 in the commit body.** It is a recorded *belief*, not a recorded *incident*. Reported,
not silently overridden — the raise is env-gated and reverting is `DROPBOX_UPLOAD_CONCURRENCY=3`.

## TASK TWO — env var (in progress)
`DROPBOX_UPLOAD_CONCURRENCY`, default **12**, clamped 1..32.

Do the two uploads share the path? **Yes** — and there are THREE call sites, not two:
- `server.js:4497` PDF/`/generate` path
- `server.js:5994` Figma Phase B, before Stage 2
- `server.js:6927` `/bridge-callback`, compiler slice images, after the callback
all call the same `uploadImagesToDropbox()`. `/approve` (`:7467`) is a fourth consumer of the
constant but through `mapWithConcurrency` — same width, different code.

## TASK THREE — failure path (analysed)
- retry site: `server.js:531-546`. **One** extra attempt, serial, after a fixed 2000 ms, 500 ms between files.
- `uploadToDropbox` (`:445`) has **no** 429 handling and the Dropbox SDK does not auto-retry.
- if all attempts fail the filename is simply absent from `imageUrlMap` → **an order CAN deliver with a
  missing image.** Hard-fail exists only for the *empty* map (`:4519`), and only on the PDF path.

## TASK TWO — DONE
`dropbox-upload.js` (new) holds the scheduler; `server.js` wraps it. Batch barrier → worker pool.
Key insertion order pinned to INPUT order so the Stage 2 prompt is byte-identical.

## TASK THREE — DONE
`dropbox-upload.test.mjs`, 16 tests, 16 pass. Counts at both widths, from the real scheduler:
`[{width:3, ok:95, missing:1, calls:100, peak:3}, {width:12, ok:95, missing:1, calls:100, peak:12}]`
Identical outcomes; only the in-flight ceiling differs. Dropbox's own 429 behaviour is NOT
measurable here — no credentials, and a fake uploader cannot produce a real rate limit.

## TASK FOUR — DONE (instrument only, nothing optimised)
1. callback POST size+duration — middleware pair around `express.json` + a log line in the route
2. Figma render phase — `renderMs` split out of Phase B's all-in-one `durationMs`; `uploadMs` too
3. /approve — **PREMISE PARTLY FALSE**: it was already timed in six places. Added the end-to-end
   line with `unaccountedMs`, which is the genuinely unmeasured stretch (confirmation email).

## TASK FIVE — poll: NOTHING TO DO
`queue-runner.js:36` `pollMs: Number(env.RUNNER_POLL_MS) || 10000` — **already** env-configurable.
File left byte-identical. See COMPLETE for the safety argument and the cost.

## VERIFICATION
- `node --check` clean on both files; server boots to "running on port 39999" with the new middleware.
- suite: 26/28. The 2 reds (`approve-schema`, `drafts-roundtrip`) print
  "SKIP: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY" — credential-gated, red before I started.
- `queue-runner.js` unmodified; no `started_at`/`finished_at`/FIFO change anywhere.
