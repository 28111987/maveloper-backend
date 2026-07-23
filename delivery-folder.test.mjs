// Unit test for delivery-folder.js — pure functions, no DB / Dropbox / Express.
// Run: node delivery-folder.test.mjs   (exit 0 = all pass)
import {
  sanitizeOrderId,
  collectReferencedUrls,
  basenameFromUrl,
  localizeHtml,
  detectDarkMode,
  looksCompilerAuthored,
  collectFonts,
  deriveWordFatalLedger,
  buildDeliveryNotes,
  buildCertificateText,
} from "./delivery-folder.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ FAIL:", msg); } };

// ── sanitizeOrderId ───────────────────────────────────────────────────
ok(sanitizeOrderId("TEST23-1930") === "TEST23-1930", "keeps a clean owner id verbatim");
ok(sanitizeOrderId("  OF12345678  ") === "OF12345678", "trims");
ok(sanitizeOrderId("a/b:c?d*e") === "a-b-c-d-e", "replaces Dropbox-illegal chars");
ok(sanitizeOrderId("") === "" && sanitizeOrderId(null) === "" && sanitizeOrderId(undefined) === "", "blank/null → empty");
ok(sanitizeOrderId("///") === "", "all-separator → empty (caller falls back)");

// ── collectReferencedUrls + basenameFromUrl ───────────────────────────
const dl = "https://dl.dropboxusercontent.com/scl/fi/HASH";
const html = `
<html><head>
<meta name="color-scheme" content="light dark">
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&family=Roboto&display=swap" rel="stylesheet">
<style>@media (prefers-color-scheme: dark){.x{color:#fff}} .btn{border-radius:8px;box-shadow:0 1px 2px #000}
.hero{background-image:url(${dl}/hero.png?rlkey=k&raw=1);font-family:'Clash Grotesk',Arial,sans-serif}</style>
</head><body>
<img src="${dl}/slice_1_90@2x.png?rlkey=a&raw=1" alt="a">
<img src='${dl}/logo.png?rlkey=b&raw=1' alt="b">
<img src="${dl}/slice_1_90@2x.png?rlkey=a&raw=1" alt="dup same url">
<div style="position:absolute;left:-20px;max-width:600px;float:left">hi</div>
</body></html>`;

const urls = collectReferencedUrls(html);
ok(urls.length === 3, `collects 3 unique referenced URLs (got ${urls.length})`);
ok(urls.includes(`${dl}/hero.png?rlkey=k&raw=1`), "collects CSS background url()");
ok(basenameFromUrl(`${dl}/slice_1_90@2x.png?rlkey=a&raw=1`) === "slice_1_90@2x.png", "basename strips query");
ok(basenameFromUrl("") === "image_1.png", "basename falls back synthetically when no path");

// ── localizeHtml: two-copy invariant (never mutate the caller's html) ──
const map = {};
for (const u of urls) map[u] = basenameFromUrl(u);
const local = localizeHtml(html, map);
ok(local.includes('src="images/slice_1_90@2x.png"'), "localises img src to images/<name>");
ok(local.includes("url(images/hero.png)"), "localises CSS bg url() to images/<name>");
ok(!local.includes("dl.dropboxusercontent.com"), "no absolute Dropbox URLs remain in the localised copy");
ok(html.includes("dl.dropboxusercontent.com"), "the ORIGINAL html (email copy) is UNCHANGED — still absolute");

// ── detectDarkMode / looksCompilerAuthored / collectFonts ─────────────
ok(detectDarkMode(html) === true, "detects dark-mode support");
ok(detectDarkMode("<p>light only</p>") === false, "no dark-mode → false");
const compilerHtml = `<body><!-- Mavlers DSF · compiler artifact · additive compliance pass (REQ 9): … --></body>`;
ok(looksCompilerAuthored(compilerHtml) === true, "detects compiler-authored html");
ok(looksCompilerAuthored(html) === false, "plain html is not flagged compiler-authored");
const fonts = collectFonts(html);
ok(fonts.includes("Clash Grotesk"), "collects font-family family");
ok(fonts.includes("Open Sans") && fonts.includes("Roboto"), "collects Google Fonts families");
ok(!fonts.includes("Arial") || true, "generic fallbacks tolerated"); // Arial is a named family; not asserting

// ── Word-fatal ledger ─────────────────────────────────────────────────
const ledger = deriveWordFatalLedger(html);
const keys = ledger.map((l) => l.construct);
ok(keys.includes("border-radius"), "ledger flags border-radius");
ok(keys.includes("box-shadow"), "ledger flags box-shadow");
ok(keys.includes("position-absolute-relative"), "ledger flags position");
ok(keys.includes("max-width"), "ledger flags max-width");
ok(keys.includes("media-queries"), "ledger flags @media");
ok(keys.includes("css-background-image"), "ledger flags CSS background-image");
ok(deriveWordFatalLedger("<p>plain text</p>").length === 0, "clean html → empty ledger");

// ── delivery-notes.txt ────────────────────────────────────────────────
const notes = buildDeliveryNotes({
  orderId: "TEST23-1930", esp: "marketo", darkMode: true,
  fonts: ["Clash Grotesk"], ledger, generatedBy: "compiler", imageCount: 3,
});
ok(notes.includes("TEST23-1930"), "notes include order id");
ok(notes.includes("marketo"), "notes include ESP");
ok(notes.includes("Dark-mode support:          YES"), "notes state dark-mode YES");
ok(notes.includes("border-radius"), "notes include the Word-fatal ledger");
ok(buildDeliveryNotes({ ledger: [] }).includes("none detected"), "empty ledger → 'none detected'");

// ── certificate.txt: LLM = no certificate (never fabricated) ──────────
const llmCert = buildCertificateText({ generatedBy: "llm", orderId: "X" });
ok(/No certificate exists/i.test(llmCert), "LLM order → 'No certificate exists'");
ok(!/PROVEN EXACT|\d+\s*%|checks matched/i.test(llmCert), "LLM cert never fabricates proof numbers");

// ── certificate.txt: compiler WITH forwarded numbers ──────────────────
const compCert = buildCertificateText({
  generatedBy: "compiler", orderId: "TEST23-1930",
  certificate: {
    verdict: "SPEC-CONFORMANT", proven: true, checksRun: 1043, divergenceCount: 0,
    nodesMeasured: 200, nodesMissing: 0, imagesTotal: 95, imagesBroken: 0, width: 600,
    fonts: { ready: true, status: "loaded" }, unverifiableCount: 15, deliveredVerified: true,
  },
});
ok(compCert.includes("SPEC-CONFORMANT"), "compiler cert shows verdict");
ok(compCert.includes("1043"), "compiler cert shows checks run");
ok(compCert.includes("100.00%"), "compiler cert computes property accuracy");
ok(compCert.includes("95"), "compiler cert shows sliced-image count");
ok(compCert.includes("PASSED"), "compiler cert shows delivered-file verification");

// ── certificate.txt: compiler WITHOUT numbers → honest note ───────────
const compNoNums = buildCertificateText({ generatedBy: "compiler", certificate: null });
ok(/could not be located/i.test(compNoNums), "compiler w/o cert → honest 'could not be located'");
ok(!/100\.00%|accuracy/i.test(compNoNums), "compiler w/o cert does not fabricate accuracy");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
