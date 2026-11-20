/**
 * figma-access-check.js - CAN THE ACCOUNT THIS ORDER WILL READ WITH OPEN THIS FILE? (20 NOV 2026)
 * =============================================================================
 *
 * THE OWNER, 20 NOV: a developer with no Figma account of their own kept
 * submitting a file the space's account (design@mavlers.com) could not open.
 * Each order was accepted, ran for minutes and failed, and the failure email
 * told them their link "could not be read". He asked for the file to be
 * refused AT SUBMISSION, naming the account that cannot open it, so the
 * developer can share the file or connect the account that owns it.
 *
 * THE QUESTION IS ASKED WITH THE ACCOUNT THE ORDER WILL ACTUALLY USE, in the
 * order path's own sequence (server.js /generate-from-figma): the person's own
 * connection in this space first; if Figma refuses it, the space's account
 * (readAgainAsSpace); a figma_required space with no account of its own is
 * refused outright (NO_SPACE_FIGMA).
 *
 * ★ ONE CHEAP CALL, NOT A DESIGN READ. GET /v1/files/:key/meta is a Tier 3
 * endpoint (scope file_metadata:read, which Mavloper's OAuth app requests);
 * the design read an order makes is Tier 1. So the check does not spend the
 * allowance orders draw on. Mavloper's own token and a pasted token were made
 * without file_metadata:read: for them Figma answers 403 "Invalid scope" and
 * the verdict is UNKNOWN, never a refusal.
 *
 * ★ NEVER BLOCK ON OUR OWN UNCERTAINTY. Only a definite refusal from Figma
 * (404, or a 403 that is not about scope) refuses the order. A 429, a timeout,
 * Figma not answering, or a scope we lack is UNKNOWN: the order is accepted as
 * it was before this check existed.
 *
 * ★ An answer is cached for 10 minutes per (account, file), so a batch of
 * frames from one file asks Figma once.
 */

import { figmaAuthHeaders } from "./figma-auth-header.js";
import { redactTokens } from "./figma-credential.js";

export const CHECK_URL = (fileKey) => "https://api.figma.com/v1/files/" + encodeURIComponent(fileKey) + "/meta";
// ★ 20 NOV 17:04, THE OWNER: the check must never slow anything down. Three
// seconds and it is unknown, and an unknown never holds an order.
export const CHECK_TIMEOUT_MS = 3000;
export const CHECK_CACHE_MS = 10 * 60 * 1000;

async function figmaSaid(r) {
  try {
    const b = await r.json();
    return redactTokens(String((b && (b.err || b.message || b.error)) || "")).slice(0, 160);
  } catch {
    return "";
  }
}

/**
 * One account, one file. Never throws; never returns the token.
 *   { verdict: 'open',    fileName }
 *   { verdict: 'refused', status, said }       Figma said this account cannot open it
 *   { verdict: 'unknown', status, said, why }  we could not tell
 */
