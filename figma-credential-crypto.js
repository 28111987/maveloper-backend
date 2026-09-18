/**
 * figma-credential-crypto.js — SEALING A CLIENT'S FIGMA TOKEN BEFORE IT REACHES
 * POSTGRES.
 * =============================================================================
 *
 * ★★ WHY THIS MODULE EXISTS, AND IT IS NOT "ENCRYPTION AT REST" THEATRE.
 *
 * The write path INSERTs a client's Figma token into `org_figma_credentials`.
 * The Supabase client does NOT interpolate that value into SQL text — PostgREST
 * binds it as a parameter — and that is where the reasoning usually stops.
 *
 * IT IS NOT ENOUGH, AND THE REASON IS THE ONE NOBODY CHECKS:
 *
 *   log_statement = 'none'  INSERT is not logged.            SAFE
 *   log_statement = 'ddl'   INSERT is not logged.            SAFE
 *   log_statement = 'mod'   INSERT IS logged.                LEAK
 *   log_statement = 'all'   INSERT IS logged.                LEAK
 *
 * and under the two that log it, Postgres emits the bound values on a following
 * `DETAIL:  parameters: $1 = '...'` line. `log_parameter_max_length` governs
 * that, and ITS DEFAULT IS -1, WHICH MEANS LOG THE PARAMETER IN FULL. So a
 * parameterised INSERT of a secret is logged verbatim on two of the four
 * settings. Binding protects against SQL INJECTION. It does not protect against
 * STATEMENT LOGGING, and those are different problems that the word
 * "parameterised" is often used to answer at once.
 *
 * This session CANNOT READ that setting: there is no psql on this machine, no
 * Supabase CLI, and no service-role key — and PostgREST cannot read pg_settings
 * even with one. So the setting is unknown and must be ASSUMED HOSTILE.
 *
 * ★ THE ANSWER IS TO MAKE THE SETTING IRRELEVANT. If the value bound into the
 * INSERT is already ciphertext, then every one of those four settings logs
 * ciphertext. The question "is log_statement on?" stops being a security
 * question and goes back to being an operations question. That is the whole
 * purpose of this file, and it is why the write path refuses to run without it.
 *
 * ─── WHAT THIS BUYS BEYOND THE LOG ──────────────────────────────────────────
 * Run 1 stated the ceiling of the plaintext design plainly: ANYONE HOLDING THE
 * SERVICE-ROLE KEY CAN READ EVERY CLIENT TOKEN. Sealing raises that ceiling —
 * the service-role key now yields ciphertext, and the reader ALSO needs
 * FIGMA_CRED_KEY, which lives only in Railway's env and never in the database.
 * Two secrets in two systems, rather than one secret guarding another.
 *
 * ─── ★★ WHAT IT COSTS, SAID PLAINLY BEFORE ANYBODY DEPENDS ON IT ────────────
 * IF FIGMA_CRED_KEY IS LOST OR ROTATED, EVERY STORED CREDENTIAL IS DEAD. There
 * is no recovery path and this module deliberately does not invent one (a
 * key-escrow column would put the key next to the ciphertext, which is the same
 * as not encrypting). The failure is not silent and not dangerous: an
 * unopenable row resolves to `malformed` and the order falls back to the global
 * Mavlers token, which is exactly today's behaviour. The client re-pastes.
 *
 * That is the trade: a lost key costs a re-paste. A logged token costs a
 * client's Figma account.
 *
 * ─── THE CONSTRUCTION ───────────────────────────────────────────────────────
 * AES-256-GCM. AEAD, so a tampered ciphertext FAILS TO OPEN rather than opening
 * to garbage — which matters here because garbage that happens to start `figd_`
 * would be sent to Figma. 12-byte random IV per seal (never reused; GCM's one
 * catastrophic misuse is IV reuse under the same key, so it is generated per
 * call and never derived from the plaintext).
 *
 * The sealed form is SELF-DESCRIBING:
 *
 *     figseal.v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
 *
 * ★ SELF-DESCRIBING ON PURPOSE — IT SAVES A COLUMN AND A MIGRATION ORDERING
 * BUG. The alternative is a `token_sealed boolean` column, which means the
 * reader's behaviour depends on a migration having been run, and a migration is
 * run by a human while the deploy is run by a robot. They WILL be out of order
 * at least once. A prefix travels inside the value, so a row can always say what
 * it is, and a plaintext row written before this module existed still reads as
 * plaintext with no flag to consult.
 *
 * `figseal.` also cannot collide with a real credential: Figma tokens begin
 * `figd_`, and `validatePastedToken` rejects anything that does not.
 */

import crypto from "node:crypto";

/** The marker that makes a sealed value self-describing. */
export const SEAL_PREFIX = "figseal.v1.";

/** AES-256 needs exactly 32 bytes. GCM's standard IV is 12. */
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** The env var that carries the key. Named once, here. */
export const KEY_ENV = "FIGMA_CRED_KEY";

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Read the sealing key from a raw env string.
 *
 * Accepts base64/base64url (44 chars) or hex (64 chars) — both are what
 * `openssl rand -base64 32` and `openssl rand -hex 32` produce, and an owner
 * generating a key will use one of them without being told which.
 *
 * ★ IT RETURNS A REASON, IT DOES NOT THROW AND IT NEVER ECHOES THE KEY. A
 * wrong-length key is an operator error that has to be readable in a 503 body,
 * and a 503 body that quotes the key back is the defect this whole run guards.
 */
