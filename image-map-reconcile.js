// =====================================================================
// IMAGE-MAP RECONCILIATION — accounting for every entry of an order's
// imageUrlMap against the delivered html and the delivered Dropbox folder.
//
// WHY THIS EXISTS. A live order recorded an imageUrlMap with 287 entries while
// its delivered folder held 114 files. The two numbers were waved off as
// "probably the node exports being excluded correctly" — which is very likely
// true, because /approve drives the delivered set off collectReferencedUrls(html)
// and uses the map ONLY to supply a preferred filename. But "probably" is not a
// measurement, and the last pair of numbers that got waved off as "two different
// counts" turned out to be two different UNITS and seven files short.
//
// So this module makes the reconciliation an arithmetic fact instead of an
// argument. Every entry of the map lands in EXACTLY ONE of four categories, and
// the four sum to the map's size by construction (asserted, not asserted-ish):
//
//   1. REFERENCED_PRESENT   the delivered html references this URL and the file
//                           it was assigned is in the delivered folder
//   2. UNREFERENCED         the delivered html never references this URL — the
//                           Figma node-export class, correctly excluded
//   3. DUPLICATE            this entry's URL is the same asset as an EARLIER
//                           entry's, under a different key
//   4. OTHER                anything the three above do not describe, itemised
//                           by sub-reason and never silently absorbed
//
// ★ AND THE QUESTION THAT ACTUALLY HURTS, answered separately: is any file the
// delivered html DOES reference missing? Two distinct forms, both reported:
//   • referencedNotInFolder — referenced by the html, NOT in the folder. This is
//     a short delivery. It is the TEST27-1800 class and the only one that costs
//     a lead anything.
//   • referencedNotInMap    — referenced by the html, absent from the map. NOT a
//     delivery failure: the map's only role at /approve is to supply a preferred
//     basename, and an absent preference falls back to basenameFromUrl. Reported
//     because it is the class people ASSUME is the dangerous one, and stating its
//     count is how that assumption stops being load-bearing.
//
// Pure: no I/O. server.js logs it per approve; reconcile-image-map.mjs runs it
// over a saved order.
// =====================================================================
import { collectReferencedUrls, assignLocalFilenames, basenameFromUrl } from "./delivery-folder.js";
import { decodeHtmlEntities } from "./asset-refs.js";

export const CATEGORIES = ["referencedPresent", "unreferenced", "duplicate", "other"];

/**
 * Asset identity for the duplicate test.
 *
 * NOT the basename: two different Figma exports can share one basename and are
 * two different files. NOT the raw URL string either: the same Dropbox file is
 * routinely written two ways (`?dl=0` vs `&raw=1`, entity-encoded vs not,
 * www.dropbox.com vs dl.dropboxusercontent.com), and counting those as two
 * assets would invent duplicates that are not there — and miss the ones that are.
 *
 * So identity is host-class + decoded path, query dropped. For Dropbox that is
 * `/scl/fi/<hash>/<name>`, which is the file. The two hosts serve the SAME
 * object for the same path, so they are folded together deliberately.
 */
export function assetIdentity(url) {
  const raw = decodeHtmlEntities(String(url || "")).trim();
  try {
    const u = new URL(raw);
    const host = /(^|\.)dropbox(usercontent)?\.com$/i.test(u.hostname)
      ? "dropbox"
      : u.hostname.toLowerCase();
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep raw path */ }
    return `${host}${path.replace(/\/+$/, "")}`;
  } catch {
    return raw.split("?")[0];
  }
}

/** A Figma node export, as generation names them, vs a compiler slice. Best-effort
 *  LABELLING ONLY — it never decides a category, it only annotates one, so a name
 *  this does not recognise cannot change the arithmetic. */
