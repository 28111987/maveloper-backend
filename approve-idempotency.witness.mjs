// ─────────────────────────────────────────────────────────────────────────────
// approve-idempotency.witness.mjs
//
// Run: node approve-idempotency.witness.mjs      (exit 0 = every witness held)
//
// ★★ FAILS-FIRST. Approve the same order TWICE and count what happens.
//
//   BEFORE (the shipped-until-now path):  2 folder builds, 2 confirmation emails
//   AFTER  (with the guard):              1 folder build,  1 confirmation email
//
// ★ AND THE OTHER HALF, WHICH MATTERS JUST AS MUCH: the guard must not be able
// to block a LEGITIMATE re-approve. TEST27-1800 needs exactly that — a genuine
// re-run after a re-compile. So the same harness proves that a re-approve after
// a re-compile still builds and still mails, that a re-approve of an INCOMPLETE
// delivery still runs (it is a repair), and that `force: true` always runs.
//
// WHY THIS IS TWO ARMS. §A simulates the route to count the effects; a
// simulation is a MIRROR and a mirror can agree with itself while the shipped
// route disagrees. §B asserts against the REAL BYTES of server.js — that the
// guard genuinely sits before the first Dropbox call, that the record write is a
// merge and not an overwrite, and that the concurrency latch is genuinely
// released in a finally. §B is what stops §A from being a story about code that
// is not shipped.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveFingerprint, readApproveRecord, decideApprove, buildApproveRecord,
  replayApproveResponse, beginApprove, _resetApproveLatch, APPROVE_RECORD_KEY,
} from "./approve-idempotency.js";
import { buildOrderConfirmation } from "./order-confirmation.js";
import { sendOrderConfirmation, confirmationMetaFor } from "./order-confirmation-transport.js";
import { deriveWordFatalLedger } from "./delivery-folder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let held = 0, broke = 0;
const W = (name, cond, detail = []) => {
  if (cond) { held++; console.log(`  ✓ ${name}`); } else { broke++; console.error(`  ✗ BROKE: ${name}`); }
  for (const d of detail) console.log(`      ${d}`);
};

const REAL_HTML = readFileSync(path.join(__dirname, "references", "arsenal-pulse.html"), "utf-8");
const RECOMPILED_HTML = REAL_HTML.replace("</body>", "<!-- recompiled: DIAMOND-47 -->\n</body>");

// ── the harness: /approve's delivery sequence, in the route's own order ───────
// Every effect the route has on the outside world is COUNTED:
//   folderBuilds  — one per full materialise + upload + share-link pass
//   emailsSent    — one per message that reached a transport
//   dbWrites      — one per delivery_meta write
// The email is the REAL pipeline (buildOrderConfirmation + sendOrderConfirmation)
// with a counting transport, so "an email was sent" means a message was actually
// rendered and handed over, not that a boolean flipped.
function makeWorld() {
  return {
    folderBuilds: 0, emailsSent: 0, dbWrites: 0, shareLinks: 0,
    // the job row's delivery_meta jsonb — the ONLY storage this guard uses
    deliveryMeta: {},
    sent: [],
    logs: [],
  };
}

