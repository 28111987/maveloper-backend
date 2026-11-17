// engine-update.test.mjs - RUN 19 (run 20: C1, the bounded-stop sentence): the pure parts of "an order that meets an
// engine update is sent again" (queue-runner.js, order-words.js).
//   node engine-update.test.mjs        (exit 0 = every case passed)
// Expected values from the run 19 brief's rules D1, D2, D3, D5 and D9, never from
// the code. The end-to-end scenarios are X1-X10 in order-control.test.mjs.
import { engineUpdateLimits, isDrainAnswer, retryAfterSeconds } from "./queue-runner.js";
import * as W from "./order-words.js";
const { plainReason, ENGINE_UPDATING, ENGINE_RESENT, START_FAILED, INTERNAL } = W;
// RUN 20 C1: the bounded-stop sentence, from the rule (it said "twice"; the default
// bound fails the order at the third stop). The old sentence maps to it.
const D5 = "The engine stopped more than once while it was being updated. Please resubmit in a few minutes.";
const D5_OLD = "The engine stopped twice while it was being updated. Please resubmit in a few minutes.";

let pass = 0, fail = 0;
function eq(name, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} | expected: ${JSON.stringify(expected)} | actual: ${JSON.stringify(actual)}`);
}

const DRAIN = '{"status":"draining","error":"This engine is shutting down for an update and takes no new orders. Send the order again: another engine takes it.","engineDraining":true}';

// D2 / D4 bounds: defaults, one place, env-overridable.
eq("bounds default", { drainResendMax: 3, stopRedispatchMax: 2 }, engineUpdateLimits({}));
eq("bounds from env", { drainResendMax: 1, stopRedispatchMax: 0 }, engineUpdateLimits({ DRAIN_RESEND_MAX: "1", STOP_REDISPATCH_MAX: "0" }));
eq("bounds: junk keeps the default", { drainResendMax: 3, stopRedispatchMax: 2 }, engineUpdateLimits({ DRAIN_RESEND_MAX: "abc", STOP_REDISPATCH_MAX: "-1" }));
eq("bounds: blank keeps the default", { drainResendMax: 3, stopRedispatchMax: 2 }, engineUpdateLimits({ DRAIN_RESEND_MAX: "", STOP_REDISPATCH_MAX: " " }));

// D1: ONLY a 503 with the draining JSON body.
eq("D1 the engine's exact answer", true, isDrainAnswer(503, DRAIN));
eq("D1 status draining alone", true, isDrainAnswer(503, '{"status":"draining"}'));
eq("D1 engineDraining alone", true, isDrainAnswer(503, '{"engineDraining":true}'));
eq("D1 engineDraining as a string is not it", false, isDrainAnswer(503, '{"engineDraining":"true"}'));
eq("D1 a 503 with another body", false, isDrainAnswer(503, '{"error":"Service Unavailable"}'));
eq("D1 a 503 with no body", false, isDrainAnswer(503, ""));
eq("D1 a 503 HTML page", false, isDrainAnswer(503, "<html><body>draining</body></html>"));
eq("D1 a 500 with the draining body", false, isDrainAnswer(500, DRAIN));
eq("D1 a 401", false, isDrainAnswer(401, '{"error":"Unauthorized"}'));
eq("D1 a 202", false, isDrainAnswer(202, DRAIN));

// D2: Retry-After.
for (const [h, want] of [[null, 5], [undefined, 5], ["", 5], ["abc", 5], ["0", 5], ["1", 1], ["5", 5], ["30", 30], ["31", 30], ["999", 30], ["2.5", 5], ["-3", 5], [" 7 ", 7]]) {
  eq(`D2 Retry-After ${JSON.stringify(h)}`, want, retryAfterSeconds(h));
}

// D3, D5, D9: the words a client reads.
eq("D3 words", "The engine was being updated and could not take the order. Please resubmit in a few minutes.", ENGINE_UPDATING);
eq("D5 words (C1)", D5, W.ENGINE_STOPPED_MORE_THAN_ONCE);
eq("D4 progress words", "The engine restarted for an update. Mavloper sent the order again.", ENGINE_RESENT);
eq("D3 the raw S-DRAIN reason, as the async route writes it", ENGINE_UPDATING,
  plainReason("Claude Code bridge failed and automatic fallback is disabled.: engine draining: the engine refused the order 4 times while it was being updated (HTTP 503, draining); nothing was built"));
eq("D5 the raw S-STOP reason (in process)", D5,
  plainReason("Claude Code bridge failed and automatic fallback is disabled.: engine stopped: the engine was stopped for an update 3 times while building this order (engineStopped); not sent again"));
eq("D5 the raw S-STOP reason (runner)", D5,
  plainReason("engine stopped: the engine was stopped for an update 3 times while building this order (engineStopped); not sent again"));
eq("D9 the engine's own S-STOP sentence reads as D5", D5,
  plainReason("The engine was stopped before this order finished building, because the server running it was shut down. Nothing was delivered. Please place the order again."));
eq("D9 the engine's sentence behind the 502 prefix", D5,
  plainReason("Claude Code bridge failed and automatic fallback is disabled.: The engine was stopped before this order finished building, because the server running it was shut down. Nothing was delivered. Please place the order again."));
eq("D3 maps to itself", ENGINE_UPDATING, plainReason(ENGINE_UPDATING));
eq("D5 maps to itself", D5, plainReason(D5));
eq("C1 the old D5 sentence maps to the new one", D5, plainReason(D5_OLD));
eq("C1 the old D5 sentence behind a prefix maps to the new one", D5, plainReason("Runner: " + D5_OLD));
eq("C1 the default export carries the new sentence", D5, W.default && W.default.ENGINE_STOPPED_MORE_THAN_ONCE);
eq("C1 no export still carries the old sentence", false, Object.values(W).concat(Object.values(W.default || {})).includes(D5_OLD));
eq("D1 a 503 without the draining body keeps today's words", START_FAILED,
  plainReason('Claude Code bridge failed and automatic fallback is disabled.: Bridge rejected dispatch with status 503: {"error":"Service Unavailable"}'));
eq("D1 an unrecognised reason keeps today's words", INTERNAL, plainReason("something nobody expected"));
for (const [n, s] of [["D3", ENGINE_UPDATING], ["D5", D5], ["D4", ENGINE_RESENT]]) {
  eq(`${n} has no em dash`, false, /—/.test(s));
  eq(`${n} never tells the client to place the order again`, false, /place the order again/i.test(s));
}

console.log(`engine-update.test.mjs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
