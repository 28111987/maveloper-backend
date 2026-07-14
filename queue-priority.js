/**
 * queue-priority.js — server-side port of the /os priority engine.
 * -----------------------------------------------------------------------------
 * Ported VERBATIM from the frontend source so the Railway runner picks the
 * SAME order the /os UI predicts:
 *   - src/lib/queueEstimates.ts  (EST_MS_PER_ORDER, bufferedHours)
 *   - src/lib/queuePriority.ts    (computeQueuePlan + comparators + lock)
 *
 * Same constants, same comparators, same iterative lock. Pure functions only
 * (no Supabase, no time source other than the `now` argument). Do not "improve"
 * the math here — if it drifts from queuePriority.ts, the UI's ETA becomes a lie.
 */

// ---- constants (queueEstimates.ts) ----
export const EST_MINUTES_PER_ORDER = 20;
export const EST_MS_PER_ORDER = EST_MINUTES_PER_ORDER * 60 * 1000; // 1,200,000

/**
 * BUFFERED (effective) hours per selected TAT. Matches spec §2 / queueEstimates.ts verbatim.
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
// helpers (queuePriority.ts)
// ---------------------------------------------------------------------------

function dlMs(r) {
  if (r.effective_deadline) return new Date(r.effective_deadline).getTime();
  const uploaded = new Date(r.uploaded_at).getTime();
  return uploaded + bufferedHours(Number(r.tat_hours)) * 3600000;
}
function uploadedMs(r) {
  return new Date(r.uploaded_at).getTime();
}
function lockedAtMs(r, fallback = 0) {
  return r.locked_at ? new Date(r.locked_at).getTime() : fallback;
}

/** Unlocked comparator: manual_rank (when set) then deadline then upload. */
function cmpUnlocked(a, b) {
  const am = a.manual_rank ?? null;
  const bm = b.manual_rank ?? null;
  if (am != null && bm != null && am !== bm) return am - bm;
  if (am != null && bm == null) return -1;
  if (am == null && bm != null) return 1;
  const ad = dlMs(a), bd = dlMs(b);
  if (ad !== bd) return ad - bd;
  return uploadedMs(a) - uploadedMs(b);
}

/**
 * barrier_key = count of OTHER locked rows whose locked_at < this row's
 * uploaded_at (§3b — "no NEWER order may be placed ahead of X").
 */
function lockedBarrierKey(row, allLocked) {
  const u = uploadedMs(row);
  let n = 0;
  for (const other of allLocked) {
    if (other.id === row.id) continue;
    const olock = other.locked_at ? new Date(other.locked_at).getTime() : Infinity;
    if (olock < u) n++;
  }
  return n;
}

function cmpLocked(a, b, all) {
  const ba = lockedBarrierKey(a, all);
  const bb = lockedBarrierKey(b, all);
  if (ba !== bb) return ba - bb;
  const ad = dlMs(a), bd = dlMs(b);
  if (ad !== bd) return ad - bd;
  return lockedAtMs(a) - lockedAtMs(b);
}

/**
 * Merge sorted locked + unlocked pending arrays into final order (§3b).
 */
function mergeLockedUnlocked(lockedSorted, unlockedSorted) {
  const out = [];
  let i = 0, j = 0;
  while (i < unlockedSorted.length && j < lockedSorted.length) {
    const U = unlockedSorted[i];
    const L = lockedSorted[j];
    const lLockAt = lockedAtMs(L, Infinity);
    if (uploadedMs(U) < lLockAt) {
      // U existed before L locked → natural dl comparison.
      if (dlMs(U) <= dlMs(L)) { out.push(U); i++; }
      else { out.push(L); j++; }
    } else {
      // U arrived after L locked → L must precede U.
      out.push(L); j++;
    }
  }
  while (i < unlockedSorted.length) out.push(unlockedSorted[i++]);
  while (j < lockedSorted.length) out.push(lockedSorted[j++]);
  return out;
}

// ---------------------------------------------------------------------------
// main (queuePriority.ts computeQueuePlan)
// ---------------------------------------------------------------------------

export function computeQueuePlan(rows, now, newlyLocking) {
  const active = rows.filter((r) => r.status === 'pending' || r.status === 'processing');
  const processing = active.filter((r) => r.status === 'processing');
  const pending = active.filter((r) => r.status === 'pending');

  const lockedNow = new Map(); // id → locked_at ISO
  for (const r of pending) {
    if (r.locked) lockedNow.set(r.id, r.locked_at ?? new Date(now).toISOString());
  }

  const MAX_PASSES = pending.length + 2;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const locked = pending.filter((r) => lockedNow.has(r.id))
      .map((r) => ({ ...r, locked: true, locked_at: lockedNow.get(r.id) }));
    const unlocked = pending.filter((r) => !lockedNow.has(r.id));
    locked.sort((a, b) => cmpLocked(a, b, locked));
    unlocked.sort(cmpUnlocked);
    const orderedPending = mergeLockedUnlocked(locked, unlocked);
    const ordered = [...processing, ...orderedPending];

    let changed = false;
    // Consider lock candidates by earliest effective deadline first (§3d).
    const candidates = [...unlocked].sort((a, b) => dlMs(a) - dlMs(b));
    for (const row of candidates) {
      const idx = ordered.findIndex((r) => r.id === row.id);
      if (idx < 0) continue;
      const position = idx + 1;
      const workAheadMs = (position - 1) * EST_MS_PER_ORDER;
      const timeLeftMs = dlMs(row) - now;
      if (timeLeftMs <= workAheadMs) {
        lockedNow.set(row.id, new Date(now).toISOString());
        if (newlyLocking && !row.locked) newlyLocking.push(row.id);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  // Final ordering.
  const finalLocked = pending.filter((r) => lockedNow.has(r.id))
    .map((r) => ({ ...r, locked: true, locked_at: lockedNow.get(r.id) }));
  const finalUnlocked = pending.filter((r) => !lockedNow.has(r.id));
  finalLocked.sort((a, b) => cmpLocked(a, b, finalLocked));
  finalUnlocked.sort(cmpUnlocked);
  const orderedPending = mergeLockedUnlocked(finalLocked, finalUnlocked);
  const orderedAll = [...processing, ...orderedPending];

  const planned = orderedAll.map((row, idx) => {
    const position = idx + 1;
    const workAheadMs = (position - 1) * EST_MS_PER_ORDER;
    const estReady = new Date(now + workAheadMs + EST_MS_PER_ORDER);
    const dl = new Date(dlMs(row));
    const locked = lockedNow.has(row.id) || row.status === 'processing';
    return {
      row,
      position,
      workAheadMs,
      estReady,
      effectiveDeadline: dl,
      willMissTat: estReady.getTime() > dl.getTime(),
      locked,
      lockedAt: lockedNow.get(row.id) ?? row.locked_at ?? null,
    };
  });

  const proc = planned.filter((p) => p.row.status === 'processing');
  const pend = planned.filter((p) => p.row.status === 'pending');
  const backlogMs = (proc.length + pend.length) * EST_MS_PER_ORDER;
  const nextFreeSlot = new Date(now + backlogMs);
  const lockedCount = pend.filter((p) => p.locked).length;

  return { ordered: planned, processing: proc, pending: pend, lockedCount, nextFreeSlot, backlogMs };
}
