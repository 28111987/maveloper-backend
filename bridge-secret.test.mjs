// bridge-secret.test.mjs - RUN 20: the shared secret with the engine, and its
// rotation window (queue-runner.js bridgeSecretConfig, bridgeSecretAccepts).
//   node bridge-secret.test.mjs        (exit 0 = every case passed)
// Expected values from the run 20 brief's rules A1-A3, never from the code. The
// values here are dummies made per run; no case prints one. The end-to-end
// scenarios are ROT0-ROT6, ROT3X, ROTSKIP and A23 in order-control.test.mjs.
import { randomBytes } from "node:crypto";
import * as Q from "./queue-runner.js";

let pass = 0, fail = 0;
function eq(name, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} | expected: ${JSON.stringify(expected)} | actual: ${JSON.stringify(actual)}`);
}

const OLD = randomBytes(24).toString("base64url");
const NEW = randomBytes(36).toString("base64url");
const labelOf = (v) => (v === OLD ? "old" : v === NEW ? "new" : v === "change-me-in-env" ? "the code default" : v === undefined ? "(undefined)" : "(other)");
const has = typeof Q.bridgeSecretConfig === "function" && typeof Q.bridgeSecretAccepts === "function";
const missing = "(no bridgeSecretConfig / bridgeSecretAccepts in queue-runner.js)";

// A1: what is sent, and the two boot words.
const view = (env) => {
  if (!has) return missing;
  const c = Q.bridgeSecretConfig(env);
  return { sends: labelOf(c.sendValue), secretNextSet: c.secretNextSet, secretSend: c.secretSend, warn: c.sendNextWithoutNext };
};
eq("A1 no variable", { sends: "old", secretNextSet: false, secretSend: "current", warn: false }, view({ MAC_BRIDGE_SECRET: OLD }));
eq("A1 MAC_BRIDGE_SECRET unset keeps today's default", { sends: "the code default", secretNextSet: false, secretSend: "current", warn: false }, view({}));
eq("A1 NEXT set", { sends: "old", secretNextSet: true, secretSend: "current", warn: false }, view({ MAC_BRIDGE_SECRET: OLD, MAC_BRIDGE_SECRET_NEXT: NEW }));
eq("A1 NEXT set, SEND=next", { sends: "new", secretNextSet: true, secretSend: "next", warn: false }, view({ MAC_BRIDGE_SECRET: OLD, MAC_BRIDGE_SECRET_NEXT: NEW, MAC_BRIDGE_SECRET_SEND: "next" }));
eq("A1 SEND=next, NEXT unset: current, and the warning", { sends: "old", secretNextSet: false, secretSend: "current", warn: true }, view({ MAC_BRIDGE_SECRET: OLD, MAC_BRIDGE_SECRET_SEND: "next" }));
eq("A1 SEND=next, NEXT empty: as unset", { sends: "old", secretNextSet: false, secretSend: "current", warn: true }, view({ MAC_BRIDGE_SECRET: OLD, MAC_BRIDGE_SECRET_NEXT: "", MAC_BRIDGE_SECRET_SEND: "next" }));
for (const s of ["current", "", "NEXT", "Next", " next", "yes", "new", "true"]) {
  eq(`A1 SEND=${JSON.stringify(s)}, NEXT set: current`, { sends: "old", secretNextSet: true, secretSend: "current", warn: false }, view({ MAC_BRIDGE_SECRET: OLD, MAC_BRIDGE_SECRET_NEXT: NEW, MAC_BRIDGE_SECRET_SEND: s }));
}
// A3: the config's printable view holds words and booleans only.
if (has) {
  const c = Q.bridgeSecretConfig({ MAC_BRIDGE_SECRET: OLD, MAC_BRIDGE_SECRET_NEXT: NEW, MAC_BRIDGE_SECRET_SEND: "next" });
  eq("A3 the boot view is two words/booleans", { secretNextSet: true, secretSend: "next" }, Q.bridgeSecretBootFields(c));
  eq("A3 the boot view holds no secret", false, JSON.stringify(Q.bridgeSecretBootFields(c)).includes(OLD.slice(0, 8)) || JSON.stringify(Q.bridgeSecretBootFields(c)).includes(NEW.slice(0, 8)));
} else {
  eq("A3 the boot view is two words/booleans", { secretNextSet: true, secretSend: "next" }, missing);
  eq("A3 the boot view holds no secret", false, missing);
}

// A2: what a callback header is accepted with.
const accepts = (env, header) => (has ? Q.bridgeSecretAccepts(header, Q.bridgeSecretConfig(env)) : missing);
const sameLen = (s) => (s[0] === "A" ? "B" : "A") + s.slice(1);
const ONLY = { MAC_BRIDGE_SECRET: OLD };
const BOTH = { MAC_BRIDGE_SECRET: OLD, MAC_BRIDGE_SECRET_NEXT: NEW };
for (const [name, env, header, want] of [
  ["current, NEXT unset", ONLY, OLD, true],
  ["new, NEXT unset", ONLY, NEW, false],
  ["current, NEXT set", BOTH, OLD, true],
  ["new, NEXT set", BOTH, NEW, true],
  ["new, NEXT set, SEND=next", { ...BOTH, MAC_BRIDGE_SECRET_SEND: "next" }, NEW, true],
  ["current, NEXT set, SEND=next", { ...BOTH, MAC_BRIDGE_SECRET_SEND: "next" }, OLD, true],
  ["new, NEXT empty", { ...ONLY, MAC_BRIDGE_SECRET_NEXT: "" }, NEW, false],
  ["empty header, NEXT empty", { ...ONLY, MAC_BRIDGE_SECRET_NEXT: "" }, "", false],
  ["wrong value, the current's length", BOTH, sameLen(OLD), false],
  ["wrong value, the next's length", BOTH, sameLen(NEW), false],
  ["wrong value, another length", BOTH, "x", false],
  ["a prefix of the current", BOTH, OLD.slice(0, -1), false],
  ["the current plus one character", BOTH, OLD + "x", false],
  ["a prefix of the next", BOTH, NEW.slice(0, -1), false],
  ["empty header", BOTH, "", false],
  ["missing header", BOTH, undefined, false],
  ["a non-string header", BOTH, [OLD], false],
  ["a multibyte value of the current's length", BOTH, "é".repeat(OLD.length / 2), false],
]) {
  let got;
  try { got = accepts(env, header); } catch (e) { got = "threw " + e.constructor.name; }
  eq(`A2 ${name}`, want, got);
}

console.log(`bridge-secret.test.mjs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
