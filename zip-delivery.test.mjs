// =====================================================================
// zip-delivery.test.mjs — proves the compiler-slice ZIP fix is
//   (1) INERT on the LLM path (ZIP manifest + contents byte-identical to today), and
//   (2) CORRECT on the compiler path (slice PNGs bundled as local images/ files, the
//       ZIP's HTML references them by a local relative path, absolute URL gone), and
//   (3) TWO-COPY safe (buildDeliveryZip never mutates the caller's HTML, so the
//       delivered EMAIL copy keeps its ABSOLUTE Dropbox URLs).
//
// Pure-function test against ./zip-delivery.js — no Express boot, no network.
// Run: node zip-delivery.test.mjs   (needs adm-zip in node_modules; already a dep)
// =====================================================================
import assert from "node:assert/strict";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import { buildDeliveryZip, mergeCompilerSlices } from "./zip-delivery.js";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Read a ZIP buffer back into a stable {name -> sha256(content)} manifest so we
// compare CONTENTS + STRUCTURE, not adm-zip's per-entry DOS timestamp bytes.
function manifest(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const out = {};
  for (const e of zip.getEntries()) out[e.entryName] = sha(e.getData());
  return out;
}
function entryText(zipBuffer, name) {
  const zip = new AdmZip(zipBuffer);
  const e = zip.getEntry(name);
  assert.ok(e, `ZIP is missing entry ${name}`);
  return e.getData().toString("utf-8");
}
function entryBuffer(zipBuffer, name) {
  const zip = new AdmZip(zipBuffer);
  const e = zip.getEntry(name);
  assert.ok(e, `ZIP is missing entry ${name}`);
  return e.getData();
}

// Minimal but real 1x1 PNGs (distinct bytes) to stand in for node exports / slices.
const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const PNG_SLICE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const ORDER = "ORD_TEST_1";
const NODE_URL = "https://dl.dropboxusercontent.com/scl/fi/nodeexport/hero_1_2.png?rlkey=aaa&dl=1";
const SLICE_URL = "https://dl.dropboxusercontent.com/scl/fi/sliceexport/slice_1_90@2x.png?rlkey=bbb&dl=1";

// The delivered HTML as the COMPILER path ships it: absolute Dropbox URLs for
// BOTH the node export and the slice (the /bridge-callback fixImageUrls rewrite
// already turned the relative slice src into an absolute Dropbox URL). This is
// also the exact bytes the EMAIL carries.
const DELIVERED_HTML = [
  "<html><body>",
  `  <img src="${NODE_URL}" alt="hero">`,
  `  <img src="${SLICE_URL}" alt="slice">`,
  "</body></html>",
].join("\n");

// The LLM/today baseline: only the node-export map (no compiler slices at all).
const nodeExportMap = { "hero_1_2.png": NODE_URL };
const nodeImages = [{ filename: "hero_1_2.png", buffer: PNG_A }];

// -----------------------------------------------------------------
console.log("TEST 1 — mergeCompilerSlices inertness (reference identity)");
// -----------------------------------------------------------------
{
  const undef = mergeCompilerSlices(nodeExportMap, undefined);
  assert.equal(undef, nodeExportMap, "undefined compiler map must return the SAME object by reference");
  ok("mergeCompilerSlices(map, undefined) === map (no copy, no new keys)");

  const emptyObj = mergeCompilerSlices(nodeExportMap, {});
  assert.equal(emptyObj, nodeExportMap, "empty compiler map must return the SAME object by reference");
  ok("mergeCompilerSlices(map, {}) === map (no copy, no new keys)");

  const nullBase = mergeCompilerSlices(null, undefined);
  assert.deepEqual(nullBase, {}, "null base with no slices -> {}");
  ok("mergeCompilerSlices(null, undefined) -> {} (safe)");
}

// -----------------------------------------------------------------
console.log("TEST 2 — LLM-path ZIP is byte-identical (manifest + contents) with vs. without the merge");
// -----------------------------------------------------------------
{
  // "today": what the code did before the fix — pass imageUrlMap straight through.
  const zipToday = buildDeliveryZip(ORDER, DELIVERED_HTML, nodeExportMap, nodeImages);
  // "after the fix, LLM path": imageUrlMap routed through mergeCompilerSlices(map, empty sink).
  const mergedLlm = mergeCompilerSlices(nodeExportMap, undefined);
  const zipFixed = buildDeliveryZip(ORDER, DELIVERED_HTML, mergedLlm, nodeImages);

  assert.deepEqual(manifest(zipFixed), manifest(zipToday), "LLM-path ZIP manifest+contents changed!");
  ok("ZIP manifest + per-entry contents identical (LLM path unchanged from today)");

  // The node export IS localised (this already happened today) — sanity that the
  // baseline is a real localising ZIP, so TEST 3's slice assertions are meaningful.
  const htmlToday = entryText(zipToday, `${ORDER}.html`);
  assert.ok(!htmlToday.includes(NODE_URL), "node-export URL should be localised out even today");
  assert.ok(htmlToday.includes("images/hero_1_2.png"), "node export should be localised to images/ even today");
  // The slice URL is NOT in the map on the LLM path, so today it stays absolute in the ZIP too.
  assert.ok(htmlToday.includes(SLICE_URL), "with no slice map, slice URL stays absolute (today's behaviour)");
  ok("baseline ZIP localises node exports; leaves un-mapped URLs absolute (as today)");
}

