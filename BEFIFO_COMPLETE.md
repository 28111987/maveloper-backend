# BEFIFO_COMPLETE — the backend dispatcher is FIFO

Not committed, not pushed, not deployed. Three code paths are staged and nothing
else in the tree was touched.

---

## 1. What the runner calls, and what it sorted by before

**The call.** `queue-runner.js:23` imports `computeQueuePlan` from
`./queue-priority.js`. There is exactly ONE call site — `queue-runner.js:205`,
inside `tick()`. The pick is section D (`:216-222`): the runner filters its rows
to `status === 'pending' && !job_id`, then takes **the first entry of
`plan.pending`** that survives that filter. So the dispatch order *is* the order
`computeQueuePlan` returns; there is no second sort anywhere in the runner.

**What it sorted by.** Buffered deadline first, upload time only as a tie-break:

- `dlMs(r)` — `effective_deadline` if the column was set, otherwise
  `uploaded_at + bufferedHours(tat_hours) × 3600000`.
- `bufferedHours` — 8→7, 12→10, 24→20, 48→40, 72→62, else `floor(H × 5/6)`.
- `cmpUnlocked` — `manual_rank`, then `dlMs`, then `uploaded_at`.
- `cmpLocked` — the §3b `lockedBarrierKey` (how many other locked rows locked
  before this row was uploaded), then `dlMs`, then `locked_at`.
- `mergeLockedUnlocked` — a locked row must precede any unlocked row that arrived
  after it locked.
- An iterative lock pass, up to `pending.length + 2` passes, locking any row whose
  slack `dlMs(row) - now` had fallen to or below the work queued ahead of it.

**Consequence, measured on a fixture in the test file:** an order queued 30 hours
ago on a 72-hour TAT sat at **position 25** behind twenty-four orders queued in
the last twenty-four minutes on 8-hour TATs. The runner dispatched `OF-n00`. That
is the defect, and it is the mixed-TAT population — every row queued before the
console's cutover — that produces it.

## 2. What else depends on that module: NOTHING

Exhaustive grep over the repo (excluding `node_modules` and `.bak` snapshots):

| Symbol | Consumers outside `queue-priority.js` |
|---|---|
| `queue-priority` (the import path) | `queue-runner.js` only |
| `computeQueuePlan` | `queue-runner.js:205` only |
| `bufferedHours` | none |
| `EST_MS_PER_ORDER`, `EST_MINUTES_PER_ORDER` | none |
| `estReady`, `willMissTat`, `nextFreeSlot`, `backlogMs`, `lockedCount` | **none — the plan's entire ETA surface was computed and thrown away** |

**The confirmation email was checked and does NOT go through this module.**
`server.js:7929` passes `effectiveDeadline: qRow.effective_deadline || qRow.deadline`
into `buildOrderConfirmation`, and `order-confirmation.js:1296` prints it as
`bufferedDeadlineIST`. `qRow` comes from `resolveConfirmationRow`
(`server.js:7278`), which SELECTs those columns **straight from `os_queue`**. It is
a column read. The column is untouched, so the email is byte-identical.

I also confirmed the column keeps being populated: the backend never INSERTs into
`os_queue` (its only writes are `update`), and the console still writes all three
legacy columns on submit via `legacyDeadlineColumns` in `src/lib/osQueue.ts` at a
fixed `LEGACY_TAT_HOURS = 24`. The email cannot go blank as a result of this change.

**No status endpoint or webhook exposes an ordering.** `GET /runner/status`
(`server.js:8186`) returns the flag, the heartbeat and two counts.
`POST /queue/run-next` (`server.js:8199`) returns `{dispatched, reason, jobId}`.
Grep for `queuePosition|queue_position|estReady|est_ready|nextFreeSlot` across
`server.js`: **zero hits**.

**Nothing the owner relies on breaks.** No falsified premise blocked the change.

## 3. The new comparator

Character-for-character the console's `cmpFifo` (`src/lib/queuePriority.ts:92`):

```js
function uploadedMs(r) {
  const t = new Date(r.uploaded_at).getTime();
  return Number.isFinite(t) ? t : Infinity;   // unparseable → the BACK
}

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
```

and `processing` is separated out and emitted first, so no ordering rule —
`manual_rank` included — can move a row the engine has already claimed:

```js
const processing = active.filter((r) => r.status === 'processing').sort(cmpFifo);
const pending    = active.filter((r) => r.status === 'pending').sort(cmpFifo);
const orderedAll = [...processing, ...pending];
```

`?? null` and not `|| null` matters: `manual_rank: 0` is a rank a human set, and a
falsy check would send it to the back instead of the front. There is an assertion
for exactly that.

**No database column was dropped or altered.** `tat_hours`, `deadline`,
`effective_deadline`, `locked` and `locked_at` keep every value they hold and are
still selected verbatim by `queue-runner.js:197`. They simply stop deciding order.

