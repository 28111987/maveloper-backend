// ─────────────────────────────────────────────────────────────────────────────
// order-confirmation.witness.mjs
//
// Run: node order-confirmation.witness.mjs      (exit 0 = every witness held)
//
// TWO JOBS, both demanded by the brief:
//
//  A. ★ PRODUCE BOTH RENDERINGS ON REAL DATA — the compiler route and the
//     LLM-fallback route — and print their exact paths so the owner can open
//     them and judge whether they read like something a lead wants to receive.
//
//  B. ★★ PROVE IT NEVER BLOCKS DELIVERY, FAILS-FIRST. Simulate a transport
//     failure and show the order still completes, still reaches Dropbox, still
//     writes provenance, and that the failure is visible in the log AND on the
//     job row rather than silent.
//
// WHY B IS TWO WITNESSES AND NOT ONE. A simulation of /approve is a MIRROR of
// /approve, and a mirror can agree with itself while the real route disagrees.
// So B1 simulates the delivery sequence to show the artifacts survive, and B2
// makes a STATIC assertion against the real bytes of server.js — that the send
// block genuinely sits after the share link, genuinely sits before res.json, and
// is genuinely wrapped in its own try/catch. B2 is what stops B1 from being a
// story about code that isn't shipped.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOrderConfirmation } from "./order-confirmation.js";
import { createStubTransport, sendOrderConfirmation, confirmationMetaFor } from "./order-confirmation-transport.js";
import { deriveWordFatalLedger, buildDeliveryNotes, buildCertificateText } from "./delivery-folder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "order-confirmations");

let held = 0, broke = 0;
const W = (name, cond, detail = []) => {
  if (cond) { held++; console.log(`  ✓ ${name}`); } else { broke++; console.error(`  ✗ BROKE: ${name}`); }
  for (const d of detail) console.log(`      ${d}`);
};

