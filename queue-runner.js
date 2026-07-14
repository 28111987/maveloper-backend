/**
 * queue-runner.js — server-side headless queue runner (Railway).
 * -----------------------------------------------------------------------------
 * Moves the /os OsShell.tsx browser runner into the always-on backend. Drains
 * os_queue one order at a time, using supabaseAdmin (SERVICE_ROLE, bypasses RLS)
 * and the SAME priority engine the UI uses (queue-priority.js).
 *
 * SHIPPED DARK: nothing runs unless RUNNER_ENABLED === "true". createQueueRunner
 * is always constructed (so the /runner/status + /queue/run-next routes have an
 * object to talk to), but start() no-ops when disabled — behaviour is unchanged.
 *
 * Does NOT touch the bridge, cc-runner, the PDF pipeline, figma-parser, or the
 * generation logic. It only ORCHESTRATES: pick → atomic-claim → dispatch (via the
 * existing async path, in-process) → watch maveloper_jobs → settle os_queue.
 *
 * Status vocabulary map (maveloper_jobs → os_queue):
 *   running   → processing
 *   completed → delivered
 *   failed    → failed
 *   pending   → (still pending/processing; leave in flight)
 */

import { computeQueuePlan } from './queue-priority.js';

export function createQueueRunner({ supabaseAdmin, startFigmaJobAsync, log, env }) {
  const cfg = {
    enabled: env.RUNNER_ENABLED === 'true',
    pollMs: Number(env.RUNNER_POLL_MS) || 10000,
    maxJobMs: Number(env.MAX_JOB_MS) || 35 * 60 * 1000,   // 2,100,000
    orphanMs: Number(env.ORPHAN_MS) || 5 * 60 * 1000,     //   300,000
    stuckMs: Number(env.STUCK_MS) || 60 * 60 * 1000,      // 3,600,000
    heartbeatMs: Number(env.HEARTBEAT_MS) || 30000,
    bridgeUrl: env.MAC_BRIDGE_URL || null,
  };

  let isTicking = false;
  let started = false;
  let pollTimer = null;
  let heartbeatTimer = null;
  let runnerReqCounter = 0;

  const state = {
    runnerLastSeen: null,
    engineOnline: null,
    engineLastOk: null,
    engineError: null,
  };

  // ---- os_queue write helpers (mirror the client's persistTerminal: awaited, one retry) ----

  async function updateRow(id, patch) {
    const { error } = await supabaseAdmin.from('os_queue').update(patch).eq('id', id);
    if (error) {
      log('warn', 'Runner: os_queue update failed', { id, error: error.message });
      return false;
    }
    return true;
  }

  // §4 DELIVERED — status, finished_at, html_content, html_bytes (do NOT rewrite started_at).
  async function settleDelivered(id, resultHtml) {
    const html = String(resultHtml || '');
    const patch = {
      status: 'delivered',
      finished_at: new Date().toISOString(),
      html_content: html,
      html_bytes: html.length,
    };
    let ok = await updateRow(id, patch);
    if (!ok) ok = await updateRow(id, patch); // one retry
    return ok;
  }

  // §5 FAILED — every failure leaves a CLEAN, re-dispatchable row (null job_id/started/finished).
  async function settleFailed(id, reason) {
    const patch = {
      status: 'failed',
      error_text: reason,
      job_id: null,
      started_at: null,
      finished_at: null,
    };
    let ok = await updateRow(id, patch);
    if (!ok) ok = await updateRow(id, patch); // one retry
    return ok;
  }

  // ---- the tick ----

  async function tick() {
    if (isTicking) return { dispatched: null, reason: 'tick already in progress' };
    isTicking = true;
    try {
      state.runnerLastSeen = new Date().toISOString();
      const now = Date.now();

      // A. BOOT-RECOVERY / ADOPT + self-heal (§2A, §3 timeout, §6).
      const { data: procRows, error: procErr } = await supabaseAdmin
        .from('os_queue')
        .select('id,order_id,job_id,started_at')
        .eq('status', 'processing');
      if (procErr) {
        log('warn', 'Runner: processing-scan failed', { error: procErr.message });
        return { dispatched: null, reason: `scan failed: ${procErr.message}` };
      }

      for (const r of (procRows ?? [])) {
        const startedMs = r.started_at ? new Date(r.started_at).getTime() : null;
        const age = startedMs != null ? now - startedMs : null;

        if (r.job_id) {
          const { data: job } = await supabaseAdmin
            .from('maveloper_jobs')
            .select('id,status,result_html')
            .eq('id', r.job_id)
            .maybeSingle();

          if (!job) {
            // MISSING JOB (§6) — processing with a job_id but no maveloper_jobs row.
            await settleFailed(r.id, 'Auto-cleared: processing job row missing');
            log('warn', 'Runner: settled row with missing maveloper_jobs row', { id: r.id, order: r.order_id, jobId: r.job_id });
            continue;
          }

          const js = String(job.status || '').toLowerCase();
          if (js === 'completed') {
            if (job.result_html) {
              await settleDelivered(r.id, job.result_html);
              log('info', 'Runner: settled delivered', { id: r.id, order: r.order_id, bytes: String(job.result_html).length });
            } else {
              await settleFailed(r.id, 'Job completed but no HTML returned');
              log('warn', 'Runner: completed with no HTML → failed', { id: r.id, order: r.order_id });
            }
            continue;
          }
          if (js === 'failed') {
            await settleFailed(r.id, 'Bridge/generation failed');
            log('warn', 'Runner: settled failed (maveloper_jobs failed)', { id: r.id, order: r.order_id });
            continue;
          }
          // still running/pending → in flight. Only intervene on the 35-min timeout (§3).
          if (age != null && age > cfg.maxJobMs) {
            await settleFailed(r.id, 'Generation timed out (>35 min)');
            log('warn', 'Runner: in-flight job exceeded MAX_JOB_MS → failed', { id: r.id, order: r.order_id, ageMs: age });
          }
        } else {
          // processing with NO job_id → orphan tiers (§6).
          if (age != null && age > cfg.stuckMs) {
            await settleFailed(r.id, 'Auto-failed: stuck in processing > 60 min (self-heal)');
            log('warn', 'Runner: self-heal freed stuck row (>60m)', { id: r.id, order: r.order_id });
          } else if (age != null && age > cfg.orphanMs) {
            await settleFailed(r.id, 'Auto-cleared: processing with no job');
            log('warn', 'Runner: auto-cleared orphan (>5m, no job_id)', { id: r.id, order: r.order_id });
          }
          // age == null (no started_at) → cannot age it; leave for a later tick / manual.
        }
      }

      // §6 STALE PENDING — pending WITH a non-null job_id. Should never happen once the
      // client runner is off (it was BUG 5). Do NOT auto-clear; log it so we see it.
      const { data: stalePending } = await supabaseAdmin
        .from('os_queue')
        .select('id,order_id,job_id')
        .eq('status', 'pending')
        .not('job_id', 'is', null);
      if (stalePending && stalePending.length > 0) {
        log('warn', 'Runner: stale pending rows with non-null job_id (investigate)', {
          count: stalePending.length,
          orders: stalePending.map((x) => x.order_id),
        });
      }

      // B. CONCURRENCY GUARD — re-read processing AFTER §A settled the finished ones.
      const { data: stillProc } = await supabaseAdmin
        .from('os_queue')
        .select('id')
        .eq('status', 'processing');
      if (stillProc && stillProc.length > 0) {
        return { dispatched: null, reason: 'engine busy (row processing)' };
      }

      // C. PLAN + PERSIST LOCKS.
      const { data: activeRows, error: activeErr } = await supabaseAdmin
        .from('os_queue')
        .select('id,order_id,tat_hours,uploaded_at,status,lead_user_id,manual_rank,effective_deadline,locked,locked_at,figma_url,esp,dark_mode,job_id')
        .in('status', ['pending', 'processing']);
      if (activeErr) {
        log('warn', 'Runner: active-rows load failed', { error: activeErr.message });
        return { dispatched: null, reason: `active load failed: ${activeErr.message}` };
      }
      const rows = activeRows ?? [];
      const newlyLocking = [];
      const plan = computeQueuePlan(rows, Date.now(), newlyLocking);

      // Persist any NEW locks the plan produced (server is the single writer).
      for (const p of plan.pending) {
        const orig = rows.find((r) => r.id === p.row.id);
        if (p.locked && orig && !orig.locked) {
          await updateRow(p.row.id, { locked: true, locked_at: p.lockedAt ?? new Date().toISOString() });
          log('info', 'Runner: persisted new lock', { id: p.row.id, order: p.row.order_id });
        }
      }

      // D. PICK — first plan.pending row that is pending AND has no job_id.
      const dispatchable = rows.filter((r) => r.status === 'pending' && !r.job_id);
      if (dispatchable.length === 0) return { dispatched: null, reason: 'no dispatchable pending' };
      const topPending = plan.pending.find((p) => dispatchable.some((d) => d.id === p.row.id));
      if (!topPending) return { dispatched: null, reason: 'no dispatchable pending' };
      const pick = dispatchable.find((d) => d.id === topPending.row.id);
      if (!pick) return { dispatched: null, reason: 'no dispatchable pending' };

      // E. ATOMIC CLAIM — the .eq(status,pending).is(job_id,null) guards ARE the lock.
      const { data: claimed, error: claimErr } = await supabaseAdmin
        .from('os_queue')
        .update({ status: 'processing', started_at: new Date().toISOString() })
        .eq('id', pick.id)
        .eq('status', 'pending')
        .is('job_id', null)
        .select();
      if (claimErr) {
        log('warn', 'Runner: claim update errored', { id: pick.id, error: claimErr.message });
        return { dispatched: null, reason: `claim errored: ${claimErr.message}` };
      }
      if (!claimed || claimed.length === 0) {
        return { dispatched: null, reason: 'claim lost (raced)' };
      }

      // F. DISPATCH — reuse the existing async path IN-PROCESS. Exactly the 5 client fields.
      const jobBody = {
        figmaUrl: pick.figma_url,
        darkMode: pick.dark_mode,
        orderId: pick.order_id,
        tatHours: Number(pick.tat_hours),
      };
      if (pick.esp && pick.esp !== 'none') jobBody.espPlatform = pick.esp;

      const requestId = `runner_${now}_${runnerReqCounter++}`;
      let jobId;
      try {
        const result = await startFigmaJobAsync({ body: jobBody, requestId, user: null, headers: {} });
        if (result && result.error) {
          throw new Error(`${result.error}${result.details ? `: ${result.details}` : ''}`);
        }
        jobId = result && result.jobId;
        if (!jobId) throw new Error('async path returned no jobId');
      } catch (err) {
        const msg = `Runner dispatch failed: ${err.message}`;
        await settleFailed(pick.id, msg);
        log('error', 'Runner: dispatch failed', { id: pick.id, order: pick.order_id, error: err.message });
        return { dispatched: null, reason: msg };
      }

      // On success → persist job_id onto the os_queue row (the poller/adopt watches it).
      await updateRow(pick.id, { job_id: jobId });
      log('info', 'Runner: dispatched order', { id: pick.id, order: pick.order_id, jobId, requestId });
      return { dispatched: pick.order_id, reason: 'dispatched', jobId };
    } catch (err) {
      log('error', 'Runner: tick crashed', { error: err.message, stack: err.stack?.substring(0, 600) });
      return { dispatched: null, reason: `tick crashed: ${err.message}` };
    } finally {
      isTicking = false;
    }
  }

  // ---- heartbeat: probe the Mac bridge and persist runner_status ----

  async function heartbeat() {
    state.runnerLastSeen = new Date().toISOString();
    let online = false;
    let err = null;
    if (cfg.bridgeUrl) {
      try {
        const resp = await fetch(`${cfg.bridgeUrl}/health`, {
          method: 'GET',
          headers: { 'ngrok-skip-browser-warning': 'true' },
          signal: AbortSignal.timeout(5000),
        });
        online = resp.ok;
        if (!resp.ok) err = `bridge /health returned ${resp.status}`;
      } catch (e) {
        online = false;
        err = e.message;
      }
    } else {
      err = 'MAC_BRIDGE_URL not set';
    }
    if (online) state.engineLastOk = new Date().toISOString();
    state.engineOnline = online;
    state.engineError = err;

    try {
      const { error } = await supabaseAdmin.from('runner_status').upsert({
        id: 'singleton',
        runner_last_seen: state.runnerLastSeen,
        engine_online: online,
        engine_last_ok: state.engineLastOk,
        engine_error: err,
        updated_at: new Date().toISOString(),
      });
      if (error) log('warn', 'Runner: runner_status upsert failed (has the table been created?)', { error: error.message });
    } catch (e) {
      log('warn', 'Runner: runner_status upsert threw', { error: e.message });
    }
  }

  // ---- lifecycle + introspection ----

  function start() {
    log('info', `Queue runner boot: ${cfg.enabled ? 'ENABLED' : 'DISABLED'}`, {
      enabled: cfg.enabled,
      pollMs: cfg.pollMs,
      maxJobMs: cfg.maxJobMs,
      orphanMs: cfg.orphanMs,
      stuckMs: cfg.stuckMs,
      heartbeatMs: cfg.heartbeatMs,
      supabase: !!supabaseAdmin,
    });
    if (!cfg.enabled) return;
    if (!supabaseAdmin) {
      log('warn', 'Queue runner: RUNNER_ENABLED=true but Supabase not configured — not starting');
      return;
    }
    if (started) return;
    started = true;

    pollTimer = setInterval(() => {
      tick().catch((e) => log('error', 'Runner: unhandled tick error', { error: e.message }));
    }, cfg.pollMs);
    if (pollTimer.unref) pollTimer.unref();

    heartbeatTimer = setInterval(() => {
      heartbeat().catch((e) => log('warn', 'Runner: unhandled heartbeat error', { error: e.message }));
    }, cfg.heartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    // Kick off immediately.
    tick().catch(() => {});
    heartbeat().catch(() => {});
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    pollTimer = null;
    heartbeatTimer = null;
    started = false;
  }

  async function counts() {
    if (!supabaseAdmin) return { processing: null, pending: null };
    try {
      const [{ count: processing }, { count: pending }] = await Promise.all([
        supabaseAdmin.from('os_queue').select('id', { count: 'exact', head: true }).eq('status', 'processing'),
        supabaseAdmin.from('os_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      ]);
      return { processing: processing ?? null, pending: pending ?? null };
    } catch {
      return { processing: null, pending: null };
    }
  }

  async function status() {
    const c = await counts();
    return {
      runnerEnabled: cfg.enabled,
      runnerLastSeen: state.runnerLastSeen,
      engineOnline: state.engineOnline,
      engineLastOk: state.engineLastOk,
      engineError: state.engineError,
      processing: c.processing,
      pending: c.pending,
    };
  }

  return { cfg, state, start, stop, tick, heartbeat, status };
}