**One change beyond the literal ask, stated plainly.** `EST_MINUTES_PER_ORDER = 20`
(1,200,000 ms) is now `EST_SECONDS_PER_ORDER = 150` (150,000 ms), matching
`src/lib/queueEstimates.ts`. It was the same two-copies-of-one-number divergence in
the same module, and leaving it would have been a fresh lie in a file whose header
now claims parity with the console. It is provably inert: it feeds only `estReady`,
`nextFreeSlot` and `backlogMs`, and the table above shows no caller reads any of
the three. If you would rather it stayed at 20 minutes, it is a one-line revert and
no test moves.

`bufferedHours` is **kept**, exported, and marked legacy — identical to the copy the
console kept in `queueEstimates.ts` for the NOT NULL column fill. Nothing in the
module calls it.

## 4. Fails-first, and the mutant

**The tests were written and run BEFORE either source file was touched**, so this
is a proof against the real shipped engine rather than a reconstruction of it.

| Run | Result |
|---|---|
| final test file vs. the **pre-change** `queue-priority.js` + `queue-runner.js` | **22 passed, 31 failed** |
| final test file vs. the **new** module | **53 passed, 0 failed** |
| final test file vs. the **mutant** | **39 passed, 14 failed** |

Among the 31 that were red before the change:

```
✗ 24 newer orders do NOT move the oldest off position one (got OF-n00)
✗ mixed legacy tat_hours dispatch in submission order (got OF-t8,OF-t12,OF-t24,OF-t48,OF-t72)
✗ the runner dispatches the OLDEST row, not the tightest deadline (got OF-n00)
✗ same-millisecond rows break by id ascending (got OF-ccc,OF-aaa,OF-bbb)
✗ all 6 input permutations give one order (got 6 different orders)
✗ unparseable uploaded_at "not-a-date" sorts LAST (got OF-bad,OF-a,OF-b)
✗ manual_rank 0 is a rank, not an absence
✗ two ranked rows sort by rank ascending, both ahead of unranked (got OF-un,OF-old,OF-new)
✗ long-overdue rows trigger NO lock UPDATE (got 6 lock writes)
```

**THE MUTANT.** A copy of the *shipped* new file with the buffered-deadline sort
key restored and wired back into `cmpFifo` — one added helper, one changed line:

```diff
+// MUTANT: the buffered-deadline sort key, restored exactly as it was.
+function dlMs(r) {
+  if (r.effective_deadline) return new Date(r.effective_deadline).getTime();
+  const uploaded = new Date(r.uploaded_at).getTime();
+  return uploaded + bufferedHours(Number(r.tat_hours)) * 3600000;
+}
+
 function uploadedMs(r) {
@@ cmpFifo
-  const au = uploadedMs(a), bu = uploadedMs(b);
+  const au = dlMs(a), bu = dlMs(b);
```

Run as `FIFO_MODULE=./queue-priority.mutant.js node queue-priority-fifo.test.mjs`
(the test file takes the module under test from that env var). It killed 14
assertions, **the oldest-first ones first**:

```
✗ oldest first even when TATs invert the deadline order (got OF-d,OF-c,OF-b,OF-a)
✗ 24 newer orders do NOT move the oldest off position one (got OF-n00)
✗ the 24 newer orders stay in submission order behind the oldest
✗ reversing the input does not move the oldest off position one
✗ mixed legacy tat_hours dispatch in submission order (got OF-t8,…,OF-t72)
✗ mixed TATs with effective_deadline stored still dispatch in submission order
✗ a stored effective_deadline does not reorder (got OF-b,OF-a)
✗ unparseable uploaded_at … sorts LAST   (×6)
✗ broken row first in input still sorts last
```

The mutant file was **deleted** after the run; only the three staged paths remain.

**One weak test found and strengthened by the mutant.** The plain oldest-first
fixture originally used one TAT for every row, so buffered-deadline order and
upload order coincided and the mutant survived it — a test that could not fail for
the reason it existed. A second assertion on the same four rows with descending
TATs (72/48/24/8, inverting the deadline order) now dies with the mutant. That is
the `oldest first even when TATs invert the deadline order` line above.

**The five properties, each with its own assertions:**

1. **processing holds position one** — the processing row is made the *newest* by
   upload and given the *latest* deadline, so every rule that exists would move it;
   plus a `manual_rank: 1` row that still cannot overtake it; plus proof a
   processing row is absent from `pending` and so is never a dispatch candidate.
2. **manual_rank** — a ranked row that is the newest still sorts first; two ranked
   rows ascending by rank with the newer/lower rank ahead of the older/higher; the
   unranked tail stays FIFO behind them; `manual_rank: 0` is a rank.
