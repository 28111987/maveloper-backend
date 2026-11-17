/**
 * figma-credential-reseal.js - THE BOOT RE-SEAL THAT MAKES FIGMA_CRED_KEY ROTATABLE.
 * =============================================================================
 * 17 NOV 2026. FIGMA_CRED_KEY seals every space's stored Figma credential: the
 * pasted token in org_figma_credentials.token and the OAuth pair in
 * org_figma_oauth.access_token / refresh_token. Swapping the key used to make
 * every stored credential unopenable at once: pasted-token spaces silently fell
 * back to the Mavlers token and OAuth spaces had to reconnect.
 *
 * THE ROTATION THIS ENABLES (Railway variables only, nothing pasted anywhere else):
 *   1. FIGMA_CRED_KEY_PREVIOUS = the current key, FIGMA_CRED_KEY = a new key,
 *      in ONE change (one restart).
 *   2. At boot, after the server listens, resealAll() opens every sealed value,
 *      and every value that opens ONLY with the previous key is sealed again under
 *      the current key and written back. It logs COUNTS, never a value.
 *   3. Remove FIGMA_CRED_KEY_PREVIOUS (one restart). Every row now opens with the
 *      current key alone.
 *
 * WITH FIGMA_CRED_KEY_PREVIOUS ABSENT, resealAll() RETURNS AT ONCE, READS NOTHING
 * AND WRITES NOTHING. That is every boot except the rotation's.
 *
 * WHAT IT NEVER DOES
 *   - never logs, returns or throws a token, a key, a length or a fragment of one;
 *   - never touches a row it cannot open (counted as `unopenable`, left as it is,
 *     so a wrong PREVIOUS loses nothing: put the right one in and boot again);
 *   - never touches a withdrawn pasted credential (is_active false, or the word
 *     "revoked" the DELETE route writes);
 *   - never overwrites a value that changed under it: every write is conditional
 *     on the value it read (an OAuth refresh racing the boot wins, and is counted).
 */

import {
  readKey,
  readPreviousKey,
  isSealed,
  sealToken,
  openToken,
  KEY_ENV,
  PREVIOUS_KEY_ENV,
} from "./figma-credential-crypto.js";

// The table names are each written ONCE, in the module that owns the table.
import { CREDENTIAL_TABLE } from "./figma-credential.js";
import { OAUTH_TABLE } from "./figma-oauth.js";
export { CREDENTIAL_TABLE, OAUTH_TABLE };

function emptyCounts() {
  return { rows: 0, current: 0, resealed: 0, unopenable: 0, raceSkipped: 0 };
}

/**
 * Classify one stored value against the two keys.
 *   "current"    opens with the current key (nothing to do)
 *   "previous"   opens only with the previous key (re-seal it)
 *   "unopenable" opens with neither (leave it)
 *   "plain"      not sealed at all
 */
function classify(value, current, previous) {
  if (!isSealed(value)) return { kind: "plain", token: null };
  const a = openToken(value, current);
  if (a.ok) return { kind: "current", token: null };
  const b = openToken(value, previous);
  if (b.ok) return { kind: "previous", token: b.token };
  return { kind: "unopenable", token: null };
}

/**
 * resealAll({ db, env, log }) -> Promise<summary>
 *
 * summary = { ran, reason, oauth: counts, pasted: counts & { inactiveSkipped, plainActive } }
 * It never throws: a database error ends the run with ran:false and the reason.
 */
