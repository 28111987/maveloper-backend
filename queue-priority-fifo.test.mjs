// queue-priority-fifo.test.mjs — the FIFO dispatch order, proven.
// ---------------------------------------------------------------------------
// Run: node queue-priority-fifo.test.mjs          (exit 0 = all pass)
// Mutant run: FIFO_MODULE=./queue-priority.mutant.js node queue-priority-fifo.test.mjs
//
// WHY THIS FILE EXISTS. queue-priority.js is what ACTUALLY dispatches — the /os
// console only predicts. The console was rewritten to FIFO; until this module
// matches it character-for-character, the screen states an order the engine does
// not honour. These assertions are the contract between the two, written so that
// restoring ANY deadline-derived sort key turns them red.
//
// THE RULE, and nothing else is the rule:
//   1. a row with status `processing` holds position one and no ordering rule
//      may move it;
//   2. `manual_rank` when set sorts ahead of every row without one; two ranked
//      rows sort by rank ascending;
//   3. otherwise `uploaded_at`, OLDEST FIRST;
//   4. ties in the same millisecond break by `id`, so the order is TOTAL and
//      stable;
//   5. an unparseable `uploaded_at` sorts to the BACK and never the front.
//
// The last two population tests are not extra credit. Rows queued BEFORE the
// console's cutover carry mixed `tat_hours` (8/12/24/48/72), and mixed TATs are
// the exact population a buffered-deadline sort reorders away from submission
// order. They are the rows that would dispatch wrong.

import { createQueueRunner } from "./queue-runner.js";

const MODULE = process.env.FIFO_MODULE || "./queue-priority.js";
const { computeQueuePlan } = await import(MODULE);

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, msg) => {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.error("  ✗ FAIL:", msg); }
};