export async function checkFileAccess({ token, fileKey, fetchImpl = globalThis.fetch, timeoutMs = CHECK_TIMEOUT_MS }) {
  if (!token) return { verdict: "unknown", status: null, said: "", why: "no-token" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let r;
  try {
    r = await fetchImpl(CHECK_URL(fileKey), { method: "GET", headers: figmaAuthHeaders(token), signal: controller.signal });
  } catch {
    return { verdict: "unknown", status: null, said: "", why: "no-answer" };
  } finally {
    clearTimeout(timer);
  }
  if (r.ok) {
    let name = null;
    try { const b = await r.json(); name = (b && ((b.file && b.file.name) || b.name)) || null; } catch { name = null; }
    return { verdict: "open", fileName: typeof name === "string" ? name.slice(0, 120) : null };
  }
  const said = await figmaSaid(r);
  // 21 NOV: 401 is a connection Figma no longer accepts (its grant was replaced
  // or revoked). The order would fail with certainty, so it is refused, and the
  // words say to reconnect, not to share the file.
  if (r.status === 401) return { verdict: "refused", status: 401, said, why: "token" };
  if (r.status === 404) return { verdict: "refused", status: 404, said };
  if (r.status === 403) {
    // A token made without file_metadata:read cannot ask this question at all.
    if (/scope/i.test(said)) return { verdict: "unknown", status: 403, said, why: "scope" };
    return { verdict: "refused", status: 403, said };
  }
  return { verdict: "unknown", status: r.status, said, why: r.status === 429 ? "rate-limited" : "other" };
}

/**
 * THE SENTENCES THE DEVELOPER READS ON GENERATE. No em dash; no Figma codes.
 * The account is named in full here (the Figma email the console already shows
 * on the account line), because sharing a file needs the exact address.
 *
 * ★ 20 NOV 17:04, THE OWNER: connecting the account that owns the file comes
 * FIRST, sharing second, in his words. "Connect my Figma account" is the
 * button beside the sentence on Generate and in the failure email.
 */
export const CONNECT_CTA = "Connect my Figma account";

// ★ 20 NOV 17:31, THE OWNER: shorter, sharper, easiest to act on. One line
// for what is wrong, one for what to do, connecting first.
const SEAT = "(Dev or Full seat)";

export function refusedOne(account, { mavlers = false } = {}) {
  if (mavlers) return "Mavloper's Figma account can't open this file. Connect the Figma account that owns it.";
  const a = account || "This space's Figma account";
  return a + " can't open this file. Connect the Figma account that owns it, or share the file with " + a + " " + SEAT + ".";
}

export function refusedBoth(mine, space) {
  return (
    "Neither your account (" + (mine || "yours") + ") nor the space's (" + (space || "the space's") + ") can open this file. " +
    "Connect the Figma account that owns it, or share the file with either " + SEAT + "."
  );
}

export function connectionEnded(account, { own = false } = {}) {
  return own
    ? "Your Figma connection (" + (account || "yours") + ") has ended. Reconnect it with Connect my Figma account."
    : (account || "This space's Figma account") + "'s connection to Mavloper has ended. Reconnect it on the Admin page, or connect your own with Connect my Figma account.";
}

export function readsAsSpaceInstead(mine, space) {
  return "Your account (" + (mine || "yours") + ") can't open this file, so " + (space || "the space's account") + " will read it.";
}

/**
 * THE ORDER PATH'S DECISION, ASKED IN ADVANCE. Mirrors server.js
 * /generate-from-figma step for step:
 *   1. a figma_required space with no account of its own        -> blocked
 *   2. the person's own connection, when they have one          -> asked first
 *      refused, and the space has a DIFFERENT token             -> the space is asked (readAgainAsSpace)
 *   3. otherwise the space's credential (OAuth, pasted, Mavloper's own)
 *   4. no credential at all                                      -> blocked
 *
 *   spaceCred / memberCred  the resolutions the order path makes (tokens inside)
 *   words      { mine, space, spaceKind: 'space' | 'mavlers' }  names for people
 *   ask(token) -> checkFileAccess's answer for this file
 *
 * Returns { verdict, readsWith: { kind, account }, fileName, message, why }.
 * Never carries a token.
 */
export async function decideFigmaAccess({ refuseForSpace, noAccountWords, spaceCred, memberCred, words, ask }) {
  const out = (verdict, kind, account, extra = {}) => ({ verdict, readsWith: { kind, account: account || null }, fileName: null, message: null, why: null, ...extra });
  if (refuseForSpace) return out("blocked", "none", null, { message: noAccountWords.space });
  const spaceKind = words.spaceKind;
  const spaceToken = spaceCred && spaceCred.token;
  if (memberCred && memberCred.token) {
    const a = await ask(memberCred.token);
    if (a.verdict === "open") return out("open", "own", words.mine, { fileName: a.fileName });
    if (a.verdict === "unknown") return out("unknown", "own", words.mine, { why: a.why });
    if (!spaceToken || spaceToken === memberCred.token) return out("refused", "own", words.mine, { why: a.why || null, message: a.why === "token" ? connectionEnded(words.mine, { own: true }) : refusedOne(words.mine) });
    const b = await ask(spaceToken);
    if (b.verdict === "open") return out("open", spaceKind, words.space, { fileName: b.fileName, message: readsAsSpaceInstead(words.mine, words.space) });
    if (b.verdict === "unknown") return out("unknown", spaceKind, words.space, { why: b.why });
    return out("refused", "own", words.mine, { why: b.why || null, message: b.why === "token" ? connectionEnded(words.space) : refusedBoth(words.mine, words.space) });
  }
  if (!spaceToken) return out("blocked", "none", null, { message: noAccountWords.none });
  const c = await ask(spaceToken);
  if (c.verdict === "open") return out("open", spaceKind, words.space, { fileName: c.fileName });
  if (c.verdict === "unknown") return out("unknown", spaceKind, words.space, { why: c.why });
  return out("refused", spaceKind, words.space, { why: c.why || null, message: c.why === "token" ? connectionEnded(words.space) : refusedOne(words.space, { mavlers: spaceKind === "mavlers" }) });
}

export default { checkFileAccess, decideFigmaAccess, refusedOne, refusedBoth, readsAsSpaceInstead, connectionEnded, CONNECT_CTA, CHECK_URL, CHECK_CACHE_MS, CHECK_TIMEOUT_MS };
