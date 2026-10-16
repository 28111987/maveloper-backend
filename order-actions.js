/**
 * order-actions.js - EVERY ORDER CAN BE CONTROLLED. Run 17.
 *
 * WHAT WAS WRONG. On 16 OCT a client's order sat in "processing" for 40 minutes
 * after its engine instance was shut down, and neither the space's Admin nor the
 * platform owner could release it: the console's only controls wrote through
 * row security, the close guard (os_queue_close_guard rule (c)) refuses an
 * Admin's status change on another person's order, the "Mark failed" and "Clear
 * stuck" dialogs were never opened by anything, and a refused write still showed
 * a green toast. It was released by hand in SQL.
 *
 * THE RULE (the owner, 16 OCT 23:12): the platform owner, in any space, and an
 * Admin of the order's own live space can act on any order; a Dev keeps what a
 * Dev can do today. Every action proves itself.
 *
 *   POST /os/orders/:id/:action      action = cancel | stop | remove | run-next | retry
 *
 * THE DOORS ARE RUN 14's. requireAuth (server.js) then requireLiveSeat
 * (route-doors.js): signed in, and a live seat somewhere (or the platform
 * owner). Then this file decides the ROLE for THIS order, and only then writes
 * with the service role:
 *   - the platform owner (PLATFORM_OWNERS, the list run 14's doors use, or a
 *     platform_owners row, the list is_platform_owner() reads): any order;
 *   - an Admin: an is_owner seat in the person's CURRENT space (profiles.org_id),
 *     which must be live, and the order must be in that space. This is the same
 *     question os_is_admin() asks (isolation.sql:70-84), asked here for this
 *     order's space;
 *   - a Dev: their own order in their current live space, and only cancel,
 *     retry and run-next (run 17 step 1b: today a Dev cancels their own pending
 *     order, resubmits their own failed one, and drags their own pending order
 *     to the front; nothing else);
 *   - everyone else, a closed space's Admin and anyone with no seat: refused.
 *
 * EVERY WRITE IS GUARDED BY THE STATE IT EXPECTS (.eq('status', ...)), and asks
 * for the rows it changed. Zero rows is a REFUSAL with a reason, never a
 * success: the order moved on before the action landed. A refusal changes
 * nothing. Every success writes ONE os_admin_audit row (the 15B/15C table,
 * stamped with the order's space) naming who, which order, before and after.
 *
 * STATES (K6), in the vocabulary os_queue already has. There is no "cancelled"
 * status (order_close.sql:18-31 refused a fifth value on purpose): a cancelled
 * order is `failed` with the reason "Cancelled by <name> ... It never ran.",
 * finished_at set, no job, so it can be retried or removed like any failure.
 * REMOVE deletes the row, as the console's Remove always has; the audit row keeps
 * the whole row as it was, and a delivered order is never removed.
 */
import { computeQueuePlan } from "./queue-priority.js";
import { stoppedBy, cancelledBy } from "./order-words.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ORDER_ACTIONS = ["cancel", "stop", "remove", "run-next", "retry"];
const AUDIT_ACTION = {
  cancel: "order_cancelled",
  stop: "order_stopped",
  remove: "order_removed",
  "run-next": "order_run_next",
  retry: "order_retried",
};
const DEV_ACTIONS = new Set(["cancel", "retry", "run-next"]);
const ORDER_COLS = "id,order_id,org_id,status,lead_email,lead_user_id,job_id,manual_rank,uploaded_at,closed_at,closed_reason,error_text,started_at,finished_at,figma_url,esp,dark_mode,tat_hours";

/** like/ilike patterns treat % and _ as wildcards; an email may hold either. */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}