export function looksLikeNodeExport(filename) {
  const f = String(filename || "");
  // <word>.png and <word>-<n>.png are both real generation names (the captured
  // production order carries `vector.png` AND `vector-3.png`), so the separator
  // is optional. `blank-gif.png` is in the list because it is a real one.
  return /^(layer|group|vector|frame|rect|ellipse|line|star|polygon|instance|component|text|image|blank-gif|node)([-_][^.]*)?\.(png|jpe?g|gif|svg|webp)$/i.test(f) ||
    /^\d+[-_]\d+\.(png|jpe?g|gif|svg|webp)$/i.test(f);
}

export function looksLikeCompilerSlice(filename) {
  return /^slice[-_]/i.test(String(filename || ""));
}

/**
 * Reconcile an order's imageUrlMap against its delivered html and its delivered
 * folder listing.
 *
 *   imageUrlMap       { filename -> url }, as recorded on maveloper_jobs.image_url_map
 *                     (or drafts.image_url_map, or the /approve request body)
 *   deliveredHtml     the DELIVERED bytes — the email copy, carrying absolute URLs
 *   folderImageNames  basenames currently in <folder>/images/. Optional: omit it
 *                     and the folder arm is reported as "not measured" rather
 *                     than guessed (an unmeasured folder must never read as an
 *                     empty one — that would turn every entry into a defect).
 *   preferredFromBody an additional map the request body carried, folded into the
 *                     preferred-name resolution exactly as /approve folds it
 */
