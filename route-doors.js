/**
 * route-doors.js - SIGN-IN AND A LIVE SEAT, ON THE ROUTES THAT READ A SPACE'S
 * DATA. Run 14.
 *
 * WHAT WAS WRONG. /generate-from-figma, /generate-from-figma-async, /approve,
 * /job-status/:jobId and /os/provenance ran under optionalAuth, which never
 * rejects. /generate-from-figma took `orgId` from the request body, so anyone
 * who knew a space id could make the engine read Figma files with that
 * space's own pasted token or OAuth connection. /job-status returned stored
 * HTML to anyone holding the job id.
 *
 * THE RULE, IN ONE LINE. The space always comes from the signed-in person's
 * live seats, never from the request. A body orgId is honoured ONLY when the
 * caller holds a live seat in that space. For a job or an order, the space is
 * the os_queue row's org_id, and the caller must hold a live seat there.
 *
 * "LIVE SEAT" is the database's own definition (has_live_seat(), run 15): an
 * email_allowlist row in a space whose orgs.is_deleted is not true. A seat in
 * a closed space is refused.
 *
 * NOT A SECOND AUTHENTICATION SYSTEM. Sign-in is the existing requireAuth
 * (server.js), passed in. The seat read is the same email_allowlist read the
 * Figma credential routes make (their requireSpaceAdmin gate),
 * minus the is_owner filter: any seat counts, not only an admin seat. The
 * platform-owner list is spaces.js's platformOwners(env).
 *
 * EVERY UNCERTAINTY DENIES. A lookup error, a missing email claim, a job or
 * order with no space on record: 403 or 503, never through.
 *
 * THE QUEUE RUNNER IS NOT AFFECTED. It calls startFigmaJobAsync in-process
 * (queue-runner.js), which invokes the LAST handler of /generate-from-figma
 * directly, so none of these middlewares run for a queued order.
 */

import { sanitizeOrderId } from "./delivery-folder.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same cap /os/provenance applies to its own id list. */
export const PROVENANCE_MAX_IDS = 60;

