// Unit test for approve-idempotency.js — pure functions, no DB / Dropbox / Express.
// Run: node approve-idempotency.test.mjs   (exit 0 = all pass)
//
// The witness (approve-idempotency.witness.mjs) proves the EFFECT — two folder
// builds and two emails before, one of each after. This proves the DECISION
// TABLE underneath it, case by case, including every way the record can be
// malformed. A guard that misreads its own state is worse than no guard: it
// would suppress a delivery that never happened.
import {
  approveFingerprint, readApproveRecord, decideApprove, approveWasComplete,
  buildApproveRecord, replayApproveResponse, beginApprove, _resetApproveLatch,
  APPROVE_RECORD_KEY, APPROVE_RECORD_SCHEMA,
} from "./approve-idempotency.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ FAIL:", msg); } };

// ── the fingerprint ───────────────────────────────────────────────────
const FP = (orderId, html) => approveFingerprint({ orderId, html });
ok(FP("A", "<html>x</html>") === FP("A", "<html>x</html>"), "same order + same bytes → same fingerprint");
ok(FP("A", "<html>x</html>") !== FP("B", "<html>x</html>"), "different order id → different fingerprint");
ok(FP("A", "<html>x</html>") !== FP("A", "<html>y</html>"), "★ different delivered bytes → different fingerprint (the re-compile case)");
ok(FP("A", "<html>x</html>") !== FP("A ", "<html>x</html>"), "the separator stops an id/html boundary alias");
ok(FP("AB", "C") !== FP("A", "BC"), "★ 'AB'+'C' cannot alias 'A'+'BC'");
ok(/^[0-9a-f]{32}$/.test(FP("A", "x")), "fingerprint is 32 hex chars (128 bits)");
ok(FP(null, null) === FP("", ""), "null inputs are handled, not thrown on");
ok(FP("A", "x".repeat(500_000)).length === 32, "a 500 KB artifact fingerprints fine");

// ── reading the record tolerantly ─────────────────────────────────────
const goodRecord = buildApproveRecord({
  fingerprint: "abc", orderId: "A", folderPath: "/p", dropboxUrl: "https://db/x",
  imageCount: 3, previewStatus: "present", generatedBy: "compiler",
  folderIntegrity: { ok: true }, confirmationEmail: null, at: "2026-07-29T00:00:00.000Z",
});
ok(readApproveRecord({ [APPROVE_RECORD_KEY]: goodRecord }) === goodRecord, "a well-formed record reads back");
for (const [label, meta] of [
  ["null delivery_meta", null],
  ["a string delivery_meta", "not-json"],
  ["no approve key", { certificate: {}, provenance: {} }],
  ["approve is a string", { [APPROVE_RECORD_KEY]: "yes" }],
  ["unknown schema", { [APPROVE_RECORD_KEY]: { ...goodRecord, schema: 99 } }],
  ["no fingerprint", { [APPROVE_RECORD_KEY]: { schema: APPROVE_RECORD_SCHEMA } }],
  ["empty fingerprint", { [APPROVE_RECORD_KEY]: { schema: APPROVE_RECORD_SCHEMA, fingerprint: "" } }],
]) {
  ok(readApproveRecord(meta) === null, `★ ${label} → null → the guard does not fire (fails toward DELIVERING)`);
}

// ── approveWasComplete: what counts as "already done properly" ─────────
ok(approveWasComplete({ dropboxUrl: "u", folderIntegrity: { ok: true }, confirmationEmail: null }) === true,
  "link + green gate + email off → complete");
ok(approveWasComplete({ dropboxUrl: "u", folderIntegrity: { ok: true }, confirmationEmail: { ok: true } }) === true,
  "link + green gate + sent email → complete");
ok(approveWasComplete({ dropboxUrl: null, folderIntegrity: { ok: true } }) === false,
  "★ no share link → NOT complete (the delivery never finished)");
ok(approveWasComplete({ dropboxUrl: "u", folderIntegrity: { ok: false } }) === false,
  "★ integrity gate RED → NOT complete (a re-approve is a repair)");
ok(approveWasComplete({ dropboxUrl: "u", folderIntegrity: { ok: null } }) === false,
  "★ integrity gate could not RUN → NOT complete (we do not claim what we did not measure)");
ok(approveWasComplete({ dropboxUrl: "u", folderIntegrity: null }) === false,
  "no integrity result at all → NOT complete");
