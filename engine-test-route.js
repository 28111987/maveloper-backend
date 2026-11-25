/**
 * engine-test-route.js - A TEST ORDER SENT TO ONE NAMED ENGINE REVISION (25 NOV 2026).
 * =============================================================================
 *
 * THE ENGINE CHAT, 25 NOV, FOR TOPAZ-15 GATE 9: the final engine version must
 * pass real production orders at 0% traffic before any traffic moves. So the
 * backend can send a chosen order to a Cloud Run revision TAG instead of the
 * main engine address, with the same BRIDGE_SECRET and the same callback, the
 * order recorded in maveloper_jobs and delivered exactly as normal.
 *
 *   ENGINE_TEST_ROUTE=GATE9-=topaz-15
 *
 * sends every order whose ID STARTS WITH "GATE9-" (case-sensitive) AND that was
 * placed by a PLATFORM OWNER to
 *
 *   https://topaz-15---<the main engine host>
 *
 * built from MAC_BRIDGE_URL, so the address is never typed by hand.
 *
 * ★ EVERY OTHER ORDER IS EXACTLY TODAY'S. The variable unset or malformed, an
 *   order ID without the prefix, or a prefixed order from anyone who is not a
 *   platform owner: the main engine address, byte for byte as before.
 *
 * ★ FAIL CLOSED, NEVER FALL BACK. Once an owner's prefixed order is meant for
 *   the tag, it goes to the tag or it fails in words that say so: if the tagged
 *   address cannot be built, if the owner check cannot be completed, or if the
 *   tag does not answer /health (server.js). A test that quietly ran on the main
 *   engine would prove nothing, so it never does.
 *
 * Only someone with Railway access can set the variable, and only a platform
 * owner's order is routed, so a client cannot reach a test revision.
 */

/** "PREFIX=tag". The prefix: 2 to 40 of A-Z a-z 0-9 _ -. The tag: a Cloud Run revision tag. */
const PREFIX_RE = /^[A-Za-z0-9_-]{2,40}$/;
const TAG_RE = /^[a-z](?:[a-z0-9-]{0,44}[a-z0-9])?$/;

export function parseTestRoute(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const at = s.indexOf("=");
  if (at <= 0) return null;
  const prefix = s.slice(0, at).trim();
  const tag = s.slice(at + 1).trim();
  if (!PREFIX_RE.test(prefix) || !TAG_RE.test(tag) || tag.includes("---")) return null;
  return { prefix, tag };
}

/** https://<tag>---<host> from the main engine address; null when the main address is not a Cloud Run host. */
export function taggedEngineUrl(mainUrl, tag) {
  if (!TAG_RE.test(String(tag || "")) || String(tag).includes("---")) return null;
  let u;
  try { u = new URL(String(mainUrl || "")); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !host.endsWith(".run.app") || host.includes("---")) return null;
  return "https://" + tag + "---" + host;
}

/**
 * Where this order is sent. Never throws.
 *   { base, routed: false, why }             the main engine, as today
 *   { base, routed: true, tag, prefix }       the tagged revision
 *   { base: null, routed: true, tag, error }  meant for the tag but cannot go: the order fails
 *
 *   isOwner()  async, true or false; it may throw, which fails the routed order.
 *              Asked ONLY when the prefix matches, so no other order pays for it.
 */
export async function decideEngineRoute({ raw, mainUrl, orderId, isOwner }) {
  const main = (why) => ({ base: mainUrl, routed: false, why });
  const route = parseTestRoute(raw);
  if (!route) return main(String(raw ?? "").trim() ? "route-malformed" : "no-route");
  if (typeof orderId !== "string" || !orderId.startsWith(route.prefix)) return main("not-prefixed");
  let owner;
  try {
    owner = (await isOwner()) === true;
  } catch (e) {
    return { base: null, routed: true, tag: route.tag, prefix: route.prefix,
      error: "test order for engine tag " + route.tag + ": could not confirm the platform owner (" + String((e && e.message) || e).slice(0, 120) + "); not sent" };
  }
  if (!owner) return main("not-owner");
  const base = taggedEngineUrl(mainUrl, route.tag);
  if (!base) {
    return { base: null, routed: true, tag: route.tag, prefix: route.prefix,
      error: "test order for engine tag " + route.tag + ": the tagged engine address could not be built from the main engine address; not sent" };
  }
  return { base, routed: true, tag: route.tag, prefix: route.prefix };
}

/**
 * Is this person a platform owner? The same two sources as order-actions.js:
 * PLATFORM_OWNERS in the environment, then the platform_owners table. The email
 * comes from the signed-in caller, or for the queue runner from the auth user
 * the order row names (lead_user_id), never from a body field.
 */
export async function isPlatformOwnerById({ db, envOwners, userId, email }) {
  let mail = typeof email === "string" && email ? email : null;
  if (!mail) {
    if (!userId) return false;
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) throw new Error("user lookup failed: " + error.message);
    mail = data && data.user && data.user.email ? data.user.email : null;
    if (!mail) return false;
  }
  const m = mail.toLowerCase();
  if ((envOwners || []).includes(m)) return true;
  const esc = m.replace(/[\\%_]/g, (ch) => "\\" + ch);
  const { data, error } = await db.from("platform_owners").select("email").ilike("email", esc).limit(1);
  if (error) throw new Error("platform owner lookup failed: " + error.message);
  return Array.isArray(data) && data.length > 0;
}

export default { parseTestRoute, taggedEngineUrl, decideEngineRoute, isPlatformOwnerById };
