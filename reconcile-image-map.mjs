#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// reconcile-image-map.mjs — account for every entry of one order's imageUrlMap.
//
// WHY: an order recorded 287 map entries while its delivered folder held 114,
// and nobody had measured which entry was which. This turns that into one
// command that anybody can run, with no Supabase key and no Dropbox token —
// only artefacts the owner can already fetch.
//
// USAGE
//   # 1. the whole thing from a saved /job-status response (it carries BOTH the
//   #    delivered html and the durable imageUrlMap):
//   curl -s https://maveloper-backend-production.up.railway.app/job-status/<JOB-UUID> > job.json
//   node reconcile-image-map.mjs --job job.json --folder folder.txt
//
//   # 2. or from the two pieces separately:
//   node reconcile-image-map.mjs --map map.json --html DELIVERED.html --folder folder.txt
//
//   --folder is optional and is a plain text file, ONE FILENAME PER LINE, of what
//   is actually in <delivery folder>/images/ (select-all in Dropbox and paste, or
//   `ls` a downloaded copy). WITHOUT it the folder arm reports "not measured"
//   rather than guessing — an unmeasured folder must never read as an empty one.
//
//   --json prints the full machine-readable result instead of the report.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { reconcileImageMap, summariseReconciliation } from "./image-map-reconcile.js";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const has = (name) => argv.includes(name);

if (has("--help") || argv.length === 0) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 27).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}

let imageUrlMap = null, deliveredHtml = null, label = "(unnamed order)";

const jobPath = arg("--job");
if (jobPath) {
  const j = JSON.parse(readFileSync(jobPath, "utf-8"));
  // /job-status returns both shapes; /generate-from-figma returns the flat one.
  imageUrlMap = j.imageUrlMap ?? j.result?.imageUrlMap ?? null;
  deliveredHtml = j.html ?? j.result?.html ?? null;
  label = j.orderId ?? j.result?.orderId ?? j.jobId ?? label;
}
if (arg("--map")) imageUrlMap = JSON.parse(readFileSync(arg("--map"), "utf-8"));
if (arg("--html")) deliveredHtml = readFileSync(arg("--html"), "utf-8");
if (arg("--order")) label = arg("--order");

if (!imageUrlMap || !deliveredHtml) {
  console.error("Need BOTH an imageUrlMap and the DELIVERED html. Pass --job, or --map and --html. (--help)");
  process.exit(2);
}

let folderImageNames = null;
if (arg("--folder")) {
  const raw = readFileSync(arg("--folder"), "utf-8");
  folderImageNames = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    // tolerate a pasted Dropbox listing: keep the basename, drop any path
    .map((s) => s.split(/[\\/]/).pop());
}

const r = reconcileImageMap({ imageUrlMap, deliveredHtml, folderImageNames });
if (has("--json")) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.balanced ? 0 : 1);
}

const n = (x) => String(x).padStart(6);
console.log(`\n════════════════════════════════════════════════════════════════════`);
console.log(`IMAGE-MAP RECONCILIATION — ${label}`);
console.log(`════════════════════════════════════════════════════════════════════`);
console.log(`  delivered html         ${n(String(deliveredHtml).length)} bytes, ${r.html.referencedUrls} referenced urls (${r.html.distinctAssets} distinct assets)`);
console.log(`  imageUrlMap            ${n(r.counts.mapEntries)} entries`);
console.log(`  delivered images/      ${r.folder.measured ? n(r.folder.files) + " files" : "     — NOT MEASURED (pass --folder)"}`);
console.log(`\n  EVERY MAP ENTRY, IN EXACTLY ONE CATEGORY`);
console.log(`  ── 1 referenced by the delivered html AND present in the folder   ${n(r.counts.referencedPresent)}`);
console.log(`  ── 2 the delivered html never references it (node-export class)   ${n(r.counts.unreferenced)}`);
for (const [k, v] of Object.entries(r.unreferencedByKind)) console.log(`         · ${k.padEnd(56)}${n(v)}`);
console.log(`  ── 3 the same asset as another entry, under a different key       ${n(r.counts.duplicate)}`);
console.log(`  ── 4 something else                                               ${n(r.counts.other)}`);
for (const [k, v] of Object.entries(r.otherByReason)) console.log(`         · ${k.padEnd(56)}${n(v)}`);
console.log(`  ${"".padEnd(64, "─")}`);
console.log(`       SUM                                                        ${n(r.counts.categorySum)}   of ${r.counts.mapEntries}`);
console.log(r.balanced
  ? `       ★ BALANCED — every entry is accounted for.`
  : `       ★★ GAP OF ${r.gap} — THAT GAP IS THE FINDING. Do not round it away.`);

console.log(`\n  THE QUESTION THAT ACTUALLY HURTS`);
if (r.folder.measured) {
  console.log(`  Is any file the delivered html REFERENCES missing from the folder?  ${r.referencedNotInFolder.length === 0 ? "NO" : `★★ YES — ${r.referencedNotInFolder.length}`}`);
  for (const m of r.referencedNotInFolder.slice(0, 40)) console.log(`      MISSING  images/${m.assignedFilename}   ← ${m.url}`);
} else {
  console.log(`  Is any file the delivered html REFERENCES missing from the folder?  NOT MEASURED`);
}
console.log(`  Is any referenced url missing from the MAP?                        ${r.referencedNotInMap.length === 0 ? "NO" : `${r.referencedNotInMap.length} — and this costs NOTHING:`}`);
for (const m of r.referencedNotInMap.slice(0, 20)) console.log(`      map has no entry for images/${m.assignedFilename} (delivered anyway, name derived from the url)`);
console.log(`\n  ${summariseReconciliation(r)}\n`);

process.exit(r.balanced && r.anyReferencedFileMissing !== true ? 0 : 1);