export function reconcileImageMap({
  imageUrlMap,
  deliveredHtml,
  folderImageNames = null,
  preferredFromBody = null,
} = {}) {
  const map = imageUrlMap && typeof imageUrlMap === "object" ? imageUrlMap : {};
  const entries = Object.entries(map);
  const html = String(deliveredHtml || "");

  // ── what /approve itself would do with these inputs, using the REAL functions ──
  // Not a re-implementation: collectReferencedUrls and assignLocalFilenames are
  // the exact functions server.js calls, so this cannot disagree with the route
  // about what "referenced" or "the local filename" means.
  const referencedUrls = collectReferencedUrls(html);
  const preferredName = {};
  for (const src of [preferredFromBody, map]) {
    if (!src || typeof src !== "object") continue;
    for (const [filename, url] of Object.entries(src)) {
      if (typeof url === "string" && /^https?:\/\//i.test(url) && !(url in preferredName)) {
        preferredName[url] = filename;
      }
    }
  }
  const urlToFilename = assignLocalFilenames(referencedUrls, preferredName);

  const referencedById = new Map(); // assetIdentity -> the referenced URL
  for (const u of referencedUrls) if (!referencedById.has(assetIdentity(u))) referencedById.set(assetIdentity(u), u);

  const folderKnown = Array.isArray(folderImageNames);
  const present = new Set(folderKnown ? folderImageNames : []);

  const buckets = { referencedPresent: [], unreferenced: [], duplicate: [], other: [] };
  const seenIdentity = new Map(); // assetIdentity -> the FIRST key that claimed it

  for (const [key, value] of entries) {
    const item = { key, url: typeof value === "string" ? value : null };

    // (4a) a value that is not an absolute http(s) URL cannot be reconciled
    //      against anything. Named, not absorbed.
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
      buckets.other.push({ ...item, why: "value-is-not-an-absolute-url", detail: typeof value });
      continue;
    }

    const id = assetIdentity(value);

    // (3) the same asset already claimed by an earlier key. Checked BEFORE the
    //     referenced test so a duplicate of a REFERENCED url is still counted as
    //     a duplicate — one file in the folder, two keys in the map.
    if (seenIdentity.has(id)) {
      buckets.duplicate.push({
        ...item,
        why: "same-asset-as-an-earlier-key",
        duplicateOf: seenIdentity.get(id),
        identity: id,
        exactUrlMatch: map[seenIdentity.get(id)] === value,
      });
      continue;
    }
    seenIdentity.set(id, key);

    const refUrl = referencedById.get(id);
    if (refUrl) {
      // (1) / (4b) referenced by the delivered html.
      const assigned = urlToFilename[refUrl] || basenameFromUrl(refUrl);
      if (!folderKnown) {
        buckets.other.push({
          ...item, why: "referenced-folder-not-measured", assignedFilename: assigned,
        });
      } else if (present.has(assigned)) {
        buckets.referencedPresent.push({ ...item, assignedFilename: assigned, keyMatchesAssigned: assigned === key });
      } else {
        // ★ THE ONE THAT HURTS. Referenced by the delivered html and NOT in the
        // folder the lead opens.
        buckets.other.push({ ...item, why: "referenced-but-missing-from-folder", assignedFilename: assigned });
      }
      continue;
    }

    // (2) the delivered html never references it — the node-export class.
    buckets.unreferenced.push({
      ...item,
      kind: looksLikeNodeExport(key) ? "figma-node-export" : looksLikeCompilerSlice(key) ? "compiler-slice" : "unrecognised-name",
      inFolder: folderKnown ? present.has(key) : null,
    });
  }

  // ── the two "is anything the html needs missing" answers ─────────────────────
  const mapIdentities = new Set(entries
    .filter(([, v]) => typeof v === "string" && /^https?:\/\//i.test(v))
    .map(([, v]) => assetIdentity(v)));

  const referencedNotInMap = referencedUrls
    .filter((u) => !mapIdentities.has(assetIdentity(u)))
    .map((u) => ({ url: u, assignedFilename: urlToFilename[u] || basenameFromUrl(u) }));

  const referencedNotInFolder = folderKnown
    ? referencedUrls
        .map((u) => ({ url: u, assignedFilename: urlToFilename[u] || basenameFromUrl(u) }))
        .filter((r) => !present.has(r.assignedFilename))
    : null;

  const counts = {
    mapEntries: entries.length,
    referencedPresent: buckets.referencedPresent.length,
    unreferenced: buckets.unreferenced.length,
    duplicate: buckets.duplicate.length,
    other: buckets.other.length,
  };
  counts.categorySum = counts.referencedPresent + counts.unreferenced + counts.duplicate + counts.other;

  // ★ THE ARITHMETIC IS ASSERTED, NOT HOPED FOR. If the four ever fail to sum to
  // the map's size, THAT is the finding, and it is reported as a gap rather than
  // rounded away.
  const balanced = counts.categorySum === counts.mapEntries;

  const otherByReason = {};
  for (const o of buckets.other) otherByReason[o.why] = (otherByReason[o.why] || 0) + 1;

  const unreferencedByKind = {};
  for (const u of buckets.unreferenced) unreferencedByKind[u.kind] = (unreferencedByKind[u.kind] || 0) + 1;

  return {
    counts,
    balanced,
    gap: counts.mapEntries - counts.categorySum,
    buckets,
    otherByReason,
    unreferencedByKind,
    // the html/folder side of the reconciliation
    html: {
      referencedUrls: referencedUrls.length,
      distinctAssets: referencedById.size,
    },
    folder: folderKnown
      ? { measured: true, files: present.size }
      : { measured: false, files: null },
    referencedNotInMap,
    referencedNotInFolder,
    // the headline the log line and the report both quote
    anyReferencedFileMissing: folderKnown ? (referencedNotInFolder.length > 0) : null,
  };
}

/** One-line summary for a log field / a CLI header. Never invents a number it
 *  does not have: an unmeasured folder says so. */
export function summariseReconciliation(r) {
  const c = r.counts;
  return [
    `map=${c.mapEntries}`,
    `referenced+present=${c.referencedPresent}`,
    `unreferenced=${c.unreferenced}`,
    `duplicate=${c.duplicate}`,
    `other=${c.other}`,
    `sum=${c.categorySum}${r.balanced ? "" : ` ★GAP ${r.gap}`}`,
    r.folder.measured ? `folderFiles=${r.folder.files}` : "folder=not-measured",
    `referencedMissingFromFolder=${r.referencedNotInFolder ? r.referencedNotInFolder.length : "not-measured"}`,
    `referencedMissingFromMap=${r.referencedNotInMap.length}`,
  ].join(" ");
}