export function readKey(raw) {
  const s = String(raw ?? "").trim();
  if (!s) {
    return {
      ok: false,
      key: null,
      error:
        `${KEY_ENV} is not set on the backend. A client credential cannot be stored ` +
        `until it is, because storing one unsealed would put the token into Postgres ` +
        `statement logs if log_statement is 'mod' or 'all'. Generate one with ` +
        `\`openssl rand -base64 32\` and set it in Railway.`,
    };
  }

  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    buf = Buffer.from(s, "hex");
  } else {
    try {
      buf = Buffer.from(s, "base64");
    } catch {
      buf = null;
    }
  }

  if (!buf || buf.length !== KEY_BYTES) {
    return {
      ok: false,
      key: null,
      // The LENGTH is named because that is the actionable fact; the value is not.
      error:
        `${KEY_ENV} is not a 32-byte key (decoded to ${buf ? buf.length : 0} bytes). ` +
        `Generate one with \`openssl rand -base64 32\`.`,
    };
  }
  return { ok: true, key: buf, error: null };
}

/** True if `v` is in the sealed form. Cheap, and safe on any input. */
export function isSealed(v) {
  return typeof v === "string" && v.startsWith(SEAL_PREFIX);
}

/**
 * Seal a plaintext token. Returns { ok, sealed, error }.
 *
 * ★ REFUSES TO SEAL AN ALREADY-SEALED VALUE. Double-sealing is not a security
 * problem, it is a DATA-LOSS problem: the row opens once and yields a string
 * that is itself a sealed value, which fails the `figd_` check and resolves to
 * `malformed` forever. Caught here rather than diagnosed later.
 */
export function sealToken(plaintext, key) {
  const s = String(plaintext ?? "");
  if (!s) return { ok: false, sealed: null, error: "Nothing to seal." };
  if (isSealed(s)) return { ok: false, sealed: null, error: "That value is already sealed." };
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    return { ok: false, sealed: null, error: "Sealing key is missing or not 32 bytes." };
  }
  try {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ok: true,
      sealed: SEAL_PREFIX + b64url(iv) + "." + b64url(tag) + "." + b64url(ct),
      error: null,
    };
  } catch (err) {
    // The message is OURS, not the exception's: a crypto error message can
    // contain the input in some Node builds.
    return { ok: false, sealed: null, error: "Could not seal the value." };
  }
}

/**
 * Open a sealed value. Returns { ok, token, error }.
 *
 * ★ A PLAINTEXT VALUE IS RETURNED UNCHANGED, AND THAT IS DELIBERATE. The
 * resolver must keep working against a row written before sealing existed, and
 * against a row an operator inserted by hand in the SQL editor. `wasSealed` is
 * reported so a caller can tell the two apart without guessing.
 *
 * ★ EVERY FAILURE IS THE SAME FAILURE FROM THE OUTSIDE. A wrong key, a
 * truncated ciphertext and a tampered tag all return the one message. Telling
 * them apart is useful to an attacker and useless to an operator, who re-pastes
 * in all three cases.
 */
export function openToken(sealed, key) {
  const s = String(sealed ?? "");
  if (!s) return { ok: false, token: null, wasSealed: false, error: "Nothing to open." };
  if (!isSealed(s)) {
    return { ok: true, token: s, wasSealed: false, error: null };
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    return { ok: false, token: null, wasSealed: true, error: "Sealing key is missing or not 32 bytes." };
  }
  const parts = s.slice(SEAL_PREFIX.length).split(".");
  if (parts.length !== 3) {
    return { ok: false, token: null, wasSealed: true, error: "Sealed value is malformed." };
  }
  try {
    const iv = Buffer.from(parts[0], "base64url");
    const tag = Buffer.from(parts[1], "base64url");
    const ct = Buffer.from(parts[2], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16) {
      return { ok: false, token: null, wasSealed: true, error: "Sealed value is malformed." };
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return { ok: true, token: pt.toString("utf8"), wasSealed: true, error: null };
  } catch {
    // GCM tag mismatch lands here. ONE message for every cause — see above.
    return {
      ok: false,
      token: null,
      wasSealed: true,
      error: "Could not open the stored credential. It was sealed with a different key.",
    };
  }
}

/**
 * The last four characters of a token — THE ONLY FRAGMENT THE PRODUCT IS EVER
 * ALLOWED TO SHOW.
 *
 * ★ WHY LAST FOUR AND NOT FIRST FOUR. The first five characters of every Figma
 * token are `figd_`, so a prefix hint identifies nothing and would render the
 * same string for every client on the platform — an instrument that cannot
 * discriminate, which this codebase has shipped enough of.
 *
 * ★ WHY FOUR AND NOT SIX. Four is the card-industry convention a reader already
 * knows how to interpret, and it is short enough that the hint cannot narrow a
 * brute-force search meaningfully. It answers exactly one question: "is the
 * credential I am looking at the one I pasted?"
 *
 * Returns null for anything too short to hint at — ABSENCE, not a padded
 * placeholder that would read as data.
 */
export function lastFour(token) {
  const s = String(token ?? "");
  if (s.length < 8) return null;
  return s.slice(-4);
}

export default { SEAL_PREFIX, KEY_ENV, readKey, isSealed, sealToken, openToken, lastFour };
