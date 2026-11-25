// engine-test-route.test.mjs - 25 NOV 2026: one prefixed test order from a platform owner to a named engine
// revision (TOPAZ-15 gate 9), and the Dropbox refusal reason.
//   node engine-test-route.test.mjs        (exit 0 = every case passed)
// Expected values come from the engine chat's CLEAR (25 NOV 18:49), never from the code:
//   ENGINE_TEST_ROUTE=GATE9-=topaz-15 sends every order whose ID starts with GATE9- AND that a platform owner
//   placed to https://topaz-15---engine-f6n4shfhqq-el.a.run.app; a client's order with that prefix, and every
//   order without it, goes to the main address as today; fail closed, never a fall-back.
import { readFileSync } from "node:fs";
import { parseTestRoute, taggedEngineUrl, decideEngineRoute, isPlatformOwnerById } from "./engine-test-route.js";
import { dropboxErrorDetail } from "./dropbox-upload.js";

let pass = 0, fail = 0;
function eq(name, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} | expected: ${JSON.stringify(expected)} | actual: ${JSON.stringify(actual)}`);
}

const MAIN = "https://engine-f6n4shfhqq-el.a.run.app";
const TAG_URL = "https://topaz-15---engine-f6n4shfhqq-el.a.run.app";
const RAW = "GATE9-=topaz-15";
const owner = async () => true;
const client = async () => false;
let asked = 0;
const counted = async () => { asked += 1; return true; };

// ── THE THREE ORDERS THE ENGINE CHAT NAMED ────────────────────────────────
eq("an order WITHOUT the prefix goes to the main address", MAIN,
  (await decideEngineRoute({ raw: RAW, mainUrl: MAIN, orderId: "TEST25-0219", isOwner: owner })).base);
eq("a CLIENT's order WITH the prefix goes to the main address", { base: MAIN, routed: false, why: "not-owner" },
  await decideEngineRoute({ raw: RAW, mainUrl: MAIN, orderId: "GATE9-01", isOwner: client }));
eq("the OWNER's order with the prefix goes to the tag", { base: TAG_URL, routed: true, tag: "topaz-15", prefix: "GATE9-" },
  await decideEngineRoute({ raw: RAW, mainUrl: MAIN, orderId: "GATE9-01", isOwner: owner }));
eq("all sixteen holdout orders route with one setting", 16,
  (await Promise.all(Array.from({ length: 16 }, (_, i) => decideEngineRoute({ raw: RAW, mainUrl: MAIN, orderId: "GATE9-H" + (i + 1), isOwner: owner }))))
    .filter((r) => r.base === TAG_URL).length);

// ── EVERY OTHER ORDER IS TODAY'S, AND PAYS NOTHING FOR THE CHECK ──────────
asked = 0;
await decideEngineRoute({ raw: RAW, mainUrl: MAIN, orderId: "TEST25-0219", isOwner: counted });
await decideEngineRoute({ raw: undefined, mainUrl: MAIN, orderId: "GATE9-01", isOwner: counted });
eq("the owner check is never asked for an unprefixed order or with no route", 0, asked);
eq("no variable: main", { base: MAIN, routed: false, why: "no-route" }, await decideEngineRoute({ raw: "", mainUrl: MAIN, orderId: "GATE9-01", isOwner: owner }));
eq("the prefix is case-sensitive", MAIN, (await decideEngineRoute({ raw: RAW, mainUrl: MAIN, orderId: "gate9-01", isOwner: owner })).base);
eq("the prefix must lead, not appear", MAIN, (await decideEngineRoute({ raw: RAW, mainUrl: MAIN, orderId: "X-GATE9-01", isOwner: owner })).base);
eq("no order ID: main", MAIN, (await decideEngineRoute({ raw: RAW, mainUrl: MAIN, orderId: undefined, isOwner: owner })).base);
for (const bad of ["GATE9-", "=topaz-15", "GATE9-=", "GATE9-=Topaz-15", "GATE9-=topaz---15", "GATE9-=topaz_15", "GATE9-=-topaz", "G=topaz-15", "GATE9-=https://evil.example"]) {
  eq(`malformed "${bad}" routes nothing`, { base: MAIN, routed: false, why: "route-malformed" },
    await decideEngineRoute({ raw: bad, mainUrl: MAIN, orderId: "GATE9-01", isOwner: owner }));
}

// ── FAIL CLOSED ───────────────────────────────────────────────────────────
const lookupDown = await decideEngineRoute({ raw: RAW, mainUrl: MAIN, orderId: "GATE9-01", isOwner: async () => { throw new Error("db down"); } });
eq("owner check fails: the order fails, it is never sent to the main engine", [null, true, true],
  [lookupDown.base, lookupDown.routed, /could not confirm the platform owner/.test(lookupDown.error)]);
const notRunApp = await decideEngineRoute({ raw: RAW, mainUrl: "https://abc.ngrok.io", orderId: "GATE9-01", isOwner: owner });
eq("tag address cannot be built: the order fails", [null, true], [notRunApp.base, /could not be built/.test(notRunApp.error)]);
eq("parse", { prefix: "GATE9-", tag: "topaz-15" }, parseTestRoute(" GATE9-=topaz-15 "));
eq("tagged address from the main host", TAG_URL, taggedEngineUrl(MAIN, "topaz-15"));
eq("tagged address refuses an already tagged host", null, taggedEngineUrl(TAG_URL, "topaz-16"));
eq("tagged address refuses http", null, taggedEngineUrl("http://engine-f6n4shfhqq-el.a.run.app", "topaz-15"));

// ── WHO IS AN OWNER: the auth user the order names, never a body field ────
const fakeDb = (ownerEmails, userEmail, fail = false) => ({
  auth: { admin: { getUserById: async () => (fail ? { data: null, error: { message: "x" } } : { data: { user: { email: userEmail } }, error: null }) } },
  from: () => ({ select: () => ({ ilike: (_c, v) => ({ limit: async () => ({ data: ownerEmails.filter((e) => e === v).map((email) => ({ email })), error: null }) }) }) }),
});
eq("owner by table", true, await isPlatformOwnerById({ db: fakeDb(["shrujal@mavlers.com"], "Shrujal@Mavlers.com"), envOwners: [], userId: "u1" }));
eq("owner by PLATFORM_OWNERS", true, await isPlatformOwnerById({ db: fakeDb([], "boss@x.com"), envOwners: ["boss@x.com"], userId: "u1" }));
eq("a client is not an owner", false, await isPlatformOwnerById({ db: fakeDb(["shrujal@mavlers.com"], "megan@inboxarmy.com"), envOwners: [], userId: "u2" }));
eq("no user on the order: not an owner", false, await isPlatformOwnerById({ db: fakeDb(["shrujal@mavlers.com"], null), envOwners: [], userId: null }));
let threw = false;
try { await isPlatformOwnerById({ db: fakeDb([], null, true), envOwners: [], userId: "u1" }); } catch { threw = true; }
eq("a failed user lookup throws (so a routed order fails closed)", true, threw);

// ── THE WIRING IN server.js (fails on fade813, which has none of it) ──────
const src = readFileSync(new URL("./server.js", import.meta.url), "utf8");
eq("dispatch posts to engineBase, not MAC_BRIDGE_URL", [true, false],
  [src.includes("await fetch(`${engineBase}/generate`"), src.includes("await fetch(`${MAC_BRIDGE_URL}/generate`")]);
eq("engineBase is MAC_BRIDGE_URL unless routed", true,
  src.includes("const engineBase = engineRoute && engineRoute.routed && engineRoute.base ? engineRoute.base : MAC_BRIDGE_URL;"));
eq("a routed order that cannot go fails before anything is sent", true,
  src.includes("if (engineRoute && engineRoute.error) throw new Error(engineRoute.error);"));
eq("every health wait in the dispatch asks the same engine", 3, (src.match(/waitForEngineHealth\(requestId, engineBase\)/g) || []).length);
eq("the order path reads ENGINE_TEST_ROUTE and passes the route", [true, true],
  // \r?\n: on a Windows checkout server.js has CRLF line endings (the 25 NOV run on the owner's machine).
  [src.includes("raw: process.env.ENGINE_TEST_ROUTE,"), /\n {10}engineRoute,\r?\n {8}\}\);/.test(src)]);
eq("an unrouted order's log line, pending entry and two delivery_meta writes gain no key", 4, (src.match(/\.\.\.\(engineTag \? \{ engine(Tag|Base) \} : \{\}\)/g) || []).length);
eq("the health message for an unrouted order is unchanged", true,
  src.includes('`engine${engineTag ? " tag " + engineTag : ""} did not answer /health within'));

// ── DROPBOX: the reason a file was refused ────────────────────────────────
eq("409 with Dropbox's summary", { status: 409, summary: "path/conflict/file/.." },
  dropboxErrorDetail({ status: 409, error: { error_summary: "path/conflict/file/..", error: { ".tag": "path" } }, headers: { secret: "x" } }));
eq("a body without a summary is kept, shortened", { status: 409, summary: '{"error":{".tag":"too_many_write_operations"}}' },
  dropboxErrorDetail({ status: 409, error: { error: { ".tag": "too_many_write_operations" } } }));
eq("a plain Error gives no status and no summary", { status: null, summary: null }, dropboxErrorDetail(new Error("socket hang up")));
eq("never longer than 300 characters", 300, dropboxErrorDetail({ status: 409, error: { error_summary: "x".repeat(999) } }).summary.length);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
