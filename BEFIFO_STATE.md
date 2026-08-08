# BEFIFO_STATE

## ATTEMPT-1

### TASK 1 — READ AND REPORT (done)

**What the runner calls to pick the next row.**
`queue-runner.js:23` imports `computeQueuePlan` from `./queue-priority.js`. It is called
ONCE, at `queue-runner.js:205`, inside `tick()` section C. The pick is section D
(`queue-runner.js:216-222`): it filters `rows` to `status === 'pending' && !job_id`
(`dispatchable`), then takes the FIRST entry of `plan.pending` that appears in that set
(`plan.pending.find(...)`). So **the dispatch order IS the order of `plan.pending`**,
which is the order `computeQueuePlan` returns.

**What it sorts by today.**
`computeQueuePlan` splits active rows into `processing` and `pending`, then:
- `processing` is emitted first, in fetch order (NOT sorted).
- `pending` is split into locked / unlocked, sorted separately, then merged:
  - `cmpUnlocked` (`:52`) — `manual_rank` first, then `dlMs`, then `uploaded_at`.
  - `dlMs` (`:39`) — `effective_deadline` if present, else
    `uploaded_at + bufferedHours(tat_hours) * 3600000`.
  - `bufferedHours` (`:21`) — 8→7, 12→10, 24→20, 48→40, 72→62, else `floor(H*5/6)`.
  - `cmpLocked` (`:78`) — §3b `lockedBarrierKey` (count of other locked rows whose
    `locked_at` < this row's `uploaded_at`), then `dlMs`, then `locked_at`.
  - `mergeLockedUnlocked` (`:90`) — a locked row must precede any unlocked row that
    arrived after it locked.
- An iterative lock pass (`:126-152`) sets `locked` on any row whose slack
  (`dlMs(row) - now`) is <= the work ahead of it, up to `pending.length + 2` passes.

So today: **buffered deadline first, upload time only as a tie-break.**

**Anything OTHER than dispatch that depends on this module: NOTHING.**
Exhaustive grep across the repo (`--exclude-dir=node_modules`, excluding `.bak`):
- `queue-priority` appears in exactly two files — itself and `queue-runner.js`.
- `computeQueuePlan` has exactly ONE call site: `queue-runner.js:205`.
- `bufferedHours`, `EST_MS_PER_ORDER`, `EST_MINUTES_PER_ORDER` have NO consumer
  outside `queue-priority.js` itself.
- The plan's ETA fields — `estReady`, `willMissTat`, `nextFreeSlot`, `backlogMs`,
  `lockedCount` — are **never read by any caller**. `grep` for each returns hits only
  inside `queue-priority.js`. The runner reads only `plan.pending`, `p.row.id`,
  `p.locked`, `p.lockedAt`.

**The confirmation email — CHECKED, and it does NOT depend on this module.**
`server.js:7929` passes `effectiveDeadline: qRow.effective_deadline || qRow.deadline`
into `buildOrderConfirmation`. `qRow` comes from `resolveConfirmationRow`
(`server.js:7278`), which SELECTs those columns **straight from `os_queue`**.
`order-confirmation.js:1296` formats it as `bufferedDeadlineIST` for a field in the
email. That is a **column read**, not a call into `queue-priority.js`. The task
forbids dropping the column and I am not dropping it, so the email is untouched.

**Status endpoints / webhooks — CHECKED.** `GET /runner/status` (`server.js:8186`)
returns `{runnerEnabled, runnerLastSeen, engineOnline, engineLastOk, engineError,
processing, pending}` — counts only, no ordering, no ETA. `POST /queue/run-next`
(`server.js:8199`) returns `tick()`'s `{dispatched, reason, jobId}`. No endpoint
exposes queue position or ETA: `grep` for `queuePosition|queue_position|estReady|
est_ready|nextFreeSlot` in `server.js` returns **zero hits**.

**PREMISE CHECK: no falsified premise blocking the change.** Every premise about
queue-priority.js and queue-runner.js in the brief is CONFIRMED (line-for-line port,
authoritative, the runner's select list, the live lock writes at `:122`/`:146` feeding
`queue-runner.js:208-214`).

**ONE PREMISE IS FALSE, and it is the git one — reported, not obeyed blindly.**
"roughly 430 lines of uncommitted RTL work in figma-parser.js" — **there is no
uncommitted work in figma-parser.js.** `git diff HEAD --stat` is EMPTY; the working
tree has NO modified or staged tracked file at all. `git status --short` shows only
untracked `.bak` snapshots and spec `.md` files. The RTL work is already COMMITTED
(`git log -- figma-parser.js`: d51e637, debd559, 4f0a814). This does not change my
behaviour — I will still stage only the exact paths I edit, never `git add -A` — but
the stated reason for the rule does not exist in the tree as described.

### TASK 4 (done FIRST, deliberately) — fails-first

`queue-priority-fifo.test.mjs` was written and run BEFORE either source file was
touched, so the fails-first proof is against the REAL shipped engine, not a
reconstruction. **22 passed, 31 failed.** The lock assertions needed a second
fixture: the first one's rows had slack, so the old engine never locked and those
assertions were green for the wrong reason. The ~500-hour-old fixture makes the
old engine lock every candidate — **6 lock UPDATEs observed on the wire**.

### TASK 2 — the change: DONE
`queue-priority.js` rewritten to the console's `cmpFifo`, character-for-character.
No column dropped or altered; the runner's select list is unchanged.

### TASK 3 — lock writes: DONE
`lockedNow` / `newlyLocking` deleted from the module; the
`UPDATE os_queue SET locked, locked_at` block deleted from `queue-runner.js`.
No other consumer reads either column (grep is in TASK 1 above).

### RESULT
- `queue-priority-fifo.test.mjs`: 22/31 → **53 passed, 0 failed**
- mutant (deadline sort restored): **39 passed, 14 failed**
- full suite: 9 files green, 2 credential-gated SKIPs — identical to baseline
- staged: `queue-priority.js`, `queue-runner.js`, `queue-priority-fifo.test.mjs`
- `figma-parser.js`: untouched, unstaged, `git status --short -- figma-parser.js` empty

ATTEMPT-1 completed. No BLOCKED state reached.
