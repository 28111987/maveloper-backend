/**
 * figma-credential.js — PER-SPACE FIGMA CREDENTIAL RESOLUTION.
 *
 * ★ WHY THIS FILE EXISTS.
 * Today every Figma read in this backend uses ONE credential: the module const
 * FIGMA_API_TOKEN (server.js:107), read once at boot from a Railway env var and
 * used at server.js:5817, :5981 and :6006. It belongs to the Mavlers Figma
 * account. That has one consequence the product cannot live with:
 *
 *   A CLIENT'S DESIGN MUST BE SHARED INTO THE MAVLERS FIGMA ACCOUNT BEFORE
 *   MAVLOPER CAN READ IT.
 *
 * A client granted access to Mavloper, working in their OWN Figma account, gets
 * a 403 — the Mavlers token cannot see a file it was never invited to. Same for
 * a Mavlers developer working inside a client's account on a file the client
 * owns. The workaround (share every design into Mavlers) is the thing the owner
 * has ruled out: it makes Mavlers a custodian of client design files.
 *
 * The inverse is worse. If the fix were "collect the client's token and keep it
 * in a Mavlers env var", Mavlers would hold standing read access to that
 * client's entire Figma account. A Figma personal access token is not scoped to
 * one file. Holding it is holding the account, and the liability that comes with
 * it. So the credential is stored PER SPACE, pasted by the client, and the owner
 * never needs to see or handle the value.
 *
 * ★ WHAT THIS FILE IS, AND IS NOT.
 * It is a pure resolver plus the redaction primitives that keep the value out of
 * argv and logs. IT IS WIRED TO NO CALLER. Nothing in server.js, queue-runner.js
 * or the bridge imports it. See org_figma_credentials.sql for the table and
 * figma-credential.test.mjs for the leak gate.
 *
 * ★ THE FALLBACK IS THE WHOLE SAFETY STORY.
 * Every failure mode — no org, no table, Supabase down, row absent, row revoked,
 * token expired, token malformed — resolves to the SAME global token production
 * uses today. This module can never make an order fail that would otherwise have
 * succeeded. It fails OPEN, by design, and reports WHY in `reason` so a future
 * caller can surface "your Figma token expired" instead of an opaque 403.
 *
 * ★★ RUN 3: THIS RESOLVER UNSEALS. READ THIS BEFORE TOUCHING IT.
 * Run 2 made the write path SEAL the token (figma-credential-crypto.js) so that
 * Postgres statement logging can only ever record ciphertext. The stored value
 * is therefore `figseal.v1.<iv>.<tag>.<ct>`, NOT `figd_...`.
 *
 * Run 1's resolver handed the RAW ROW STRAIGHT TO validatePastedToken, which
 * rejects anything not beginning `figd_`. So a correctly stored, perfectly valid
 * client credential resolved to reason `malformed` and FELL BACK TO THE GLOBAL
 * MAVLERS TOKEN — with no error, no warning, no 403, and no visible difference.
 * Every client order would have quietly billed the wrong Figma account while
 * looking, from every angle the product exposes, like it worked.
 *
 * THAT IS WHY openToken() IS CALLED BEFORE validatePastedToken() BELOW, and why
 * figma-credential.test.mjs §8 seals a known value, resolves it, and asserts the
 * resolved token is byte-identical to the original. Remove the unseal step and
 * that section goes RED. It is the only thing standing between this design and a
 * silent, permanent, invisible fallback.
 *
 * ★ CREDENTIAL TYPES. Accepts a pasted string. Figma personal access tokens and
 * Org/Enterprise PLAN ACCESS TOKENS (issued by a plan admin, not a person;
 * resource allowlist; expiry up to a year) share the `figd_` prefix and the same
 * X-Figma-Token header, so both work here with no extra code path. OAuth is
 * deliberately deferred — it needs a redirect/refresh flow this table cannot hold.
 */

import { readKey, openToken, isSealed, KEY_ENV } from "./figma-credential-crypto.js";

// ---------------------------------------------------------------------------
// SHAPE
// ---------------------------------------------------------------------------

/**
 * Token-shaped prefixes. `figd_` covers personal access tokens AND plan access
 * tokens. `figu_`/`figr_` are OAuth user/refresh tokens — not accepted as a
 * pasted credential, but MATCHED here because the leak gate must recognise them
 * as secrets even though the resolver will not store them.
 */
const FIGMA_TOKEN_RE = /\bfig(?:d|u|r)_[A-Za-z0-9_-]{8,}/g;

/** The only prefix a pasted credential may carry. */
const ACCEPTED_PREFIX = "figd_";