export function createRouteDoors({ supabaseAdmin, requireAuth, platformOwners, log }) {
  const owners = new Set((platformOwners || []).map((s) => String(s).toLowerCase()));

  function deny(res, status, error, details) {
    return res.status(status).json({ error, details });
  }

  /**
   * Read the caller's LIVE seats: distinct org ids from email_allowlist whose
   * org is not deleted. Two reads rather than a join so the shape stays the
   * one the existing seat gate uses (.eq on the lower-cased email).
   */
  async function readLiveSeats(email) {
    const { data: seatRows, error: seatErr } = await supabaseAdmin
      .from("email_allowlist")
      .select("org_id")
      .eq("email", email);
    if (seatErr) throw new Error("seat lookup failed: " + seatErr.message);

    const orgIds = [...new Set((seatRows || []).map((r) => r.org_id).filter(Boolean))];
    if (orgIds.length === 0) return new Set();

    const { data: orgRows, error: orgErr } = await supabaseAdmin
      .from("orgs")
      .select("id,is_deleted")
      .in("id", orgIds);
    if (orgErr) throw new Error("space lookup failed: " + orgErr.message);

    return new Set((orgRows || []).filter((o) => !o.is_deleted).map((o) => o.id));
  }

  /**
   * After requireAuth. Loads req.seat = { email, orgIds:Set, owner:boolean }.
   * A signed-in account with no live seat anywhere, and not a platform owner,
   * is refused here with 403.
   */
  async function requireLiveSeat(req, res, next) {
    const email = String(req.user?.email || "").toLowerCase().trim();
    if (!email) {
      return deny(res, 403, "Not permitted",
        "Your sign-in carries no email address, so no space seat can be matched to it.");
    }
    const owner = owners.has(email);
    let orgIds;
    try {
      orgIds = await readLiveSeats(email);
    } catch (err) {
      log("error", "route-doors: seat lookup failed", { requestId: req.id, error: err.message });
      return deny(res, 503, "Could not check your access",
        "The seat directory did not answer. Nothing was done.");
    }
    if (!owner && orgIds.size === 0) {
      return deny(res, 403, "No seat in a live space",
        "You are signed in as " + email + " but you do not hold a seat in any open space.");
    }
    req.seat = { email, orgIds, owner };
    return next();
  }

  /**
   * /generate-from-figma and /generate-from-figma-async.
   * The space is the caller's seat. A body orgId is accepted ONLY when the
   * caller holds a live seat in THAT space (platform owners excepted). With no
   * body orgId: one seat -> that seat is written onto the body; several seats
   * -> 403, the caller must say which.
   */
  function seatForGenerate(req, res, next) {
    const { orgIds, owner } = req.seat;
    const bodyOrgId = req.body && req.body.orgId != null && req.body.orgId !== ""
      ? String(req.body.orgId)
      : null;

    if (bodyOrgId) {
      if (owner || orgIds.has(bodyOrgId)) return next();
      return deny(res, 403, "No seat in that space",
        "You do not hold a seat in the space named by orgId, so this order cannot use its Figma credential.");
    }
    if (orgIds.size === 1) {
      req.body.orgId = [...orgIds][0];
      return next();
    }
    if (owner) return next();
    return deny(res, 403, "Say which space",
      "You hold seats in more than one space. Send the orgId of the space this order belongs to.");
  }

  /** Distinct non-null org ids of os_queue rows matching a filter. */
  async function queueOrgIds(column, value) {
    const { data, error } = await supabaseAdmin
      .from("os_queue")
      .select("org_id")
      .eq(column, value);
    if (error) throw new Error("os_queue lookup failed: " + error.message);
    return [...new Set((data || []).map((r) => r.org_id).filter(Boolean))];
  }

  function seatedInAny(seat, orgIdList) {
    if (seat.owner) return true;
    return orgIdList.some((id) => seat.orgIds.has(id));
  }

  /**
   * /job-status/:jobId. The space is the os_queue row whose job_id is this id.
   * A malformed id is left to the handler's own 400.
   */
  async function seatForJob(req, res, next) {
    const jobId = String(req.params.jobId || "");
    if (!UUID_RE.test(jobId)) return next();
    let orgIdList;
    try {
      orgIdList = await queueOrgIds("job_id", jobId);
    } catch (err) {
      log("error", "route-doors: job lookup failed", { requestId: req.id, error: err.message });
      return deny(res, 503, "Could not check your access", "The order queue did not answer.");
    }
    if (!seatedInAny(req.seat, orgIdList)) {
      return deny(res, 403, "No seat in this job's space",
        "This job does not belong to a space you hold a seat in.");
    }
    return next();
  }

  /**
   * /approve. The space is the os_queue row whose order_id is the body's
   * orderId (sanitised the way /approve itself sanitises it). A missing
   * orderId is left to the handler's own 400.
   */
  async function seatForOrder(req, res, next) {
    const raw = req.body && req.body.orderId;
    if (!raw) return next();
    const orderId = sanitizeOrderId(raw) || String(raw);
    let orgIdList;
    try {
      orgIdList = await queueOrgIds("order_id", orderId);
    } catch (err) {
      log("error", "route-doors: order lookup failed", { requestId: req.id, error: err.message });
      return deny(res, 503, "Could not check your access", "The order queue did not answer.");
    }
    if (!seatedInAny(req.seat, orgIdList)) {
      return deny(res, 403, "No seat in this order's space",
        "This order does not belong to a space you hold a seat in.");
    }
    return next();
  }

  /**
   * /os/provenance?jobIds=a,b,c. Each id's space is its os_queue row. The
   * list is cut down to the ids in spaces the caller is seated in before the
   * handler runs. If at least one id belongs to a space and none of them is
   * the caller's, 403. Ids with no space on record are dropped, not refused,
   * so a console batch of older rows still answers (as "not recorded").
   */
  async function seatForProvenance(req, res, next) {
    const raw = String(req.query.jobIds || "").trim();
    if (!raw) return next();
    const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s)))]
      .slice(0, PROVENANCE_MAX_IDS);
    if (ids.length === 0) return next();

    let rows;
    try {
      const { data, error } = await supabaseAdmin
        .from("os_queue")
        .select("job_id,org_id")
        .in("job_id", ids);
      if (error) throw new Error("os_queue lookup failed: " + error.message);
      rows = data || [];
    } catch (err) {
      log("error", "route-doors: provenance lookup failed", { requestId: req.id, error: err.message });
      return deny(res, 503, "Could not check your access", "The order queue did not answer.");
    }

    const orgOfJob = new Map();
    for (const r of rows) {
      if (r.job_id && r.org_id) orgOfJob.set(r.job_id, r.org_id);
    }
    const allowed = req.seat.owner
      ? ids
      : ids.filter((id) => orgOfJob.has(id) && req.seat.orgIds.has(orgOfJob.get(id)));

    if (allowed.length === 0 && orgOfJob.size > 0) {
      return deny(res, 403, "No seat in these jobs' spaces",
        "None of the jobs you asked about belong to a space you hold a seat in.");
    }
    req.query.jobIds = allowed.join(",");
    return next();
  }

  return {
    requireLiveSeat,
    seatForGenerate,
    seatForJob,
    seatForOrder,
    seatForProvenance,
    generate: [requireAuth, requireLiveSeat, seatForGenerate],
    job: [requireAuth, requireLiveSeat, seatForJob],
    order: [requireAuth, requireLiveSeat, seatForOrder],
    provenance: [requireAuth, requireLiveSeat, seatForProvenance],
  };
}

export default { createRouteDoors, PROVENANCE_MAX_IDS };
