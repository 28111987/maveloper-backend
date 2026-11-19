// figma-refusal-words.test.mjs - what a client reads when Figma refuses (19 NOV 2026).
// Run: node figma-refusal-words.test.mjs   (exit 0 = all pass)
//
// The raw reasons below are COPIED from production (maveloper_jobs.error_message,
// 19 NOV, read-only). Catches: a Figma rate limit read as "an automatic quality
// check stopped it" (HAMILTON) or "stopped on our side" (Hamilton); a 429 read
// as the plan itself being out of quota; the runner cutting the reason before
// the 429; a failed order losing its failure time.
import W from "./order-words.js";
import { readFileSync } from "node:fs";
const { plainReason, FIGMA_TOO_MANY, FIGMA_PICTURES_MISSING, FIGMA_PLAN_LIMIT, DECLINED, INTERNAL, BAD_LINK } = W;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  x FAIL:", m); } };

const HAMILTON = `Figma did not render 23 pictures; please send the order again.


!!!====================================================================!!!
!!!  ORDER FAILED \u2014 THE COMPILER REFUSED AND THERE IS NO OTHER ENGINE  !!!
!!!====================================================================!!!
!!!  jobId=job_1795086002556_8c04f1c6  fileKey=0fJ9mD5u3JrTFO1X3cPI15  nodeId=1:27
!!!  GUARD  : FIGMA_RENDER_INCOMPLETE
!!!  REASON : Figma did not render 23 pictures; please send the order again.
!!!  CERTIFY: exit 2
!!!  certify stderr |   \u2502      figma-image-export: 429 Too Many Requests for https://api.figma.com/v1/images/0fJ9mD5u3JrTFO1X3cPI15?ids=1%3A206&format=png&scale=2
!!!  certify stderr |   \u2502    1:207          HTTP 429  TRANSIENT  Glassdoor img
!!!  certify stderr | CERTIFICATION UNMEASURABLE (C51) \u2014 exit 2, NOT a verdict on this design.`;
const HAMILTON_1 = "Claude Code bridge failed and automatic fallback is disabled.: Figma did not render 23 pictures; please send the order again.";
const FETCH_429 = "Figma fetch failed: Figma API rate-limited (429). Wait a minute and retry.";

ok(plainReason(HAMILTON) === FIGMA_TOO_MANY, "HAMILTON (429 in the engine's record) reads as too many requests, got: " + plainReason(HAMILTON));
ok(plainReason(HAMILTON) !== DECLINED, "HAMILTON is never 'a quality check stopped it'");
ok(plainReason(HAMILTON_1) === FIGMA_PICTURES_MISSING, "Hamilton (no 429 recorded) reads as missing pictures, got: " + plainReason(HAMILTON_1));
ok(plainReason(HAMILTON_1) !== INTERNAL, "Hamilton is never 'stopped on our side'");
ok(plainReason(FETCH_429) === FIGMA_TOO_MANY, "the backend's own 429 is too many requests");
ok(plainReason("Figma returned 402 Payment Required") === FIGMA_PLAN_LIMIT, "a 402 is still the plan limit");
ok(plainReason("quota exceeded for this plan") === FIGMA_PLAN_LIMIT, "a stated quota is still the plan limit");
ok(plainReason("QUALITY GATE FAILED: STRUCTURAL COLLAPSE") === DECLINED, "a real quality gate is still declined");
ok(plainReason("Invalid Figma URL") === BAD_LINK, "a bad link is still a bad link");
ok(plainReason(FIGMA_TOO_MANY) === FIGMA_TOO_MANY && plainReason(FIGMA_PICTURES_MISSING) === FIGMA_PICTURES_MISSING, "our sentences map to themselves");
// Cut at 500 characters (what the old runner passed) the 429 is gone: it can
// then only be said as missing pictures. The whole reason is what names the 429.
ok(plainReason(HAMILTON.slice(0, 500)) === FIGMA_PICTURES_MISSING, "cut at 500 characters the 429 is lost: only missing pictures can be said, got: " + plainReason(HAMILTON.slice(0, 500)));
ok(!/[\u2014\u2013]/.test(FIGMA_TOO_MANY + FIGMA_PICTURES_MISSING), "no em or en dash");
// The console groups the sentence by its words (src/lib/failureCause.ts): the
// too-many sentence must carry "too many requests" and none of the words that
// would put it under "Engine declined" or "Stopped on our side".
ok(/too many requests/i.test(FIGMA_TOO_MANY) && !/on our side|guard|QUALITY GATE|could not build this design/i.test(FIGMA_TOO_MANY), "the console can group it as Figma's limit");

// The runner: the whole reason reaches plainReason, and a failure keeps its time.
const runner = readFileSync(new URL("./queue-runner.js", import.meta.url), "utf8");
const settle = runner.slice(runner.indexOf("async function settleFailed"), runner.indexOf("async function failJobRow"));
ok(/finished_at: new Date\(\)\.toISOString\(\)/.test(settle), "settleFailed records the failure time");
ok(!/started_at: null/.test(settle), "settleFailed keeps the start time");
ok(/job_id: null/.test(settle), "settleFailed still clears job_id (console tabs write by job_id)");
ok(!/meaningful\.slice\(0, 500\)/.test(runner), "the runner no longer cuts the reason at 500 characters");

console.log(`figma-refusal-words.test.mjs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