/** True if `s` contains anything shaped like a Figma credential. */
export function looksLikeFigmaToken(s) {
  if (typeof s !== "string") return false;
  FIGMA_TOKEN_RE.lastIndex = 0;
  return FIGMA_TOKEN_RE.test(s);
}

/**
 * Strip a UTF-8 BOM and surrounding whitespace.
 *
 * NOT decorative. _autonomous_24H/lib/figma-token.mjs carries a written-up
 * incident where a PowerShell-written token file began EF BB BF, Figma answered
 * "403 Invalid token", and a 3-byte BOM was misread as an expired credential for
 * a full cycle. A pasted value can arrive with the same leading bytes, or with a
 * trailing newline from a copy. Scrub once, here.
 */
export function scrubToken(raw) {
  if (raw == null) return "";
  return String(raw).replace(/^﻿/, "").replace(/^\xEF\xBB\xBF/, "").trim();
}

/**
 * Validate a pasted credential. Returns { ok, token, error }.
 * Rejects LOUDLY on a bad prefix rather than storing it and letting the 403 read
 * as "expired" — the exact confusion the BOM incident produced.
 */
export function validatePastedToken(raw) {
  const token = scrubToken(raw);
  if (!token) {
    return { ok: false, token: null, error: "Token is empty." };
  }
  if (!token.startsWith(ACCEPTED_PREFIX)) {
    // NOTE: the bad value is NOT echoed. Saying what was wrong must not repeat
    // the secret back into a response body or a log line.
    return {
      ok: false,
      token: null,
      error:
        "That does not look like a Figma access token. Expected a value beginning " +
        "with `figd_` (Figma personal access tokens and Org/Enterprise plan access " +
        "tokens both start that way). If you pasted from a file written by " +
        "PowerShell, check for an invisible byte-order mark at the start.",
    };
  }
  if (token.length < ACCEPTED_PREFIX.length + 8) {
    return { ok: false, token: null, error: "That token is too short to be complete. Copy the whole value." };
  }
  if (/\s/.test(token)) {
    return { ok: false, token: null, error: "That token contains a space or newline. Copy the whole value with no line breaks." };
  }
  return { ok: true, token, error: null };
}

// ---------------------------------------------------------------------------
// REDACTION + THE LEAK GATE
// ---------------------------------------------------------------------------

/** Replace every token-shaped run in `s` with a fixed marker. Never reversible. */
export function redactTokens(s) {
  if (typeof s !== "string") return s;
  return s.replace(FIGMA_TOKEN_RE, "figd_[REDACTED]");
}

/**
 * THE LEAK GATE.
 *
 * ★ WHY IT HAS TO EXIST AS A TEST AND NOT AS A RULE.
 * bridge-server.mjs:270 is `console.log("[bridge] Spawning: node " +
 * runnerArgs.join(" "))`. It prints EVERY flag verbatim, and that output goes to
 * Cloud Run logs. If run 3 threads the per-space token as a cc-runner FLAG, the
 * client's Figma credential is written to a log Mavlers retains — which is the
 * custody problem this whole design exists to avoid, reintroduced through the
 * back door. Process argv is also world-readable to any other process on the
 * box (`ps`, Task Manager), so argv leaks the token even with logging off.
 *
 * The correct carrier is the spawn `env` option: bridge-server.mjs:273 spawns a
 * FRESH process per job with no env option today, so adding a per-job env is a
 * per-order token by construction, and env is not printed by that log line.
 *
 * `haystacks` is anything that could carry the value outward: argv arrays, log
 * lines, a serialised error, a response body.
 *
 * Two independent detectors, because either alone is blind:
 *   1. SHAPE — the figd_/figu_/figr_ regex. Catches a token nobody told us about.
 *   2. EXACT — a substring scan for `secrets` you hand it. Catches a real token
 *      whose shape the regex does not anticipate, and catches a fragment.
 *
 * Returns { ok, leaks: [{ where, detector, sample }] }. `sample` is REDACTED —
 * a gate that prints the secret to prove the secret leaked is the same defect.
 */
