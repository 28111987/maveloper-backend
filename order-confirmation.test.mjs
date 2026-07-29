// Unit test for order-confirmation.js + order-confirmation-transport.js.
// Pure functions and the never-throws send wrapper. No DB, no Dropbox, no
// network, no credentials. Run: node order-confirmation.test.mjs  (exit 0 = pass)
//
// FIXTURES ARE REAL, NOT INVENTED:
//   • The delivered HTML is references/arsenal-pulse.html — a real deliverable
//     already committed to this repo, carrying 33 real href="#" placeholders and
//     104 images. Anyone who clones the repo can re-run this.
//   • The provenance records use the REAL shape from the bridge's
//     route-provenance.mjs (PROVENANCE_SCHEMA 2) with the REAL numbers recorded
//     for compile job_1785026968111_96fadbd7 (DIAMOND-46): 59 divergences broken
//     down 29 link.href / 29 type.runs / 1 type.lineCount, live-text coverage
//     1.0, slice ratio 0.1781 nodes / 0.1272 area, property accuracy
//     0.95933702..0.99348066, 41.6s elapsed, certify exit 1 (shipped unproven).
//   • The fallback record uses a REAL guard/reason pair from the compiler
//     adapter: COORDINATES_MISSING / "missing figma coordinates".

import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  countPlaceholderLinks,
  readProvenanceFacts,
  buildLeadSummary,
  buildFields,
  qbGradText,
  encodedSizeReport,
  buildOrderConfirmation,
  buildRfc822,
  fmtIST,
  fmtSeconds,
  esc,
  safeHref,
  LOGO_MASTHEAD,
  LOGO_FOOTER,
  BRAND_ATTRIBUTION,
  TOKENS,
} from "./order-confirmation.js";
import {
  isConfirmationEnabled,
  CONFIRMATION_FLAG,
  createTransport,
  createStubTransport,
  sendOrderConfirmation,
  confirmationMetaFor,
} from "./order-confirmation-transport.js";
import { deriveWordFatalLedger } from "./delivery-folder.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ FAIL:", msg); } };

const REAL_HTML = readFileSync(new URL("./references/arsenal-pulse.html", import.meta.url), "utf-8");

// ── the REAL provenance shapes ────────────────────────────────────────────────
const COMPILER_PROV = {
  schema: 2,
  at: "2026-07-27T11:42:18.310Z",
  jobId: "job_1785026968111_96fadbd7",
  engine: "compiler",
  engineLabel: "DETERMINISTIC COMPILER (DIAMOND-46)",
  diamondTag: "DIAMOND-46",
  figma: { fileKey: "TmppLGRXkZmWB5OqzZD00H", nodeId: "1:7", designWidth: 650 },
  compiler: {
    attempted: true, exit: 1, proven: false, shipped: true,
    refusalGuard: null, refusalReason: null,
    transforms: ["compliance", "mobile:599-480-374", "centering", "buttontarget:14"],
    notAttemptedBecause: null,
  },
  fallback: {
    occurred: false, from: null, to: null, guard: null, reason: null,
    mode: "fallback", flag: "COMPILER_FALLBACK_MODE", note: null,
  },
  quality: {
    liveTextCoverage: 1,
    sliceRatioNodes: 0.1781,
    sliceRatioArea: 0.1272,
    propertyAccuracyFloor: 0.95933702,
    propertyAccuracyCeiling: 0.99348066,
    divergenceCount: 59,
    divergenceBreakdown: { "link.href": 29, "type.runs": 29, "type.lineCount": 1 },
    textNodes: 108, slicedTextNodes: 0, wordFatalCount: 0,
    source: "compile_job_1785026968111_96fadbd7.certificate.json",
  },
  delivery: {
    espTarget: "klaviyo", espTargetRecognised: "klaviyo", espTokensApplied: 14,
    darkMode: true, specSource: "figma", note: "esp_target and darkMode gate two additive layers…",
  },
  secondsElapsed: 41.6,
  deliveredVerification: { ok: true, dims: null, pixel: { diff: 0 }, fonts: null, images: { broken: 0 }, reasons: null },
  banner: "ENGINE: DETERMINISTIC COMPILER (DIAMOND-46) — UNPROVEN, 59 divergence(s) (certify exit 1; shipped per OUTPUT POLICY §8)",
  humanBlock: "ROUTE PROVENANCE\n  compiler tag        : DIAMOND-46\n  certify exit        : 1",
};