const H = 3600_000;
const T0 = Date.parse("2026-08-08T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

/**
 * A row shaped like the runner's own select list (queue-runner.js:197), so the
 * legacy deadline columns are PRESENT and a restored deadline sort has real data
 * to sort by. A mutant that finds these columns missing would pass by accident.
 */
function row(o) {
  return {
    id: o.id,
    order_id: o.order_id ?? `OF-${o.id}`,
    uploaded_at: o.uploaded_at,
    status: o.status ?? "pending",
    tat_hours: o.tat_hours ?? 24,
    manual_rank: o.manual_rank ?? null,
    effective_deadline: o.effective_deadline ?? null,
    locked: o.locked ?? false,
    locked_at: o.locked_at ?? null,
    job_id: o.job_id ?? null,
    figma_url: `https://figma.com/file/${o.id}`,
    esp: "none",
    dark_mode: false,
    lead_user_id: "lead-1",
  };
}

/** order_ids of the full plan, position 1 first. */
const orderOf = (rows, now = T0) =>
  computeQueuePlan(rows, now).ordered.map((p) => p.row.order_id);
/** order_ids of the pending queue only — this is what the runner dispatches from. */
const pendingOf = (rows, now = T0) =>
  computeQueuePlan(rows, now).pending.map((p) => p.row.order_id);

console.log("queue-priority-fifo.test.mjs — module under test:", MODULE);

// ── PROPERTY 1 — processing holds position one ────────────────────────
{
  // The processing row is the NEWEST by upload and has the LATEST deadline, so
  // every ordering rule that exists would move it if it were allowed to.
  const rows = [
    row({ id: "p", uploaded_at: iso(T0 - 1 * 60_000), status: "processing", tat_hours: 72 }),
    row({ id: "a", uploaded_at: iso(T0 - 5 * H), tat_hours: 8 }),
    row({ id: "b", uploaded_at: iso(T0 - 4 * H), tat_hours: 8 }),
  ];
  const got = orderOf(rows);
  ok(got[0] === "OF-p", `processing holds position one (got ${got[0]})`);
  ok(got.join(",") === "OF-p,OF-a,OF-b", `processing first, then FIFO (got ${got.join(",")})`);
}
{
  // A manual_rank is the strongest ordering rule there is, and it still may not
  // move a row the engine has already claimed.
  const rows = [
    row({ id: "p", uploaded_at: iso(T0 - 60_000), status: "processing" }),
    row({ id: "r", uploaded_at: iso(T0 - 9 * H), manual_rank: 1 }),
  ];
  const got = orderOf(rows);
  ok(got[0] === "OF-p", `manual_rank 1 does NOT overtake processing (got ${got[0]})`);
}
{
  // A processing row is not in `pending`, so it is never a dispatch candidate.
  const rows = [
    row({ id: "p", uploaded_at: iso(T0 - 60_000), status: "processing" }),
    row({ id: "a", uploaded_at: iso(T0 - 3 * H) }),
  ];
  ok(pendingOf(rows).join(",") === "OF-a", "processing row is absent from pending");
}

// ── PROPERTY 2 — manual_rank ──────────────────────────────────────────
{
  // The ranked row is the NEWEST. Rank must still win.
  const rows = [
    row({ id: "a", uploaded_at: iso(T0 - 9 * H) }),
    row({ id: "b", uploaded_at: iso(T0 - 8 * H) }),
    row({ id: "z", uploaded_at: iso(T0 - 1 * H), manual_rank: 5 }),
  ];
  const got = pendingOf(rows);
  ok(got[0] === "OF-z", `a ranked row sorts ahead of every unranked row (got ${got[0]})`);
  ok(got.join(",") === "OF-z,OF-a,OF-b", `unranked tail stays FIFO (got ${got.join(",")})`);
}
{
  // Two ranked rows: ascending by rank, and rank beats upload order between them.
  const rows = [
    row({ id: "old", uploaded_at: iso(T0 - 20 * H), manual_rank: 9 }),
    row({ id: "new", uploaded_at: iso(T0 - 1 * H), manual_rank: 2 }),
    row({ id: "un", uploaded_at: iso(T0 - 30 * H) }),
  ];
  const got = pendingOf(rows);
  ok(got.join(",") === "OF-new,OF-old,OF-un",
    `two ranked rows sort by rank ascending, both ahead of unranked (got ${got.join(",")})`);
}
{
  // rank 0 is a REAL rank, not a falsy absence. `?? null` is the only guard that
  // gets this right; a `|| null` would drop it to the back of the queue.
  const rows = [
    row({ id: "zero", uploaded_at: iso(T0 - 1 * H), manual_rank: 0 }),
    row({ id: "old", uploaded_at: iso(T0 - 40 * H) }),
  ];
  ok(pendingOf(rows)[0] === "OF-zero", "manual_rank 0 is a rank, not an absence");
}

// ── PROPERTY 3 — uploaded_at, oldest first ────────────────────────────
{
  // Deliberately shuffled input, uniform TAT: only upload order can produce this.
  const rows = [
    row({ id: "c", uploaded_at: iso(T0 - 2 * H) }),
    row({ id: "a", uploaded_at: iso(T0 - 6 * H) }),
    row({ id: "d", uploaded_at: iso(T0 - 1 * H) }),
    row({ id: "b", uploaded_at: iso(T0 - 4 * H) }),
  ];
  ok(pendingOf(rows).join(",") === "OF-a,OF-b,OF-c,OF-d",
    `oldest uploaded_at dispatches first (got ${pendingOf(rows).join(",")})`);

  // ★ THE SAME FOUR ROWS WITH TATs THAT INVERT THE DEADLINE ORDER. The fixture
  // above uses one TAT for every row, so buffered-deadline order and upload order
  // COINCIDE and a restored deadline sort would survive it — a test that cannot
  // fail for the reason it exists. These carry descending TATs, so the two orders
  // are exact opposites and only upload order gives this answer.
  const tats = { a: 72, b: 48, c: 24, d: 8 };
  const mixed = rows.map((r) => ({ ...r, tat_hours: tats[r.id] }));
  ok(pendingOf(mixed).join(",") === "OF-a,OF-b,OF-c,OF-d",
    `oldest first even when TATs invert the deadline order (got ${pendingOf(mixed).join(",")})`);
}
{
  // effective_deadline is PRESENT and points the OPPOSITE way to upload order.
  // The column keeps its history; it must not decide anything.
  const rows = [
    row({ id: "a", uploaded_at: iso(T0 - 6 * H), effective_deadline: iso(T0 + 90 * H) }),
    row({ id: "b", uploaded_at: iso(T0 - 2 * H), effective_deadline: iso(T0 + 1 * H) }),
  ];
  ok(pendingOf(rows).join(",") === "OF-a,OF-b",
    `a stored effective_deadline does not reorder (got ${pendingOf(rows).join(",")})`);
}

// ── PROPERTY 4 — same-millisecond ties break by id, total and stable ──
{
  const same = iso(T0 - 3 * H);
  const rows = [
    row({ id: "ccc", uploaded_at: same }),
    row({ id: "aaa", uploaded_at: same }),
    row({ id: "bbb", uploaded_at: same }),
  ];
  ok(pendingOf(rows).join(",") === "OF-aaa,OF-bbb,OF-ccc",
    `same-millisecond rows break by id ascending (got ${pendingOf(rows).join(",")})`);

  // TOTAL and STABLE: every input permutation must yield the SAME output.
  const perms = [
    [rows[0], rows[1], rows[2]], [rows[0], rows[2], rows[1]],
    [rows[1], rows[0], rows[2]], [rows[1], rows[2], rows[0]],
    [rows[2], rows[0], rows[1]], [rows[2], rows[1], rows[0]],
  ];
  const outs = new Set(perms.map((p) => pendingOf(p).join(",")));
  ok(outs.size === 1, `all 6 input permutations give one order (got ${outs.size}: ${[...outs].join(" | ")})`);

  // And the plan is idempotent: planning the plan changes nothing.
  const once = pendingOf(rows);
  const twice = pendingOf(computeQueuePlan(rows, T0).pending.map((p) => p.row));
  ok(once.join(",") === twice.join(","), "re-planning an already-ordered queue is a no-op");
}

// ── PROPERTY 5 — an unparseable uploaded_at sorts to the BACK ─────────
{
  for (const bad of ["not-a-date", "", "0000-13-45T99:99:99Z"]) {
    const rows = [
      row({ id: "bad", uploaded_at: bad }),
      row({ id: "a", uploaded_at: iso(T0 - 2 * H) }),
      row({ id: "b", uploaded_at: iso(T0 - 1 * H) }),
    ];
    const got = pendingOf(rows);
    ok(got[got.length - 1] === "OF-bad", `unparseable uploaded_at ${JSON.stringify(bad)} sorts LAST (got ${got.join(",")})`);
    ok(got[0] !== "OF-bad", `unparseable uploaded_at ${JSON.stringify(bad)} never sorts FIRST`);
  }
}
{
  // A broken row may delay itself; it may never overtake a good row, whichever
  // end of the input array it arrives on.
  const bad = row({ id: "bad", uploaded_at: "garbage" });
  const good = row({ id: "a", uploaded_at: iso(T0 - 1 * H) });
  ok(pendingOf([bad, good]).join(",") === "OF-a,OF-bad", "broken row first in input still sorts last");
  ok(pendingOf([good, bad]).join(",") === "OF-a,OF-bad", "broken row last in input still sorts last");
}

// ── POPULATION A — 24 newer orders do not move the oldest off one ─────
{
  // The oldest carries the LONGEST legacy TAT (72h → buffered 62h) and the 24
  // newer ones the SHORTEST (8h → buffered 7h). Under a buffered-deadline sort
  // every one of the 24 has an earlier deadline than the oldest, so the oldest
  // lands at position 25. Under FIFO it cannot move.
  const rows = [row({ id: "oldest", uploaded_at: iso(T0 - 30 * H), tat_hours: 72 })];
  for (let i = 0; i < 24; i++) {
    rows.push(row({ id: `n${String(i).padStart(2, "0")}`, uploaded_at: iso(T0 - (24 - i) * 60_000), tat_hours: 8 }));
  }
  const got = pendingOf(rows);
  ok(got.length === 25, `all 25 rows planned (got ${got.length})`);
  ok(got[0] === "OF-oldest", `24 newer orders do NOT move the oldest off position one (got ${got[0]})`);

  // and the 24 newer ones stay in submission order behind it
  const tail = got.slice(1);
  const expectedTail = Array.from({ length: 24 }, (_, i) => `OF-n${String(i).padStart(2, "0")}`);
  ok(tail.join(",") === expectedTail.join(","), "the 24 newer orders stay in submission order behind the oldest");

  // Shuffling the input must not change the answer.
  const shuffled = [...rows].reverse();
  ok(pendingOf(shuffled)[0] === "OF-oldest", "reversing the input does not move the oldest off position one");
}

// ── POPULATION B — mixed legacy tat_hours still dispatch in submission order ──
{
  // Every TAT the old bufferedHours table knew, deliberately arranged so that
  // buffered-deadline order is the EXACT REVERSE of submission order.
  const tats = [72, 48, 24, 12, 8];
  const rows = tats.map((t, i) =>
    row({ id: `t${t}`, uploaded_at: iso(T0 - (10 - i) * H), tat_hours: t }));
  const got = pendingOf(rows);
  ok(got.join(",") === "OF-t72,OF-t48,OF-t24,OF-t12,OF-t8",
    `mixed legacy tat_hours dispatch in submission order (got ${got.join(",")})`);

  // Same rows, with the stored effective_deadline column populated the legacy way
  // (uploaded_at + bufferedHours(tat)) rather than left null — both code paths
  // of the old dlMs helper, so a mutant cannot survive on either one.
  const buffered = { 8: 7, 12: 10, 24: 20, 48: 40, 72: 62 };
  const withDl = rows.map((r) => ({
    ...r,
    effective_deadline: iso(Date.parse(r.uploaded_at) + buffered[r.tat_hours] * H),
  }));
  ok(pendingOf(withDl).join(",") === "OF-t72,OF-t48,OF-t24,OF-t12,OF-t8",
    `mixed TATs with effective_deadline stored still dispatch in submission order (got ${pendingOf(withDl).join(",")})`);

  // A mixed-TAT row that is LONG past its legacy deadline is still not special.
  const late = [
    row({ id: "late", uploaded_at: iso(T0 - 200 * H), tat_hours: 8 }),
    row({ id: "older", uploaded_at: iso(T0 - 300 * H), tat_hours: 72 }),
  ];
  ok(pendingOf(late).join(",") === "OF-older,OF-late",
    "a row 200h past its legacy deadline does not jump an older row");
}

// ── THE PLAN CARRIES NO LOCK STATE ────────────────────────────────────
{
  // The lock is gone. Not "always false" — gone. A consumer that still reads
  // `p.locked` must get `undefined` and be fixed, not silently read false.
  const rows = [
    row({ id: "a", uploaded_at: iso(T0 - 300 * H), tat_hours: 8, locked: true, locked_at: iso(T0 - 250 * H) }),
    row({ id: "b", uploaded_at: iso(T0 - 200 * H), tat_hours: 8 }),
  ];
  const plan = computeQueuePlan(rows, T0);
  ok(!("locked" in plan.pending[0]), "PlannedRow has no `locked` field");
  ok(!("lockedAt" in plan.pending[0]), "PlannedRow has no `lockedAt` field");
  ok(!("lockedCount" in plan), "the plan has no `lockedCount`");
  ok(!("willMissTat" in plan.pending[0]), "PlannedRow has no `willMissTat` flag");
  ok(!("effectiveDeadline" in plan.pending[0]), "PlannedRow has no `effectiveDeadline`");

  // A pre-existing locked row keeps its columns untouched and gets no special
  // treatment — it is just an old row, and it is oldest, so it is first.
  ok(plan.pending[0].row.locked === true, "the row's own locked column is preserved verbatim");
  ok(pendingOf(rows).join(",") === "OF-a,OF-b", "a legacy locked row orders by upload like any other");
}

// ── THE ENGINE IS PURE AND TIME-INDEPENDENT ───────────────────────────
{
  const rows = [
    row({ id: "a", uploaded_at: iso(T0 - 5 * H), tat_hours: 8 }),
    row({ id: "b", uploaded_at: iso(T0 - 4 * H), tat_hours: 72 }),
    row({ id: "c", uploaded_at: iso(T0 - 3 * H), tat_hours: 24 }),
  ];
  const before = JSON.stringify(rows);
  const at = (now) => pendingOf(rows, now).join(",");
  ok(at(T0) === at(T0 + 500 * H) && at(T0) === at(T0 - 500 * H),
    "the order does not depend on `now` — no clock can reorder a FIFO queue");
  ok(JSON.stringify(rows) === before, "computeQueuePlan does not mutate its input rows");
}

// ── delivered/failed rows are not in the queue ────────────────────────
{
  const rows = [
    row({ id: "d", uploaded_at: iso(T0 - 99 * H), status: "delivered" }),
    row({ id: "f", uploaded_at: iso(T0 - 98 * H), status: "failed" }),
    row({ id: "a", uploaded_at: iso(T0 - 2 * H) }),
  ];
  ok(orderOf(rows).join(",") === "OF-a", "delivered and failed rows are excluded from the plan");
}

// =====================================================================
// THE RUNNER, END TO END, AGAINST A FAKE SUPABASE.
// The pure assertions above prove the comparator. These prove the thing that
// actually dispatches uses it, and that the lock UPDATE is gone from the wire.
// =====================================================================

function makeSupabaseFake(tables) {
  const updates = [];   // every write that reached the "database"
  const match = (r, filters) => filters.every(([op, col, val]) => {
    if (op === "eq") return r[col] === val;
    if (op === "is") return r[col] === null || r[col] === undefined;
    if (op === "in") return val.includes(r[col]);
    if (op === "notis") return r[col] !== null && r[col] !== undefined;
    return true;
  });

  function from(table) {
    const q = { table, op: "select", patch: null, filters: [] };
    const run = (single) => {
      const rows = tables[table] || [];
      const hit = rows.filter((r) => match(r, q.filters));
      if (q.op === "update") {
        updates.push({ table, patch: { ...q.patch }, filters: q.filters, matched: hit.length });
        for (const r of hit) Object.assign(r, q.patch);
      }
      const data = hit.map((r) => ({ ...r }));
      return single ? { data: data[0] ?? null, error: null } : { data, error: null };
    };
    const api = {
      select() { return api; },
      update(patch) { q.op = "update"; q.patch = patch; return api; },
      upsert() { return Promise.resolve({ error: null }); },
      eq(c, v) { q.filters.push(["eq", c, v]); return api; },
      is(c) { q.filters.push(["is", c, null]); return api; },
      in(c, v) { q.filters.push(["in", c, v]); return api; },
      not(c) { q.filters.push(["notis", c, null]); return api; },
      order() { return api; },
      limit() { return api; },
      maybeSingle() { return Promise.resolve(run(true)); },
      then(res, rej) { return Promise.resolve(run(false)).then(res, rej); },
    };
    return api;
  }
  return { supabaseAdmin: { from }, updates };
}

{
  // 25 rows: the oldest with the longest legacy TAT, 24 newer with the shortest.
  // A buffered-deadline engine dispatches OF-n00; FIFO dispatches OF-oldest.
  const rows = [row({ id: "oldest", uploaded_at: iso(T0 - 30 * H), tat_hours: 72 })];
  for (let i = 0; i < 24; i++) {
    rows.push(row({ id: `n${String(i).padStart(2, "0")}`, uploaded_at: iso(T0 - (24 - i) * 60_000), tat_hours: 8 }));
  }
  const { supabaseAdmin, updates } = makeSupabaseFake({ os_queue: rows, maveloper_jobs: [] });

  let dispatchedBody = null;
  const runner = createQueueRunner({
    supabaseAdmin,
    startFigmaJobAsync: async ({ body }) => { dispatchedBody = body; return { jobId: "job-1" }; },
    log: () => {},
    env: { RUNNER_ENABLED: "true" },
  });

  const result = await runner.tick();
  ok(result.dispatched === "OF-oldest",
    `the runner dispatches the OLDEST row, not the tightest deadline (got ${result.dispatched})`);
  ok(dispatchedBody && dispatchedBody.orderId === "OF-oldest", "the dispatched job body carries the oldest order");

  // TASK 3 — the lock writes. Not one UPDATE may carry lock state.
  const lockWrites = updates.filter((u) => "locked" in u.patch || "locked_at" in u.patch);
  ok(lockWrites.length === 0,
    `no UPDATE writes lock state (got ${lockWrites.length}: ${JSON.stringify(lockWrites.map((u) => u.patch))})`);
  ok(rows.every((r) => r.locked === false), "no row's `locked` column was flipped by a tick");
  ok(rows.every((r) => r.locked_at === null), "no row's `locked_at` column was stamped by a tick");

  // The claim itself still happened, exactly as before.
  const claimed = rows.find((r) => r.order_id === "OF-oldest");
  ok(claimed.status === "processing", "the dispatched row was claimed into processing");
  ok(claimed.job_id === "job-1", "the job_id was persisted onto the claimed row");
  ok(rows.filter((r) => r.status === "processing").length === 1, "exactly one row is processing after a tick");
}

{
  // ── TASK 3, THE FIXTURE THAT ACTUALLY LOCKS ────────────────────────
  // The fixture above did not lock under the old engine (its rows had slack), so
  // its lock assertions were green before the change and prove nothing. THESE
  // rows are ~500 hours old with the SHORTEST legacy TAT, so every buffered
  // deadline is weeks in the past and `timeLeftMs <= workAheadMs` holds for every
  // candidate on the first pass. The old engine locks them and queue-runner.js
  // persists `{locked:true, locked_at}` for each — a database UPDATE on rows
  // nothing reads. This assertion is RED before the change and is the proof.
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(row({ id: `stale${i}`, uploaded_at: iso(T0 - (500 - i) * H), tat_hours: 8 }));
  }
  const { supabaseAdmin, updates } = makeSupabaseFake({ os_queue: rows, maveloper_jobs: [] });
  const runner = createQueueRunner({
    supabaseAdmin,
    startFigmaJobAsync: async () => ({ jobId: "job-stale" }),
    log: () => {},
    env: { RUNNER_ENABLED: "true" },
  });
  await runner.tick();

  const lockWrites = updates.filter((u) => "locked" in u.patch || "locked_at" in u.patch);
  ok(lockWrites.length === 0,
    `long-overdue rows trigger NO lock UPDATE (got ${lockWrites.length} lock writes)`);
  ok(rows.every((r) => r.locked === false),
    `no long-overdue row had \`locked\` flipped (got ${rows.filter((r) => r.locked).length} flipped)`);
  ok(rows.every((r) => r.locked_at === null),
    `no long-overdue row had \`locked_at\` stamped (got ${rows.filter((r) => r.locked_at).length} stamped)`);
}

