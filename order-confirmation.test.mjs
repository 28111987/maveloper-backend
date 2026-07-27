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
  buildOrderConfirmation,
  buildRfc822,
  buildOutlookCaveat,
  fmtIST,
  fmtSeconds,
  esc,
  safeHref,
  PREVIEW_CID,
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

// ── ★ THE LEAD-READABLE TRANSLATION ───────────────────────────────────────────
const cs = buildLeadSummary(cf, { placeholderCount: 33 });
ok(/deterministic compiler/i.test(cs.headline), "compiler summary leads with a plain sentence naming the engine");
ok(cs.tone === "lime" && cs.fellBack === false, "a compiler ship is lime and not marked as a fallback");
ok(cs.paragraphs.some((p) => /108 text blocks/.test(p)), "the live-text guarantee is stated in lead language with the real count");
ok(cs.paragraphs.some((p) => /not pixel-perfect|59 checked/.test(p)), "★ certify exit 1 is disclosed — a compiler ship is not silently presented as proven");
ok(cs.paragraphs.some((p) => /replace 33 placeholder link/.test(p)), "the sendability sentence carries the real placeholder count");
ok(!/slice ratio|divergence|certify/i.test(cs.headline), "the HEADLINE contains no jargon a lead would not understand");

const fs2 = buildLeadSummary(ff, { placeholderCount: 33 });
ok(/LLM, not the deterministic compiler/i.test(fs2.headline), "★ a fallback SAYS SO PLAINLY in the headline");
ok(fs2.tone === "amber" && fs2.fellBack === true, "a fallback is amber and flagged");
ok(fs2.paragraphs.some((p) => /COORDINATES_MISSING/.test(p)), "★ the fallback names the guard to the lead");
ok(fs2.paragraphs.some((p) => /missing figma coordinates/.test(p)), "★ the fallback quotes the verbatim reason to the lead");
ok(fs2.paragraphs.some((p) => /no pixel-level proof/i.test(p)), "the fallback states what the lead loses, in plain terms");
ok(!fs2.paragraphs.some((p) => /108 text blocks/.test(p)), "the compiler's live-text claim is NOT made on a fallback");

// ── the assembled message ─────────────────────────────────────────────────────
const msg = buildOrderConfirmation({ ...BASE_ROW, provenance: COMPILER_PROV });
ok(msg.from === "shrujal@mavlers.com", "FROM is shrujal@mavlers.com");
ok(msg.to === "lead@example.com", "TO is the lead (os_queue.lead_email)");
ok(msg.bcc === "shrujal@mavlers.com", "★ BCC is shrujal@mavlers.com");
ok(/^TEST27-1907 is built — 33 links to replace before sending$/.test(msg.subject), `★ the SUBJECT carries the placeholder count (got: ${msg.subject})`);
ok(buildOrderConfirmation({ ...BASE_ROW, deliveredHtml: "<a href='https://x'>ok</a>", provenance: COMPILER_PROV }).subject.includes("ready to send"), "a build with no placeholders gets a 'ready to send' subject");

