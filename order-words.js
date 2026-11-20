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
/**
 * ★ 19 NOV: Figma answered 429 (too many requests). Measured on HAMILTON
 * (job af5a2a94): the engine's picture export got 429 for one file, and the
 * client read "an automatic quality check stopped it ... learn what to change",
 * which sent them to change a design that had nothing wrong with it. The words
 * the engine chat asked for, 19 NOV 22:04.
 */
export const FIGMA_TOO_MANY =
  "Figma refused too many requests for this file, so the design could not be read. Wait a few minutes and resubmit. " +
  "If it happens again, the Figma plan that owns the file may be out of its allowance: copy the file into the Mavlers Figma space and submit the new link.";
/** Figma sent no picture for some elements, and no 429 was recorded. */
export const FIGMA_PICTURES_MISSING =
  "Figma did not send the pictures this design needs. Wait a few minutes and resubmit. " +
  "If it happens again, write to " + SUPPORT + " with the order id.";
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
  if (r.source === "member-oauth") return label ? (label.includes("@") ? label.split("@")[0] : label.slice(0, 60)) : "your own Figma account";
  return "Mavloper's own Figma account";
}

/**
 * 20 NOV, THE OWNER: the failure said what was wrong and nothing a developer
 * could do about it. Both refusals now end with the two ways out, connecting
 * the account that owns the file FIRST (17:04, his order), then sharing the
 * file with the account that was used. Generate now refuses such a link before
 * it is queued (figma-access-check.js), so these sentences are the rare case
 * the check could not see in advance. The failure email carries the same
 * "Connect my Figma account" button.
 */
// 17:31, the owner: shorter and sharper. Connect first, then share, then resubmit.
const CONNECT_OR_SHARE = "Connect the Figma account that owns it on Generate, or share the file with ";
const SEAT_THEN = " (Dev or Full seat), then resubmit.";

/**
 * The orderer had connected their OWN Figma account in this space and it could
 * not open the file, and neither could the space's account that was tried next.
 * Both are named (never an address), so the person knows which two to check.
 */
export function figmaCannotOpenEither(memberName, spaceName) {
  return (
    "Mavloper could not open this Figma file with your account (" + String(memberName || "yours") +
    ") or the space's (" + String(spaceName || "the space's") + "). " + CONNECT_OR_SHARE + "either" + SEAT_THEN
  );
}

/** T2: the Figma refusal, naming the account that was used. */
export function figmaCannotOpen(accountName) {
  // The account's name in brackets: on a client's screen it is a handle or an
  // address cut to its local part (accountNameOf), which reads as a word, not a name.
  return "Mavloper could not open this Figma file with the Figma account (" + String(accountName || "this space's") + "). " + CONNECT_OR_SHARE + "that account" + SEAT_THEN;
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

/** A space created after 19 NOV 2026 takes no orders until its own Figma account is connected. */
export const NO_SPACE_FIGMA =
  "This space has no Figma account yet. An Admin connects one on the Admin page.";

/** No Figma credential at all for this order. */
export const NO_FIGMA_ACCOUNT =
  "Mavloper has no Figma account to read this design with. Connect a Figma account to this space, or write to " + SUPPORT + ".";

// Sentences this file wrote, so a reason is never translated twice. The handler
// prefixes its own refusals ("Figma fetch failed: <details>"), so an embedded
// sentence of ours is found and returned on its own.
const OURS = [
  ENGINE_LOST, START_FAILED, NO_EMAIL, INTERNAL, DECLINED, FIGMA_PLAN_LIMIT, BAD_LINK, NO_FIGMA_ACCOUNT,
  ENGINE_UPDATING, ENGINE_STOPPED_MORE_THAN_ONCE, NO_SPACE_FIGMA, FIGMA_TOO_MANY, FIGMA_PICTURES_MISSING,
];
const OURS_RE = [
  /The build ran longer than \d+ minutes and was stopped on our side\. Please resubmit\./,
  /Mavloper could not open this Figma file with the Figma account connected to this space \(.+?\)\. Make sure that account can open the file: it needs a Dev or Full seat in the team that owns it\./,
  /Mavloper could not open this Figma file with your own connected Figma account \(.+?\) or with this space's \(.+?\)\. Make sure one of them can open the file: it needs a Dev or Full seat in the team that owns it\./,
  // 20 NOV 17:31 wording (short, connect first). Rows already written keep theirs and match above.
  /Mavloper could not open this Figma file with the Figma account \(.+?\)\. Connect the Figma account that owns it on Generate, or share the file with that account \(Dev or Full seat\), then resubmit\./,
  /Mavloper could not open this Figma file with your account \(.+?\) or the space's \(.+?\)\. Connect the Figma account that owns it on Generate, or share the file with either \(Dev or Full seat\), then resubmit\./,
  // the 19 NOV wording of the no-account sentence, on rows already written
  /This space has no Figma account connected yet\. An Admin of the space connects one on the Admin page, then orders can be placed\./,
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
  // ★ 19 NOV: Figma did not send the pictures. AHEAD of the guard rule below:
  // the engine reports it as a guard (FIGMA_RENDER_INCOMPLETE, "THE COMPILER
  // REFUSED"), but its own record says "NOT a verdict on this design". With a
  // 429 anywhere in the reason it is too many requests; without, it is said
  // as missing pictures, never as a quality check.
  if (/Figma did not render|FIGMA_RENDER_INCOMPLETE/i.test(s)) {
    return /\b429\b|too many requests|rate[- ]?limit/i.test(s) ? FIGMA_TOO_MANY : FIGMA_PICTURES_MISSING;
  }
  // the handler's user errors: a wrong link, a page instead of a frame, several frames
  if (/Multiple email frames|Invalid Figma URL|Figma URL|node-id|Copy link|email-shaped|email design frame|no content\. Check the URL/i.test(s)) {
    return BAD_LINK;
  }
  // A 429 is too many requests (it can clear in minutes); a 402 or a stated
  // plan limit or quota is the plan itself. They were one sentence before 19 NOV.
  if (/\b429\b|rate-limited|rate limited|too many requests/i.test(s)) return FIGMA_TOO_MANY;
  if (/\b402\b|plan limit|quota/i.test(s)) return FIGMA_PLAN_LIMIT;
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
  SUPPORT, ENGINE_LOST, START_FAILED, NO_EMAIL, INTERNAL, DECLINED, FIGMA_PLAN_LIMIT, FIGMA_TOO_MANY, FIGMA_PICTURES_MISSING, BAD_LINK, NO_FIGMA_ACCOUNT,
  ENGINE_UPDATING, ENGINE_STOPPED_MORE_THAN_ONCE, ENGINE_RESENT, NO_SPACE_FIGMA,
  tookTooLong, accountNameOf, figmaCannotOpen, figmaCannotOpenEither, stoppedBy, cancelledBy, lateResultNote,
  lateResultDelivered, istClock, plainReason,
};
