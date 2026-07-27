#!/usr/bin/env node
/**
 * folder-integrity.test.mjs — the /approve delivered-folder gate, proven
 * FAILS-FIRST on the shape that actually shipped.
 *
 * The load-bearing assertion is not "the gate goes red on a broken folder". It
 * is that the gate goes red on the SPECIFIC folder that passed every existing
 * instrument: 7 background-only files short, zero broken <img>, zero missing
 * `images/…` refs. If a test only proves the gate catches a deleted <img>, it
 * proves nothing this incident needed.
 *
 * Run: node folder-integrity.test.mjs
 */
import {
  gateDeliveredFolderStatic, collectDeadLocalRefs, localizeHtml,
  collectReferencedUrls, planDeliveredImagesFolder,
} from "./delivery-folder.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
};

// The TEST27-1800 shape, reduced: img refs correctly localised, background refs
// left as dead `assets/…` paths because the collector never saw them.
const SHIPPED = `<html><body>
  <table style="background-image:url(assets/fill_5d11a208.png)">
    <tr><td><img src="images/slice_1_32@2x.png"></td></tr>
    <tr><td><div style="background-image:url(assets/fill_4faaf192.png)"></div></td></tr>
    <tr><td><img src="images/slice_1_50@2x.png"></td></tr>
  </table></body></html>`;
const SHIPPED_FOLDER = ["slice_1_32@2x.png", "slice_1_50@2x.png"];

console.log("\n★ FAILS-FIRST — the folder that passed everything else");
{
  const r = gateDeliveredFolderStatic(SHIPPED, SHIPPED_FOLDER, { orderId: "TEST27-1800" });
  check("RED on the shipped shape", r.ok === false, JSON.stringify(r.counts));
  check("every images/<file> ref IS present — an img-only check passes here",
    r.violations.filter((v) => v.kind === "MISSING_FILE").length === 0);
  check("the background refs are caught as DEAD_LOCAL",
    r.counts.dead === 2, `dead=${r.counts.dead}`);
  check("the disclosure NAMES each dead reference",
    r.disclosure.includes("assets/fill_5d11a208.png") &&
    r.disclosure.includes("assets/fill_4faaf192.png"));
  check("the disclosure says the EMAIL copy is unaffected (it is)",
    /EMAIL copy .* is NOT affected/s.test(r.disclosure));
}

console.log("\nGREEN — the same document, correctly delivered");
{
  const fixed = SHIPPED.replace(/assets\//g, "images/");
  const folder = [...SHIPPED_FOLDER, "fill_5d11a208.png", "fill_4faaf192.png"];
  const r = gateDeliveredFolderStatic(fixed, folder, { orderId: "TEST27-1800" });
  check("GREEN when images/ carries the backgrounds too", r.ok === true, JSON.stringify(r.violations));
  check("no disclosure file is produced", r.disclosure === null);
  check("it counted all four references", r.counts.referenced === 4, `${r.counts.referenced}`);
}

console.log("\n★ IT CAN STILL FAIL AFTER THE FIX — delete one background-only file");
{
  const fixed = SHIPPED.replace(/assets\//g, "images/");
  const folder = [...SHIPPED_FOLDER, "fill_4faaf192.png"];   // fill_5d11a208 removed
  const r = gateDeliveredFolderStatic(fixed, folder, { orderId: "TEST27-1800" });
  check("RED when a background-only file is missing from images/", r.ok === false);
  check("it NAMES the deleted file", r.missingFiles.length === 1 &&
    r.missingFiles[0] === "fill_5d11a208.png", JSON.stringify(r.missingFiles));
  check("no <img> is broken — an img-only gate would still pass",
    !r.violations.some((v) => /slice_/.test(v.ref)));
}

console.log("\nNOT VACUOUS IN THE FAIL DIRECTION");
{
  // A correct all-absolute LLM folder must NOT go red.
  const llm = `<img src="https://dl.dropboxusercontent.com/scl/fi/A/frame-1.png?raw=1">` +
              `<td background="https://dl.dropboxusercontent.com/scl/fi/B/hero.png?raw=1"></td>`;
  const r = gateDeliveredFolderStatic(llm, [], { orderId: "X" });
  check("an all-absolute document is GREEN (external assets are legitimate)", r.ok === true);
  check("…but its absolute refs are REPORTED, not hidden",
    r.counts.undeclaredAbsolute === 2, `${r.counts.undeclaredAbsolute}`);
}
{
  const declared = "https://dl.dropboxusercontent.com/scl/fi/A/frame-1.png?raw=1";
  const r = gateDeliveredFolderStatic(`<img src="${declared}">`, [], {
    declaredMaterialisationFailures: [declared],
  });
  check("a DECLARED materialisation failure is an honest disclosed state",
    r.ok === true && r.notes[0].kind === "DECLARED_ABSOLUTE");
}
{
  const r = gateDeliveredFolderStatic(`<html><body>no images at all</body></html>`, []);
  check("an image-free document is GREEN, not vacuously RED", r.ok === true);
}

console.log("\nEND-TO-END — localise then gate, the /approve order of operations");
{
  const U = "https://dl.dropboxusercontent.com/scl/fi/A/hero.png?rlkey=k&raw=1";
  // one logical URL, two byte forms — the 5508db1a shape
  const html = `<td background="https://dl.dropboxusercontent.com/scl/fi/A/hero.png?rlkey=k&amp;raw=1">` +
               `<div style="background-image:url(${U})"></div></td>`;
  check("collectReferencedUrls collapses the two byte forms to one url",
    collectReferencedUrls(html).length === 1);
  const local = localizeHtml(html, { [U]: "hero.png" });
  const r = gateDeliveredFolderStatic(local, ["hero.png"]);
  check("both byte forms localise, so the gate is GREEN and nothing hotlinks",
    r.ok === true && r.counts.absolute === 0, JSON.stringify(r.counts));
  const { remove } = planDeliveredImagesFolder(html, { [U]: "hero.png" }, ["hero.png", "stray.png"]);
  check("the trim keeps the background file and removes only the stray",
    remove.length === 1 && remove[0] === "stray.png", JSON.stringify(remove));
}

console.log("\nDEAD-REF HELPER");
{
  check("collectDeadLocalRefs finds assets/ but not images/",
    collectDeadLocalRefs(`<img src="images/a.png"><div style="background:url(assets/b.png)">`).length === 1);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