const FALLBACK_PROV = {
  schema: 2,
  at: "2026-07-27T09:03:44.001Z",
  jobId: "job_failsfirst_1",
  engine: "llm",
  engineLabel: "LLM PIPELINE (Claude Code)",
  diamondTag: "DIAMOND-46",
  figma: { fileKey: null, nodeId: null, designWidth: null },
  compiler: {
    attempted: true, exit: null, proven: null, shipped: false,
    refusalGuard: "COORDINATES_MISSING",
    refusalReason: "missing figma coordinates",
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
  delivery: { espTarget: null, espTargetRecognised: null, espTokensApplied: null, darkMode: false, specSource: null, note: "…" },
  secondsElapsed: 0,
  deliveredVerification: null,
  banner: "ENGINE: LLM PIPELINE — ★ FALLBACK. The compiler REFUSED this design [COORDINATES_MISSING] and the LLM produced this artifact instead.",
  humanBlock: "ROUTE PROVENANCE\n  ★ FALLBACK — THIS IS NOT COMPILER OUTPUT.",
};

// ★★ THE SECOND STATE THIS EMAIL HAS TO RENDER, AS OF 2026-07-29.
// The owner has BANNED the LLM route: every order is COMPILER or it FAILS. So a
// design the compiler refuses no longer hands off to an LLM — it produces no
// artifact at all. Same real guard/reason pair from the compiler adapter
// (COORDINATES_MISSING / "missing figma coordinates"), but the record now says
// engine:"compiler", shipped:false, fallback.occurred:false — and the guard sits
// ONLY at compiler.refusalGuard, which is why the email reads it from there.
const FAILURE_PROV = {
  schema: 2,
  at: "2026-07-27T09:03:44.001Z",
  jobId: "job_compilefail_1",
  engine: "compiler",
  engineLabel: "DETERMINISTIC COMPILER (DIAMOND-46)",
  diamondTag: "DIAMOND-46",
  figma: { fileKey: null, nodeId: null, designWidth: null },
  compiler: {
    attempted: true, exit: 2, proven: false, shipped: false,
    refusalGuard: "COORDINATES_MISSING",
    refusalReason: "missing figma coordinates",
    transforms: null, notAttemptedBecause: null,
  },
  fallback: {
    occurred: false, from: null, to: null, guard: null, reason: null,
    mode: "off", flag: "COMPILER_FALLBACK_MODE",
    note: "COMPILER_FALLBACK_MODE=off — the LLM route is banned. A refusal is a FAILED ORDER, not a substitution.",
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
  banner: "ENGINE: DETERMINISTIC COMPILER — ★ REFUSED [COORDINATES_MISSING]. NOTHING WAS BUILT.",
  humanBlock: "ROUTE PROVENANCE\n  ★ COMPILE FAILED — no artifact was produced.",
};

const BASE_ROW = {
  orderId: "TEST27-1907",
  leadEmail: "lead@example.com",
  figmaUrl: "https://www.figma.com/design/TmppLGRXkZmWB5OqzZD00H/Pulse?node-id=1-7",
  esp: "klaviyo",
  darkMode: true,
  tatHours: 24,
  deadline: "2026-07-28T06:30:00.000Z",
  effectiveDeadline: "2026-07-28T02:30:00.000Z",
  deliveredHtml: REAL_HTML,
  dropboxFolderUrl: "https://www.dropbox.com/scl/fo/abc123/TEST27-1907?rlkey=k1&dl=0",
  dropboxHtmlUrl: "https://www.dropbox.com/scl/fi/def456/TEST27-1907.html?rlkey=k2&dl=0",
  previewUrl: "https://dl.dropboxusercontent.com/scl/fi/ghi789/preview.png?rlkey=k3&raw=1",
  previewStatus: "present",
  imageCount: 104,
  ledger: deriveWordFatalLedger(REAL_HTML),
  generationSeconds: 150,
};

// ── ★ PLACEHOLDER LINKS — the sendability gate ────────────────────────────────
const ph = countPlaceholderLinks(REAL_HTML);
ok(ph.count === 33, `placeholder scan finds all 33 real href="#" links in arsenal-pulse.html (got ${ph.count})`);
ok(ph.items.length === 33, "every placeholder is itemised, not just counted");
ok(ph.items.every((i) => i.ordinal >= 1 && i.label), "each placeholder carries an ordinal and a usable label");
ok(["id-attribute", "link-text", "ordinal"].includes(ph.identifiedBy), `identifiedBy names how they were identified (${ph.identifiedBy})`);
ok(countPlaceholderLinks("").count === 0 && countPlaceholderLinks(null).count === 0, "empty/null html → 0, never a throw");
ok(countPlaceholderLinks(`<a href="https://x.com">real</a>`).count === 0, "a real href is NOT counted as a placeholder");
ok(countPlaceholderLinks(`<a href='#'>q</a><a href=# >u</a>`).count === 2, "single-quoted and unquoted href=# both count");
ok(
  countPlaceholderLinks(`<a id="cta-main" href="#">Shop now</a>`).items[0].id === "cta-main",
  "an id attribute is preferred as the disclosure key",
);
ok(
  countPlaceholderLinks(`<a href="#"><img src="a.png" alt="Logo"/></a>`).items[0].text === "[image: Logo]",
  "an image-only anchor falls back to its alt text",
);
// REGRESSION: reading the first rendered output showed raw "&zwnj;Mar 18&zwnj;,
// &zwnj;2026&zwnj;" leaking into the lead's email, because entity decoding was a
// four-item allow-list. Real deliverables pepper dates with zero-width entities
// to stop Gmail auto-linking them.
ok(
  countPlaceholderLinks(`<a href="#">&zwnj;Mar 18&zwnj;, &zwnj;2026&zwnj;</a>`).items[0].text === "Mar 18, 2026",
  "★ zero-width entities are removed from link text, not leaked raw",
);
ok(
  countPlaceholderLinks(`<a href="#">&bull; Issue 012 &middot; Live</a>`).items[0].text === "• Issue 012 · Live",
  "typographic entities decode to real characters",
);
ok(
  countPlaceholderLinks(`<a href="#">Caf&#233; &#x2192; go</a>`).items[0].text === "Café → go",
  "numeric entities (decimal and hex) decode too",
);
ok(!/&[a-z]+;/i.test(ph.items.map((i) => i.text || "").join(" ")), "★ no raw entity survives into ANY of the 33 real placeholder labels");

// ── provenance reading: the REAL shape, the REAL units ────────────────────────
const cf = readProvenanceFacts({ provenance: COMPILER_PROV, deliveredHtml: REAL_HTML, imageCount: 104 });
ok(cf.engine === "compiler", "compiler record → engine 'compiler'");
ok(cf.diamondTag === "DIAMOND-46", "diamondTag read from the record");
ok(cf.exitCode && cf.exitCode.value === 1 && cf.exitCode.source === "provenance.compiler.exit", "exit code read from compiler.exit, with its source named");
ok(cf.coverage && cf.coverage.value === 1 && cf.coverage.source === "provenance.quality.liveTextCoverage", "coverage read from quality.liveTextCoverage");
ok(cf.sliceRatio && cf.sliceRatio.value === 0.1781, "slice ratio read from quality.sliceRatioNodes");
ok(cf.sliceRatioArea && cf.sliceRatioArea.value === 0.1272, "slice ratio by AREA also read");
ok(cf.accuracyFloor.value === 0.95933702 && cf.accuracyCeiling.value === 0.99348066, "accuracy read as a RANGE (floor + ceiling), not a point");
ok(cf.divergences && cf.divergences.value === 59, "divergence count read from quality.divergenceCount");
ok(cf.divergenceBreakdown && cf.divergenceBreakdown["link.href"] === 29, "divergence BREAKDOWN read, not just the count");
ok(cf.seconds && cf.seconds.value === 41.6, "seconds read from secondsElapsed");
ok(cf.textNodes.value === 108 && cf.slicedTextNodes.value === 0, "text-node counts read (108 live, 0 sliced)");
ok(cf.espTargetRecorded === "klaviyo" && cf.darkModeRecorded === true, "ESP target + dark mode read from delivery.*");
ok(cf.proven === false, "compiler.proven read (false — shipped unproven)");
ok(cf.deliveredVerified === true, "deliveredVerification.ok read");
ok(cf.fallback === null, "a clean compiler ship records NO fallback");

const ff = readProvenanceFacts({ provenance: FALLBACK_PROV, deliveredHtml: REAL_HTML });
ok(ff.engine === "llm", "fallback record → engine 'llm'");
ok(ff.fallback && ff.fallback.occurred === true, "fallback.occurred is read");
ok(ff.fallback.guard === "COORDINATES_MISSING", "★ the NAMED GUARD survives into the email facts");
ok(ff.fallback.reason === "missing figma coordinates", "★ the VERBATIM reason survives too");
ok(ff.coverage === null && ff.accuracyFloor === null && ff.divergences === null, "a fallback has NO proof numbers — they are null, not zero");

// A record that names its guard ONLY at compiler.refusalGuard still discloses it.
const oneSided = readProvenanceFacts({
  provenance: { ...FALLBACK_PROV, fallback: { ...FALLBACK_PROV.fallback, guard: null, reason: null } },
});
ok(oneSided.fallback.guard === "COORDINATES_MISSING", "guard is recovered from compiler.refusalGuard when fallback.guard is blank");

// No record at all → nothing is fabricated.
const nf = readProvenanceFacts({ provenance: null, certificate: null, deliveredHtml: REAL_HTML });
ok(nf.hasProvenanceRecord === false && nf.engine === null, "no record → engine null, never defaulted to 'compiler'");
ok(nf.coverage === null && nf.accuracyFloor === null && nf.divergences === null && nf.seconds === null, "no record → every proof number null (nothing invented)");
ok(nf.liveTextDerived && nf.liveTextDerived.words > 0, "with no record, a DERIVED live-text proxy is offered instead — and labelled");
ok(/DERIVED|counted from the delivered HTML/.test(nf.liveTextDerived.source), "the derived proxy names itself as derived");

// Certificate-only fallback: the spelling verified in delivery-folder.js.
const certOnly = readProvenanceFacts({
  provenance: null,
  certificate: { checksRun: 1000, divergenceCount: 12, imagesTotal: 25, verdict: "MEASURED & DIVERGENT", proven: false },
});
ok(certOnly.divergences.value === 12 && certOnly.divergences.source === "certificate.divergenceCount", "certificate.divergenceCount is the documented fallback path");
ok(certOnly.accuracyDerived && certOnly.accuracyDerived.value === 98.8, "accuracy is COMPUTED from certificate checksRun/divergenceCount when provenance has none");
ok(certOnly.slicedImages.value === 25, "certificate.imagesTotal serves as the slice-count proxy");

// ── ★ THE VERDICT, IN FOUR STRINGS ────────────────────────────────────────────
const cs = buildLeadSummary(cf, { placeholderCount: 33 });
ok(cs.state === "shipped" && cs.tone === "lime", "a clean compiler ship is state 'shipped' and lime");
ok(/compiler/i.test(cs.headline) && cs.headline.length < 70, "the headline names the engine in one short statement");
ok(/DIAMOND-46/.test(cs.chip), "the scope chip carries the build tag");
ok(/pixel-perfect/.test(cs.cap), "★ certify exit 1 is still disclosed — the one caption carries the caveat now the detail table is gone");
ok(!/slice ratio|divergence|certify/i.test(cs.headline), "the HEADLINE contains no jargon a lead would not understand");

// ★★ THE COMPILE-FAILURE STATE. The LLM route is banned; a refusal is a failed
//    order, and the guard sits only at compiler.refusalGuard.
const xf = readProvenanceFacts({ provenance: FAILURE_PROV, deliveredHtml: "" });
ok(xf.refusalGuard === "COORDINATES_MISSING", "★ the refusal guard is read from compiler.refusalGuard, NOT via the fallback block");
ok(xf.compilerShipped === false, "compiler.shipped:false is read");
const xs = buildLeadSummary(xf, { placeholderCount: 0 });
ok(xs.state === "failed", "★★ a compiler that refused renders state 'failed' — NOT a clean ship");
ok(xs.tone === "red" && xs.chip === "COMPILE FAILED", "★ a failed compile is RED and says COMPILE FAILED");
ok(/could not build/i.test(xs.headline), "★ the failure headline says the order did not build, in plain words");
ok(/COORDINATES_MISSING/.test(xs.cap) && /missing figma coordinates/.test(xs.cap), "★ the failure names the guard AND quotes the verbatim reason");
ok(!/LLM/i.test(xs.headline + xs.cap + xs.engineLabel), "★★ a compiler failure NEVER mentions an LLM substitution — that route is banned");
ok(/nothing was built/i.test(xs.cap), "the failure states the consequence: no HTML, no folder");

// A pre-ban record that DOES name an LLM substitution must still not read as a
// compiler ship. It renders red like any other non-compiler artifact.
const fs2 = buildLeadSummary(ff, { placeholderCount: 33 });
ok(fs2.state === "llm" && fs2.tone === "red", "★ a legacy LLM record is red, not lime — it is not a compiler ship");
ok(/did not come from the deterministic compiler/i.test(fs2.headline), "★ a legacy LLM record SAYS SO PLAINLY in the headline");
ok(/COORDINATES_MISSING/.test(fs2.cap) && /missing figma coordinates/.test(fs2.cap), "★ it still names the guard and the verbatim reason");
ok(!/108 text blocks/.test(fs2.cap), "the compiler's live-text claim is NOT made on a non-compiler build");

// ── the assembled message ─────────────────────────────────────────────────────
const msg = buildOrderConfirmation({ ...BASE_ROW, provenance: COMPILER_PROV });
ok(msg.from === "shrujal@mavlers.com", "FROM is shrujal@mavlers.com");
ok(msg.to === "lead@example.com", "TO is the lead (os_queue.lead_email)");
ok(msg.bcc === "shrujal@mavlers.com", "★ BCC is shrujal@mavlers.com");
ok(/^TEST27-1907 is built — 33 links to replace before sending$/.test(msg.subject), `★ the SUBJECT carries the placeholder count (got: ${msg.subject})`);
ok(buildOrderConfirmation({ ...BASE_ROW, deliveredHtml: "<a href='https://x'>ok</a>", provenance: COMPILER_PROV }).subject.includes("ready to send"), "a build with no placeholders gets a 'ready to send' subject");

const H = msg.html;

// ── ★★ THE ELEVEN FIELDS, AND NOTHING ELSE ────────────────────────────────────
// The owner listed these himself on 2026-07-29. Each one must be in the bytes.
ok(H.includes("TEST27-1907"), "field 1/11: Order ID");
ok(/>TAT</.test(H) && /24h/.test(H), "field 2/11: TAT");
ok(/YOUR DEADLINE|Your deadline/i.test(H) && /IST/.test(H), "field 3/11: Your deadline, in IST");
ok(/ESP target/i.test(H) && /klaviyo/i.test(H), "field 4/11: ESP target");
ok(/Colour scheme/i.test(H) && /Dark \+ light/.test(H), "field 5/11: Colour scheme (dark or light)");
ok(/Generated by/i.test(H) && /Deterministic compiler/i.test(H) && /DIAMOND-46/.test(H), "field 6/11: Generated by");
ok(/Build time/i.test(H) && /41\.6s|42s/.test(H), "field 7/11: Build time, in seconds");
ok(H.includes("figma.com/design/TmppLGRXkZmWB5OqzZD00H"), "field 8/11: the Figma design link");
ok(H.includes(BASE_ROW.dropboxHtmlUrl.replace(/&/g, "&amp;")), "field 9/11: the direct HTML link");
ok(H.includes(BASE_ROW.dropboxFolderUrl.replace(/&/g, "&amp;")), "field 11/11: the Dropbox link");

// ★ field 10/11 — EMAIL ON ACID. No field stores one yet (blocked on a budget
//   decision), so the row must not exist at all: never a blank row, never a dead
//   label. The moment a link is supplied, it appears.
ok(!/Email on Acid/.test(H), "★ field 10/11 is ABSENT when no link exists — no blank row, no dead label");
{
  const withEoa = buildOrderConfirmation({
    ...BASE_ROW, provenance: COMPILER_PROV, emailOnAcidUrl: "https://app.emailonacid.com/test/abc",
  });
  ok(withEoa.html.includes("Email on Acid") && withEoa.html.includes("app.emailonacid.com/test/abc"),
    "★ field 10/11 APPEARS the moment a link is supplied");
  ok(withEoa.diagnostics.fieldCount === 11, `★★ with the Email on Acid link present the count is exactly ELEVEN (got ${withEoa.diagnostics.fieldCount})`);
  ok(msg.diagnostics.fieldCount === 10, "★ without it, ten — the eleventh is the only optional one");
}

// ── ★★ WHAT WAS DELETED. These assertions are the cut, expressed as tests. ────
ok(!/Live-text coverage/.test(H) && !/Live editable text/.test(H), "DELETED: live-text coverage");
ok(!/Slice ratio/.test(H) && !/17\.81%/.test(H) && !/12\.72%/.test(H), "DELETED: slice ratio");
ok(!/Layout accuracy/.test(H) && !/95\.93%/.test(H) && !/99\.35%/.test(H), "DELETED: layout accuracy");
ok(!/Known differences/.test(H) && !/59 checked/.test(H), "DELETED: known differences");
ok(!/Final-file check/.test(H), "DELETED: the final-file check row");
ok(!/how it was built/i.test(H), "DELETED: the HOW IT WAS BUILT prose block");
ok(!/the build, in detail/i.test(H), "DELETED: THE BUILD IN DETAIL block");
ok(!/before you send/i.test(H), "DELETED: the BEFORE YOU SEND section");
// (the word "Outlook" survives inside a CSS comment explaining [data-ogsc]; the
//  CAVEAT — the Word-engine paragraph a lead was asked to read — is what went.)
ok(!/Outlook on Windows|Outlook 2007-2019|none of the constructs|Word to draw email/.test(H), "DELETED: the Outlook caveat");
ok(!/On mobile/.test(H), "DELETED: the mobile caveat");
ok(!/<img[^>]*preview/i.test(H) && !/Full-length preview/.test(H), "DELETED: the inline full-length preview image");
// The 25-line itemisation is gone. Its most distinctive artefact was a list of
// link TEXTS lifted out of the delivered HTML — none of that may survive.
ok(!/Which links/.test(H), "DELETED: the 'Which links' itemisation header");
ok(!/placeholder link #/.test(H), "DELETED: the per-placeholder ordinal list");
{
  const texts = ph.items.map((i) => i.text).filter((t) => t && t.length > 8);
  ok(texts.length > 3 && !texts.some((t) => H.includes(t)),
    `★★ DELETED: not one of the ${texts.length} placeholder link TEXTS appears anywhere in the email`);
}

// ── ★ THE ONE THING KEPT THAT HE DID NOT LIST ─────────────────────────────────
// A lead who forwards an unedited master template ships dead links. One line.
{
  const line = /(\d+) placeholder links?<\/strong> still points? to &ldquo;#&rdquo; &mdash; this email is not sendable until (they are|it is) replaced\./.exec(H);
  ok(!!line && line[1] === "33", "★ the placeholder warning is present and carries the real count");
  ok((H.match(/not sendable/g) || []).length === 1, "★★ it is ONE line — it appears exactly once in the document");
  const clean = buildOrderConfirmation({ ...BASE_ROW, provenance: COMPILER_PROV, deliveredHtml: "<a href='https://x'>ok</a>" });
  ok(!/placeholder/i.test(clean.html) && !/not sendable/.test(clean.html),
    "★★ COUNT ZERO → the line is OMITTED entirely, and the word 'placeholder' appears nowhere");
  ok(!/#E8C07D/i.test(clean.html) && /#E8C07D/i.test(H),
    "★ colour ENCODES: amber has one job, so zero placeholders means zero amber in the document");
}
ok(/automated order confirmation/i.test(H) && /do not reply/i.test(H), "★ KEPT (spec): the automated-confirmation line and the do-not-reply statement");

// ── ★ IT MUST BE A REAL EMAIL ─────────────────────────────────────────────────
ok(!/display\s*:\s*flex/i.test(H), "real email: NO flexbox");
ok(!/display\s*:\s*(inline-)?grid/i.test(H), "real email: NO CSS grid");
ok(!/var\(--/.test(H), "real email: NO CSS custom properties (Outlook/Gmail strip them)");
ok(!/<link[^>]+stylesheet/i.test(H), "real email: NO external stylesheet");
ok(/role="presentation"/.test(H), "real email: layout tables are role=presentation");
ok((H.match(/<table/g) || []).length >= 5, "real email: built from nested tables");
ok(/cellpadding="0"/.test(H) && /cellspacing="0"/.test(H) && /border="0"/.test(H), "real email: tables carry the reset ATTRIBUTES, not just styles");
ok(/style="[^"]*color:#/i.test(H), "real email: styles are inline with explicit hex");
ok(/name="color-scheme"/.test(H) && /supported-color-schemes/.test(H), "real email: dark-client metas present");
ok(/prefers-color-scheme: dark/.test(H), "real email: renders in a dark client (dark-mode block present)");
ok(/\[data-ogsc\]/.test(H), "★ real email: [data-ogsc] too — Outlook.com's dark mode ignores prefers-color-scheme");
ok(/<!--\[if mso\]>/.test(H), "real email: an MSO conditional block for the Word engine");
ok(!/border-radius:\s*[1-9]/.test(H), "★ brand: sharp edges, per the /os sharp-edge system (also Outlook-safe)");
ok(/<!DOCTYPE/.test(H) && /<\/html>/.test(H), "real email: a complete document");
ok(!/<link[^>]+fonts|@import/i.test(H), "★ real email: NO webfont is fetched — the design is drawn for the fallback face");

// ── ★★ PART 2 — THE BRAND CORRECTIONS ─────────────────────────────────────────
ok(!/Born at Mavlers/i.test(H) && !/Born at Mavlers/i.test(msg.text),
  "★★ RETIRED: 'Born at Mavlers' appears nowhere in the HTML or the text part");
ok(BRAND_ATTRIBUTION === "CRAFTED BY MAVLERS", "★ the attribution constant is 'CRAFTED BY MAVLERS'");
ok(H.includes("CRAFTED BY MAVLERS") && msg.text.includes("CRAFTED BY MAVLERS"), "★★ 'CRAFTED BY MAVLERS' is in both parts");

// ── ★★ THE TWO REAL LOGOS, AND THE BLOCKED-IMAGE STATE ────────────────────────
ok(H.includes(LOGO_MASTHEAD) && H.includes(LOGO_FOOTER), "★ both real logo GIFs are wired");
{
  const imgs = H.match(/<img\b[^>]*>/g) || [];
  ok(imgs.length === 2, `★ exactly two images — both logos, no preview (got ${imgs.length})`);
  for (const [i, tag] of imgs.entries()) {
    const alt = (tag.match(/\balt="([^"]*)"/) || [])[1];
    ok(!!alt && /^[A-Z][A-Z ]+$/.test(alt), `★★ logo ${i + 1}: the alt reads as a wordmark, not a filename (${alt})`);
    ok(/\bwidth="\d+"/.test(tag) && /\bheight="\d+"/.test(tag),
      `★★ logo ${i + 1}: width AND height ATTRIBUTES reserve the box so the layout cannot collapse`);
    ok(/font-family:/.test(tag) && /font-weight:/.test(tag) && /color:#/.test(tag),
      `★★ logo ${i + 1}: the alt text is STYLED, so a blocked image renders as a wordmark and not as 8px serif`);
  }
  ok(/alt="MAVELOPER"/.test(H), "★ the masthead alt IS the Maveloper wordmark");
  ok(/alt="DESIGN MAVLERS"/.test(H), "★ the footer alt IS the DesignMavlers wordmark");
  // 600x120 and 500x500 are the real GIF header dimensions, read off the files.
  ok(/width="170" height="34"/.test(H), "★ the masthead logo is drawn at its true 5:1 ratio (source 600x120)");
  ok(/width="60" height="60"/.test(H), "★ the footer logo is SQUARE (source 500x500) and is not stretched into a letterbox");
}
ok(H.includes("Maveloper &middot; CRAFTED BY MAVLERS"),
  "★★ the attribution is LIVE TEXT under the footer logo — blocked images cost the animation, never the identity");

// ── ★★ PART 3 — THE DESIGN SYSTEM, IN THE BRIEF'S VOCABULARY ──────────────────
ok(/font-family:Poppins,'Segoe UI'/.test(H), "★ Poppins,'Segoe UI' — the second face is deliberate, it catches Windows and Gmail");
ok(/class="em_sec em_panel"/.test(H), "★ emSec_: each section is its own band");
ok(/background-image:radial-gradient\(ellipse/.test(H) && /bgcolor="#0B0B0E"/.test(H),
  "★ emSec_: a solid bgcolor for Outlook PLUS a radial glow for everything else");
ok((H.match(/border-top:1px solid #1E1E26;padding:50px 46px/g) || []).length === 3,
  "★ emSec_: three bands, each with the 1px top border and 50px/46px padding");
ok(/linear-gradient\(90deg,#C1FF72 0%,#FFDD2F 100%\)/.test(H), "★ emKick_: the 28px gradient rule");
ok(/letter-spacing:0.24em;text-transform:uppercase/.test(H), "★ emKick_: the uppercase letterspaced 10px label");
ok(/>THE ORDER</.test(H) && /THE BUILD/.test(H) && /YOUR FILES/.test(H), "★ emKick_: three sections announce themselves");
ok(/COMPILER &middot; DIAMOND-46/.test(H), "★ emKick_: the optional scope chip");
ok(/class="em_t23 em_ondark_ink"/.test(H) && /font-size:23px/.test(H), "★ emHeadScoped_: the 23px 800-weight statement");
ok(/font-size:13.5px;line-height:22px/.test(H) && /max-width:520px/.test(H), "★ emCap_: 13.5px at max-width 520px with generous leading");
ok(/class="em_mast"/.test(H) && /font-size:48px/.test(H), "★ the masthead: a gradient panel and a very large 48px title");
ok(/height:2.5px;line-height:2.5px/.test(H) && /linear-gradient\(90deg,#FFDD2F 0%,#C1FF72 100%\)/.test(H),
  "★ the footer: a 2.5px yellow-to-lime rule, then the black panel");
ok(/@media only screen and \(max-width: 600px\)/.test(H), "★ @media max-width 600px, as the reference specifies");
ok(/\.col2, \.col2b \{ display: block/.test(H), "★ col2 / col2b stacking classes");
ok(/class="col2"/.test(H) && /class="col2b"/.test(H), "★ …and they are actually applied to the grid cells");

// ── ★★ qbGradText_ — THE ONLY TEXT GRADIENT THAT SURVIVES GMAIL ───────────────
{
  const g = qbGradText("ABCD", "#C1FF72", "#FFDD2F");
  const spans = g.match(/<span style="color:#[0-9a-f]{6};">/g) || [];
  ok(spans.length === 4, "★ qbGradText_ emits one solid-colour <span> PER CHARACTER — no background-clip, which Gmail strips");
  ok(g.startsWith('<span style="color:#c1ff72;">A'), "★ …ramping from the first colour");
  ok(g.endsWith('<span style="color:#ffdd2f;">D</span>'), "★ …to the last");
  ok(!/background/.test(g), "★ …and it uses no background property at all");
  ok(qbGradText("").length === 0 && qbGradText("X").length > 0, "qbGradText_ handles empty and single-character input");
  // ★ SPENT ONCE, ON THE ONE VALUE WORTH IT. Not on prose.
  const perChar = (H.match(/<span style="color:#[0-9a-f]{6};">/g) || []).length;
  ok(perChar === "TEST27-1907".length,
    `★★ the ramp is used EXACTLY ONCE, on the Order ID, and nowhere else (${perChar} spans for an ${"TEST27-1907".length}-character id)`);
}

// ── ★★ THE COLOUR LAW: "colour ENCODES, it never decorates" ───────────────────
ok(H.includes(TOKENS.LIME), "★ LIME #C1FF72 — the deterministic route");
ok(!H.includes(TOKENS.RED), "★★ a shipped order carries NO red anywhere — red has exactly one job, and it is failure");
ok(H.includes(TOKENS.YELLOW), "★ YELLOW #FFDD2F — the house, in the masthead ramp and the footer rule");
{
  // Yellow may never touch a data value: every occurrence must be a ramp stop,
  // the footer rule, the footer alt/attribution, or the kicker rule.
  const yellowLines = H.split("\n").filter((l) => l.includes(TOKENS.YELLOW));
  ok(
    yellowLines.every((l) => /linear-gradient|em_foot|alt="DESIGN MAVLERS"|height="3"/.test(l)),
    "★★ YELLOW never touches a data value — only ramps, the footer rule and the house attribution",
  );
  // ★ Links carry NO hue. The one filled affordance — the Dropbox button — is
  //   the verdict, and it only exists on an order that shipped.
  ok(/color:#FFFFFF;text-decoration:none;border-bottom:1px solid #4E4E5A/.test(H),
    "★★ link rows are INK + underline, not accent-tinted");
  ok(/bgcolor="#C1FF72" height="46"/.test(H),
    "★ the one filled button IS the verdict — and a lime button can only exist on an order that shipped");
}

// ── ★★ THE FAILURE VARIANT IS RED THE WHOLE WAY DOWN ──────────────────────────
{
  const failMsg = buildOrderConfirmation({
    ...BASE_ROW, provenance: FAILURE_PROV, generationSeconds: null,
    deliveredHtml: "", dropboxFolderUrl: null, dropboxHtmlUrl: null,
  });
  const F = failMsg.html;
  ok(failMsg.diagnostics.state === "failed", "★★ the failure variant is state 'failed'");
  ok(/did not build/.test(failMsg.subject), `★ the SUBJECT says the order did not build (got: ${failMsg.subject})`);
  ok(/ORDER HELD/.test(F) && !/ORDER CONFIRMED/.test(F), "★ the masthead label is ORDER HELD, not ORDER CONFIRMED");
  ok(F.includes(TOKENS.RED), "★ RED #FF5A47 is present");
  ok(!F.includes(TOKENS.LIME), "★★ …and NOT ONE lime pixel survives — the whole document is tinted by its verdict");
  ok((F.match(/rgba\(255,90,71,0\.\d+\)/g) || []).length === 3, "★ all three band glows carry the failure hue, not just the one that states it");
  ok(/linear-gradient\(90deg,#FFDD2F 0%,#FF5A47 100%\)/.test(F),
    "★★ even the footer rule ramps house-yellow → RED: lime does not outlive the fact it encodes");
  ok(/COMPILE FAILED/.test(F), "★ the scope chip says COMPILE FAILED");
  ok(/COORDINATES_MISSING/.test(F) && /missing figma coordinates/.test(F), "★★ the failure names the guard and quotes the verbatim reason");
  ok(!/LLM/i.test(F), "★★ NO LLM SUBSTITUTION IS MENTIONED — the owner banned that route; a refusal is a failed order");
  ok(!/dropbox\.com/.test(F), "★ no Dropbox link is faked for an order that produced no folder");
  ok(F.includes("figma.com"), "★ the Figma link survives — it is the design the lead sent us, and it still exists");
  // ★★ AND IT IS NOT RED. Colour that encodes cannot be spent on a thing it does
  //    not describe: the compile failed, the LINK did not.
  ok(/figma\.com[^"]*" target="_blank" style="color:#FFFFFF/.test(F),
    "★★ the surviving Figma link is INK, not failure-red — a working link is never coloured as broken");
  ok(!/color:#FF5A47;text-decoration:none/.test(F), "★ no link anywhere borrows the verdict hue");
  ok(!/Build time/.test(F), "★ secondsElapsed 0 on a refused compile is a missing measurement, so the row is OMITTED");
  ok(!/not sendable/.test(F), "★ nothing was built, so there is no placeholder warning to give");
}

// ── ★ THE PREVIEW IMAGE IS GONE, AND SO IS THE PART THAT CARRIED IT ───────────
ok(msg.inlineImages.length === 0, "★ inlineImages is empty — nothing is inlined any more");
ok(msg.diagnostics.previewMode === "removed", "diagnostics say so plainly rather than reporting a mode that no longer exists");
{
  const stillPassed = buildOrderConfirmation({ ...BASE_ROW, provenance: COMPILER_PROV, hasInlinePreviewBytes: true });
  ok(stillPassed.inlineImages.length === 0 && !/cid:/.test(stillPassed.html),
    "★★ /approve still passes preview bytes and they are ACCEPTED AND IGNORED — the send site did not have to change");
}

const raw = buildRfc822(msg, { date: "Mon, 27 Jul 2026 12:00:00 +0530", messageId: "<x@y>" });
ok(/^From: Maveloper <shrujal@mavlers.com>/m.test(raw), "rfc822: From header");
ok(/^Bcc: shrujal@mavlers.com/m.test(raw), "★ rfc822: the Bcc header is present");
ok(/Content-Type: multipart\/alternative/.test(raw), "rfc822: a text/plain alternative is included");
ok(!/multipart\/related/.test(raw), "★ rfc822: with nothing to inline it is a clean multipart/alternative");
ok(!/Content-Disposition: attachment/.test(raw), "★★ rfc822: the word 'attachment' appears nowhere");
ok(/^Auto-Submitted: auto-generated/m.test(raw), "rfc822: Auto-Submitted marks it machine-generated");
ok(
  buildRfc822(msg, { date: "d", messageId: "<m>" }) === buildRfc822(msg, { date: "d", messageId: "<m>" }),
  "rfc822 is deterministic (clock is injected, never read) so it can be regression-tested",
);

// ── ★★ THE ENCODED SIZE, AGAINST GMAIL'S CLIP THRESHOLD ───────────────────────
{
  const s = msg.diagnostics.encodedSize;
  ok(s && s.gmailClipLimit === 102400, "★ the check runs on EVERY build, against Gmail's ~102,400 encoded bytes");
  ok(s.quotedPrintableBytes === Math.ceil(s.rawBytes * 1.06), "★ quoted-printable is modelled at +6%, as the reference does");
  ok(s.base64Bytes > s.quotedPrintableBytes, "★ base64 is modelled too — it is what this repo's own buildRfc822 emits");
  ok(s.worstCaseBytes === Math.max(s.qp, s.base64Bytes) || s.worstCaseBytes === s.base64Bytes, "★ the verdict is taken against the WORSE encoding");
  ok(s.clipped === false, `★★ NOT CLIPPED — ${s.worstCaseBytes} of ${s.gmailClipLimit} encoded bytes, ${s.headroomPct}% headroom`);
  ok(s.headroomPct > 50, `★ and it is not close: over half the budget is unused (${s.headroomPct}%)`);
  ok(Buffer.byteLength(H) < 26000, `★★ the source HTML is far smaller than the 34,497 bytes it replaced (now ${Buffer.byteLength(H)})`);
  const huge = encodedSizeReport("x".repeat(200000));
  ok(huge.clipped === true && huge.headroomBytes < 0, "★ and the check actually fires: an oversized document reports clipped:true");
}

// ── the plain-text part ───────────────────────────────────────────────────────
const T = msg.text;
ok(/33 placeholder links still point to "#"/.test(T), "★ the text part carries the same one-line warning");
ok((T.match(/not sendable/g) || []).length === 1, "★ …once, exactly as in the HTML");
ok(/do not reply/i.test(T), "the text part carries the do-not-reply line");
ok(!/<\/?(table|tr|td|div|span|strong|img|a|p|br)\b[^>]*>/i.test(T), "the text part contains no HTML tags");
ok(!/&(mdash|amp|nbsp|ldquo|rdquo|hellip|times|rarr|middot|#39|quot);/.test(T), "the text part has no leftover HTML entities — they are decoded to real characters");
ok(!/17\.81%|95\.93%|Outlook|On mobile|HOW IT WAS BUILT|THE BUILD, IN DETAIL/.test(T),
  "★★ the text part was cut too — the deletions are not hiding in the plain-text alternative");
ok(/^Order ID: TEST27-1907$/m.test(T) && /^TAT: 24h$/m.test(T) && /^ESP target: klaviyo$/m.test(T) && /^Colour scheme: Dark \+ light$/m.test(T),
  "★ the text part carries the same eleven fields");
ok(new RegExp(BASE_ROW.dropboxFolderUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(T), "the text part carries the raw Dropbox URL");

// ── escaping / injection ──────────────────────────────────────────────────────
ok(esc(`<script>alert(1)</script>`) === "&lt;script&gt;alert(1)&lt;/script&gt;", "esc neutralises tags");
ok(safeHref("javascript:alert(1)") === "", "safeHref drops a javascript: URL");
ok(safeHref("https://ok.example/x?a=1&b=2") === "https://ok.example/x?a=1&amp;b=2", "safeHref keeps https and escapes &");
const evil = buildOrderConfirmation({
  ...BASE_ROW, provenance: COMPILER_PROV,
  orderId: `X"><script>alert(1)</script>`,
  figmaUrl: "javascript:alert(1)",
});
ok(!/<script>alert\(1\)<\/script>/.test(evil.html), "★ a hostile order id from the DB cannot inject markup into the lead's inbox");
ok(!/href="javascript:/.test(evil.html), "★ a hostile figma_url cannot become a live javascript: link");

// ── formatters ────────────────────────────────────────────────────────────────
ok(/IST$/.test(fmtIST("2026-07-28T02:30:00.000Z")), "fmtIST returns an IST-suffixed string");
ok(fmtIST(null) === null && fmtIST("not-a-date") === null, "fmtIST returns null for missing/invalid input (row is then omitted)");
ok(fmtSeconds(150) === "2 min 30s (150s)" && fmtSeconds(41.6) === "42s", "fmtSeconds reports seconds, as the spec asks");
ok(fmtSeconds(null) === null && fmtSeconds(-1) === null, "fmtSeconds refuses nonsense rather than printing it");
// REGRESSION: the LLM-fallback rendering showed "Build time: 0s" because a
// refused compile records secondsElapsed 0 and that beat the real os_queue span.
ok(fmtSeconds(0) === null && fmtSeconds(0.4) === null, "★ a sub-second build time is a missing measurement, not '0s'");
{
  const m0 = buildOrderConfirmation({ ...BASE_ROW, provenance: FAILURE_PROV, generationSeconds: 150 });
  ok(/2 min 30s \(150s\)/.test(m0.html), "★ secondsElapsed:0 falls through to the real os_queue span, not '0s'");
  ok(!/Build time: 0s|>0s</.test(m0.html), "no '0s' build time reaches the lead");
  const mNone = buildOrderConfirmation({ ...BASE_ROW, provenance: FAILURE_PROV, generationSeconds: null });
  ok(!/Build time/.test(mNone.html), "with no usable time at all, the Build time row is OMITTED rather than faked");
}

// ── ★ buildFields: a field that could not be READ is OMITTED, never blank ─────
{
  const bare = buildFields({ orderId: "X1" });
  ok(bare.order.length === 0 && bare.links.length === 0,
    "★ with nothing readable, every optional field is omitted — no 'unknown', no blank rows");
  ok(bare.build.length === 1 && bare.build[0].value === "Generic",
    "★ …except ESP target, because 'Generic' is a real answer to that question and not a guess");
  ok(!bare.build.some((p) => p.label === "Colour scheme"),
    "★★ darkMode undefined is NOT darkMode false — the row is omitted rather than guessing 'Light only'");
  ok(bare.fieldCount === 2, "…so only the order id and the ESP target remain");
  const full = buildFields({
    orderId: "X1", tatHours: 24, bufferedDeadlineIST: "a", rawDeadlineIST: "a",
    esp: "klaviyo", darkMode: false, engineLabel: "E", generationSeconds: "42s",
    figmaUrl: "https://f", dropboxHtmlUrl: "https://h", dropboxFolderUrl: "https://d",
    emailOnAcidUrl: "https://e",
  });
  ok(full.fieldCount === 11, `★★ everything present → exactly ELEVEN fields (got ${full.fieldCount})`);
  ok(full.links[0].primary === true && full.links[0].label === "Dropbox folder", "the Dropbox folder is the primary CTA");
  ok(full.order.find((p) => p.label === "Your deadline").value === "a",
    "★ when the buffered and raw deadlines are the same, the '(buffered)' gloss is not added");
  ok(!full.build.find((p) => p.label === "Colour scheme").value.includes("Dark"),
    "darkMode:false renders 'Light only'");
}

// ── the FLAG ──────────────────────────────────────────────────────────────────
ok(CONFIRMATION_FLAG === "ORDER_CONFIRMATION_ENABLED", "the flag is named ORDER_CONFIRMATION_ENABLED");
ok(isConfirmationEnabled({}) === false, "★ DEFAULT OFF: an absent flag is disabled");
ok(isConfirmationEnabled({ ORDER_CONFIRMATION_ENABLED: "false" }) === false, `"false" is disabled`);
ok(isConfirmationEnabled({ ORDER_CONFIRMATION_ENABLED: "1" }) === false, `"1" is NOT enough — only the exact string "true" enables it`);
ok(isConfirmationEnabled({ ORDER_CONFIRMATION_ENABLED: "TRUE" }) === false, `"TRUE" is NOT enough — a flag must not turn on by accident`);
ok(isConfirmationEnabled({ ORDER_CONFIRMATION_ENABLED: "true" }) === true, `"true" enables it`);

// ── the transport selector ────────────────────────────────────────────────────
ok(createTransport({ env: {} }).name === "stub", "★ an unset transport defaults to the STUB (writes to disk, sends nothing)");
ok(createTransport({ env: { ORDER_CONFIRMATION_TRANSPORT: "gmail" } }).name === "gmail", "gmail is selectable");
ok(createTransport({ env: { ORDER_CONFIRMATION_TRANSPORT: "smtp" } }).name === "smtp", "smtp is selectable");
ok(createTransport({ env: { ORDER_CONFIRMATION_TRANSPORT: "resend" } }).name === "resend", "resend is selectable");
ok(createTransport({ env: { ORDER_CONFIRMATION_TRANSPORT: "typo" } }).name === "stub", "an unknown transport name falls back to the stub, not to a silent no-op");
ok(createTransport({ env: { ORDER_CONFIRMATION_TRANSPORT: "gmail" } }).configured === false, "gmail with no secrets reports configured:false rather than pretending");
ok(/NOT CONFIGURED/.test(createTransport({ env: { ORDER_CONFIRMATION_TRANSPORT: "smtp" } }).describe()), "an unconfigured transport describes itself as such");

// ── ★★ THE FAILS-FIRST: A SEND FAILURE MUST NEVER THROW ───────────────────────
const logged = [];
const capture = (level, msg2, meta) => logged.push({ level, msg: msg2, meta });

const boom = {
  name: "boom",
  describe: () => "a transport that always fails",
  async send() { throw new Error("SMTP 535 authentication failed"); },
};
const failResult = await sendOrderConfirmation({
  message: msg, orderId: "TEST27-1907", requestId: "req-1",
  env: { ORDER_CONFIRMATION_ENABLED: "true" }, log: capture, transport: boom,
});
ok(failResult.ok === false, "★★ a throwing transport yields ok:false — it does NOT propagate");
ok(failResult.attempted === true && failResult.reason === "transport-error", "the failure is classified, not swallowed");
ok(failResult.error.includes("535"), "the real provider error is preserved for the owner");
const loud = logged.find((l) => l.level === "error");
ok(!!loud, "★★ the failure is LOGGED LOUDLY at error level");
ok(/★/.test(loud.msg) && /ORDER SHIPPED ANYWAY/.test(loud.msg), "★★ the log line says the order shipped anyway — greppable, and reads as an incident");
ok(/was NOT notified/.test(loud.msg), "the log states the actual consequence: the lead did not get an email");
ok(loud.meta.whatToDo && /by hand/.test(loud.meta.whatToDo), "the log tells the owner what to do about it");
ok(loud.meta.transport === "boom" && loud.meta.error.includes("535"), "the log carries the transport and the error");

// A transport that rejects asynchronously, and one that returns a rejected
// promise from a non-async function — neither may escape.
for (const [label, t] of [
  ["async reject", { name: "t1", describe: () => "", send: async () => { await new Promise((_, r) => setTimeout(() => r(new Error("late")), 1)); } }],
  ["sync throw", { name: "t2", describe: () => "", send() { throw new TypeError("immediate"); } }],
  ["rejected promise", { name: "t3", describe: () => "", send: () => Promise.reject(new Error("rejected")) }],
]) {
  const r = await sendOrderConfirmation({
    message: msg, orderId: "X", env: { ORDER_CONFIRMATION_ENABLED: "true" }, log: () => {}, transport: t,
  });
  ok(r.ok === false && r.attempted === true, `fails-first: a ${label} transport is contained (ok:false, no throw)`);
}

// Flag off → nothing attempted, and that is NOT a failure.
const offResult = await sendOrderConfirmation({ message: msg, orderId: "X", env: {}, log: () => {}, transport: boom });
ok(offResult.attempted === false && offResult.reason === "flag-off", "★ flag off → not attempted (production is untouched)");
ok(offResult.ok === null, "flag off reports ok:null — 'off' is not the same as 'failed'");

// A missing lead_email is a DATA gap, named separately from a transport failure.
const noTo = await sendOrderConfirmation({
  message: { ...msg, to: null }, orderId: "X", env: { ORDER_CONFIRMATION_ENABLED: "true" }, log: capture, transport: boom,
});
ok(noTo.attempted === false && noTo.reason === "no-lead-email" && noTo.ok === false, "a missing lead_email is reported as a data gap, not a transport error");

// confirmationMetaFor is JSON-serialisable for the delivery_meta jsonb write.
const meta = confirmationMetaFor(failResult, msg);
ok(JSON.stringify(meta).length > 0 && meta.ok === false && meta.error.includes("535"), "the job-row record serialises and carries the failure");
ok(meta.placeholderLinks === 33 && meta.engine === "compiler", "the job-row record carries the diagnostics worth querying later");

// ── the STUB actually writes openable files ───────────────────────────────────
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mav-conf-"));
  const stub = createStubTransport({ dir, log: () => {} });
  const r = await stub.send({
    message: msg, previewBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    orderId: "TEST27-1907", date: "Mon, 27 Jul 2026 12:00:00 +0530", messageId: "<x@y>",
  });
  ok(r.ok === true && r.sent === false, "the stub reports success WITHOUT claiming it sent anything");
  const eml = await fs.readFile(r.wrote.eml, "utf-8");
  ok(eml.includes("Content-Type: multipart/alternative") && !eml.includes("Content-Disposition"),
    "★ the stub's .eml is a real message and carries no part to dispose of");
  const browser = await fs.readFile(r.wrote.html, "utf-8");
  ok(!browser.includes('src="cid:'), "the stub's browser copy has no cid: src to rewrite — nothing is inlined");
  ok(browser.includes("NOT SENT"), "the stub's browser copy says plainly that it was not sent");
  const j = JSON.parse(await fs.readFile(r.wrote.json, "utf-8"));
  ok(j.notSent === true && j.envelope.bcc === "shrujal@mavlers.com" && j.inlinePreview.attachedAsFile === false, "the stub's json records the envelope, the bcc and that nothing was attached");
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