export function findTokenLeaks(haystacks, { secrets = [] } = {}) {
  const leaks = [];
  const live = (Array.isArray(secrets) ? secrets : [secrets])
    .map((s) => scrubToken(s))
    .filter((s) => s.length >= 8);

  const entries = [];
  const walk = (value, where) => {
    if (value == null) return;
    if (typeof value === "string") { entries.push([where, value]); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${where}[${i}]`)); return; }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, `${where}.${k}`);
      return;
    }
    entries.push([where, String(value)]);
  };
  walk(haystacks, "$");

  for (const [where, text] of entries) {
    if (looksLikeFigmaToken(text)) {
      leaks.push({ where, detector: "shape", sample: redactTokens(text).slice(0, 160) });
      continue;
    }
    for (const secret of live) {
      if (text.includes(secret)) {
        leaks.push({ where, detector: "exact", sample: text.split(secret).join("[REDACTED]").slice(0, 160) });
        break;
      }
    }
  }
  return { ok: leaks.length === 0, leaks };
}

/** findTokenLeaks, but throws. The assertion form for a test or a boot check. */
export function assertNoTokenLeak(haystacks, opts = {}) {
  const { ok, leaks } = findTokenLeaks(haystacks, opts);
  if (ok) return true;
  const lines = leaks.map((l) => `  ${l.where}  [${l.detector}]  ${l.sample}`).join("\n");
  throw new Error(`TOKEN LEAK: a Figma credential reached ${leaks.length} place(s) it must never reach:\n${lines}`);
}

// ---------------------------------------------------------------------------
// THE RESOLVER
// ---------------------------------------------------------------------------

export const CREDENTIAL_TABLE = "org_figma_credentials";

/**
 * Reduce anything an upstream caller might hand us to "a usable org id, or null".
 *
 * Accepts only a non-empty string or a number. REJECTS the literal strings
 * "null" and "undefined" because those are what `String(x ?? 'null')` produces,
 * and a query for org_id = 'null' silently matches nothing - which resolves to
 * the global token and looks identical to having no credential stored.
 */
export function normalisedOrgId(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s === "null" || s === "undefined" || s === "NaN") return null;
  return s;
}

/**
 * resolveFigmaToken(orgId, { db, globalToken, now })
 *
 * Returns the space's own Figma token when one is stored, usable and unexpired;
 * otherwise the global token production uses today.
 *
 *   db          a service-role Supabase client (supabaseAdmin). Omit → global.
 *   globalToken the existing FIGMA_API_TOKEN. Omit → falls back to
 *               process.env.FIGMA_API_TOKEN, then FIGMA_TOKEN, so this module
 *               works from either repo's naming without either being renamed.
 *   now         injectable clock, for testing expiry.
 *
 * Resolves to:
 *   { token, source, reason, orgId, label, expiresAt, expired, tokenKind }
 *
 *   source  'org'    the space's own credential
 *           'global' the Mavlers credential — today's behaviour, unchanged
 *           'none'   neither exists (caller decides; we do not throw)
 *   reason  why, in one machine-readable token. NEVER contains the secret.
 *
 * ★ IT NEVER THROWS AND IT NEVER RETURNS A TOKEN IT HAS NOT SHAPE-CHECKED.
 * Every error path lands on the global token. A Supabase outage degrades this to
 * exactly the behaviour of the code that ships today.
 */
export async function resolveFigmaToken(
  orgId,
  { db = null, globalToken = null, now = null, key = null, env = null } = {}
) {
  const fallback = scrubToken(
    globalToken ?? process.env.FIGMA_API_TOKEN ?? process.env.FIGMA_TOKEN ?? ""
  );
  const global = (reason) => ({
    token: fallback || null,
    source: fallback ? "global" : "none",
    reason,
    orgId: normalisedOrgId(orgId),
    label: null,
    expiresAt: null,
    expired: false,
    tokenKind: null,
    wasSealed: false,
  });

  // ★ THE `String(r.org_id ?? 'null')` TRAP, HANDLED AT THE DOOR.
  // The per-space LOCK bug was exactly this shape: an id stringified upstream
  // turned every key into the literal text "null", the lock never matched, and
  // FOUR THEORIES WERE CHECKED AND ALL FOUR WERE WRONG before anyone read the
  // select list. A literal "null"/"undefined" is NOT an org id and must take the
  // same path a genuinely absent one takes - the GLOBAL TOKEN, without throwing.
  orgId = normalisedOrgId(orgId);
  if (!orgId) return global("no-org-id");
  if (!db || typeof db.from !== "function") return global("no-db-client");

  let row = null;
  try {
    const { data, error } = await db
      .from(CREDENTIAL_TABLE)
      .select("org_id,token,label,token_kind,expires_at,is_active")
      .eq("org_id", orgId)
      .maybeSingle();
    // An RLS refusal and a missing table BOTH arrive here as an error, not as an
    // exception. Treat either as "no per-space credential" and keep going: this
    // module must not be able to take production down by being deployed before
    // the table is created.
    if (error) return global(`lookup-failed:${String(error.code || "unknown")}`);
    row = data;
  } catch (err) {
    return global("lookup-threw");
  }

  if (!row) return global("no-row-for-org");
  if (row.is_active === false) return global("revoked");

  const expiresAt = row.expires_at ?? null;
  // NULL expiry means NO EXPIRY DECLARED, not expired. Figma personal tokens
  // predating the expiry option genuinely have none.
  const expired = expiresAt != null && new Date(expiresAt).getTime() <= (now ?? Date.now());
  if (expired) {
    return { ...global("expired"), label: row.label ?? null, expiresAt, expired: true };
  }

  // ─── ★★ THE UNSEAL. THE STEP WHOSE ABSENCE IS INVISIBLE. ─────────────────
  // The row holds ciphertext (see the header note). Open it BEFORE shape-checking,
  // because a sealed value fails the `figd_` check by construction.
  //
  // The key is resolved here rather than required of the caller, so that a caller
  // that forgets to pass one cannot silently degrade to the global token: a
  // MISSING KEY WITH A SEALED ROW IS A DISTINCT, NAMED REASON (`no-seal-key`),
  // not the same `malformed` a garbage row produces. Those two want different
  // operator actions - set the env var, versus re-paste the token - and a single
  // reason covering both is an instrument that cannot discriminate.
  const wasSealedRow = isSealed(row.token);
  let sealingKey = key;
  if (wasSealedRow && !sealingKey) {
    const keyRead = readKey(env ? env[KEY_ENV] : process.env[KEY_ENV]);
    if (!keyRead.ok) {
      return { ...global("no-seal-key"), label: row.label ?? null, expiresAt };
    }
    sealingKey = keyRead.key;
  }

  const opened = openToken(row.token, sealingKey);
  if (!opened.ok) {
    // Wrong key, truncated ciphertext or a tampered tag. All three mean the same
    // thing operationally: this row cannot be used and the client re-pastes.
    return { ...global("unopenable"), label: row.label ?? null, expiresAt };
  }

  const check = validatePastedToken(opened.token);
  if (!check.ok) {
    // Stored value is not token-shaped. Do NOT send it — a 403 from a malformed
    // token reads exactly like an expired one and costs a day to diagnose.
    return { ...global("malformed"), label: row.label ?? null, expiresAt };
  }

  return {
    token: check.token,
    source: "org",
    reason: "org-credential",
    orgId,
    label: row.label ?? null,
    expiresAt,
    expired: false,
    tokenKind: row.token_kind ?? "personal",
    wasSealed: opened.wasSealed,
  };
}

/**
 * A log-safe summary of a resolution. THE SHAPE A CALLER SHOULD LOG.
 * It is the resolution with `token` replaced by a boolean, so there is no way to
 * log the outcome and accidentally log the value.
 */
export function describeResolution(r) {
  if (!r) return { resolved: false };
  return {
    resolved: Boolean(r.token),
    source: r.source,
    reason: r.reason,
    orgId: r.orgId ?? null,
    label: r.label ?? null,
    expiresAt: r.expiresAt ?? null,
    expired: Boolean(r.expired),
    tokenKind: r.tokenKind ?? null,
    wasSealed: Boolean(r.wasSealed),
  };
}

/**
 * ★ THE PROVENANCE SIGNAL, IN ONE LINE THE OWNER CAN READ WITHOUT A DECODER.
 *
 * A silent fallback is invisible unless every delivered order SAYS which account
 * paid for it. This renders that sentence. It is built from `describeResolution`,
 * so there is no code path by which the token itself can reach it: the value is
 * simply not present in the object this reads.
 *
 * ASCII only, and NO EM DASH - it lands in maveloper_jobs.progress_message, which
 * is user-facing text under the osVoice house rule.
 */
export function credentialProvenanceLine(r) {
  const d = describeResolution(r);
  if (!d.resolved) return "Figma credential: NONE resolved (reason: " + String(d.reason || "unknown") + ")";
  if (d.source === "org") {
    return (
      "Figma credential: this space's own token" +
      (d.label ? ' ("' + String(d.label).slice(0, 60) + '")' : "") +
      (d.wasSealed ? "" : " [stored unsealed]")
    );
  }
  return "Figma credential: global Mavlers token (reason: " + String(d.reason || "unknown") + ")";
}

export default {
  CREDENTIAL_TABLE,
  normalisedOrgId,
  credentialProvenanceLine,
  resolveFigmaToken,
  validatePastedToken,
  looksLikeFigmaToken,
  scrubToken,
  redactTokens,
  findTokenLeaks,
  assertNoTokenLeak,
  describeResolution,
};