export async function resealAll({ db, env = process.env, log = () => {} } = {}) {
  const prevRead = readPreviousKey(env[PREVIOUS_KEY_ENV]);
  if (prevRead.ok && !prevRead.key) {
    return { ran: false, reason: `${PREVIOUS_KEY_ENV} is not set` };
  }
  // Fixed sentences: readKey's own errors name a decoded length, and nothing
  // about a key, its length included, is ever logged from here.
  if (!prevRead.ok) {
    return { ran: false, reason: `${PREVIOUS_KEY_ENV} is set but is not a valid 32-byte key; nothing was read or written` };
  }
  const curRead = readKey(env[KEY_ENV]);
  if (!curRead.ok) {
    return { ran: false, reason: `${KEY_ENV} is missing or not a valid 32-byte key; nothing was read or written` };
  }
  const current = curRead.key;
  const previous = prevRead.key;
  if (current.equals(previous)) {
    return { ran: false, reason: `${PREVIOUS_KEY_ENV} is the same key as ${KEY_ENV}; nothing to re-seal` };
  }
  if (!db || typeof db.from !== "function") {
    return { ran: false, reason: "no database client" };
  }

  const oauth = emptyCounts();
  const pasted = { ...emptyCounts(), inactiveSkipped: 0, plainActive: 0 };

  try {
    // -- OAuth connections: both values of a row move together or not at all.
    {
      const { data, error } = await db.from(OAUTH_TABLE).select("org_id,access_token,refresh_token");
      if (error) throw new Error(`${OAUTH_TABLE} read failed`);
      for (const row of data || []) {
        oauth.rows++;
        const a = classify(row.access_token, current, previous);
        const r = classify(row.refresh_token, current, previous);
        if (a.kind === "unopenable" || r.kind === "unopenable") { oauth.unopenable++; continue; }
        if (a.kind !== "previous" && r.kind !== "previous") { oauth.current++; continue; }
        const update = {};
        if (a.kind === "previous") {
          const s = sealToken(a.token, current);
          if (!s.ok) { oauth.unopenable++; continue; }
          update.access_token = s.sealed;
        }
        if (r.kind === "previous") {
          const s = sealToken(r.token, current);
          if (!s.ok) { oauth.unopenable++; continue; }
          update.refresh_token = s.sealed;
        }
        const { data: hit, error: upErr } = await db
          .from(OAUTH_TABLE)
          .update(update)
          .eq("org_id", row.org_id)
          .eq("access_token", row.access_token)
          .eq("refresh_token", row.refresh_token)
          .select("org_id");
        if (upErr) throw new Error(`${OAUTH_TABLE} write failed`);
        if ((hit?.length ?? 0) === 0) oauth.raceSkipped++;
        else oauth.resealed++;
      }
    }

    // -- Pasted tokens: withdrawn rows are left exactly as they are.
    {
      const { data, error } = await db.from(CREDENTIAL_TABLE).select("org_id,token,is_active");
      if (error) throw new Error(`${CREDENTIAL_TABLE} read failed`);
      for (const row of data || []) {
        pasted.rows++;
        if (row.is_active === false) { pasted.inactiveSkipped++; continue; }
        const c = classify(row.token, current, previous);
        if (c.kind === "plain") { pasted.plainActive++; continue; }
        if (c.kind === "unopenable") { pasted.unopenable++; continue; }
        if (c.kind === "current") { pasted.current++; continue; }
        const s = sealToken(c.token, current);
        if (!s.ok) { pasted.unopenable++; continue; }
        const { data: hit, error: upErr } = await db
          .from(CREDENTIAL_TABLE)
          .update({ token: s.sealed })
          .eq("org_id", row.org_id)
          .eq("token", row.token)
          .select("org_id");
        if (upErr) throw new Error(`${CREDENTIAL_TABLE} write failed`);
        if ((hit?.length ?? 0) === 0) pasted.raceSkipped++;
        else pasted.resealed++;
      }
    }
  } catch (err) {
    // Our own message only: never the driver's, which could quote a value.
    const summary = { ran: false, reason: String(err && err.message ? err.message : "re-seal failed").slice(0, 80), oauth, pasted };
    log("warn", "figma credential re-seal stopped", summary);
    return summary;
  }

  const summary = { ran: true, reason: null, oauth, pasted };
  log("info", "figma credential re-seal", summary);
  return summary;
}

export default { resealAll, CREDENTIAL_TABLE, OAUTH_TABLE };
