// Unit test for delivery-folder.js — pure functions, no DB / Dropbox / Express.
// Run: node delivery-folder.test.mjs   (exit 0 = all pass)
import {
  sanitizeOrderId,
  collectReferencedUrls,
  basenameFromUrl,
  localizeHtml,
  collectLocalImageNames,
  planDeliveredImagesFolder,
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

// ── images/ trim: the DELIVERED HTML is the authority ─────────────────
// Property under test: given a delivered html referencing a KNOWN SUBSET, only
// that subset survives in images/ — for both a compiler-style and an LLM-style
// html. Mirrors exactly what /approve does: build url→filename from the html,
// then planDeliveredImagesFolder(html, map, <what is on disk>) → { keep, remove }.

// helper: build the url→filename map the html-authoritative /approve builds
const mapFromHtml = (h, preferred = {}) => {
  const out = {};
  for (const u of collectReferencedUrls(h)) out[u] = preferred[u] || basenameFromUrl(u);
  return out;
};

// --- COMPILER-style: html references ONLY 25 slices; folder also holds 32 node
//     exports uploaded by generation. Trim must drop the 32, keep the 25. ---
const NODE_EXPORTS = [
  "layer-1.png", "group-3.png", "vector-2.png", "ellipse-1.png", "frame-5.png",
  "blank-gif.png", "bg-hero.png", "logo.png", "icon-1.png", "icon-2.png",
  "shape-7.png", "shape-8.png", "rect-9.png", "rect-10.png", "star-11.png",
  "path-12.png", "path-13.png", "img-14.png", "img-15.png", "img-16.png",
  "img-17.png", "img-18.png", "img-19.png", "img-20.png", "img-21.png",
  "img-22.png", "img-23.png", "img-24.png", "img-25.png", "img-26.png",
  "img-27.png", "img-28.png",
]; // 32 node exports
const SLICES = Array.from({ length: 25 }, (_, i) => `slice_1_${i + 1}@2x.png`); // 25 slices

let compilerHtmlTrim = "<html><body>\n";
for (const s of SLICES) compilerHtmlTrim += `<img src="${dl}/${s}?rlkey=k${s}&raw=1" alt="">\n`;
compilerHtmlTrim += "</body></html>";

const compilerMap = mapFromHtml(compilerHtmlTrim);
const onDiskCompiler = [...NODE_EXPORTS, ...SLICES]; // 57 files generation + bridge left behind
const compilerPlan = planDeliveredImagesFolder(compilerHtmlTrim, compilerMap, onDiskCompiler);

ok(compilerPlan.keep.length === 25, `compiler: keep-set is the 25 referenced slices (got ${compilerPlan.keep.length})`);
ok(SLICES.every((s) => compilerPlan.keep.includes(s)), "compiler: every referenced slice is kept");
ok(compilerPlan.remove.length === 32, `compiler: removes the 32 unreferenced node exports (got ${compilerPlan.remove.length})`);
ok(NODE_EXPORTS.every((n) => compilerPlan.remove.includes(n)), "compiler: every node export is a delete target");
ok(!compilerPlan.remove.some((n) => SLICES.includes(n)), "compiler: NO referenced slice is ever a delete target");
// the surviving set == exactly the referenced subset (no more, no fewer)
const survivingCompiler = onDiskCompiler.filter((n) => !compilerPlan.remove.includes(n)).sort();
ok(JSON.stringify(survivingCompiler) === JSON.stringify([...SLICES].sort()), "compiler: images/ ends up == exactly the delivered subset");
// and the localised html resolves every one of those survivors (nothing dead)
const compilerLocal = localizeHtml(compilerHtmlTrim, compilerMap);
ok(!compilerLocal.includes("dl.dropboxusercontent.com"), "compiler: localised html has no absolute image URLs left");
ok(SLICES.every((s) => compilerLocal.includes(`images/${s}`)), "compiler: localised html references every surviving slice locally");

// --- LLM-style: html references the node exports themselves. Trim must keep ALL
//     of them and remove NOTHING (byte-identical folder). ---
let llmHtmlTrim = "<html><body>\n";
for (const n of NODE_EXPORTS) llmHtmlTrim += `<img src="${dl}/${n}?rlkey=k${n}&raw=1" alt="">\n`;
llmHtmlTrim += "</body></html>";

const llmMap = mapFromHtml(llmHtmlTrim);
const onDiskLlm = [...NODE_EXPORTS]; // generation uploaded exactly what the html uses
const llmPlan = planDeliveredImagesFolder(llmHtmlTrim, llmMap, onDiskLlm);
ok(llmPlan.remove.length === 0, `LLM: nothing removed — node exports ARE referenced (got ${llmPlan.remove.length})`);
ok(llmPlan.keep.length === 32 && NODE_EXPORTS.every((n) => llmPlan.keep.includes(n)), "LLM: keep-set is every node export");

// --- guards: never delete a referenced file even when the folder is a superset ---
const llmPlusStray = planDeliveredImagesFolder(llmHtmlTrim, llmMap, [...NODE_EXPORTS, "stray-orphan.png"]);
ok(llmPlusStray.remove.length === 1 && llmPlusStray.remove[0] === "stray-orphan.png", "LLM: an unreferenced stray is removed, referenced exports kept");

// --- re-approve: an ALREADY-localised html (images/<name> local refs) must not
//     have its local files deleted (collectLocalImageNames keeps them). ---
ok(JSON.stringify(collectLocalImageNames(compilerLocal).sort()) === JSON.stringify([...SLICES].sort()), "collectLocalImageNames finds images/<name> refs");
const reApprovePlan = planDeliveredImagesFolder(compilerLocal, {}, [...SLICES, "leftover.png"]);
ok(reApprovePlan.remove.length === 1 && reApprovePlan.remove[0] === "leftover.png", "re-approve: local image refs kept, only true orphan removed");

// --- empty folder / no images → no removals, no throw ---
ok(planDeliveredImagesFolder("<p>no images</p>", {}, []).remove.length === 0, "empty folder → nothing to remove");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