const H = msg.html;
// SPEC CONTENT CHECKLIST — every required element present in the rendered bytes.
ok(H.includes("TEST27-1907"), "content: Order ID");
ok(H.includes("figma.com/design/TmppLGRXkZmWB5OqzZD00H"), "content: the Figma link");
ok(/24h/.test(H), "content: TAT");
ok(/IST/.test(H), "content: the deadline in IST");
ok(/klaviyo/i.test(H), "content: ESP target");
ok(/Dark mode supported/.test(H), "content: dark or light");
ok(/deterministic compiler/i.test(H) && /DIAMOND-46/.test(H), "content: GENERATED BY, from route provenance");
ok(H.includes(BASE_ROW.dropboxFolderUrl.replace(/&/g, "&amp;")), "content: the Dropbox folder link");
ok(H.includes(BASE_ROW.dropboxHtmlUrl.replace(/&/g, "&amp;")), "content: the DIRECT HTML link");
ok(/41\.6s|42s/.test(H), "content: generation time in seconds (from provenance secondsElapsed)");
ok(/Live-text coverage/.test(H) && /100%/.test(H), "content: live-text coverage, as a percentage of the 0-1 ratio");
ok(/Slice ratio/.test(H) && /17\.81%/.test(H), "content: slice ratio");
ok(/12\.72% of the visual area/.test(H), "content: slice ratio by area too");
ok(/95\.93%.*99\.35%|95\.93% to 99\.35%/.test(H), "content: accuracy as a RANGE");
ok(/Outlook/.test(H), "content: the Outlook caveat");
ok(/On mobile/.test(H), "content: mobile status");
ok(!/Email on Acid/.test(H), "content: the Email on Acid row is ABSENT when no link exists (never faked)");
ok(
  buildOrderConfirmation({ ...BASE_ROW, provenance: COMPILER_PROV, emailOnAcidUrl: "https://app.emailonacid.com/test/abc" }).html.includes("Email on Acid"),
  "content: the Email on Acid row APPEARS the moment a link is supplied",
);
ok(/automated confirmation/i.test(H) && /do not reply/i.test(H), "★ an explicit automated / do-not-reply line is present");
ok(/33 placeholder links to replace/.test(H), "★ the placeholder count is a prominent block, not a footnote");
ok((H.match(/33/g) || []).length >= 3, "★ the placeholder count appears in at least three places");

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
ok(/<!--\[if mso\]>/.test(H), "real email: an MSO conditional block for the Word engine");
ok(H.includes("#C1FF72"), "★ brand: Maveloper lime #C1FF72");
ok(/Born at Mavlers/.test(H), "★ brand: 'Born at Mavlers'");
ok(!/border-radius:\s*[1-9]/.test(H), "★ brand: sharp edges, per the /os sharp-edge system (also Outlook-safe)");
ok(/<!DOCTYPE/.test(H) && /<\/html>/.test(H), "real email: a complete document");

// ── ★ preview.png INLINE, NOT ATTACHED ────────────────────────────────────────
const inlineMsg = buildOrderConfirmation({ ...BASE_ROW, provenance: COMPILER_PROV, hasInlinePreviewBytes: true });
ok(inlineMsg.html.includes(`src="cid:${PREVIEW_CID}"`), "★ with bytes, the preview is a cid: reference (inline, survives blocked remote images)");
ok(inlineMsg.diagnostics.previewMode === "inline-cid", "diagnostics report inline-cid mode");
ok(msg.html.includes("preview.png?rlkey") || msg.html.includes("preview.png"), "without bytes, the preview falls back to the absolute Dropbox URL — still inline in the body");
ok(msg.diagnostics.previewMode === "inline-remote-url", "diagnostics report the remote-URL fallback honestly");
const noPrev = buildOrderConfirmation({ ...BASE_ROW, provenance: COMPILER_PROV, previewUrl: null, previewStatus: "absent" });
ok(!/<img[^>]*preview/.test(noPrev.html) && noPrev.diagnostics.previewMode === "absent", "with no preview at all, no broken image box is rendered");

