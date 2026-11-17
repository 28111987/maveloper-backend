/**
 * order-words.js - WHAT A CLIENT READS WHEN AN ORDER DOES NOT ARRIVE. Run 17.
 *
 * os_queue.error_text is shown on the console's FAILED rows to every person in
 * the space, clients included. Until run 17 it carried the machine's words:
 * env var names, "bridge", "token", "Runner", exit codes, engine stderr. The
 * rule (T2): plain words, what happened and what the reader can do, no internal
 * names, no em dash, and support is mavloper@mavlers.com.
 *
 * ONE PLACE. The runner writes os_queue.error_text through `plainReason`, so
 * every path that fails an order (the handler's own refusals, the engine's
 * callback, the runner's own timeouts, a person's stop) reaches the client
 * through this file. The raw reason is not lost: it stays in
 * maveloper_jobs.error_message, which no client reads, and in the logs.
 *
 * THE CONSOLE GROUPS FAILURES BY THESE WORDS (src/lib/failureCause.ts in the
 * console repository). Each sentence below carries the phrase its group's rule
 * matches; if a sentence changes, change that rule in the same breath.
 */

export const SUPPORT = "mavloper@mavlers.com";

/** L1, L5: the engine no longer holds the job, or this backend lost it. */
export const ENGINE_LOST = "The build stopped on our side. Please resubmit.";
/** The engine could not be reached or refused the order before building. */
export const START_FAILED = "The build could not start on our side. Please resubmit in a few minutes.";
/** The engine finished without an email. */
export const NO_EMAIL = "The build stopped on our side without an email. Please resubmit.";
/** An unexpected failure inside this backend. */
export const INTERNAL = "The build stopped on our side. Please resubmit. If it happens again, write to " + SUPPORT + ".";
/** The engine's own quality checks refused the design (QUALITY GATE, a compiler guard). */
export const DECLINED =
  "Mavloper could not build this design as it stands: an automatic quality check stopped it. " +
  "Write to " + SUPPORT + " with the order id to learn what to change.";
/** Figma refused for quota or plan reasons (429 / 402). */
export const FIGMA_PLAN_LIMIT =
  "Figma refused to send this design because the Figma plan that owns the file has reached its plan limit. " +
  "Wait an hour and resubmit, or copy the file into a team on a paid Figma plan.";
/** The link itself is wrong. */
export const BAD_LINK =
  "This Figma link does not point at one email frame. In Figma, right-click the email frame, choose Copy link to selection, and submit that link.";

/** RUN 19 D3: the engine kept refusing the order while it was being updated (S-DRAIN past the bound). */
export const ENGINE_UPDATING = "The engine was being updated and could not take the order. Please resubmit in a few minutes.";
/** RUN 19 D5: the engine was stopped under the order more often than Mavloper re-sends it (S-STOP past the bound).
 *  RUN 20 C1: "more than once" (it said "twice"; the default bound fails the order at the third stop). */
export const ENGINE_STOPPED_MORE_THAN_ONCE = "The engine stopped more than once while it was being updated. Please resubmit in a few minutes.";
// RUN 20 C1: run 19 wrote this sentence; a reason that carries it reads as the new one.
const ENGINE_STOPPED_TWICE_OLD = "The engine stopped twice while it was being updated. Please resubmit in a few minutes.";
/** RUN 19 D4: the progress words of an order Mavloper sent again after the engine stopped. Not a failure. */
export const ENGINE_RESENT = "The engine restarted for an update. Mavloper sent the order again.";

/** L1's timeout fallback, in minutes the runner actually uses. */
export function tookTooLong(minutes) {
  const m = Math.max(1, Math.round(Number(minutes) || 35));
  return `The build ran longer than ${m} minutes and was stopped on our side. Please resubmit.`;
}

/** The account name a client recognises, never a token, never an email. */
export function accountNameOf(resolution) {
  const r = resolution || {};
  const label = typeof r.label === "string" ? r.label.trim() : "";
  if ((r.source === "oauth" || r.source === "org") && label) {
    // An OAuth label is the Figma handle; a pasted token's label is what the
    // space typed. Either way it is the space's own name for its account. An
    // address is cut to its local part so no email reaches a client screen.
    return label.includes("@") ? label.split("@")[0] : label.slice(0, 60);
  }
  if (r.source === "oauth" || r.source === "org") return "this space's Figma account";
  return "Mavloper's own Figma account";
}

/** T2: the Figma refusal, naming the account that was used. */
export function figmaCannotOpen(accountName) {
  return (
    "Mavloper could not open this Figma file with the Figma account connected to this space (" +
    String(accountName || "this space's Figma account") +
    "). Make sure that account can open the file: it needs a Dev or Full seat in the team that owns it."
  );
}

/** K6 STOP. "(Admin)" for an Admin and for the platform owner alike, as the rule words it. */
export function stoppedBy(name) {
  return `Stopped by ${name} (Admin).`;
}

/** K6 CANCEL. An Admin's cancel says so; a Dev cancelling their own order is named alone. */
export function cancelledBy(name, asAdmin) {
  return `Cancelled by ${name}${asAdmin ? " (Admin)" : ""} before it started. It never ran.`;
}