3. **uploaded_at oldest first** — shuffled input at uniform TAT, and the same rows
   at inverting TATs; plus a stored `effective_deadline` pointing the opposite way
   that must not reorder anything.
4. **same-millisecond ties by id, total and stable** — three rows sharing a
   timestamp sort by id ascending, and **all six input permutations produce one
   identical output**; re-planning an already-ordered queue is a no-op.
5. **unparseable `uploaded_at` sorts to the BACK** — three malformed values
   (`"not-a-date"`, `""`, `"0000-13-45T99:99:99Z"`), each asserted both last *and*
   never first, from either end of the input array.

**The two populations you named:**

- **24 newer orders do not move the oldest off position one.** Oldest at 72h TAT,
  twenty-four newer at 8h TAT — under a buffered-deadline sort every one of the 24
  has an earlier deadline, so the oldest lands at position 25. Asserted at
  position 1, with the 24 in submission order behind it, and again with the input
  array reversed.
- **Mixed legacy `tat_hours` still dispatch in submission order.** All five TATs
  the old `bufferedHours` table knew (72/48/24/12/8) arranged so buffered-deadline
  order is the exact reverse of submission order. Asserted twice — once with
  `effective_deadline` NULL (the `uploaded_at + bufferedHours` path) and once with
  it stored the legacy way (the column path) — so a mutant cannot survive on
  either branch of the old `dlMs`. Plus a row 200 hours past its legacy deadline
  that still does not jump an older row.

**Beyond the five:** the plan is asserted to carry no `locked`, `lockedAt`,
`lockedCount`, `willMissTat` or `effectiveDeadline` field at all — *gone*, not
"always false", so a consumer still reading `p.locked` gets `undefined` and breaks
loudly instead of silently reading false. The engine is asserted pure (input rows
unmutated) and time-independent (identical order at `now`, `now ± 500 hours` — no
clock can reorder a FIFO queue). `delivered`/`failed` rows are asserted excluded.

**The runner is tested end to end** against a fake Supabase (a thenable query
builder honouring `eq`/`is`/`in`/`not`/`update`/`maybeSingle` and recording every
write). Three ticks: the 25-row fixture dispatches `OF-oldest` and claims it into
`processing` with its `job_id` persisted; a busy queue dispatches nothing; a
`manual_rank` row wins the dispatch.

## 5. What happened to the lock writes (TASK 3)

**Both halves are gone.**

In `queue-priority.js`: `lockedNow`, the `newlyLocking` out-parameter, the
iterative lock pass, `cmpLocked`, `lockedBarrierKey` and `mergeLockedUnlocked` are
deleted. The module is now pure in the strict sense — it computes and returns, and
has no output channel other than its return value.

In `queue-runner.js`, this block is deleted:

```js
-      const newlyLocking = [];
-      const plan = computeQueuePlan(rows, Date.now(), newlyLocking);
-
-      // Persist any NEW locks the plan produced (server is the single writer).
-      for (const p of plan.pending) {
-        const orig = rows.find((r) => r.id === p.row.id);
-        if (p.locked && orig && !orig.locked) {
-          await updateRow(p.row.id, { locked: true, locked_at: p.lockedAt ?? new Date().toISOString() });
-          log('info', 'Runner: persisted new lock', { id: p.row.id, order: p.row.order_id });
-        }
-      }
+      const plan = computeQueuePlan(rows, Date.now());
```

**No other consumer reads `locked` or `locked_at`**, so there was nothing to leave
in place. The full grep is in section 2: outside `queue-priority.js` the only hits
are the runner's select list (kept) and this deleted block. The console deleted its
copy because it fired a database UPDATE from inside a render; this copy fired one
from inside a ten-second poll loop, onto rows nothing has read since.

**The defect was observed live, not argued.** The `long-overdue rows` fixture drove
a real `tick()` through the fake Supabase and recorded **6 `UPDATE os_queue SET
locked, locked_at` writes** before the change and **0** after — plus assertions
that no row's `locked` column was flipped and no row's `locked_at` was stamped.

The columns keep every value they already hold. Rows locked by the old engine still
carry `locked: true`; the test asserts such a row is preserved verbatim and orders
by upload time like any other.

## 6. Test counts

**Before (whole repo, before any edit):**

| File | Result |
|---|---|
| approve-idempotency.test.mjs | 50 passed, 0 failed |
| approve-schema.test.mjs | **SKIP** (exit 2) — needs live `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` |
| asset-refs.test.mjs | 21 passed, 0 failed |
| delivery-folder.test.mjs | 73 passed, 0 failed |
| drafts-persist.test.mjs | ALL ASSERTIONS PASSED |
| drafts-roundtrip.test.mjs | **SKIP** (exit 2) — needs live credentials |
| dropbox-prune.test.mjs | 38 passed, 0 failed |
| folder-integrity.test.mjs | 19 passed, 0 failed |
| image-map-reconcile.test.mjs | 38 passed, 0 failed |
| order-confirmation.test.mjs | 251 passed, 0 failed |
| zip-delivery.test.mjs | 9 passed |
| *queue-priority-fifo.test.mjs* | *did not exist; when written, **22 passed, 31 failed*** |

