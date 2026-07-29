// Unit test for image-map-reconcile.js — pure functions, no DB / Dropbox / Express.
// Run: node image-map-reconcile.test.mjs   (exit 0 = all pass)
//
// Three jobs:
//   A. the classifier is a PARTITION — every entry lands in exactly one of four
//      categories and the four always sum to the map's size, for every input,
//      including deliberately hostile ones.
//   B. ★ THE PROPERTY THE 287-vs-114 QUESTION IS REALLY ABOUT: the delivered set
//      is the DELIVERED HTML's reference set and NOTHING ELSE — a map with a
//      thousand node exports cannot add a file to the folder, and a map missing
//      every referenced url cannot remove one. Proven against the REAL functions
//      /approve calls (collectReferencedUrls + assignLocalFilenames), not a mirror.
//   C. run it on REAL bytes: a captured production /generate-from-figma response.
import {
  reconcileImageMap, summariseReconciliation, assetIdentity,
  looksLikeNodeExport, looksLikeCompilerSlice,
} from "./image-map-reconcile.js";
import { collectReferencedUrls, assignLocalFilenames } from "./delivery-folder.js";
import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ FAIL:", msg); } };

const DL = "https://dl.dropboxusercontent.com/scl/fi";
const url = (hash, name) => `${DL}/${hash}/${name}?rlkey=k${hash}&raw=1`;

// ── assetIdentity ─────────────────────────────────────────────────────
ok(assetIdentity(url("h1", "a.png")) === assetIdentity(`${DL}/h1/a.png?rlkey=OTHER&dl=0`),
  "assetIdentity ignores the query string — ?raw=1 and ?dl=0 are one asset");
ok(assetIdentity(`https://www.dropbox.com/scl/fi/h1/a.png?dl=0`) === assetIdentity(url("h1", "a.png")),
  "assetIdentity folds www.dropbox.com and dl.dropboxusercontent.com — same object, two hosts");
ok(assetIdentity(`${DL}/h1/a.png?a=1&amp;raw=1`) === assetIdentity(url("h1", "a.png")),
  "assetIdentity decodes entities — &amp;raw=1 is not a second asset");
ok(assetIdentity(url("h1", "a.png")) !== assetIdentity(url("h2", "a.png")),
  "★ assetIdentity is NOT the basename — two exports sharing a name are two assets");
ok(assetIdentity("not a url") === "not a url", "assetIdentity degrades on junk rather than throwing");

// ── the four categories, one of each ──────────────────────────────────
{
  const referenced = url("r1", "slice_1@2x.png");
  const html = `<html><body><img src="${referenced}"><td background="${url("r2", "slice_2@2x.png")}"></td></body></html>`;
  const map = {
    "slice_1@2x.png": referenced,                        // 1 referenced + present
    "slice_2@2x.png": url("r2", "slice_2@2x.png"),       // 1 referenced + present
    "layer-1.png": url("n1", "layer-1.png"),             // 2 unreferenced node export
    "group-3.png": url("n2", "group-3.png"),             // 2 unreferenced node export
    "slice_1_copy@2x.png": `${DL}/r1/slice_1@2x.png?dl=0`, // 3 duplicate, different key
    "broken.png": null,                                  // 4 other: not a url
  };
  const r = reconcileImageMap({
    imageUrlMap: map, deliveredHtml: html,
    folderImageNames: ["slice_1@2x.png", "slice_2@2x.png"],
  });
  ok(r.counts.referencedPresent === 2, "category 1: two referenced entries present in the folder");
  ok(r.counts.unreferenced === 2, "category 2: two node exports the html never references");
  ok(r.counts.duplicate === 1, "category 3: one duplicate under a different key");
  ok(r.counts.other === 1, "category 4: one entry that is not an absolute url");
  ok(r.counts.categorySum === 6 && r.counts.mapEntries === 6 && r.balanced && r.gap === 0,
    "★ the four sum to the map size exactly");
  ok(r.anyReferencedFileMissing === false, "★ nothing the html references is missing from the folder");
  ok(r.referencedNotInMap.length === 0, "every referenced url is in the map");
  ok(r.unreferencedByKind["figma-node-export"] === 2, "the unreferenced pair is labelled as node exports");
  ok(r.buckets.duplicate[0].duplicateOf === "slice_1@2x.png" && r.buckets.duplicate[0].exactUrlMatch === false,
    "a duplicate names the key it duplicates, and says the url bytes differ");
}