/** L4: what a late result's fate looks like on the order. */
export function lateResultNote(at, reason) {
  return `A late result arrived at ${istClock(at)} and was discarded because ${reason}.`;
}
export function lateResultDelivered(at) {
  return `Delivered from a result that arrived at ${istClock(at)}, after the order had been marked failed.`;
}

export function istClock(d) {
  const t = new Date(d);
  if (!Number.isFinite(t.getTime())) return "an unknown time";
  const ist = new Date(t.getTime() + 330 * 60000);
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mm = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} IST`;
}

/** No Figma credential at all for this order. */
export const NO_FIGMA_ACCOUNT =
  "Mavloper has no Figma account to read this design with. Connect a Figma account to this space, or write to " + SUPPORT + ".";

// Sentences this file wrote, so a reason is never translated twice. The handler
// prefixes its own refusals ("Figma fetch failed: <details>"), so an embedded
// sentence of ours is found and returned on its own.
const OURS = [
  ENGINE_LOST, START_FAILED, NO_EMAIL, INTERNAL, DECLINED, FIGMA_PLAN_LIMIT, BAD_LINK, NO_FIGMA_ACCOUNT,
  ENGINE_UPDATING, ENGINE_STOPPED_MORE_THAN_ONCE,
];
const OURS_RE = [
  /The build ran longer than \d+ minutes and was stopped on our side\. Please resubmit\./,
  /Mavloper could not open this Figma file with the Figma account connected to this space \(.+?\)\. Make sure that account can open the file: it needs a Dev or Full seat in the team that owns it\./,
  /Stopped by .+ \(Admin\)\.(?: A late result arrived at .+)?$/,
  /Cancelled by .+ before it started\. It never ran\.(?: A late result arrived at .+)?$/,
];
function oursIn(s) {
  for (const o of OURS) if (s.includes(o)) return o;
  for (const re of OURS_RE) { const m = re.exec(s); if (m) return m[0]; }
  return null;
}

/**
 * The raw reason -> the sentence a client reads. The order of the tests is the
 * order of specificity; anything unrecognised is an internal failure, said so
 * plainly, never passed through.
 */
export function plainReason(raw) {
  const s = String(raw || "").trim();
  if (!s) return INTERNAL;
  if (s.includes(ENGINE_STOPPED_TWICE_OLD)) return ENGINE_STOPPED_MORE_THAN_ONCE;
  const ours = oursIn(s);
  if (ours) return ours;
  // RUN 19: an engine update. Ahead of the dispatch rule, because the raw S-DRAIN
  // reason also names HTTP 503. The engine's own S-STOP sentence ("Please place
  // the order again.") is never shown to a client: it reads as D5.
  if (/engine draining:|\(HTTP 503, draining\)/i.test(s)) return ENGINE_UPDATING;
  if (/engine stopped:|\bengineStopped\b|engine was stopped before this order finished building/i.test(s)) return ENGINE_STOPPED_MORE_THAN_ONCE;
  if (/No Figma credential|Figma not configured|FIGMA_API_TOKEN is not set/i.test(s)) return NO_FIGMA_ACCOUNT;
  // the handler's user errors: a wrong link, a page instead of a frame, several frames
  if (/Multiple email frames|Invalid Figma URL|Figma URL|node-id|Copy link|email-shaped|email design frame|no content\. Check the URL/i.test(s)) {
    return BAD_LINK;
  }
  if (/\b429\b|rate-limited|rate limited|too many requests|\b402\b|plan limit|quota/i.test(s)) return FIGMA_PLAN_LIMIT;
  if (/\b(401|403|404)\b|rejected the token|not found|no access|forbidden/i.test(s) && /figma/i.test(s)) {
    return figmaCannotOpen(null);
  }
  if (/QUALITY GATE|structural collapse|compiler (refused|declined)|refusal|guard/i.test(s)) return DECLINED;
  if (/no HTML|delivered no HTML|missing html/i.test(s)) return NO_EMAIL;
  if (/timed out \(>\d+ min\)|did not call back within/i.test(s)) return tookTooLong(35);
  if (/dispatch failed|rejected dispatch|UNREACHABLE|ngrok|ECONNREFUSED|fetch failed|not configured|could not start|engine did not answer/i.test(s)) {
    return START_FAILED;
  }
  if (/job row missing|processing with no job|stuck in processing|engine lost|lost the job|stopped on our side/i.test(s)) return ENGINE_LOST;
  return INTERNAL;
}

export default {
  SUPPORT, ENGINE_LOST, START_FAILED, NO_EMAIL, INTERNAL, DECLINED, FIGMA_PLAN_LIMIT, BAD_LINK, NO_FIGMA_ACCOUNT,
  ENGINE_UPDATING, ENGINE_STOPPED_MORE_THAN_ONCE, ENGINE_RESENT,
  tookTooLong, accountNameOf, figmaCannotOpen, stoppedBy, cancelledBy, lateResultNote,
  lateResultDelivered, istClock, plainReason,
};