// -----------------------------------------------------------------
console.log("TEST 3 — compiler path: slice PNGs bundled as local files, ZIP HTML uses local relative path");
// -----------------------------------------------------------------
{
  // The compiler slice map the /bridge-callback produced (basename -> Dropbox URL),
  // handed to the figma handler and folded into imageUrlMap.
  const compilerSliceMap = { "slice_1_90@2x.png": SLICE_URL };
  const merged = mergeCompilerSlices(nodeExportMap, compilerSliceMap);

  // Slice win on key collision + additive merge.
  assert.notEqual(merged, nodeExportMap, "merged must be a NEW object when slices are present");
  assert.equal(merged[NODE_URL] === undefined, true);
  assert.equal(merged["hero_1_2.png"], NODE_URL, "node export entry preserved");
  assert.equal(merged["slice_1_90@2x.png"], SLICE_URL, "slice entry present");
  ok("mergeCompilerSlices folds the slice map in (additive)");

  // /approve downloads every map entry into images[]; here both node + slice.
  const images = [
    { filename: "hero_1_2.png", buffer: PNG_A },
    { filename: "slice_1_90@2x.png", buffer: PNG_SLICE },
  ];
  const zip = buildDeliveryZip(ORDER, DELIVERED_HTML, merged, images);

  // (a) the slice PNG is a LOCAL FILE under images/ with the exact bytes.
  const m = manifest(zip);
  assert.ok(m["images/slice_1_90@2x.png"], "ZIP must contain images/slice_1_90@2x.png");
  assert.equal(
    sha(entryBuffer(zip, "images/slice_1_90@2x.png")),
    sha(PNG_SLICE),
    "bundled slice bytes must equal the source PNG",
  );
  ok("slice PNG bundled as a local file images/slice_1_90@2x.png with exact bytes");

  // (b) the ZIP's HTML references the slice by LOCAL RELATIVE PATH, absolute URL gone.
  const zipHtml = entryText(zip, `${ORDER}.html`);
  assert.ok(zipHtml.includes("images/slice_1_90@2x.png"), "ZIP HTML must reference the slice locally");
  assert.ok(!zipHtml.includes(SLICE_URL), "ZIP HTML must NOT contain the absolute slice Dropbox URL");
  assert.ok(!zipHtml.includes(NODE_URL), "ZIP HTML must NOT contain the absolute node-export URL");
  ok("ZIP HTML references the slice by local relative path; absolute slice URL removed");
}

// -----------------------------------------------------------------
console.log("TEST 4 — two-copy: EMAIL copy keeps ABSOLUTE Dropbox URLs (buildDeliveryZip never mutates input)");
// -----------------------------------------------------------------
{
  const emailHtmlBefore = DELIVERED_HTML; // the exact bytes the email delivers
  const merged = mergeCompilerSlices(nodeExportMap, { "slice_1_90@2x.png": SLICE_URL });
  buildDeliveryZip(ORDER, emailHtmlBefore, merged, [
    { filename: "hero_1_2.png", buffer: PNG_A },
    { filename: "slice_1_90@2x.png", buffer: PNG_SLICE },
  ]);
  // The email source string is untouched — still absolute for BOTH images.
  assert.equal(emailHtmlBefore, DELIVERED_HTML, "buildDeliveryZip must not mutate the caller's HTML");
  assert.ok(emailHtmlBefore.includes(SLICE_URL), "EMAIL copy must keep the ABSOLUTE slice URL");
  assert.ok(emailHtmlBefore.includes(NODE_URL), "EMAIL copy must keep the ABSOLUTE node-export URL");
  assert.ok(!emailHtmlBefore.includes("images/slice_1_90@2x.png"), "EMAIL copy must NOT reference a local path");
  ok("EMAIL html unchanged and still absolute — ZIP copy and email copy differ deliberately");
}

console.log(`\nALL ${passed} ASSERTIONS PASSED`);