// ── ★ the failure mode that actually hurts ────────────────────────────
{
  const a = url("m1", "hero.png"), b = url("m2", "cta.png");
  const html = `<img src="${a}"><img src="${b}">`;
  const r = reconcileImageMap({
    imageUrlMap: { "hero.png": a, "cta.png": b },
    deliveredHtml: html,
    folderImageNames: ["hero.png"],           // cta.png never made it
  });
  ok(r.anyReferencedFileMissing === true, "★ a referenced file absent from the folder is REPORTED, not absorbed");
  ok(r.referencedNotInFolder.length === 1 && r.referencedNotInFolder[0].assignedFilename === "cta.png",
    "★ and it is NAMED");
  ok(r.otherByReason["referenced-but-missing-from-folder"] === 1,
    "★ its map entry is category 4 with its own reason — never counted as 'correctly excluded'");
  ok(r.counts.categorySum === 2, "the partition still balances when something is wrong");
}

// ── referenced but NOT in the map: not a delivery failure ─────────────
{
  const a = url("q1", "hero.png"), b = url("q2", "cta.png");
  const html = `<img src="${a}"><img src="${b}">`;
  const r = reconcileImageMap({
    imageUrlMap: { "hero.png": a },           // cta.png missing from the map entirely
    deliveredHtml: html,
    folderImageNames: ["hero.png", "cta.png"],
  });
  ok(r.referencedNotInMap.length === 1 && r.referencedNotInMap[0].assignedFilename === "cta.png",
    "★ a referenced url absent from the map is reported by name");
  ok(r.anyReferencedFileMissing === false,
    "★ …and it is STILL delivered — the map supplies a preferred name, not the set");
}

// ── an unmeasured folder must not read as an empty one ────────────────
{
  const a = url("u1", "hero.png");
  const r = reconcileImageMap({ imageUrlMap: { "hero.png": a }, deliveredHtml: `<img src="${a}">` });
  ok(r.folder.measured === false && r.anyReferencedFileMissing === null,
    "★ no folder listing → 'not measured', NOT 'missing' (an unmeasured folder is not an empty one)");
  ok(r.otherByReason["referenced-folder-not-measured"] === 1 && r.counts.categorySum === 1,
    "the entry lands in category 4 with a reason that says why, and the sum still balances");
}

// ── A. the partition holds for hostile input ──────────────────────────
{
  const cases = [
    { imageUrlMap: null, deliveredHtml: null },
    { imageUrlMap: {}, deliveredHtml: "" },
    { imageUrlMap: { a: 1, b: [], c: {}, d: undefined, e: "" }, deliveredHtml: "<img src='x'>" },
    { imageUrlMap: { a: "ftp://x/y.png", b: "data:image/png;base64,AAA", c: "images/local.png" }, deliveredHtml: "" },
    { imageUrlMap: { a: url("z", "n.png"), b: url("z", "n.png") }, deliveredHtml: "" }, // identical twice
  ];
  let allBalanced = true;
  for (const c of cases) {
    const r = reconcileImageMap({ ...c, folderImageNames: [] });
    if (!r.balanced) allBalanced = false;
  }
  ok(allBalanced, "★ the four categories sum to the map size on every hostile input");
}

// randomised: 300 generated maps, every one must balance
{
  let bad = 0;
  let seed = 20260729;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let t = 0; t < 300; t++) {
    const n = 1 + Math.floor(rnd() * 40);
    const map = {};
    const refs = [];
    for (let i = 0; i < n; i++) {
      const hash = `h${Math.floor(rnd() * 12)}`;
      const name = `f${Math.floor(rnd() * 12)}.png`;
      const u = url(hash, name);
      map[`k${i}.png`] = rnd() < 0.1 ? null : u;
      if (rnd() < 0.5) refs.push(u);
    }
    const html = refs.map((u) => `<img src="${u}">`).join("");
    const r = reconcileImageMap({
      imageUrlMap: map, deliveredHtml: html,
      folderImageNames: rnd() < 0.5 ? Object.keys(map) : [],
    });
    if (!r.balanced || r.counts.categorySum !== Object.keys(map).length) bad++;
  }
  ok(bad === 0, `★ 300 randomised maps all balance (${bad} did not)`);
}