**After:** every line above identical, plus
**queue-priority-fifo.test.mjs — 53 passed, 0 failed.**

**Every failure, named, and whether it was red before I started:**

- **`approve-schema.test.mjs` — exit 2, SKIP, red before I started.** It refuses to
  run without live service-role credentials and prints
  `SKIP: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run the schema check.`
  The file itself says the owner runs it. Not a failure, not caused by this change,
  and identical before and after.
- **`drafts-roundtrip.test.mjs` — exit 2, SKIP, red before I started.** Same cause,
  same message, identical before and after.
- **No other file failed, before or after.** The only assertions that went from red
  to green are the 31 in `queue-priority-fifo.test.mjs`, which is the point.

`node --check` passes on `queue-priority.js`, `queue-runner.js` and `server.js`.

## 7. Exact paths staged

```
queue-priority.js            (modified)
queue-runner.js              (modified)
queue-priority-fifo.test.mjs (new)
BEFIFO_STATE.md              (new)
BEFIFO_COMPLETE.md           (new)
```

Staged by explicit path, one `git add --` per named file. **`git add -A` / `git add .`
was never run.** `queue-priority.js` and `queue-runner.js` were staged **together**
in a single command, because the runner imports the module and a Railway boot with
one but not the other would crash.

**Not committed. Not pushed. Not deployed.**

`git status --short -- figma-parser.js` is **empty** — untouched and unstaged. So is
`server.js`. Nothing under `C:\maveloper-bridge`, `C:\maveloper-os-current` or
`_autonomous_24H` was written to; the console repo was read only, to copy its
comparator.

## 8. One premise in the brief is false — reported, not obeyed blindly

> "there are roughly 430 lines of uncommitted RTL work in figma-parser.js that must
> not be touched or staged"

**There is no uncommitted work in `figma-parser.js`, or in any tracked file.**
`git diff HEAD --stat` on this repo is **empty**. `git status --short` shows only
untracked `.bak` snapshots and spec `.md` files — no `M` and no staged entry
existed before I started. The RTL work is already **committed**: `git log --
figma-parser.js` gives `d51e637`, `debd559`, `4f0a814`.

This changed nothing about how I worked — I staged only the exact paths I edited
and never used `git add -A` — but the stated reason for that rule does not exist in
the tree as described, and you should know that before relying on it again.

---

## WHAT REMAINS UNCERTAIN

- **Nothing has run against the real database.** Every proof here is against a
  hand-written fake Supabase in `queue-priority-fifo.test.mjs`. The two tests in
  this repo that touch live Postgres (`approve-schema`, `drafts-roundtrip`) were
  SKIP before and after, because I have no service-role credentials. The fake
  honours the filters the runner actually calls; it is not PostgREST. **Nobody has
  watched a real order dispatch through this code.**
- **The two implementations are still two implementations.** The comparator is
  character-for-character identical to `src/lib/queuePriority.ts:92` *today*, and
  nothing enforces that tomorrow. There is no shared module, no generated file and
  no cross-repo test — the two repos deploy separately and neither imports the
  other. A one-line edit to either copy re-opens exactly the divergence this round
  closed, and the only thing that would catch it is a person remembering to read
  both. The comment in each file asking you to change both in the same breath is a
  request, not a guard.
- **The 150-second constant is a change you did not ask for.** I argued in section 3
  that it is inert and why I made it, but "no caller reads `estReady`" is a fact
  about this repo at this commit, not a promise about the next one. If you disagree
  with the reasoning, revert those three lines; no assertion in the suite moves.
- **`effective_deadline` now has exactly one reader left, and it is in a different
  repo's blast radius.** The confirmation email prints it as the buffered deadline.
  It is populated by the console at a fixed `LEGACY_TAT_HOURS = 24`, so it is no
  longer a promise anyone made — it is `uploaded_at + 20h`, printed to a client as
  though it meant something. That is out of scope here and I changed nothing about
  it, but it is now the *only* thing keeping those columns alive and it is stating
  a number nobody computed.
- **Ordering is proven; throughput is not.** These tests assert *which* row goes
  next. Nothing here measures whether FIFO drains the queue faster or slower than
  the deadline sort did under real load, and no fixture exercises two runner
  instances racing for the same row — the atomic-claim guard at `queue-runner.js:E`
  is unchanged and untested by this round.
- **The console must still not deploy before this does**, and this is staged, not
  committed. Until both are live the screen and the engine agree only on my
  machine.
