/**
 * queue-priority.js — the server-side dispatch order for os_queue. FIFO.
 * -----------------------------------------------------------------------------
 * ★★ THIS FILE IS THE AUTHORITY. The /os console at src/lib/queuePriority.ts
 * PREDICTS an order; this module IS the order — queue-runner.js:205 calls
 * computeQueuePlan and dispatches the first row of `plan.pending`. When the two
 * disagree, the screen is the one that is wrong, and a lead reading it is being
 * told something untrue about their own queue.
 *
 * ★ WHAT THIS FILE USED TO BE. A line-for-line port of the buffered-deadline
 * engine: bufferedHours per TAT, `dlMs` (effective_deadline, else uploaded_at +
 * bufferedHours), `cmpUnlocked` sorting by deadline, a fairness LOCK with a §3b
 * `lockedBarrierKey` barrier, `cmpLocked`, `mergeLockedUnlocked`, an iterative
 * lock pass and a `newlyLocking` out-parameter that queue-runner.js:208-214 wrote
 * straight back to the database. Every one of those answered ONE question —
 * *which of these orders is in danger of missing its promise* — and that question
 * had a real answer when a generation took 15-45 minutes.
 *
 * MAVELOPER NOW BUILDS AN ORDER IN ONE TO FIVE MINUTES. The measured per-order
 * figure is 150 SECONDS, a median over the compiler-route records (see
 * EST_SECONDS_PER_ORDER below). A 24-deep queue drains in an hour. Nothing can
 * miss an 8-hour promise, so sorting by nearness to one is machinery for a
 * problem that no longer exists.
 *
 * ★ THE WHOLE SCHEDULING RULE NOW: THE ORDER QUEUED FIRST IS DELIVERED FIRST.
 *
 * ★ AND THE FAIRNESS PROPERTY IS NOT DISCARDED — IT IS STRENGTHENED. The lock
 * existed *because* deadline-first sorting could let a newer short-TAT order jump
 * an older long-TAT one indefinitely; the barrier recovered upload order for a
 * starved row after the fact. Ordering by `uploaded_at` means no row can EVER be
 * overtaken, so the barrier has nothing left to protect. The lock's own guarantee
 * is FIFO's precondition. Nothing worth keeping is lost.
 *
 * ★ NO DATABASE COLUMN WAS DROPPED OR ALTERED. `tat_hours`, `deadline`,
 * `effective_deadline`, `locked` and `locked_at` all keep their history and are
 * still selected by queue-runner.js:197. They simply stop deciding order.
 * `effective_deadline` in particular is still READ outside this repo —
 * server.js:7929 puts it in the client's confirmation email as the buffered
 * deadline — and that read goes straight to the column and never through here.
 *
 * ★ THIS MODULE NO LONGER WRITES ANYTHING. `newlyLocking` is gone from the
 * signature. It existed so a caller could persist `locked`/`locked_at` the moment
 * the engine decided a row had run out of slack. There is no lock, so there is no
 * write. The console deleted its copy of that write because it fired a database
 * UPDATE from inside a render; this one fired it from inside a poll, on rows
 * nothing reads.
 *
 * Pure functions only — an array of rows and a `now` in, a plan out. No Supabase,
 * no clock other than the argument. That is what lets the FIFO invariants be
 * proven against fake rows in queue-priority-fifo.test.mjs rather than argued
 * about.
 */

// ---------------------------------------------------------------------------
// constants (mirrors src/lib/queueEstimates.ts)
// ---------------------------------------------------------------------------

/**
 * ★ 150 SECONDS, MEASURED, NOT 20 MINUTES. This constant used to read
 * `EST_MINUTES_PER_ORDER = 20` here while the console's own copy read 150s — the
 * same two-implementations-of-one-number divergence this rewrite exists to end.
 * The figure is a MEDIAN over the compiler-route records (126 · 133 · 138 · 144 ·
 * 151 · 163 · 172 · 214 → 147.5s, rounded to the nearest 10s).
 *
 * It affects NOTHING that dispatches. It feeds only `estReady`, `nextFreeSlot`
 * and `backlogMs`, and no caller in this repo reads any of the three — grep for
 * them outside this file and there are zero hits. The dispatch order is decided
 * entirely by cmpFifo, which never looks at a duration.
 */
export const EST_SECONDS_PER_ORDER = 150;
export const EST_MS_PER_ORDER = EST_SECONDS_PER_ORDER * 1000; // 150,000
/** Kept for callers that want it in minutes. Fractional — it is 2.5, not 3. */
export const EST_MINUTES_PER_ORDER = EST_SECONDS_PER_ORDER / 60;