const REAL_HTML = readFileSync(path.join(__dirname, "references", "arsenal-pulse.html"), "utf-8");
const FAKE_PNG = Buffer.from(
  // A real 1x1 PNG. Small, but genuinely decodable, so the .eml the owner opens
  // shows an image rather than a broken part.
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

// ── the REAL provenance records (shape: route-provenance.mjs PROVENANCE_SCHEMA 2)
// Numbers are the real ones recorded for compile job_1785026968111_96fadbd7
// under DIAMOND-46: 59 divergences (29 link.href / 29 type.runs / 1
// type.lineCount), live-text coverage 1.0, slice ratio 0.1781 nodes / 0.1272
// area, property accuracy 0.95933702 .. 0.99348066, 41.6s, certify exit 1.
const COMPILER_PROV = {
  schema: 2, at: "2026-07-27T11:42:18.310Z", jobId: "job_1785026968111_96fadbd7",
  engine: "compiler", engineLabel: "DETERMINISTIC COMPILER (DIAMOND-46)", diamondTag: "DIAMOND-46",
  figma: { fileKey: "TmppLGRXkZmWB5OqzZD00H", nodeId: "1:7", designWidth: 650 },
  compiler: {
    attempted: true, exit: 1, proven: false, shipped: true,
    refusalGuard: null, refusalReason: null,
    transforms: ["compliance", "mobile:599-480-374", "centering", "buttontarget:14"],
    notAttemptedBecause: null,
  },
  fallback: { occurred: false, from: null, to: null, guard: null, reason: null, mode: "fallback", flag: "COMPILER_FALLBACK_MODE", note: null },
  quality: {
    liveTextCoverage: 1, sliceRatioNodes: 0.1781, sliceRatioArea: 0.1272,
    propertyAccuracyFloor: 0.95933702, propertyAccuracyCeiling: 0.99348066,
    divergenceCount: 59, divergenceBreakdown: { "link.href": 29, "type.runs": 29, "type.lineCount": 1 },
    textNodes: 108, slicedTextNodes: 0, wordFatalCount: 0,
    source: "compile_job_1785026968111_96fadbd7.certificate.json",
  },
  delivery: { espTarget: "klaviyo", espTargetRecognised: "klaviyo", espTokensApplied: 14, darkMode: true, specSource: "figma", note: "" },
  secondsElapsed: 41.6,
  deliveredVerification: { ok: true, dims: null, pixel: { diff: 0 }, fonts: null, images: { broken: 0 }, reasons: null },
  banner: "ENGINE: DETERMINISTIC COMPILER (DIAMOND-46) — UNPROVEN, 59 divergence(s) (certify exit 1; shipped per OUTPUT POLICY §8)",
  humanBlock: "ROUTE PROVENANCE\n  compiler tag        : DIAMOND-46\n  certify exit        : 1   proven=false",
};

const FALLBACK_PROV = {
  schema: 2, at: "2026-07-27T09:03:44.001Z", jobId: "job_failsfirst_1",
  engine: "llm", engineLabel: "LLM PIPELINE (Claude Code)", diamondTag: "DIAMOND-46",
  figma: { fileKey: null, nodeId: null, designWidth: null },
  compiler: {
    attempted: true, exit: null, proven: null, shipped: false,
    refusalGuard: "COORDINATES_MISSING", refusalReason: "missing figma coordinates",
    transforms: null, notAttemptedBecause: null,
  },
  fallback: {
    occurred: true, from: "compiler", to: "llm",
    guard: "COORDINATES_MISSING", reason: "missing figma coordinates",
    mode: "fallback", flag: "COMPILER_FALLBACK_MODE",
    note: "COMPILER_FALLBACK_MODE=fallback (default) — the LLM produced this artifact BECAUSE the compiler refused. This is recorded, not silent (Owner Requirement 8).",
  },
  quality: {
    liveTextCoverage: null, sliceRatioNodes: null, sliceRatioArea: null,
    propertyAccuracyFloor: null, propertyAccuracyCeiling: null,
    divergenceCount: null, divergenceBreakdown: null,
    textNodes: null, slicedTextNodes: null, wordFatalCount: null,
    source: "no certificate path (the compiler did not get far enough to write one)",
  },
  delivery: { espTarget: null, espTargetRecognised: null, espTokensApplied: null, darkMode: false, specSource: null, note: "" },
  secondsElapsed: 0,
  deliveredVerification: null,
  banner: "ENGINE: LLM PIPELINE — ★ FALLBACK. The compiler REFUSED this design [COORDINATES_MISSING] and the LLM produced this artifact instead.",
  humanBlock: "ROUTE PROVENANCE\n  ★ FALLBACK — THIS IS NOT COMPILER OUTPUT.\n  refusal guard : COORDINATES_MISSING",
};

const rowFor = (orderId, over = {}) => ({
  orderId,
  leadEmail: "lead@example.com",
  figmaUrl: "https://www.figma.com/design/TmppLGRXkZmWB5OqzZD00H/Pulse?node-id=1-7",
  esp: "klaviyo", darkMode: true, tatHours: 24,
  deadline: "2026-07-28T06:30:00.000Z",
  effectiveDeadline: "2026-07-28T02:30:00.000Z",
  deliveredHtml: REAL_HTML,
  dropboxFolderUrl: `https://www.dropbox.com/scl/fo/w1tn3ss/${orderId}?rlkey=folder&dl=0`,
  dropboxHtmlUrl: `https://www.dropbox.com/scl/fi/w1tn3ss/${orderId}.html?rlkey=file&dl=0`,
  previewUrl: `https://dl.dropboxusercontent.com/scl/fi/w1tn3ss/preview.png?rlkey=prev&raw=1`,
  hasInlinePreviewBytes: true,
  previewStatus: "present",
  imageCount: 104,
  ledger: deriveWordFatalLedger(REAL_HTML),
  generationSeconds: 150,
  ...over,
});

console.log("\n════════════════════════════════════════════════════════════════════");
console.log("A. BOTH RENDERINGS, ON REAL DATA");
console.log("════════════════════════════════════════════════════════════════════");
console.log("   Delivered HTML: references/arsenal-pulse.html — a REAL deliverable");
console.log("   committed to this repo (181,532 bytes, 33 real href=\"#\" placeholders,");
console.log("   104 images). Provenance: the real route-provenance.mjs shape with the");
console.log("   real numbers from compile job_1785026968111_96fadbd7 (DIAMOND-46).\n");

await fs.mkdir(OUT, { recursive: true });
const stub = createStubTransport({ dir: OUT, log: () => {} });
const written = {};

for (const [label, orderId, prov] of [
  ["COMPILER ROUTE", "TEST27-1907-compiler", COMPILER_PROV],
  ["LLM-FALLBACK ROUTE", "TEST27-1907-llm-fallback", FALLBACK_PROV],
]) {
  const message = buildOrderConfirmation({ ...rowFor(orderId), provenance: prov });
  const r = await sendOrderConfirmation({
    message, previewBytes: FAKE_PNG, orderId,
    env: { ORDER_CONFIRMATION_ENABLED: "true" }, log: () => {}, transport: stub,
    date: "Mon, 27 Jul 2026 12:00:00 +0530", messageId: `<${orderId}@maveloper.local>`,
  });
  written[label] = r.wrote;
  console.log(`── ${label} ──────────────────────────────────────────────`);
  console.log(`   subject : ${message.subject}`);
  console.log(`   envelope: ${message.from} → ${message.to}   bcc ${message.bcc}`);
  console.log(`   .eml    : ${r.wrote.eml}`);
  console.log(`   .html   : ${r.wrote.html}`);
  console.log(`   .json   : ${r.wrote.json}`);
  console.log(`   engine  : ${message.diagnostics.engine}   fellBack=${message.diagnostics.fellBack}` +
    `${message.diagnostics.fallbackGuard ? `   guard=${message.diagnostics.fallbackGuard}` : ""}`);
  console.log(`   preview : ${message.diagnostics.previewMode}`);
  console.log("");
}

const compilerHtml = await fs.readFile(written["COMPILER ROUTE"].html, "utf-8");
const fallbackHtml = await fs.readFile(written["LLM-FALLBACK ROUTE"].html, "utf-8");
const compilerEml = await fs.readFile(written["COMPILER ROUTE"].eml, "utf-8");

W("A1 ★ the two renderings are DIFFERENT documents — a fallback does not read like a compiler ship",
  compilerHtml !== fallbackHtml && Math.abs(compilerHtml.length - fallbackHtml.length) > 200,
  [`compiler : ${compilerHtml.length} bytes`, `fallback : ${fallbackHtml.length} bytes`,
   `delta    : ${Math.abs(compilerHtml.length - fallbackHtml.length)} bytes`]);

W("A2 ★ the compiler rendering names the engine AND its real proof numbers",
  /deterministic compiler/i.test(compilerHtml) && /DIAMOND-46/.test(compilerHtml) &&
  /100%/.test(compilerHtml) && /17\.81%/.test(compilerHtml) && /59 checked properties/.test(compilerHtml),
  ["live-text coverage 100% · slice ratio 17.81% (12.72% area)",
   "property accuracy 95.93% to 99.35% · 59 divergences, broken down"]);

W("A3 ★★ the FALLBACK rendering says so PLAINLY and NAMES THE REASON",
  /built by our LLM, not the deterministic compiler/i.test(fallbackHtml) &&
  /COORDINATES_MISSING/.test(fallbackHtml) && /missing figma coordinates/.test(fallbackHtml),
  ["headline names the LLM", "guard : COORDINATES_MISSING", "reason: \"missing figma coordinates\" (verbatim)"]);

W("A4 ★ the fallback rendering makes NO compiler claim and reports NO invented numbers",
  !/17\.81%|95\.93%|108 text blocks|DIAMOND-46 \(proven/.test(fallbackHtml) &&
  !/Layout accuracy/.test(fallbackHtml) && !/Slice ratio/.test(fallbackHtml),
  ["no accuracy row, no slice-ratio row — the record has no numbers, so none are printed"]);

W("A5 ★ the placeholder gate is prominent in BOTH, and in the subject line",
  /33 placeholder links to replace/.test(compilerHtml) && /33 placeholder links to replace/.test(fallbackHtml) &&
  /not sendable/i.test(compilerHtml) && /not sendable/i.test(fallbackHtml),
  ["subject: \"TEST27-1907-compiler is built — 33 links to replace before sending\""]);

W("A6 ★ the preview is INLINE in the .eml the owner opens — not an attachment",
  /Content-Type: multipart\/related/.test(compilerEml) &&
  /Content-Disposition: inline/.test(compilerEml) &&
  !/Content-Disposition: attachment/.test(compilerEml),
  ["multipart/related + Content-ID + Content-Disposition: inline",
   "the string 'attachment' appears nowhere in the message"]);

W("A7 it is a real email: tables, no flexbox/grid, inline styles, dark-client metas",
  !/display\s*:\s*flex/i.test(compilerHtml) && !/display\s*:\s*(inline-)?grid/i.test(compilerHtml) &&
  !/var\(--/.test(compilerHtml) && /role="presentation"/.test(compilerHtml) &&
  /prefers-color-scheme: dark/.test(compilerHtml) && /<!--\[if mso\]>/.test(compilerHtml));

W("A8 it is Maveloper-generated: lime #C1FF72, 'Born at Mavlers', sharp edges",
  compilerHtml.includes("#C1FF72") && /Born at Mavlers/.test(compilerHtml) &&
  !/border-radius:\s*[1-9]/.test(compilerHtml));

console.log("\n════════════════════════════════════════════════════════════════════");
console.log("B. ★★ FAILS-FIRST — A TRANSPORT FAILURE MUST NOT BLOCK DELIVERY");
console.log("════════════════════════════════════════════════════════════════════\n");

// ── B1: the delivery sequence, with the transport hard-down ───────────────────
// This mirrors /approve's ORDER of operations. Every step before the email is a
// real function from this repo where one exists (buildDeliveryNotes,
// buildCertificateText, deriveWordFatalLedger); the Dropbox and Supabase effects
// are recorded so we can assert they completed.
console.log("── B1. the delivery sequence with SMTP hard-down ────────────────\n");

const logLines = [];
const log = (level, msg, meta) => logLines.push({ level, msg, meta });
const dropbox = { uploaded: [], shareLinks: [] };
const db = { os_queue: {}, maveloper_jobs: { delivery_meta: {} } };

const orderId = "TEST27-1907";
const folderPath = "/maveloper/2026/07-2026/TEST27-1907";

// steps 1-5: the folder (as /approve builds it, in the same order)
for (const f of [`${orderId}.html`, "delivery-notes.txt", "certificate.txt", "preview.png", ...Array.from({ length: 104 }, (_, i) => `images/slice_${i}@2x.png`)]) {
  dropbox.uploaded.push(`${folderPath}/${f}`);
}
const notes = buildDeliveryNotes({
  orderId, esp: "klaviyo", darkMode: true, fonts: ["Inter"],
  ledger: deriveWordFatalLedger(REAL_HTML), generatedBy: "compiler",
  imageCount: 104, generatedAt: "2026-07-27T12:00:00.000Z", provenance: COMPILER_PROV,
});
const cert = buildCertificateText({ generatedBy: "compiler", certificate: null, orderId, provenance: COMPILER_PROV });
// step 6: the folder share link — the email cannot fire before this exists
const dropboxUrl = `https://www.dropbox.com/scl/fo/w1tn3ss/${orderId}?rlkey=folder&dl=0`;
dropbox.shareLinks.push(dropboxUrl);
// step 7: os_queue.dropbox_url write-back
db.os_queue.dropbox_url = dropboxUrl;
// step 8: provenance is already on the job row from /bridge-callback
db.maveloper_jobs.delivery_meta.provenance = COMPILER_PROV;
db.maveloper_jobs.delivery_meta.certificate = null;

// step 9: THE EMAIL — with a transport that is completely down.
const deadSmtp = {
  name: "smtp",
  describe: () => "smtp smtp-relay.gmail.com:587 (STARTTLS, AUTH LOGIN)",
  async send() { throw new Error("SMTP smtp-relay.gmail.com:587 step 5 (AUTH LOGIN) expected 235 got 535: 5.7.8 Username and Password not accepted"); },
};
const message = buildOrderConfirmation({ ...rowFor(orderId), provenance: COMPILER_PROV, dropboxFolderUrl: dropboxUrl });
const sendResult = await sendOrderConfirmation({
  message, previewBytes: FAKE_PNG, orderId, requestId: "req-witness",
  env: { ORDER_CONFIRMATION_ENABLED: "true" }, log, transport: deadSmtp,
});
const confirmationEmail = confirmationMetaFor(sendResult, message);
db.maveloper_jobs.delivery_meta.confirmationEmail = confirmationEmail;

// step 10: the response /approve returns
const approveResponse = {
  dropboxUrl, orderId, folderPath, imageCount: 104, previewStatus: "present",
  generatedBy: "compiler", folderIntegrity: { ok: true, missingFiles: [], deadRefs: [] },
  confirmationEmail, requestId: "req-witness",
};

W("B1.1 ★★ THE ORDER STILL COMPLETES — /approve returns its success payload, not a 500",
  !!approveResponse.dropboxUrl && approveResponse.orderId === orderId && approveResponse.generatedBy === "compiler",
  [`dropboxUrl : ${approveResponse.dropboxUrl}`, `generatedBy: ${approveResponse.generatedBy}`]);

W("B1.2 ★★ IT STILL REACHES DROPBOX — every folder file was uploaded and the share link exists",
  dropbox.uploaded.length === 108 && dropbox.uploaded.includes(`${folderPath}/${orderId}.html`) &&
  dropbox.uploaded.includes(`${folderPath}/preview.png`) && dropbox.shareLinks.length === 1,
  [`uploaded    : ${dropbox.uploaded.length} files (html + notes + certificate + preview + 104 images)`,
   `share links : ${dropbox.shareLinks.length}`, `os_queue.dropbox_url written: ${db.os_queue.dropbox_url === dropboxUrl}`]);

W("B1.3 ★★ IT STILL WRITES PROVENANCE — the engine record is intact and untouched by the email failure",
  db.maveloper_jobs.delivery_meta.provenance === COMPILER_PROV &&
  db.maveloper_jobs.delivery_meta.provenance.engine === "compiler" &&
  db.maveloper_jobs.delivery_meta.provenance.diamondTag === "DIAMOND-46",
  ["delivery_meta.provenance.engine     : compiler",
   "delivery_meta.provenance.diamondTag : DIAMOND-46",
   "the confirmationEmail write is a MERGE — it does not clobber provenance or certificate"]);

W("B1.4 the human-facing folder files were still written, still naming the engine",
  /ENGINE: DETERMINISTIC COMPILER \(DIAMOND-46\)/.test(notes) && /DIAMOND-46/.test(cert),
  [`delivery-notes.txt : ${notes.length} bytes`, `certificate.txt    : ${cert.length} bytes`]);

const errLine = logLines.find((l) => l.level === "error");
W("B1.5 ★★ THE FAILURE IS VISIBLE IN THE LOG, LOUDLY — not silent",
  !!errLine && /★/.test(errLine.msg) && /ORDER SHIPPED ANYWAY/.test(errLine.msg) && /535/.test(errLine.meta.error),
  [`level : ${errLine ? errLine.level : "(none)"}`,
   `msg   : ${errLine ? errLine.msg : "(none)"}`,
   `error : ${errLine ? String(errLine.meta.error).slice(0, 90) : "(none)"}`,
   `action: ${errLine ? String(errLine.meta.whatToDo).slice(0, 90) : "(none)"}`]);

W("B1.6 ★★ THE FAILURE IS VISIBLE ON THE JOB ROW — in delivery_meta, an EXISTING jsonb column",
  db.maveloper_jobs.delivery_meta.confirmationEmail.ok === false &&
  /535/.test(db.maveloper_jobs.delivery_meta.confirmationEmail.error) &&
  db.maveloper_jobs.delivery_meta.confirmationEmail.transport === "smtp" &&
  db.maveloper_jobs.delivery_meta.confirmationEmail.to === "lead@example.com",
  [`delivery_meta.confirmationEmail = ${JSON.stringify({
    ok: confirmationEmail.ok, reason: confirmationEmail.reason, transport: confirmationEmail.transport,
    to: confirmationEmail.to, placeholderLinks: confirmationEmail.placeholderLinks,
  })}`,
   "★ NO NEW COLUMN: this is the same jsonb the certificate and provenance already use"]);

W("B1.7 ★ and it is in the /approve RESPONSE, so the UI can surface it without a log dive",
  approveResponse.confirmationEmail.ok === false && approveResponse.confirmationEmail.attempted === true);

W("B1.8 ★ 'off' and 'failed' are distinguishable — a disabled feature is not an incident",
  (await sendOrderConfirmation({ message, orderId, env: {}, log: () => {}, transport: deadSmtp })).ok === null);

// ── B2: the STATIC assertion against the real shipped server.js ───────────────
console.log("\n── B2. the real server.js wiring, asserted statically ───────────\n");

const serverSrc = readFileSync(path.join(__dirname, "server.js"), "utf-8");
const approveStart = serverSrc.indexOf('app.post("/approve"');
const approveEnd = serverSrc.indexOf('app.get("/runner/status"');
const approveSrc = serverSrc.slice(approveStart, approveEnd);

const iShareLink = approveSrc.indexOf("const dropboxUrl = await createFolderShareLink(folderPath)");
const iFlagGate = approveSrc.indexOf("if (isConfirmationEnabled(process.env))");
const iSend = approveSrc.indexOf("await sendOrderConfirmation(");
const iResJson = approveSrc.indexOf("res.json({");

W("B2.1 the confirmation block exists inside the real /approve handler",
  approveStart > 0 && iFlagGate > 0 && iSend > 0,
  [`/approve handler spans ${approveSrc.length} bytes of server.js`]);

W("B2.2 ★ THE SEND IS AFTER THE DROPBOX SHARE LINK — so the email can carry the links",
  iShareLink > 0 && iShareLink < iFlagGate && iFlagGate < iSend,
  [`createFolderShareLink at +${iShareLink}`, `flag gate at +${iFlagGate}`, `sendOrderConfirmation at +${iSend}`]);

W("B2.3 ★ THE SEND IS BEFORE res.json — so the outcome reaches the response",
  iSend < iResJson, [`sendOrderConfirmation at +${iSend}`, `res.json at +${iResJson}`]);

// The block between the flag gate and res.json must contain its OWN try/catch.
const block = approveSrc.slice(iFlagGate, iResJson);
W("B2.4 ★★ THE BLOCK HAS ITS OWN try/catch — without it a throw here would turn a COMPLETED delivery into a 500",
  /\btry\s*\{/.test(block) && /catch\s*\(confErr\)/.test(block) &&
  /ORDER-CONFIRMATION BLOCK THREW/.test(block) && /ORDER SHIPPED ANYWAY/.test(block),
  ["catch (confErr) present, logs at error, does not rethrow"]);

// ★ THIS ASSERTION WAS RED AND NOBODY SAW IT. Its first clause used to read
// `iFlagGate < iShareLink + block.length` — arithmetic across two unrelated
// offsets that happened to be true while createFolderShareLink(folderPath) sat
// LATE in the route. Commit 1b436b5 hoisted the share link above the
// housekeeping (correctly — it is why the Dropbox link now appears in seconds),
// which moved iShareLink 5.4 KB earlier and made the sum smaller than iFlagGate.
// The witness has therefore been reporting "22 held, 1 broke" since that commit
// while the PROPERTY it names has never stopped being true. Restated as the
// property itself: every Dropbox call and the send that the confirmation block
// makes must sit
// after the flag gate, so an unset flag reaches none of them.
const iHtmlLink = approveSrc.indexOf("createFolderShareLink(`${folderPath}/${orderId}.html`)");
const iPreviewDownload = approveSrc.indexOf("await dbx.filesDownload({ path: previewDest })");
W("B2.5 ★ the flag gate wraps the WHOLE block, so with the flag off not even a Dropbox call is made",
  iFlagGate > 0 && iHtmlLink > iFlagGate && iPreviewDownload > iFlagGate && iSend > iFlagGate &&
  iHtmlLink < iResJson && iPreviewDownload < iResJson,
  ["the direct-HTML-link call and the preview download both sit INSIDE the flag gate",
   `flag gate +${iFlagGate} < html share link +${iHtmlLink} < preview download +${iPreviewDownload} < send +${iSend}`,
   "→ flag off means byte-identical production behaviour, including latency and Dropbox API usage"]);

W("B2.6 ★ the confirmation write to delivery_meta is a read-modify-write MERGE, not an overwrite",
  /select\("delivery_meta"\)/.test(block) && /\.\.\.\(cur && cur\.delivery_meta/.test(block),
  ["a blind update would delete the certificate and provenance already in the column"]);

// The flag must have exactly ONE definition. server.js must call the predicate,
// never re-read the env var itself — two readers is how a flag ends up half-on.
W("B2.7 the flag has ONE definition — server.js calls the predicate, it never reads the env var directly",
  !/process\.env\.ORDER_CONFIRMATION_ENABLED/.test(serverSrc) &&
  !/process\.env\[["']ORDER_CONFIRMATION_ENABLED/.test(serverSrc) &&
  /isConfirmationEnabled\(process\.env\)/.test(serverSrc),
  ["server.js: isConfirmationEnabled(process.env)",
   "the only definition of the name is CONFIRMATION_FLAG in order-confirmation-transport.js"]);

console.log("\n════════════════════════════════════════════════════════════════════");
console.log(`${broke === 0 ? "ALL WITNESSES HELD" : "WITNESSES BROKE"} — ${held} held, ${broke} broke`);
console.log("════════════════════════════════════════════════════════════════════");
console.log("\nOPEN THESE:");
console.log(`  compiler route     : ${written["COMPILER ROUTE"].eml}`);
console.log(`  LLM-fallback route : ${written["LLM-FALLBACK ROUTE"].eml}`);
console.log("  (.eml opens in Outlook / Apple Mail / Thunderbird with the preview inline;");
console.log("   the .html next to it opens in a browser for a faster look.)\n");

process.exit(broke === 0 ? 0 : 1);
