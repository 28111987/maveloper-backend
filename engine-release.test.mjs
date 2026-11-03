// engine-release.test.mjs - RUN 18, E8. THE ORDER CONFIRMATION NAMES THE RELEASE THAT RAN.
// Pure functions of order-confirmation.js. No DB, no network, no credentials.
// Run: node engine-release.test.mjs   (exit 0 = every case passed)
//
// THE RULE (run 18 brief, V10), written before the code changed: the email's
// engine names the release that ACTUALLY ran, provenance.engineRelease first,
// and only for a record without it today's field (diamondTag). diamondTag keeps
// its old meaning, the tag of the checked-out tree, and is not the release when
// engineRelease exists.
//
// THE ROWS (the brief's P1 to P7, exactly these field names):
//   P1 older row, before D159: diamondTag DIAMOND-150, engineTag DIAMOND-150, rung 0, no engine* fields
//   P2 DIAMOND order on the new engine: engineRelease DIAMOND-158
//   P3 TOPAZ order on TOPAZ-1: engineRelease TOPAZ-1 (diamondTag still DIAMOND-158)
//   P4 TOPAZ asked, DIAMOND ran: engineRelease DIAMOND-158, engineNote
//   P5 fallback ladder: engineTag DIAMOND-157, rung 1, engineRelease DIAMOND-157
//   P6 refused (fallback.occurred true), P7 no record: today's behaviour, unchanged
import { readProvenanceFacts, buildLeadSummary } from "./order-confirmation.js";

const NOTE4 = "TOPAZ was asked for; this image carries no TOPAZ writer, so the order ran DIAMOND";
export const P = {
  P1: { engine: "compiler", diamondTag: "DIAMOND-150", engineTag: "DIAMOND-150", engineRung: 0 },
  P2: { engine: "compiler", diamondTag: "DIAMOND-158", engineRung: 0, engineRequested: "DIAMOND", engineFamily: "DIAMOND", engineRelease: "DIAMOND-158" },
  P3: { engine: "compiler", diamondTag: "DIAMOND-158", engineRung: 0, engineRequested: "TOPAZ", engineFamily: "TOPAZ", engineRelease: "TOPAZ-1" },
  P4: { engine: "compiler", diamondTag: "DIAMOND-158", engineRung: 0, engineRequested: "TOPAZ", engineFamily: "DIAMOND", engineRelease: "DIAMOND-158", engineNote: NOTE4 },
  P5: { engine: "compiler", diamondTag: "DIAMOND-158", engineTag: "DIAMOND-157", engineRung: 1, engineRequested: "TOPAZ", engineFamily: "DIAMOND", engineRelease: "DIAMOND-157", engineNote: "the fallback ladder produced these bytes on DIAMOND-157" },
  P6: { engine: "llm", diamondTag: "DIAMOND-158", fallback: { occurred: true, guard: "COORDINATES_MISSING", reason: "missing figma coordinates" } },
};

// expected, from V10 (release first) and "P6, P7 unchanged"
const EXPECT = {
  P1: { label: "Deterministic compiler (DIAMOND-150)", chip: "COMPILER &middot; DIAMOND-150" },
  P2: { label: "Deterministic compiler (DIAMOND-158)", chip: "COMPILER &middot; DIAMOND-158" },
  P3: { label: "Deterministic compiler (TOPAZ-1)", chip: "COMPILER &middot; TOPAZ-1" },
  P4: { label: "Deterministic compiler (DIAMOND-158)", chip: "COMPILER &middot; DIAMOND-158" },
  P5: { label: "Deterministic compiler (DIAMOND-157)", chip: "COMPILER &middot; DIAMOND-157" },
  P6: { label: "LLM route &mdash; NOT the compiler (COORDINATES_MISSING)", chip: "NOT COMPILER OUTPUT" },
  P7: { label: "LLM route &mdash; NOT the compiler", chip: "NOT COMPILER OUTPUT" },
};

const ARM = process.env.OC_ARM === "old" ? "old" : "new";
let pass = 0, fail = 0;
const lines = [];
function record(kase, rule, expected, actual) {
  const ok = String(expected) === String(actual);
  ok ? pass++ : fail++;
  const t = `${ok ? "PASS" : "FAIL"} ${ARM} E8 | ${kase} | ${rule} | expected: ${expected} | actual: ${actual}`;
  lines.push(t);
  console.log(t);
}

for (const k of ["P1", "P2", "P3", "P4", "P5", "P6", "P7"]) {
  const facts = readProvenanceFacts({ provenance: P[k] ?? null, certificate: null });
  const s = buildLeadSummary(facts);
  record(k, "V10 the email's engine line", EXPECT[k].label, s.engineLabel);
  record(k, "V10 the email's engine chip", EXPECT[k].chip, s.chip);
}
// diamondTag keeps its old meaning on the facts (no reader turns it into the release)
record("P3", "diamondTag is still the checked-out tree's tag", "DIAMOND-158", readProvenanceFacts({ provenance: P.P3 }).diamondTag);

console.log(`engine-release.test.mjs: ${pass} passed, ${fail} failed (${ARM} arm)`);
process.exit(fail ? 1 : 0);