const raw = buildRfc822(inlineMsg, { date: "Mon, 27 Jul 2026 12:00:00 +0530", messageId: "<x@y>", previewBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
ok(/^From: Maveloper <shrujal@mavlers.com>/m.test(raw), "rfc822: From header");
ok(/^Bcc: shrujal@mavlers.com/m.test(raw), "★ rfc822: the Bcc header is present");
ok(/Content-Type: multipart\/related/.test(raw), "★ rfc822: multipart/RELATED — the image is tied to the HTML that references it");
ok(/Content-Type: multipart\/alternative/.test(raw), "rfc822: a text/plain alternative is included");
ok(new RegExp(`Content-ID: <${PREVIEW_CID}>`).test(raw), "★ rfc822: the image carries the Content-ID the HTML points at");
ok(/Content-Disposition: inline/.test(raw), "★★ rfc822: Content-Disposition is INLINE — NOT 'attachment'");
ok(!/Content-Disposition: attachment/.test(raw), "★★ rfc822: the word 'attachment' appears nowhere");
ok(/^Auto-Submitted: auto-generated/m.test(raw), "rfc822: Auto-Submitted marks it machine-generated");
const rawNoImg = buildRfc822(msg, { date: "d", messageId: "<m>" });
ok(!/multipart\/related/.test(rawNoImg) && /multipart\/alternative/.test(rawNoImg), "rfc822: with no bytes it degrades to a clean multipart/alternative");
ok(
  buildRfc822(inlineMsg, { date: "d", messageId: "<m>", previewBytes: Buffer.from([1]) }) ===
    buildRfc822(inlineMsg, { date: "d", messageId: "<m>", previewBytes: Buffer.from([1]) }),
  "rfc822 is deterministic (clock is injected, never read) so it can be regression-tested",
);

// ── the plain-text part ───────────────────────────────────────────────────────
const T = msg.text;
ok(/33 PLACEHOLDER LINKS TO REPLACE — NOT SENDABLE YET/.test(T), "★ the text part leads with the placeholder gate too");
ok(/do not reply/i.test(T), "the text part carries the do-not-reply line");
ok(!/<\/?(table|tr|td|div|span|strong|img|a|p|br)\b[^>]*>/i.test(T), "the text part contains no HTML tags");
ok(!/&(mdash|amp|nbsp|ldquo|rdquo|hellip|times|rarr|#39|quot);/.test(T), "the text part has no leftover HTML entities — they are decoded to real characters");
ok(/17\.81%/.test(T), "the text part keeps the exact numbers");
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
  const m0 = buildOrderConfirmation({ ...BASE_ROW, provenance: FALLBACK_PROV, generationSeconds: 150 });
  ok(/2 min 30s \(150s\)/.test(m0.html), "★ secondsElapsed:0 falls through to the real os_queue span, not '0s'");
  ok(!/Build time: 0s|>0s</.test(m0.html), "no '0s' build time reaches the lead");
  const mNone = buildOrderConfirmation({ ...BASE_ROW, provenance: FALLBACK_PROV, generationSeconds: null });
  ok(!/Build time/.test(mNone.html), "with no usable time at all, the Build time row is OMITTED rather than faked");
}
ok(/none of the constructs/.test(buildOutlookCaveat([])), "an empty Word-fatal ledger yields an honest 'none detected' caveat");
ok(/Word/.test(buildOutlookCaveat([{ construct: "css-float", count: 3, note: "n" }])), "a populated ledger names the Word engine and the constructs");

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
    message: inlineMsg, previewBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    orderId: "TEST27-1907", date: "Mon, 27 Jul 2026 12:00:00 +0530", messageId: "<x@y>",
  });
  ok(r.ok === true && r.sent === false, "the stub reports success WITHOUT claiming it sent anything");
  const eml = await fs.readFile(r.wrote.eml, "utf-8");
  ok(eml.includes("Content-Disposition: inline") && eml.includes(`Content-ID: <${PREVIEW_CID}>`), "★ the stub's .eml is a real message with the preview INLINE");
  const browser = await fs.readFile(r.wrote.html, "utf-8");
  ok(!browser.includes("src=\"cid:"), "the stub's browser copy rewrites the cid: src so it renders outside a mail client");
  ok(browser.includes("NOT SENT"), "the stub's browser copy says plainly that it was not sent");
  const j = JSON.parse(await fs.readFile(r.wrote.json, "utf-8"));
  ok(j.notSent === true && j.envelope.bcc === "shrujal@mavlers.com" && j.inlinePreview.attachedAsFile === false, "the stub's json records the envelope, the bcc and that nothing was attached");
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