{
  // A row already processing means the engine is busy: nothing new dispatches,
  // and still nothing writes a lock.
  const rows = [
    row({ id: "busy", uploaded_at: iso(T0 - 5 * H), status: "processing", started_at: iso(T0 - 60_000), job_id: null }),
    row({ id: "a", uploaded_at: iso(T0 - 40 * H), tat_hours: 8 }),
  ];
  rows[0].started_at = iso(T0 - 60_000);
  const { supabaseAdmin, updates } = makeSupabaseFake({ os_queue: rows, maveloper_jobs: [] });
  const runner = createQueueRunner({
    supabaseAdmin,
    startFigmaJobAsync: async () => { throw new Error("must not dispatch while busy"); },
    log: () => {},
    env: { RUNNER_ENABLED: "true" },
  });
  const result = await runner.tick();
  ok(result.dispatched === null, `nothing dispatches while a row is processing (got ${result.dispatched})`);
  ok(updates.filter((u) => "locked" in u.patch || "locked_at" in u.patch).length === 0,
    "a busy tick writes no lock state either");
}

{
  // manual_rank reaches the wire: a human override still decides the dispatch.
  const rows = [
    row({ id: "old", uploaded_at: iso(T0 - 50 * H) }),
    row({ id: "picked", uploaded_at: iso(T0 - 1 * H), manual_rank: 1 }),
  ];
  const { supabaseAdmin } = makeSupabaseFake({ os_queue: rows, maveloper_jobs: [] });
  const runner = createQueueRunner({
    supabaseAdmin,
    startFigmaJobAsync: async () => ({ jobId: "job-2" }),
    log: () => {},
    env: { RUNNER_ENABLED: "true" },
  });
  const result = await runner.tick();
  ok(result.dispatched === "OF-picked", `manual_rank decides the dispatch (got ${result.dispatched})`);
}

// ── summary ───────────────────────────────────────────────────────────
console.log(`\nqueue-priority-fifo.test.mjs: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILED ASSERTIONS:");
  for (const f of failures) console.error("  ✗", f);
}
process.exit(fail === 0 ? 0 : 1);