async function approve(world, {
  orderId = "TEST27-1800",
  html = REAL_HTML,
  guard = true,                 // false = the code as it shipped before this change
  emailEnabled = true,
  hasJobRow = true,             // false = no maveloper_jobs row → the guard is inert
  integrityOk = true,           // false = the folder shipped short (disclosed)
  transportFails = false,
  force = false,
} = {}) {
  const log = (level, msg, meta) => world.logs.push({ level, msg, meta });
  const fingerprint = approveFingerprint({ orderId, html });

  // ★ THE GUARD — exactly where server.js puts it: after the job-meta read and
  //   BEFORE the first Dropbox call.
  if (guard) {
    const record = hasJobRow ? readApproveRecord(world.deliveryMeta) : null;
    const decision = decideApprove({ record, fingerprint, force });
    if (!decision.run) {
      log("info", "Approve: DUPLICATE SUPPRESSED", { orderId, fingerprint });
      return { ...replayApproveResponse(decision.prior, { requestId: "req-2" }), _reason: decision.reason };
    }
    if (record) log("info", "Approve: prior approve found and NOT suppressed", { reason: decision.reason });
  }

  // ── everything below is the delivery path the guard exists to stop repeating ──
  world.folderBuilds++;                       // materialise images/ + 3 file uploads
  const dropboxUrl = `https://www.dropbox.com/scl/fo/w1tn3ss/${orderId}?rlkey=folder&dl=0`;
  world.shareLinks++;
  const folderIntegrity = integrityOk
    ? { ok: true, missingFiles: [], deadRefs: [], counts: { referenced: 14, presentInFolder: 14 } }
    : { ok: false, missingFiles: ["images/cta.png"], deadRefs: [], counts: { referenced: 14, presentInFolder: 13 } };

  let confirmationEmail = null;
  if (emailEnabled) {
    const message = buildOrderConfirmation({
      orderId, leadEmail: "lead@example.com",
      figmaUrl: "https://www.figma.com/design/TmppLGRXkZmWB5OqzZD00H/Pulse?node-id=1-7",
      esp: "klaviyo", darkMode: true, tatHours: 24,
      deadline: "2026-07-28T06:30:00.000Z", effectiveDeadline: "2026-07-28T02:30:00.000Z",
      deliveredHtml: html, dropboxFolderUrl: dropboxUrl,
      dropboxHtmlUrl: `${dropboxUrl}&f=html`, previewUrl: null,
      hasInlinePreviewBytes: false, previewStatus: "present",
      imageCount: 14, ledger: deriveWordFatalLedger(html), generationSeconds: 150,
    });
    const transport = {
      name: "counting",
      describe: () => "counting transport (witness)",
      async send() {
        if (transportFails) throw new Error("535 5.7.8 Username and Password not accepted");
        world.emailsSent++;
        world.sent.push({ to: message.to, subject: message.subject });
        return { id: `msg-${world.emailsSent}` };
      },
    };
    const result = await sendOrderConfirmation({
      message, orderId, requestId: "req", env: { ORDER_CONFIRMATION_ENABLED: "true" },
      log: () => {}, transport,
    });
    confirmationEmail = confirmationMetaFor(result, message);
  }

  // ★ the record, written last, as a MERGE
  if (guard && hasJobRow) {
    const record = buildApproveRecord({
      fingerprint, orderId, folderPath: `/maveloper/2026/07-2026/${orderId}`, dropboxUrl,
      imageCount: 14, previewStatus: "present", generatedBy: "compiler",
      folderIntegrity, confirmationEmail, at: "2026-07-29T10:00:00.000Z", requestId: "req",
    });
    world.deliveryMeta = { ...world.deliveryMeta, [APPROVE_RECORD_KEY]: record };
    world.dbWrites++;
  }

  return {
    dropboxUrl, orderId, folderPath: `/maveloper/2026/07-2026/${orderId}`,
    imageCount: 14, previewStatus: "present", generatedBy: "compiler",
    folderIntegrity, confirmationEmail, requestId: "req",
  };
}

console.log("\n════════════════════════════════════════════════════════════════════");
console.log("A. ★★ THE SAME ORDER, APPROVED TWICE");
console.log("════════════════════════════════════════════════════════════════════\n");

// ── BEFORE: the path as it shipped ───────────────────────────────────────────
console.log("── BEFORE — /approve with no idempotency guard ──────────────────\n");
const before = makeWorld();
await approve(before, { guard: false });
await approve(before, { guard: false });

W("A1 ★★ BEFORE: two approves of IDENTICAL bytes built the delivery folder TWICE",
  before.folderBuilds === 2 && before.shareLinks === 2,
  [`folder builds : ${before.folderBuilds}`, `share links   : ${before.shareLinks}`,
   "every referenced image re-materialised into Dropbox, the whole pipeline paid twice"]);

W("A2 ★★ BEFORE: and the lead was emailed TWICE",
  before.emailsSent === 2 && before.sent.length === 2 && before.sent[0].subject === before.sent[1].subject,
  [`emails sent : ${before.emailsSent}`,
   `both to     : ${before.sent.map((s) => s.to).join(", ")}`,
   `both subject: "${before.sent[0].subject}"`]);

// ── AFTER: with the guard ────────────────────────────────────────────────────
console.log("\n── AFTER — the same two approves, with the guard ────────────────\n");
const after = makeWorld();
const first = await approve(after, {});
const second = await approve(after, {});

W("A3 ★★ AFTER: ONE folder build, ONE share link",
  after.folderBuilds === 1 && after.shareLinks === 1,
  [`folder builds : ${after.folderBuilds}`, `share links   : ${after.shareLinks}`]);