ok(approveWasComplete({ dropboxUrl: "u", folderIntegrity: { ok: true }, confirmationEmail: { ok: false } }) === false,
  "★ the email FAILED → NOT complete (the lead was not notified; the repeat is a repair)");

// ── the decision table ────────────────────────────────────────────────
const complete = { ...goodRecord, fingerprint: "FP1", complete: true };
const incomplete = { ...goodRecord, fingerprint: "FP1", complete: false };

const d1 = decideApprove({ record: null, fingerprint: "FP1" });
ok(d1.run === true && d1.reason === "no-prior-approve", "no record → run");

const d2 = decideApprove({ record: complete, fingerprint: "FP1" });
ok(d2.run === false && d2.reason === "duplicate-approve" && d2.prior === complete,
  "★★ identical bytes after a COMPLETE approve → SUPPRESS");

const d3 = decideApprove({ record: complete, fingerprint: "FP2" });
ok(d3.run === true && d3.reason === "delivered-html-changed",
  "★★ different bytes → RUN (the re-compile TEST27-1800 needs)");

const d4 = decideApprove({ record: incomplete, fingerprint: "FP1" });
ok(d4.run === true && d4.reason === "prior-approve-incomplete",
  "★★ identical bytes after an INCOMPLETE approve → RUN (the repair)");

const d5 = decideApprove({ record: complete, fingerprint: "FP1", force: true });
ok(d5.run === true && d5.reason === "forced", "force:true → RUN, always");

ok(decideApprove({}).run === true, "an empty call runs — the guard never suppresses on ignorance");

// ── the record ────────────────────────────────────────────────────────
{
  const r = buildApproveRecord({
    fingerprint: "fp", orderId: "O", folderPath: "/f", dropboxUrl: "https://d/x",
    imageCount: 110, previewStatus: "present", generatedBy: "compiler",
    folderIntegrity: { ok: true, missingFiles: [], deadRefs: [], counts: { referenced: 110, presentInFolder: 110 } },
    confirmationEmail: { ok: true, transport: "gmail", to: "lead@example.com", subject: "…", html: "<b>…</b>" },
    at: "2026-07-29T10:00:00.000Z",
  });
  ok(r.complete === true && r.schema === APPROVE_RECORD_SCHEMA, "a good run records complete:true");
  ok(r.confirmationEmail.ok === true && r.confirmationEmail.to === "lead@example.com" &&
     !("subject" in r.confirmationEmail) && !("html" in r.confirmationEmail),
    "★ only the email's OUTCOME is stored — this jsonb is not a mail spool");
  ok(JSON.stringify(r).length < 1200, `the record is small (${JSON.stringify(r).length} bytes) — it shares a column`);
  ok(JSON.parse(JSON.stringify(r)).fingerprint === "fp", "the record round-trips through jsonb");

  const replay = replayApproveResponse(r, { requestId: "req-2" });
  for (const k of ["dropboxUrl", "orderId", "folderPath", "imageCount", "previewStatus", "generatedBy", "folderIntegrity", "confirmationEmail", "requestId"]) {
    ok(k in replay, `the replayed response carries ${k} — the shape the frontend already reads`);
  }
  ok(replay.alreadyApproved === true && replay.approvedAt === "2026-07-29T10:00:00.000Z",
    "★ the replay is truthful: it says it is a replay and when the real delivery happened");
  ok(replay.confirmationEmail.replayed === true && replay.confirmationEmail.ok === true,
    "★ a replayed email outcome is not null — null means 'the feature is off', which would be a lie here");
  ok(replay.requestId === "req-2", "the replay carries THIS request's id, not the first one's");
}

// ── the latch ─────────────────────────────────────────────────────────
{
  _resetApproveLatch();
  const a = beginApprove("O1");
  ok(a.ok === true, "first caller takes the latch");
  ok(beginApprove("O1").ok === false, "★ a concurrent second caller for the same order is refused");
  ok(beginApprove("O2").ok === true, "a different order is unaffected");
  a.release(); a.release();                       // double release must be safe
  ok(beginApprove("O1").ok === true, "★ after release, the order can be approved again");
  _resetApproveLatch();
  ok(beginApprove(null).ok === true && beginApprove(null).ok === true,
    "a blank order id never latches (it cannot be identified, so it must not be blocked)");
  _resetApproveLatch();
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