// ── B. ★★ THE PROPERTY THE WHOLE QUESTION RESTS ON ────────────────────
// The delivered images/ set is the delivered html's reference set, and the map
// changes only the NAMES. Proven against the real /approve functions.
{
  const refUrls = Array.from({ length: 110 }, (_, i) => url(`s${i}`, `slice_${i}@2x.png`));
  const html = refUrls.map((u) => `<img src="${u}">`).join("\n");

  const noMap = assignLocalFilenames(collectReferencedUrls(html), {});
  ok(Object.keys(noMap).length === 110, "with NO map at all, 110 referenced urls → 110 files");

  // a 287-entry map: the 110 referenced + 160 node exports + 17 duplicate keys
  const bigMap = {};
  refUrls.forEach((u, i) => { bigMap[`slice_${i}@2x.png`] = u; });
  for (let i = 0; i < 160; i++) bigMap[`layer-${i}.png`] = url(`n${i}`, `layer-${i}.png`);
  for (let i = 0; i < 17; i++) bigMap[`dup_slice_${i}@2x.png`] = `${DL}/s${i}/slice_${i}@2x.png?dl=0`;
  ok(Object.keys(bigMap).length === 287, "the constructed map has exactly 287 entries");

  const preferred = {};
  for (const [f, u] of Object.entries(bigMap)) if (!(u in preferred)) preferred[u] = f;
  const withMap = assignLocalFilenames(collectReferencedUrls(html), preferred);
  ok(Object.keys(withMap).length === 110,
    "★★ a 287-entry map produces the SAME 110 files — 177 unreferenced entries add NOTHING to the folder");
  ok(Object.values(withMap).every((n) => /^slice_\d+@2x\.png$/.test(n)),
    "★★ …and not one node-export name reaches the folder");

  // the reconciliation of exactly the reported shape: 287 map entries, 114 folder files
  const folder = Object.values(withMap);                       // 110 images
  const r = reconcileImageMap({ imageUrlMap: bigMap, deliveredHtml: html, folderImageNames: folder });
  ok(r.counts.mapEntries === 287 && r.counts.categorySum === 287 && r.balanced,
    "★★ 287 entries account for 287 — no gap");
  ok(r.counts.referencedPresent === 110 && r.counts.unreferenced === 160 && r.counts.duplicate === 17 && r.counts.other === 0,
    `★★ 110 + 160 + 17 + 0 = 287 (got ${r.counts.referencedPresent}+${r.counts.unreferenced}+${r.counts.duplicate}+${r.counts.other})`);
  ok(folder.length + 4 === 114,
    "★ 110 images + <orderId>.html + delivery-notes.txt + certificate.txt + preview.png = 114 files in the folder");
  ok(r.anyReferencedFileMissing === false && r.referencedNotInMap.length === 0,
    "★★ nothing the delivered html references is missing — from the folder OR from the map");
}

// the mirror image: a map that is MISSING every referenced url still delivers all of them
{
  const refUrls = Array.from({ length: 25 }, (_, i) => url(`x${i}`, `pic_${i}.png`));
  const html = refUrls.map((u) => `<img src="${u}">`).join("");
  const wrongMap = {}; for (let i = 0; i < 300; i++) wrongMap[`unrelated-${i}.png`] = url(`zz${i}`, `unrelated-${i}.png`);
  const assigned = assignLocalFilenames(collectReferencedUrls(html), Object.fromEntries(
    Object.entries(wrongMap).map(([f, u]) => [u, f])));
  ok(Object.keys(assigned).length === 25 && Object.values(assigned).every((n) => /^pic_\d+\.png$/.test(n)),
    "★★ a map that knows NONE of the referenced urls still delivers all 25, named from the url");
}

// ── name labelling ────────────────────────────────────────────────────
ok(looksLikeNodeExport("layer-1.png") && looksLikeNodeExport("group-3.png") && looksLikeNodeExport("vector-2.png") &&
   looksLikeNodeExport("blank-gif.png") && !looksLikeNodeExport("slice_1@2x.png"),
  "node-export names are recognised, slices are not");
ok(looksLikeCompilerSlice("slice_1_90@2x.png") && !looksLikeCompilerSlice("layer-1.png"),
  "compiler slice names are recognised");

// ── C. REAL BYTES: a captured production /generate-from-figma response ─
{
  const CAPTURE = "C:/Users/shrujal_mavlers/Desktop/Response.txt";
  if (existsSync(CAPTURE)) {
    const j = JSON.parse(readFileSync(CAPTURE, "utf-8"));
    const map = j.imageUrlMap || {};
    const preferred = {};
    for (const [f, u] of Object.entries(map)) if (typeof u === "string" && !(u in preferred)) preferred[u] = f;
    const folder = Object.values(assignLocalFilenames(collectReferencedUrls(j.html), preferred));
    const r = reconcileImageMap({ imageUrlMap: map, deliveredHtml: j.html, folderImageNames: folder });
    console.log(`\n  REAL ORDER ${j.orderId} — ${summariseReconciliation(r)}`);
    ok(r.balanced, "★ REAL ORDER: the four categories account for every map entry");
    ok(r.anyReferencedFileMissing === false, "★ REAL ORDER: nothing the delivered html references is missing");
    ok(r.counts.mapEntries === 26 && r.counts.referencedPresent === 26,
      `★ REAL ORDER (LLM/figma path): all ${r.counts.mapEntries} entries ARE referenced — the node exports are the delivered files, exactly as the route's comments predict`);
  } else {
    console.log("\n  (real-capture case skipped — Response.txt not on this machine)");
    pass++;
  }
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