export function createOrderActions({ app, supabaseAdmin, requireAuth, requireLiveSeat, platformOwners, log, hooks = {}, runnerCfg = {} }) {
  const envOwners = new Set((platformOwners || []).map((s) => String(s).toLowerCase()));

  /** Every refusal on this route has one shape, whichever door said it. */
  function shapeRefusals(req, res, next) {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400 && body && typeof body === "object" && !("refused" in body)) {
        return json({
          ok: false,
          refused: true,
          changed: [],
          reason: String(body.details || body.error || "This action was refused."),
          ...body,
        });
      }
      return json(body);
    };
    if (!/^Bearer\s+\S+/.test(req.headers.authorization || "")) {
      return res.status(401).json({ reason: "Sign in to act on an order." });
    }
    return next();
  }

  function refuse(res, status, reason, extra = {}) {
    return res.status(status).json({ ok: false, refused: true, changed: [], reason, ...extra });
  }

  async function isPlatformOwner(email) {
    if (envOwners.has(email)) return true;
    const { data, error } = await supabaseAdmin.from("platform_owners").select("email").ilike("email", escapeLike(email)).limit(1);
    if (error) throw new Error("platform owner lookup failed: " + error.message);
    return Array.isArray(data) && data.length > 0;
  }

  async function standing(req) {
    const email = req.seat.email;
    const owner = req.seat.owner || (await isPlatformOwner(email));
    const { data: prof, error: profErr } = await supabaseAdmin
      .from("profiles").select("org_id,full_name").eq("id", req.user.id).maybeSingle();
    if (profErr) throw new Error("profile lookup failed: " + profErr.message);
    const cur = prof && prof.org_id && req.seat.orgIds.has(prof.org_id) ? prof.org_id : null;
    let adminHere = false;
    if (cur) {
      const { data: seats, error: seatErr } = await supabaseAdmin
        .from("email_allowlist").select("is_owner").eq("org_id", cur).ilike("email", escapeLike(email));
      if (seatErr) throw new Error("seat lookup failed: " + seatErr.message);
      adminHere = (seats || []).some((s) => s.is_owner === true);
    }
    const name = (prof && typeof prof.full_name === "string" && prof.full_name.trim()) || email.split("@")[0];
    return { email, owner, cur, adminHere, name: name.slice(0, 60) };
  }

  /** K1-K4. Returns the role, or a refusal reason. */
  function decide(me, order, action, userId) {
    if (me.owner) return { role: "owner" };
    if (!order.org_id) return { refuse: "Only the platform owner can act on an order that belongs to no space." };
    if (!me.cur) return { refuse: "You are not standing in a live space, so you cannot act on this order." };
    if (order.org_id !== me.cur) return { refuse: "This order belongs to another space. Switch to that space to act on it, if you hold a seat there." };
    if (me.adminHere) return { role: "admin" };
    if (order.lead_user_id && order.lead_user_id === userId && DEV_ACTIONS.has(action)) return { role: "dev" };
    if (order.lead_user_id === userId) return { refuse: "Only an Admin of this space can do that to an order." };
    return { refuse: "Only an Admin of this space can act on another person's order." };
  }

  /** K6. The states each action has a meaning in. */
  function stateRefusal(action, order) {
    const cancelled = order.status === "failed" && /^Cancelled by /.test(order.error_text || "");
    switch (action) {
      case "cancel":
        if (order.status === "pending") return null;
        return order.status === "processing" ? "This order has already started. Stop it instead." : cancelled ? "This order is already cancelled." : `This order is ${order.status}, so there is nothing to cancel.`;
      case "stop":
        return order.status === "processing" ? null : order.status === "pending" ? "This order has not started. Cancel it instead." : `This order is ${order.status}, so there is nothing to stop.`;
      case "remove":
        if (order.status === "pending" || order.status === "failed") return null;
        return order.status === "delivered" ? "A delivered order is the client's record and is never removed." : "This order is building. Stop it first.";
      case "run-next":
        return order.status === "pending" ? null : `This order is ${order.status}, so it is not waiting in the line.`;
      case "retry":
        if (order.status !== "failed") return `This order is ${order.status}, so there is nothing to retry.`;
        if (order.closed_at) return "This order is closed. Reopen it before retrying.";
        return null;
    }
    return "Unknown action.";
  }

  async function audit(me, userId, action, order, after, extra = {}) {
    const row = {
      actor_user_id: userId,
      actor_email: me.email,
      action: AUDIT_ACTION[action],
      subject_email: order.lead_email || null,
      subject_order: order.order_id,
      subject_row_id: order.id,
      org_id: order.org_id,
      detail: {
        role: me.owner ? "platform owner" : me.adminHere ? "admin" : "dev",
        before: { status: order.status, error_text: order.error_text, job_id: order.job_id, manual_rank: order.manual_rank, started_at: order.started_at, finished_at: order.finished_at },
        after,
        ...extra,
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await supabaseAdmin.from("os_admin_audit").insert(row);
      if (!error) return true;
      log("error", "order-actions: audit write failed", { action: row.action, order: order.order_id, error: error.message, attempt });
    }
    return false;
  }

  const nowIso = () => new Date().toISOString();

  async function doCancel(me, order) {
    const patch = { status: "failed", error_text: cancelledBy(me.name, !(me.role === "dev")), job_id: null, started_at: null, finished_at: nowIso() };
    const { data, error } = await supabaseAdmin.from("os_queue").update(patch)
      .eq("id", order.id).eq("status", "pending").is("job_id", null).select("id,status,error_text");
    if (error) throw new Error(error.message);
    return { rows: data || [], after: patch };
  }

  async function doStop(me, order) {
    const reason = stoppedBy(me.name);
    const patch = { status: "failed", error_text: reason, job_id: null, started_at: null, finished_at: null };
    const { data, error } = await supabaseAdmin.from("os_queue").update(patch)
      .eq("id", order.id).eq("status", "processing").select("id,status,error_text");
    if (error) throw new Error(error.message);
    if ((data || []).length && order.job_id && UUID_RE.test(order.job_id)) {
      // The job row keeps its bridge record (delivery_meta.bridge) so a result
      // that arrives later is recognised and recorded as discarded (L4).
      const { data: job } = await supabaseAdmin.from("maveloper_jobs").select("id,status,delivery_meta").eq("id", order.job_id).maybeSingle();
      if (job && (job.status === "pending" || job.status === "running")) {
        const dm = job.delivery_meta && typeof job.delivery_meta === "object" ? job.delivery_meta : {};
        await supabaseAdmin.from("maveloper_jobs").update({
          status: "failed",
          error_message: reason,
          completed_at: nowIso(),
          updated_at: nowIso(),
          delivery_meta: { ...dm, stopped: { at: nowIso(), by: me.name } },
        }).eq("id", job.id).in("status", ["pending", "running"]);
      }
      try { hooks.onStop && hooks.onStop(order.job_id); } catch (e) { log("warn", "order-actions: onStop hook threw", { error: e.message }); }
    }
    return { rows: data || [], after: patch };
  }

  async function doRemove(me, order) {
    const { data, error } = await supabaseAdmin.from("os_queue").delete()
      .eq("id", order.id).in("status", ["pending", "failed"]).select("id,status");
    if (error) throw new Error(error.message);
    return { rows: (data || []).map((r) => ({ ...r, status: "removed" })), after: { removed: true } };
  }

  async function doRetry(me, order) {
    const patch = { status: "pending", error_text: null, job_id: null, started_at: null, finished_at: null };
    const { data, error } = await supabaseAdmin.from("os_queue").update(patch)
      .eq("id", order.id).eq("status", "failed").is("closed_at", null).select("id,status");
    if (error) throw new Error(error.message);
    return { rows: data || [], after: patch };
  }

  /**
   * RUN NEXT: the order moves to the front of ITS OWN space's line and never
   * jumps another space. manual_rank is the one override (queue-priority.js
   * cmpFifo: ranked rows first, by rank; then oldest first). The line is the one
   * the runner builds from: the space's own pending rows when PER_SPACE_QUEUE is
   * on, the whole pending list on the single global lock (the code default).
   * The order takes the place of its space's first pending order. On the global
   * line, if unranked orders of other spaces stand ahead of that place, they are
   * given ranks that keep them EXACTLY where they are (a rank is the only way to
   * place a row before an older unranked one); the audit row lists them.
   */
  async function doRunNext(me, order) {
    let q = supabaseAdmin.from("os_queue").select("id,order_id,org_id,status,manual_rank,uploaded_at,job_id").eq("status", "pending");
    if (runnerCfg.perSpaceQueue) q = order.org_id ? q.eq("org_id", order.org_id) : q.is("org_id", null);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const line = computeQueuePlan(rows || [], Date.now()).pending.map((p) => p.row);
    const key = (r) => String(r.org_id ?? "null");
    const xIdx = line.findIndex((r) => key(r) === key(order));
    if (xIdx < 0) return { rows: [], refusal: "This order is no longer waiting in the line." };
    const X = line[xIdx];
    if (X.id === order.id) return { rows: [], refusal: "This order is already the next one in its space." };
    const ahead = line.slice(0, xIdx);
    const writes = [];
    let rank;
    if (X.manual_rank != null) {
      const prev = ahead.length ? ahead[ahead.length - 1].manual_rank : null;
      rank = prev == null ? X.manual_rank - 1000 : (prev + X.manual_rank) / 2;
    } else {
      const ranked = ahead.filter((r) => r.manual_rank != null).map((r) => r.manual_rank);
      let base = ranked.length ? Math.max(...ranked) : 0;
      for (const r of ahead.filter((r) => r.manual_rank == null)) {
        base += 1000;
        writes.push({ id: r.id, order_id: r.order_id, manual_rank: base });
      }
      rank = ahead.length ? base + 1000 : 0;
    }
    const kept = [];
    for (const w of writes) {
      const { data } = await supabaseAdmin.from("os_queue").update({ manual_rank: w.manual_rank }).eq("id", w.id).eq("status", "pending").is("manual_rank", null).select("id");
      if (data && data.length) kept.push(w);
    }
    const { data, error: upErr } = await supabaseAdmin.from("os_queue").update({ manual_rank: rank })
      .eq("id", order.id).eq("status", "pending").select("id,status,manual_rank");
    if (upErr) throw new Error(upErr.message);
    return {
      rows: [...(data || []), ...kept.map((k) => ({ id: k.id, status: "pending", manual_rank: k.manual_rank }))],
      after: { manual_rank: rank },
      extra: { kept_in_place: kept.map((k) => k.order_id), ahead_of: X.order_id },
    };
  }

  const DO = { cancel: doCancel, stop: doStop, remove: doRemove, retry: doRetry, "run-next": doRunNext };

  app.post("/os/orders/:id/:action", shapeRefusals, requireAuth, requireLiveSeat, async (req, res) => {
    const { id, action } = req.params;
    if (!ORDER_ACTIONS.includes(action)) return refuse(res, 400, "Unknown action.");
    if (!UUID_RE.test(String(id))) return refuse(res, 400, "That is not an order id.");
    try {
      const { data: order, error } = await supabaseAdmin.from("os_queue").select(ORDER_COLS).eq("id", id).maybeSingle();
      if (error) return refuse(res, 503, "The order queue did not answer. Nothing was done.");
      if (!order) return refuse(res, 404, "This order no longer exists.");
      const me = await standing(req);
      const verdict = decide(me, order, action, req.user.id);
      if (verdict.refuse) {
        log("info", "order action refused", { action, order: order.order_id, why: "role" });
        return refuse(res, 403, verdict.refuse);
      }
      me.role = verdict.role;
      const why = stateRefusal(action, order);
      if (why) return refuse(res, 409, why, { order: { id: order.id, status: order.status } });

      const out = await DO[action](me, order);
      if (out.refusal) return refuse(res, 409, out.refusal, { order: { id: order.id, status: order.status } });
      const mine = out.rows.find((r) => r.id === order.id);
      if (!mine) {
        return refuse(res, 409, "The order changed before this action landed. Nothing was done. Look at it again.", { order: { id: order.id, status: order.status } });
      }
      const audited = await audit(me, req.user.id, action, order, out.after, out.extra || {});
      log("info", "order action", { action, order: order.order_id, role: verdict.role, changed: out.rows.length, audited });
      return res.json({
        ok: true,
        action,
        changed: out.rows.map((r) => r.id),
        order: { id: order.id, status: mine.status, error_text: mine.error_text ?? null, manual_rank: mine.manual_rank ?? null },
        audited,
        requestId: req.id,
      });
    } catch (err) {
      log("error", "order action failed", { action, error: err.message, requestId: req.id });
      return refuse(res, 500, "The action could not be completed. Nothing was confirmed. Look at the order again.");
    }
  });

  return { ORDER_ACTIONS };
}

export default { createOrderActions, ORDER_ACTIONS };