W("A4 ★★ AFTER: ONE email. The lead is notified once, for one delivery",
  after.emailsSent === 1 && after.sent.length === 1,
  [`emails sent : ${after.emailsSent}`]);

W("A5 ★ the suppressed call still ANSWERS, with the first call's own payload",
  second.dropboxUrl === first.dropboxUrl && second.orderId === first.orderId &&
  second.folderPath === first.folderPath && second.imageCount === first.imageCount &&
  second.folderIntegrity.ok === true,
  [`dropboxUrl identical : ${second.dropboxUrl === first.dropboxUrl}`,
   "the frontend reads data.dropboxUrl and renders the link, exactly as before — no client change"]);

W("A6 ★ and it says so truthfully rather than pretending to have delivered again",
  second.alreadyApproved === true && second.approvedAt === "2026-07-29T10:00:00.000Z" &&
  second._reason === "duplicate-approve" && second.confirmationEmail?.replayed === true,
  ["alreadyApproved: true", "approvedAt: the FIRST approve's timestamp",
   "confirmationEmail.replayed: true — not null, which would read as 'the feature is off'"]);

W("A7 the record lives in delivery_meta, an EXISTING jsonb — no column was invented",
  !!after.deliveryMeta[APPROVE_RECORD_KEY] && after.deliveryMeta[APPROVE_RECORD_KEY].schema === 1 &&
  typeof after.deliveryMeta[APPROVE_RECORD_KEY].fingerprint === "string",
  [`delivery_meta.${APPROVE_RECORD_KEY} = ${JSON.stringify({
    fingerprint: after.deliveryMeta[APPROVE_RECORD_KEY].fingerprint.slice(0, 12) + "…",
    complete: after.deliveryMeta[APPROVE_RECORD_KEY].complete,
    at: after.deliveryMeta[APPROVE_RECORD_KEY].at,
  })}`,
   "the same column the certificate, the provenance and the confirmation outcome already share"]);

W("A8 ★ ten rapid re-approves add nothing at all",
  await (async () => {
    const w = makeWorld();
    for (let i = 0; i < 10; i++) await approve(w, {});
    return w.folderBuilds === 1 && w.emailsSent === 1 && w.dbWrites === 1;
  })(),
  ["10 calls → 1 folder build, 1 email, 1 record write"]);

console.log("\n════════════════════════════════════════════════════════════════════");
console.log("B. ★ THE GUARD MUST NOT BLOCK A LEGITIMATE RE-APPROVE");
console.log("════════════════════════════════════════════════════════════════════\n");

{
  // ★ TEST27-1800's case: the order is re-compiled and re-approved.
  const w = makeWorld();
  await approve(w, { orderId: "TEST27-1800", html: REAL_HTML });
  const re = await approve(w, { orderId: "TEST27-1800", html: RECOMPILED_HTML });
  W("B1 ★★ A RE-COMPILE STILL DELIVERS — different delivered bytes, so it runs in full",
    w.folderBuilds === 2 && w.emailsSent === 2 && !re.alreadyApproved,
    [`folder builds : ${w.folderBuilds}`, `emails sent   : ${w.emailsSent}`,
     `fingerprint before : ${approveFingerprint({ orderId: "TEST27-1800", html: REAL_HTML }).slice(0, 16)}…`,
     `fingerprint after  : ${approveFingerprint({ orderId: "TEST27-1800", html: RECOMPILED_HTML }).slice(0, 16)}…`,
     "one comment's difference in the html is enough — the key is the bytes, not the order id"]);

  // and the SECOND re-compile of the same new bytes collapses again
  await approve(w, { orderId: "TEST27-1800", html: RECOMPILED_HTML });
  W("B2 ★ …and the re-approve is itself idempotent — double-clicking the re-run collapses too",
    w.folderBuilds === 2 && w.emailsSent === 2);
}

{
  const w = makeWorld();
  await approve(w, { integrityOk: false });         // shipped short, disclosed
  await approve(w, { integrityOk: true });          // the repair
  W("B3 ★★ A REPAIR STILL RUNS — a prior approve that shipped an INCOMPLETE folder never suppresses",
    w.folderBuilds === 2,
    ["integrity gate red on run 1 → record.complete = false → run 2 rebuilds",
     "★ this is why the guard keys on 'a delivery that actually succeeded', not on 'an approve happened'"]);
}