/**
 * ★ LEGACY, AND NO LONGER PART OF ANY ORDERING. `deadline` and `tat_hours` are
 * NOT NULL on os_queue and `effective_deadline` is still read by the confirmation
 * email, so the buffered-hours table has to keep existing somewhere; the console
 * kept its copy in queueEstimates.ts for exactly that reason. Character-for-
 * character identical to it. NOTHING in this module calls it — it is exported so
 * a future backfill or column-fill has one definition to use instead of writing
 * a second one.
 */
export function bufferedHours(tatHours) {
  if (!Number.isFinite(tatHours) || tatHours <= 0) return 1;
  switch (tatHours) {
    case 8: return 7;
    case 12: return 10;
    case 24: return 20;
    case 48: return 40;
    case 72: return 62;
    default:
      // Custom: round down to ~83% (H - H/6), min 1.
      return Math.max(1, Math.floor(tatHours * 5 / 6));
  }
}

// ---------------------------------------------------------------------------
// the comparator — and it is the whole algorithm now
// ---------------------------------------------------------------------------

function uploadedMs(r) {
  const t = new Date(r.uploaded_at).getTime();
  // ★ AN UNPARSEABLE TIMESTAMP SORTS LAST, NOT FIRST. `NaN` fails every
  // comparison, so a bad row would otherwise land wherever the sort happened to
  // leave it. Infinity puts it at the back deterministically, which is the safe
  // end: it can delay one broken row, never overtake a good one.
  return Number.isFinite(t) ? t : Infinity;
}

/**
 * ★ THE COMPARATOR. Character-for-character the console's `cmpFifo`
 * (src/lib/queuePriority.ts:92). Two implementations of one algorithm is how the
 * divergence this rewrite fixes happened in the first place — if you change one,
 * change both in the same breath.
 *
 *   1. a row with a manual_rank sorts ahead of every row without one;
 *   2. two ranked rows sort by rank ascending;
 *   3. everything else sorts by submission time, OLDEST FIRST;
 *   4. two rows submitted in the same millisecond sort by id, so the order is
 *      TOTAL and stable — the same rows always produce the same list, which is
 *      what makes "position 3" mean something between two polls.
 *
 * `?? null` and not `|| null`: `manual_rank: 0` is a REAL rank a human set, and
 * a falsy check would send it to the back of the queue instead of the front.
 */
function cmpFifo(a, b) {
  const am = a.manual_rank ?? null;
  const bm = b.manual_rank ?? null;
  if (am != null && bm != null && am !== bm) return am - bm;
  if (am != null && bm == null) return -1;
  if (am == null && bm != null) return 1;
  const au = uploadedMs(a), bu = uploadedMs(b);
  if (au !== bu) return au - bu;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * ★ THE PER-ORDER ESTIMATE IS AN INPUT, NOT A FACT ABOUT THIS ALGORITHM.
 * `estMs` defaults to the shipped constant, so every production caller behaves
 * exactly as it did. It is the third parameter where `newlyLocking` used to sit,
 * and that is deliberate: a caller that was not updated and still passes an array
 * there gets `[] * 150000 = NaN` in the ETA fields rather than a silently wrong
 * ORDER. There is exactly one caller (queue-runner.js:205) and it was updated.
 */
export function computeQueuePlan(rows, now, estMs = EST_MS_PER_ORDER) {
  const active = rows.filter((r) => r.status === 'pending' || r.status === 'processing');

  /**
   * ★ PROCESSING FIRST, AND NOT AS A SPECIAL CASE OF THE SORT. A row the engine
   * has already claimed is not "next" — it is HAPPENING — and no ordering rule
   * may move it, manual_rank included. Only after it does the FIFO comparator
   * apply.
   *
   * Two processing rows should never exist (queue-runner.js section B refuses to
   * dispatch while any row is processing), but if they do they are ordered by the
   * same comparator rather than by whatever order PostgREST returned.
   */
  const processing = active.filter((r) => r.status === 'processing').sort(cmpFifo);
  const pending = active.filter((r) => r.status === 'pending').sort(cmpFifo);
  const orderedAll = [...processing, ...pending];

  const planned = orderedAll.map((row, idx) => {
    const position = idx + 1;
    const workAheadMs = (position - 1) * estMs;
    return {
      row,
      position,
      workAheadMs,
      estReady: new Date(now + workAheadMs + estMs),
    };
  });

  const proc = planned.filter((p) => p.row.status === 'processing');
  const pend = planned.filter((p) => p.row.status === 'pending');
  const backlogMs = (proc.length + pend.length) * estMs;

  return {
    ordered: planned,
    processing: proc,
    pending: pend,
    nextFreeSlot: new Date(now + backlogMs),
    backlogMs,
  };
}