{
  const w = makeWorld();
  await approve(w, { transportFails: true });        // delivered, but the lead was NOT notified
  await approve(w, { transportFails: false });
  W("B4 ★★ A FAILED CONFIRMATION EMAIL STILL RETRIES — the lead was not notified, so the repeat is a repair",
    w.folderBuilds === 2 && w.emailsSent === 1,
    ["run 1: folder shipped, send failed (ok:false) → record.complete = false",
     "run 2: runs in full and the email finally goes out"]);
}

{
  const w = makeWorld();
  await approve(w, {});
  await approve(w, { force: true });
  W("B5 ★ force:true always runs — a guard with no way past it gets deleted the first time it is inconvenient",
    w.folderBuilds === 2);
}

{
  const w = makeWorld();
  await approve(w, { emailEnabled: false });
  await approve(w, { emailEnabled: false });
  W("B6 with the email feature OFF (the default), the guard still suppresses the duplicate FOLDER build",
    w.folderBuilds === 1 && w.emailsSent === 0,
    ["confirmationEmail: null means 'the feature is off' — NOT a failure, so it does not force a re-run"]);
}

{
  const w = makeWorld();
  await approve(w, { hasJobRow: false });
  await approve(w, { hasJobRow: false });
  W("B7 ★ HONEST LIMIT: with no maveloper_jobs row there is nowhere to store the record, so BOTH runs deliver",
    w.folderBuilds === 2 && w.dbWrites === 0,
    ["this is today's behaviour, unchanged — the guard degrades to inert rather than failing an approve",
     "the runner-driven path always has a job row, which is the path this guard exists for"]);
}

{
  const w = makeWorld();
  await approve(w, { orderId: "ORDER-A" });
  await approve(w, { orderId: "ORDER-B" });
  W("B8 two DIFFERENT orders are never confused for each other",
    w.folderBuilds === 2,
    ["the fingerprint covers the order id as well as the html"]);
}

console.log("\n── the CONCURRENT duplicate (arm 1: the in-process latch) ───────\n");
{
  _resetApproveLatch();
  const a = beginApprove("ORDER-X", { requestId: "req-1" });
  const b = beginApprove("ORDER-X", { requestId: "req-2" });
  W("B9 ★ a second approve ARRIVING WHILE THE FIRST IS STILL RUNNING is refused, before any Dropbox call",
    a.ok === true && b.ok === false && b.held.requestId === "req-1",
    ["the durable record is written at the END of a run, so it cannot see an overlapping call",
     "409 + 'nothing was rebuilt and no second email was sent' — the honest answer for a caller that retried"]);
  a.release();
  const c = beginApprove("ORDER-X", { requestId: "req-3" });
  W("B10 ★ and the latch is released, so a genuine later approve is never locked out",
    c.ok === true);
  c.release();
  const d = beginApprove("ORDER-Y", { requestId: "req-4" });
  W("B11 the latch is per ORDER, not global — two different orders approve concurrently",
    d.ok === true);
  d.release();
}

console.log("\n════════════════════════════════════════════════════════════════════");
console.log("C. THE REAL server.js WIRING, ASSERTED STATICALLY");
console.log("════════════════════════════════════════════════════════════════════\n");

const serverSrc = readFileSync(path.join(__dirname, "server.js"), "utf-8");
const approveStart = serverSrc.indexOf('app.post("/approve"');
const approveEnd = serverSrc.indexOf("const queueRunner = createQueueRunner(");
const approveSrc = serverSrc.slice(approveStart, approveEnd);

const iLatch = approveSrc.indexOf("const latch = beginApprove(orderId");
const iDecide = approveSrc.indexOf("const decision = decideApprove(");
const iReplay = approveSrc.indexOf("replayApproveResponse(decision.prior");
const iFirstDropbox = approveSrc.indexOf("const materialized = await mapWithConcurrency(urlList");
const iShareLink = approveSrc.indexOf("const dropboxUrl = await createFolderShareLink(folderPath)");
const iSend = approveSrc.indexOf("await sendOrderConfirmation(");
const iRecordWrite = approveSrc.indexOf("const approveRecord = buildApproveRecord(");
const iResJson = approveSrc.indexOf("res.json({\n      dropboxUrl,");
const iFinally = approveSrc.indexOf("latch.release();");

W("C1 the guard is genuinely inside the real /approve handler",
  approveStart > 0 && iLatch > 0 && iDecide > 0 && iReplay > 0,
  [`/approve spans ${approveSrc.length} bytes of server.js`]);

W("C2 ★★ THE DECISION IS MADE BEFORE THE FIRST DROPBOX CALL — a suppressed duplicate costs nothing",
  iDecide > 0 && iDecide < iFirstDropbox && iDecide < iShareLink && iDecide < iSend,
  [`decideApprove at +${iDecide}`, `first image materialisation at +${iFirstDropbox}`,
   `createFolderShareLink at +${iShareLink}`, `sendOrderConfirmation at +${iSend}`]);

W("C3 ★ the concurrency latch is taken before the job-meta read and released in a FINALLY",
  iLatch > 0 && iLatch < iDecide && iFinally > iResJson && /\}\s*finally\s*\{[^}]*latch\.release\(\)/s.test(approveSrc),
  [`beginApprove at +${iLatch}`, `latch.release() in a finally at +${iFinally}`,
   "a latch that can be left held turns one failed approve into an order that can never be approved again"]);

W("C4 ★★ THE RECORD WRITE IS A READ-MODIFY-WRITE MERGE, not an overwrite",
  iRecordWrite > 0 &&
  /select\("delivery_meta"\)\.eq\("id", jobMeta\.jobRowId\)/.test(approveSrc.slice(iRecordWrite, iRecordWrite + 1200)) &&
  /\.\.\.\(cur && cur\.delivery_meta/.test(approveSrc.slice(iRecordWrite, iRecordWrite + 1200)),
  ["a blind update would delete the certificate, the provenance AND the confirmation outcome"]);

W("C5 ★ the record is written AFTER the email block, so it records the send's real outcome",
  iRecordWrite > iSend && iRecordWrite < iResJson,
  [`sendOrderConfirmation at +${iSend}`, `record write at +${iRecordWrite}`, `res.json at +${iResJson}`]);

W("C6 ★ NO COLUMN WAS INVENTED — the record uses delivery_meta, and no DDL is added anywhere",
  /delivery_meta/.test(approveSrc.slice(iRecordWrite, iRecordWrite + 1200)) &&
  !/notified_at/.test(serverSrc) &&
  !/alter table/i.test(serverSrc),
  ["EMAIL_NOTIFY_scope.md's os_queue.notified_at was NOT added: this repo cannot apply DDL"]);

W("C7 the suppressed path returns the SAME response shape the frontend already reads",
  /return res\.json\(replayApproveResponse\(/.test(approveSrc) &&
  /dropboxUrl: record\.dropboxUrl/.test(readFileSync(path.join(__dirname, "approve-idempotency.js"), "utf-8")),
  ["dropboxUrl, orderId, folderPath, imageCount, previewStatus, generatedBy, folderIntegrity, confirmationEmail"]);

W("C8 ★ nothing that must not regress moved: the share link is still before the housekeeping, the gate still ships loudly",
  approveSrc.indexOf("const dropboxUrl = await createFolderShareLink(folderPath)") <
    approveSrc.indexOf("Approve images/ trimmed to delivered-html reference set") &&
  /folderIntegrity/.test(approveSrc.slice(iResJson, iResJson + 900)) &&
  /IT DOES NOT BLOCK/.test(approveSrc),
  ["share link → os_queue write-back → prune → integrity gate → email → record → res.json"]);

W("C9 the image-map reconciliation runs on every approve and can never fail one",
  /reconcileImageMap\(\{/.test(approveSrc) &&
  /catch \(recErr\)/.test(approveSrc) &&
  /delivery unaffected/.test(approveSrc),
  ["it is pure arithmetic over data the route already holds — no extra Dropbox or Supabase call"]);

console.log("\n════════════════════════════════════════════════════════════════════");
console.log(`${broke === 0 ? "ALL WITNESSES HELD" : "WITNESSES BROKE"} — ${held} held, ${broke} broke`);
console.log("════════════════════════════════════════════════════════════════════");
console.log(`
  THE NUMBERS THIS RUN EXISTS TO PRODUCE

                          folder builds   emails to the lead
    BEFORE  (no guard)          ${before.folderBuilds}               ${before.emailsSent}
    AFTER   (guard)             ${after.folderBuilds}               ${after.emailsSent}
`);

process.exit(broke === 0 ? 0 : 1);
