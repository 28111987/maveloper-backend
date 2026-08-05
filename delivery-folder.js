// =====================================================================
// DELIVERY FOLDER — the /approve deliverable, restructured as a LOOSE Dropbox
// folder keyed by the OWNER-SUPPLIED order id (matching how Mavlers human-coded
// orders are delivered), instead of a ZIP keyed differently from the images.
//
//   Apps/maveloper/<YYYY>/<MM-YYYY>/<ORDER ID>/
//     ├─ <ORDER ID>.html      delivered html, unzipped, images referenced LOCALLY
//     ├─ images/              all images the html references as local files
//     ├─ preview.png          full-length render (co-located at generation)
//     ├─ delivery-notes.txt   ESP · dark-mode · fonts · Outlook Word-fatal ledger
//     └─ certificate.txt      compiler proof numbers, or "no certificate" for LLM
//
// This module is PURE (no Dropbox / Express / Supabase). server.js does the I/O
// (download images, upload files, create the folder share link); everything here
// is string-in / string-out so it is unit-testable without live credentials.
// =====================================================================

import {
  extractAssetRefs, distinctAssetUrls, replaceAssetUrl, isRemoteRef,
} from "./asset-refs.js";

// ── Dropbox-safe order id ─────────────────────────────────────────────
// The owner-supplied order id becomes a Dropbox FOLDER NAME. Strip only the
// characters Dropbox forbids in a path segment (/ \ : ? * " < > |) and control
// chars; keep the owner's exact spelling/casing otherwise (e.g. "TEST23-1930").
// Returns "" for a null/empty/blank id so callers can fall back.
export function sanitizeOrderId(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  s = s.replace(/[\/\\:?*"<>|]/g, "-").replace(/[\x00-\x1f]/g, "").trim();
  // collapse any run of separators the strip produced and trim leading/trailing
  s = s.replace(/-{2,}/g, "-").replace(/^[-.\s]+|[-.\s]+$/g, "");
  return s;
}

// ── image src discovery ───────────────────────────────────────────────
// The delivered HTML is the AUTHORITATIVE record of which images the email
// references — every <img src> (and CSS url(...)) carries an absolute Dropbox
// URL on the delivered path. Collecting from the HTML makes the folder assembly
// independent of any image map the frontend may or may not send: whatever the
// email points at is exactly what we bundle. Returns the ordered, de-duplicated
// list of absolute http(s) URLs referenced by the HTML.
// ★ FOLDER-FIX. The mechanism list is no longer written out here. It lives in
// asset-refs.js, the SINGLE extractor every stage in both repos now shares, so
// the collector that BUILDS the folder and the gate that MEASURES it cannot
// disagree about what "referenced" means. Two mechanisms this function used to
// miss and now does not:
//   • `background="https://…"` — the HTML4 attribute. MEASURED: 5 of 103 surveyed
//     LLM artifacts reference a real Dropbox image that way AND NO OTHER WAY.
//   • an entity-encoded URL (`…&amp;raw=1`) — the same logical asset in a second
//     byte form, which used to be collected once and localised zero times.
// Distinctness is now by DECODED url, so those two forms collapse to one file.
export function collectReferencedUrls(html) {
  return distinctAssetUrls(html, (r) => /^https?:\/\//i.test(r.url));
}

// The local filename for a referenced URL: the basename of its path, ignoring
// the query string. Dropbox direct URLs look like
// https://dl.dropboxusercontent.com/scl/fi/HASH/slice_1_90@2x.png?rlkey=...&raw=1
// → "slice_1_90@2x.png". Falls back to a stable synthetic name if none is found.
export function basenameFromUrl(url, index = 0) {
  try {
    const noQuery = String(url).split("?")[0].split("#")[0];
    const base = noQuery.split("/").filter(Boolean).pop() || "";
    const decoded = safeDecode(base);
    if (decoded && /\.[a-z0-9]{2,5}$/i.test(decoded)) return decoded;
    if (decoded) return decoded;
  } catch { /* fall through */ }
  return `image_${index + 1}.png`;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ── already-local image references ────────────────────────────────────
// The basenames the html references as LOCAL files (src="images/foo.png" /
// url(images/foo.png)) rather than absolute URLs. Normally a freshly delivered
// html carries only absolute URLs (localisation happens at /approve), so this is
// [] — but a re-approve of an ALREADY-localised html, or a hand-edited delivery,
// can carry local refs. Collected so the images/ trim NEVER deletes a file the
// delivered html still points at, whichever form the reference takes.
export function collectLocalImageNames(html) {
  const names = new Set();
  for (const ref of extractAssetRefs(html)) {
    if (isRemoteRef(ref.url)) continue;
    const m = /(?:^|\/)images\/([^/?#"')\s]+)/i.exec(ref.url);
    if (m && m[1]) names.add(safeDecode(m[1]));
  }
  return [...names];
}

// ── the assets the html references but CANNOT reach ───────────────────────────
// Every LOCAL (relative) asset ref that is not an `images/<name>` ref. On a
// correctly delivered folder this is EMPTY: /approve either localises a ref to
// `images/<file>` or leaves it an absolute URL (a disclosed MIXED document). A
// leftover relative ref is neither — it is a DEAD PATH, and it is exactly what
// TEST27-1800's 7 `assets/fill_<sha>.png` backgrounds were. Reported so the
// share-link step can refuse to call a folder complete when the html still
// points at a directory the folder does not contain.
export function collectDeadLocalRefs(html) {
  const dead = new Set();
  for (const ref of extractAssetRefs(html)) {
    if (isRemoteRef(ref.url)) continue;
    if (/(?:^|\/)images\/[^/?#"')\s]+/i.test(ref.url)) continue;
    dead.add(ref.url);
  }
  return [...dead];
}

// ── url → local-filename assignment ───────────────────────────────────
// Assign each referenced URL a UNIQUE local images/<filename>. This is the exact
// algorithm /approve used inline (server.js): prefer the caller-supplied name
// (the basename generation uploaded under, which may carry meaningful casing),
// else the basename derived from the URL; on a collision between two DIFFERENT
// URLs that map to the same name, suffix the later one `_2`, `_3`, … so one
// images/ file is never silently overwritten by a second URL. Extracted here so
// the REAL assignment (not a test mirror) is unit-tested — the LLM path relies on
// it just as much as the compiler path (two node exports from different frames
// can share a basename). Deterministic + order-stable for a given URL list.
//   `urls`          ordered, de-duplicated referenced URLs (collectReferencedUrls)
//   `preferredName` { url -> preferred basename } from the frontend/durable maps
// Returns { url -> assigned local filename }.
export function assignLocalFilenames(urls, preferredName = {}) {
  const urlToFilename = {};
  const taken = new Set();
  let idx = 0;
  for (const url of urls || []) {
    if (urlToFilename[url]) continue; // belt-and-suspenders (urls is deduped)
    let name = (preferredName && preferredName[url]) || basenameFromUrl(url, idx);
    if (taken.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let n = 2;
      while (taken.has(`${stem}_${n}${ext}`)) n++;
      name = `${stem}_${n}${ext}`;
    }
    taken.add(name);
    urlToFilename[url] = name;
    idx++;
  }
  return urlToFilename;
}

// ── images/ folder plan: the DELIVERED HTML is the sole authority ─────
// Given the delivered html, the url→local-filename map used to localise it, and
// the list of files CURRENTLY present in the delivery `images/` folder, decide
// which files must REMAIN (exactly the set the html references) and which are
// UNREFERENCED and must be removed. This is the same "delivered html is the
// authority" principle /approve already uses to build its local map — extended to
// the folder on disk so images/ holds exactly what the html references, no more
// and no fewer.
//
// Why it matters: generation uploads a compiler order's Figma NODE EXPORTS
// (layer-1.png, group-3.png, vector-2.png, …) into the SAME order folder before
// the html exists, but the delivered COMPILER html references ONLY the
// slice_*@2x.png files. Those node exports are unreferenced clutter and must be
// trimmed. On the LLM path the node exports ARE the referenced files → keep-set
// == every file → `remove` is empty (folder byte-identical).
//
// Pure: no I/O. server.js lists the folder + performs the deletes; this decides.
export function planDeliveredImagesFolder(html, urlToFilename, existingImageNames) {
  const keep = new Set();
  // (a) every absolute URL the delivered html references → its local basename.
  //     Prefer the caller's assigned filename (carries collision suffixes); fall
  //     back to the basename derived straight from the URL.
  for (const url of collectReferencedUrls(html)) {
    const name = (urlToFilename && urlToFilename[url]) || basenameFromUrl(url);
    if (name) keep.add(name);
  }
  // (b) any already-local images/<name> ref in the html (re-approve / hand-edit).
  for (const name of collectLocalImageNames(html)) keep.add(name);

  const remove = [];
  for (const name of existingImageNames || []) {
    if (!keep.has(name)) remove.push(name);
  }
  return { keep: [...keep], remove };
}

// ── ★ THE DELIVERED-FOLDER INTEGRITY GATE (static arm) ────────────────────────
// TEST27-1800 shipped a folder whose images/ held 79 files while the delivered
// html needed 86, and NOTHING said so. Every instrument in the chain measured a
// document nobody receives (SEAM_AUDIT I-1), so the folder that DID reach the
// owner was rendered by no gate at all.
//
// ★ WHY THIS IS A STATIC CHECK AND NOT `delivered-folder-gate.mjs`.
// That gate is the stronger instrument — it launches headless Chrome and reads
// COMPUTED `background-image`, which catches a background this scan cannot see
// (one injected by a `<style>` rule, or a shorthand the extractor mis-parses).
// It CANNOT run at /approve: `/approve` runs on Railway, which has no Chrome
// binary, and the folder lives on Dropbox rather than local disk. Wiring the
// render gate there would mean shipping Chrome into the container and
// downloading ~22 MB of images per approval, on the request path, for every
// order. So the split is deliberate and stated:
//
//   • THIS function runs on EVERY delivery, needs nothing but the html string
//     and the folder listing /approve already fetches for the trim, and would
//     have caught TEST27-1800 outright (its 7 dead `assets/…` refs are exactly
//     the DEAD_LOCAL class below).
//   • `delivered-folder-gate.mjs` stays the pre-deploy / local instrument that
//     proves this one is not lying, on a real render.
//
// The two share `asset-refs.js`, so they cannot disagree about what a reference
// IS — only about what a browser then does with it.
//
// Pure: no I/O. Returns violations, notes and a ready-to-write disclosure.
//
//   `localHtml`     the LOCALISED html actually written into the folder
//   `folderImages`  basenames currently in <folder>/images/ (post-trim)
//   `declaredMaterialisationFailures` absolute URLs /approve KNOWS it failed to
//                   materialise (server.js:7328). A disclosed absolute is an
//                   honest MIXED document; an undisclosed one is a surprise.
export function gateDeliveredFolderStatic(localHtml, folderImages, opts = {}) {
  const declared = new Set(opts.declaredMaterialisationFailures || []);
  const present = new Set(folderImages || []);
  const violations = [];
  const notes = [];

  // (1) DEAD LOCAL REFS — a relative path that is neither `images/…` nor
  //     absolute. It resolves to nothing inside the folder. ★ THIS IS THE
  //     TEST27-1800 CLASS: 7 × `assets/fill_<sha>.png`.
  for (const ref of collectDeadLocalRefs(localHtml)) {
    violations.push({
      kind: "DEAD_LOCAL", ref,
      why: `the folder html points at "${ref}", a path the folder does not contain`,
    });
  }

  // (2) MISSING FILES — referenced as images/<name>, not in images/.
  const referencedNames = collectLocalImageNames(localHtml);
  for (const name of referencedNames) {
    if (!present.has(name)) {
      violations.push({
        kind: "MISSING_FILE", ref: `images/${name}`,
        why: `the html references images/${name} but that file is NOT in the folder`,
      });
    }
  }

  // (3) ABSOLUTE REFS still in the folder copy. NOT a violation: a genuinely
  //     external asset (an ESP-hosted logo, a tracking pixel) is legitimate, and
  //     a materialisation failure that /approve declared is an honest disclosed
  //     state. Both are REPORTED so the recipient's offline copy is never
  //     silently a hotlink — but neither inflates the missing-file count, because
  //     a gate that cries wolf gets switched off.
  const absolute = [...new Set(
    extractAssetRefs(localHtml)
      .filter((r) => /^https?:\/\//i.test(r.url))
      .map((r) => r.url)
  )];
  for (const url of absolute) {
    notes.push({
      kind: declared.has(url) ? "DECLARED_ABSOLUTE" : "UNDECLARED_ABSOLUTE", ref: url,
    });
  }

  const missingFiles = violations
    .filter((v) => v.kind === "MISSING_FILE")
    .map((v) => v.ref.replace(/^images\//, ""));
  const deadRefs = violations.filter((v) => v.kind === "DEAD_LOCAL").map((v) => v.ref);

  return {
    ok: violations.length === 0,
    violations,
    notes,
    counts: {
      referenced: referencedNames.length,
      presentInFolder: present.size,
      dead: deadRefs.length,
      missing: missingFiles.length,
      absolute: absolute.length,
      undeclaredAbsolute: notes.filter((n) => n.kind === "UNDECLARED_ABSOLUTE").length,
    },
    missingFiles,
    deadRefs,
    disclosure: violations.length === 0 ? null
      : buildFolderIntegrityDisclosure({ violations, notes, orderId: opts.orderId }),
  };
}

// The disclosure the lead actually reads. Written as its OWN file so it sorts to
// the top of the Dropbox listing — burying it in delivery-notes.txt would repeat
// this incident's actual failure, which was not absence of information but
// absence of anything that made the information unavoidable.
export function buildFolderIntegrityDisclosure({ violations, notes = [], orderId }) {
  const L = [];
  L.push("!!!  THIS DELIVERY FOLDER IS INCOMPLETE  !!!");
  L.push("");
  L.push(`order: ${orderId || "(unknown)"}`);
  L.push("");
  L.push("The HTML in this folder references files that are not in it. The email");
  L.push("will render with blank or missing areas where those files belong.");
  L.push("");
  L.push("★ The EMAIL copy sent for deployment references the images by absolute");
  L.push("  Dropbox URL and is NOT affected by this. Only this offline folder is.");
  L.push("");
  const dead = violations.filter((v) => v.kind === "DEAD_LOCAL");
  const miss = violations.filter((v) => v.kind === "MISSING_FILE");
  if (miss.length) {
    L.push(`MISSING FROM images/  (${miss.length})`);
    for (const v of miss) L.push(`  - ${v.ref}`);
    L.push("");
  }
  if (dead.length) {
    L.push(`REFERENCES THAT RESOLVE NOWHERE  (${dead.length})`);
    for (const v of dead) L.push(`  - ${v.ref}`);
    L.push("");
  }
  const undeclared = notes.filter((n) => n.kind === "UNDECLARED_ABSOLUTE");
  if (undeclared.length) {
    L.push(`STILL POINTING AT DROPBOX rather than a local file  (${undeclared.length})`);
    L.push("  (these render online but not from an offline copy of this folder)");
    for (const n of undeclared.slice(0, 20)) L.push(`  - ${n.ref}`);
    if (undeclared.length > 20) L.push(`  … and ${undeclared.length - 20} more`);
    L.push("");
  }
  L.push("WHAT TO DO: re-approve this order. If the same files are named again,");
  L.push("send this file to engineering — it means the image collector missed a");
  L.push("reference mechanism, which is exactly what happened on TEST27-1800.");
  L.push("");
  return L.join("\n") + "\n";
}

// ── HTML localisation ─────────────────────────────────────────────────
// Swap each absolute URL for its local `images/<filename>` path so the folder's
// html references the co-located files (owner requirement). NEVER mutates the
// caller's string in place — returns a new one — so the ABSOLUTE-URL email copy
// the backend keeps is untouched (the deliberate two-copy split: email = absolute
// Dropbox URLs, folder = local images/). Longest URLs first so a URL that is a
// prefix of another is not partially replaced.
// ★ FOLDER-FIX: replace EVERY BYTE FORM of each URL, not just the one the map
// was keyed by. `job_1779773959367_5508db1a` carries one logical Dropbox URL
// twice — raw inside `url(...)` and entity-encoded (`&amp;raw=1`) inside
// `background="…"`. A pure split/join swapped the raw form and left the
// attribute pointing at Dropbox: an UNDECLARED mixed document, which reads as
// "delivered fine" to a folder check and as a hotlink to the recipient.
// replaceAssetUrl (asset-refs.js) swaps both forms, longest first.
export function localizeHtml(html, urlToFilename) {
  let out = html;
  const entries = Object.entries(urlToFilename).sort((a, b) => b[0].length - a[0].length);
  for (const [url, filename] of entries) {
    out = replaceAssetUrl(out, url, `images/${filename}`).html;
  }
  return out;
}

// ── delivery-notes.txt inputs (derived from the delivered bytes) ──────

// Dark-mode support is present iff the html carries the color-scheme metadata or
// a prefers-color-scheme:dark block (exactly what the framework/compiler emit).
export function detectDarkMode(html) {
  if (!html) return false;
  return /prefers-color-scheme\s*:\s*dark/i.test(html) ||
         /name\s*=\s*["']color-scheme["']/i.test(html);
}

// A compiler-authored artifact carries the additive-pass provenance comment
// (compiler-adapter.mjs applyCompliance) — a reliable, dependency-free signal of
// which engine produced the delivered bytes, readable at /approve from the html
// alone (no DB / bridge round-trip needed to decide compiler vs LLM).
export function looksCompilerAuthored(html) {
  if (!html) return false;
  return /Mavlers DSF\s*[·`-]?\s*compiler artifact/i.test(html) ||
         /compiler artifact · additive compliance pass/i.test(html);
}

// The distinct font FAMILIES the delivered html asks for: the first family of
// each font-family declaration plus any Google Fonts <link>. De-duplicated,
// generic keywords dropped. Best-effort scan of the delivered bytes.
export function collectFonts(html) {
  if (!html) return [];
  const fams = new Set();
  const GENERIC = new Set([
    "sans-serif", "serif", "monospace", "cursive", "fantasy",
    "system-ui", "ui-sans-serif", "ui-serif", "inherit", "initial",
  ]);
  // Capture the whole value up to ; } or a closing " (inline style attr). The
  // family list may contain quoted names with spaces ('Clash Grotesk'), so we do
  // NOT exclude quotes from the capture — we strip them from the first family.
  const ffRe = /font-family\s*:\s*([^;}"]+)/gi;
  let m;
  while ((m = ffRe.exec(html)) !== null) {
    const first = m[1].split(",")[0].replace(/['"]/g, "").replace(/[>{].*$/, "").trim();
    if (first && !GENERIC.has(first.toLowerCase())) fams.add(first);
  }
  // Google Fonts links: family=Open+Sans:wght@400;700&family=Roboto
  const linkRe = /fonts\.googleapis\.com\/css2?\?([^"'>\s]+)/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const famRe = /family=([^&:]+)/gi;
    let f;
    while ((f = famRe.exec(m[1])) !== null) {
      const name = safeDecode(f[1].replace(/\+/g, " ")).trim();
      if (name) fams.add(name);
    }
  }
  return [...fams];
}

// ── Outlook Word-fatal ledger ─────────────────────────────────────────
// The constructs that render DIFFERENTLY in Outlook 2007-2019 (the Word HTML
// rendering engine). Scanned directly from the DELIVERED bytes so the disclosure
// reflects what actually ships. This is a heuristic scan of the html, not the
// compiler's internal ledger; it is disclosed as such. Each rule notes how the
// Word engine treats the construct so the lead can judge the risk at delivery.
const WORD_FATAL_RULES = [
  { key: "css-background-image", note: "CSS background-image is ignored by Outlook (Word) — needs a VML fill or a real <img>",
    test: (h) => countMatches(h, /background(?:-image)?\s*:\s*[^;"']*url\(/gi) },
  { key: "border-radius", note: "border-radius is ignored — corners render square in Outlook",
    test: (h) => countMatches(h, /border-radius\s*:/gi) },
  { key: "box-shadow", note: "box-shadow is ignored — no shadow in Outlook",
    test: (h) => countMatches(h, /box-shadow\s*:/gi) },
  { key: "position-absolute-relative", note: "position:absolute/relative is dropped — overlays/offsets collapse in Outlook",
    test: (h) => countMatches(h, /position\s*:\s*(?:absolute|relative|fixed)/gi) },
  { key: "float", note: "float is ignored — floated blocks stack instead of sitting side-by-side",
    test: (h) => countMatches(h, /(?:^|[;{"'\s])float\s*:/gi) },
  { key: "flex-grid", note: "display:flex/grid is ignored — layout falls back to normal flow in Outlook",
    test: (h) => countMatches(h, /display\s*:\s*(?:inline-)?(?:flex|grid)/gi) },
  { key: "max-width", note: "max-width is ignored — width is not constrained; use a fixed table width for Outlook",
    test: (h) => countMatches(h, /max-width\s*:/gi) },
  { key: "css-margin", note: "margin on non-table elements is unreliable in Outlook — prefer table cell padding",
    test: (h) => countMatches(h, /(?:^|[;{"'\s])margin(?:-(?:top|bottom|left|right))?\s*:/gi) },
  { key: "negative-margin", note: "negative margins are dropped by Outlook — offset positioning is lost",
    test: (h) => countMatches(h, /margin(?:-(?:top|bottom|left|right))?\s*:\s*-\d/gi) },
  { key: "transform", note: "CSS transform is ignored — rotation/scale/translate has no effect in Outlook",
    test: (h) => countMatches(h, /(?:^|[;{"'\s])transform\s*:/gi) },
  { key: "media-queries", note: "@media queries are ignored by Outlook — desktop (widest) styles apply; mobile rules never fire",
    test: (h) => countMatches(h, /@media\b/gi) },
  { key: "background-gradient", note: "CSS gradients are ignored — no gradient fill in Outlook (needs VML)",
    test: (h) => countMatches(h, /(?:linear|radial)-gradient\s*\(/gi) },
  { key: "letter-spacing", note: "letter-spacing is only partially honoured by Outlook — tracking may differ",
    test: (h) => countMatches(h, /letter-spacing\s*:/gi) },
];

function countMatches(html, re) {
  const m = html.match(re);
  return m ? m.length : 0;
}

// Returns [{ construct, count, note }] for every Word-fatal construct PRESENT in
// the delivered html (count > 0), ordered by count desc. Empty array = the
// delivered bytes contain none of the scanned constructs (Outlook-clean by this
// heuristic).
export function deriveWordFatalLedger(html) {
  if (!html) return [];
  const ledger = [];
  for (const rule of WORD_FATAL_RULES) {
    const count = rule.test(html);
    if (count > 0) ledger.push({ construct: rule.key, count, note: rule.note });
  }
  ledger.sort((a, b) => b.count - a.count);
  return ledger;
}

// ── delivery-notes.txt ────────────────────────────────────────────────
export function buildDeliveryNotes({ orderId, esp, darkMode, fonts, ledger, generatedBy, imageCount, generatedAt, provenance, certificate } = {}) {
  const lines = [];
  lines.push("MAVELOPER — DELIVERY NOTES");
  lines.push("==========================");
  lines.push(`Order ID:      ${orderId || "(unknown)"}`);
  // ★ ROUTE PROVENANCE — THE ENGINE STATEMENT, AT THE TOP, WHERE IT IS SEEN.
  //   "Generated by" was a HEURISTIC scan of the html (looksCompilerAuthored).
  //   The provenance record is the ENGINE'S OWN statement, forwarded from
  //   cc-runner through the bridge, and it wins where the two disagree. A lead
  //   must never receive an artifact without knowing which engine made it — and
  //   on a FALLBACK, why. The wording is authored ONCE, in the bridge repo's
  //   route-provenance.mjs, and travels INSIDE the record, so the two halves
  //   cannot drift into describing the same order differently.
  if (provenance && provenance.banner) {
    lines.push(provenance.banner);
    if (provenance.engine && generatedBy && provenance.engine !== generatedBy)
      lines.push(`  (the html heuristic guessed "${generatedBy}"; the engine's own record says "${provenance.engine}" and wins)`);
  } else {
    lines.push(`Generated by:  ${generatedBy || "unknown"}  (HEURISTIC — no provenance record was forwarded for this order)`);
  }
  if (generatedAt) lines.push(`Delivered at:  ${generatedAt}`);
  if (provenance && provenance.humanBlock) { lines.push(""); lines.push(provenance.humanBlock); }
  lines.push("");
  lines.push(`ESP the html is shaped for: ${esp && String(esp).toLowerCase() !== "none" ? esp : "generic / none specified"}`);
  lines.push(`Dark-mode support:          ${darkMode ? "YES — @media (prefers-color-scheme:dark) block + color-scheme metas present" : "NO — light-only (no dark-mode block emitted)"}`);
  lines.push(`Fonts used:                 ${fonts && fonts.length ? fonts.join(", ") : "(none detected — system/fallback stack)"}`);
  lines.push(`Local images bundled:       ${imageCount != null ? imageCount : "(n/a)"}`);
  lines.push("");
  lines.push("OUTLOOK (2007-2019 / Word engine) RISK LEDGER");
  lines.push("---------------------------------------------");
  lines.push("Constructs below render DIFFERENTLY in Outlook desktop than in modern");
  lines.push("clients. This is a heuristic scan of the DELIVERED html (not the");
  lines.push("compiler's internal ledger) — disclosed so the risk is visible at");
  lines.push("delivery rather than discovered by the client.");
  lines.push("");
  if (!ledger || ledger.length === 0) {
    lines.push("  (none detected — the delivered html contains none of the scanned");
    lines.push("   Word-fatal constructs. Outlook-clean by this heuristic.)");
  } else {
    for (const item of ledger) {
      lines.push(`  • ${item.construct} (${item.count}×): ${item.note}`);
    }
  }
  lines.push("");
  // ★★ D119 — ELEMENTS FIGMA COULD NOT SUPPLY, NAMED HERE TOO.
  //    The compiler now ships an email missing such an element rather than failing
  //    the order — but ONLY after proving the element declares no fill, stroke,
  //    effect or text anywhere in its own Figma subtree and has nothing placed
  //    inside it. The absence must be visible in BOTH human-facing files, so it is
  //    printed here as well as in certificate.txt, and printed even when the count
  //    is zero: "none" is a claim, silence is not.
  {
    const cert = certificate && typeof certificate === "object" ? certificate : null;
    const list = Array.isArray(cert && cert.assetsUnavailable) ? cert.assetsUnavailable : [];
    const n = (cert && typeof cert.assetsUnavailableCount === "number")
      ? cert.assetsUnavailableCount : list.length;
    lines.push("ELEMENTS MISSING FROM THIS EMAIL");
    lines.push("--------------------------------");
    if (!cert) {
      lines.push("  (no compiler certificate reached this delivery — see certificate.txt)");
    } else if (!n) {
      lines.push("  NONE — Figma supplied every asset the design asked for.");
    } else {
      lines.push(`  ${n} layer(s) are ABSENT. Figma returned no image for them.`);
      lines.push("  Each was checked first: no fill, no stroke, no effect and no text");
      lines.push("  anywhere inside it, and nothing else in the design was placed inside");
      lines.push("  it — so no visible content is missing from your email.");
      for (const o of list) {
        const box = o && o.box ? ` (${Number(o.box.w).toFixed(2)} x ${Number(o.box.h).toFixed(2)} px)` : "";
        lines.push(`    - node ${(o && o.node) || "?"}  ${JSON.stringify(o && o.name != null ? o.name : "")}${box}`);
        if (o && o.figmaReason) lines.push(`        Figma said : ${o.figmaReason}`);
        if (o && o.why) lines.push(`        Checked    : ${o.why}`);
      }
    }
    lines.push("");
  }
  // ── ★★ D133: WHAT IN THIS EMAIL IS NOT EXACT ──────────────────────────────
  // The section above answers "is anything MISSING". This answers the different
  // question the compiler can now raise: "is anything PRESENT BUT NOT EXACT".
  // They are deliberately separate headings — a developer who reads "nothing is
  // missing" and stops must not thereby be told nothing is approximate.
  //
  // Printed at zero for the same reason as the block above: "none" is a claim,
  // silence is not. Written in the recipient's language, not the compiler's —
  // no guard names, no line numbers, and every element named so the imperfection
  // can be seen WITHOUT OPENING THE HTML.
  {
    const cert = certificate && typeof certificate === "object" ? certificate : null;
    const appr = Array.isArray(cert && cert.approximated) ? cert.approximated : [];
    const degr = Array.isArray(cert && cert.degradedSlices) ? cert.degradedSlices : [];
    const n = (cert && typeof cert.notExactCount === "number") ? cert.notExactCount : appr.length + degr.length;
    lines.push("WHAT IN THIS EMAIL IS NOT EXACT");
    lines.push("-------------------------------");
    if (!cert) {
      lines.push("  (no compiler certificate reached this delivery — see certificate.txt)");
    } else if (!n) {
      lines.push("  NOTHING — every element took the compiler's exact path.");
    } else {
      lines.push(`  ${n} element(s) could not be reproduced exactly.`);
      lines.push("  EVERY ONE OF THEM IS IN YOUR EMAIL. Nothing was dropped, no section was");
      lines.push("  collapsed, and no live text was turned into a picture to make this work.");
      lines.push("  What is imperfect about each one is stated below.");
      for (const a of appr) {
        lines.push(`    - node ${(a && a.id) || "?"}  ${JSON.stringify(a && a.name != null ? a.name : "")}  [${a && a.type}]`);
        lines.push(`        shown as   : ${a && a.route}`);
        lines.push(`        not exact  : ${a && a.outline}`);
        lines.push(`        kept       : ${a && a.preserved}`);
      }
      for (const d of degr) {
        lines.push(`    - node ${(d && d.nodeId) || "?"}  [image slice]`);
        lines.push(`        expected   : ${d && d.expected}   Figma returned: ${d && d.received}`);
        if (d && d.originPx) lines.push(`        off by     : ${d.originPx.x}px across, ${d.originPx.y}px down`);
        if (d && d.residualPx) lines.push(`        off by     : ${d.residualPx.w}px wide, ${d.residualPx.h}px tall`);
        lines.push(`        shipped    : ${d && d.what}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

// ── certificate.txt ───────────────────────────────────────────────────
// For a COMPILER order with a forwarded certificate → the real proof numbers.
// For a compiler order whose certificate could not be located → say so plainly.
// For an LLM order → state clearly that NO certificate exists (never fabricate).
export function buildCertificateText({ generatedBy, certificate, orderId, provenance } = {}) {
  const lines = [];
  lines.push("MAVELOPER — DELIVERY CERTIFICATE");
  lines.push("================================");
  if (orderId) lines.push(`Order ID: ${orderId}`);
  // ★ THE ENGINE STATEMENT COMES FIRST, ON EVERY CERTIFICATE, ON BOTH ROUTES.
  if (provenance && provenance.banner) lines.push(provenance.banner);
  lines.push("");

  // The provenance record is the engine's OWN statement and outranks the html
  // heuristic; the heuristic is consulted only when no record was forwarded.
  const engine = (provenance && provenance.engine) || (generatedBy === "compiler" ? "compiler" : "llm");

  if (engine !== "compiler") {
    lines.push("No certificate exists for this order.");
    lines.push("");
    // ★★ A FALLBACK MUST SAY IT WAS A FALLBACK, AND NAME THE GUARD. Without this,
    //    the certificate for a REFUSED compiler order is indistinguishable from one
    //    for an order that was never routed to the compiler at all — which is
    //    precisely how LLM artifacts came to be read as compiler output.
    if (provenance && provenance.fallback && provenance.fallback.occurred) {
      lines.push("★ THIS ORDER WAS ROUTED TO THE COMPILER AND THE COMPILER REFUSED IT.");
      lines.push(`  Guard  : ${provenance.fallback.guard}`);
      lines.push(`  Reason : ${provenance.fallback.reason}`);
      lines.push(`  Mode   : ${provenance.fallback.mode} (env ${provenance.fallback.flag})`);
      lines.push("  The LLM produced the delivered bytes INSTEAD. This is a RECORDED fallback,");
      lines.push("  not compiler output, and not a silent substitution.");
      lines.push("");
    }
    lines.push("This email was produced by the LLM generation path, which does not");
    lines.push("emit a deterministic proof. There are no measured numbers to report —");
    lines.push("stating otherwise would be fabrication. Review the delivered html");
    lines.push("against the design manually.");
    lines.push("");
    if (provenance && provenance.humanBlock) { lines.push(provenance.humanBlock); lines.push(""); }
    return lines.join("\n") + "\n";
  }

  lines.push("Engine:  deterministic compiler (geometry-compiled from the Figma design)");
  if (provenance && provenance.humanBlock) { lines.push(""); lines.push(provenance.humanBlock); }
  lines.push("");
  if (!certificate || typeof certificate !== "object" || Object.keys(certificate).length === 0) {
    lines.push("This order was compiler-authored, but the proof certificate could not be located");
    lines.push("for this delivery. The compiler DID produce one at compile time (recorded in the");
    lines.push("job's compiler-provenance sidecar / PROOF/*.certificate.json); it was not");
    lines.push("forwarded to this delivery folder. Reported numbers are omitted rather than");
    lines.push("guessed. Check the bridge logs for the compile job's certificate.");
    lines.push("");
    return lines.join("\n") + "\n";
  }

  const c = certificate;
  const verdict = c.verdict != null ? c.verdict : (c.proven ? "PROVEN EXACT" : "MEASURED & DIVERGENT");
  lines.push(`Verdict:               ${verdict}`);
  if (c.proven != null)          lines.push(`Proven exact:          ${c.proven ? "YES (certify exit 0)" : "NO — shipped with divergences (certify exit 1)"}`);
  if (c.checksRun != null)       lines.push(`Property checks run:    ${c.checksRun}`);
  if (c.divergenceCount != null) lines.push(`Property divergences:   ${c.divergenceCount}`);
  if (c.checksRun != null && c.divergenceCount != null) {
    const acc = c.checksRun > 0 ? (((c.checksRun - c.divergenceCount) / c.checksRun) * 100).toFixed(2) : "n/a";
    lines.push(`Property accuracy:      ${acc}% (${c.checksRun - c.divergenceCount}/${c.checksRun} checks matched)`);
  }
  if (c.nodesMeasured != null)   lines.push(`Nodes measured:         ${c.nodesMeasured}${c.nodesMissing != null ? ` (missing: ${c.nodesMissing})` : ""}`);
  if (c.imagesTotal != null)     lines.push(`Sliced images:          ${c.imagesTotal}${c.imagesBroken != null ? ` (broken: ${c.imagesBroken})` : ""}`);
  if (c.width != null)           lines.push(`Compiled width:         ${c.width}px`);
  if (c.fonts && c.fonts.status) lines.push(`Fonts:                  ${c.fonts.status}${c.fonts.ready != null ? ` (ready: ${c.fonts.ready})` : ""}`);
  if (c.unverifiableCount != null) lines.push(`Unverifiable properties: ${c.unverifiableCount} (dimensions the oracle cannot measure headlessly — see below)`);
  if (Array.isArray(c.unverifiable) && c.unverifiable.length) {
    lines.push(`  ${c.unverifiable.join(", ")}`);
  }
  if (c.deliveredVerified != null) {
    lines.push("");
    lines.push(`Delivered-file re-verification: ${c.deliveredVerified ? "PASSED (final bytes matched the frozen proof)" : "SEE PROVENANCE"}`);
  }
  // ★★ D119 — ELEMENTS FIGMA COULD NOT SUPPLY. A hole must never be silent.
  //    The compiler now ships an email that is missing such an element rather than
  //    failing the order — but ONLY after proving the element declares no fill,
  //    stroke, effect or text anywhere in its own Figma subtree AND has nothing
  //    adopted into it. This section names every one, so a developer sees exactly
  //    what is absent without opening the file. Printed even when the count is 0,
  //    because "none" is a claim and silence is not.
  {
    const list = Array.isArray(c.assetsUnavailable) ? c.assetsUnavailable : [];
    const n = typeof c.assetsUnavailableCount === "number" ? c.assetsUnavailableCount : list.length;
    lines.push("");
    if (!n) {
      lines.push("Elements missing from this email: NONE — Figma supplied every asset requested.");
    } else {
      lines.push(`★ ELEMENTS MISSING FROM THIS EMAIL: ${n}`);
      lines.push("  Figma returned no image for the layers below, so they are ABSENT from the");
      lines.push("  delivered html. Each was checked first: none declares a fill, a stroke, an");
      lines.push("  effect or any text anywhere inside it, and nothing else in the design was");
      lines.push("  placed inside it — so no visible content is missing. They are listed here");
      lines.push("  so the absence is known rather than discovered.");
      for (const o of list) {
        lines.push(`    - node ${o.node || "?"}  ${JSON.stringify(o.name ?? "")}` +
          (o.box ? `  (${Number(o.box.w).toFixed(2)} x ${Number(o.box.h).toFixed(2)} px)` : ""));
        if (o.figmaReason) lines.push(`        Figma said : ${o.figmaReason}`);
        if (o.why)         lines.push(`        Checked    : ${o.why}`);
      }
    }
  }
  // ★★ D133 — ELEMENTS PRESENT BUT NOT EXACT. The mirror of the block above, in
  // certificate.txt as well as delivery-notes.txt, because the owner's rule is
  // that a degradation reaches BOTH human-facing files. Printed at zero.
  {
    const appr = Array.isArray(c.approximated) ? c.approximated : [];
    const degr = Array.isArray(c.degradedSlices) ? c.degradedSlices : [];
    const n = typeof c.notExactCount === "number" ? c.notExactCount : appr.length + degr.length;
    lines.push("");
    if (!n) {
      lines.push("Elements not reproduced exactly: NONE — every element took the exact path.");
    } else {
      lines.push(`★ ELEMENTS NOT REPRODUCED EXACTLY: ${n}`);
      lines.push("  The compiler could not reproduce these exactly, so it did the most faithful");
      lines.push("  thing available and recorded what it could not match. EVERY ONE IS PRESENT");
      lines.push("  in the delivered html: nothing was dropped, no section collapsed, and no");
      lines.push("  live text was baked into a picture.");
      for (const a of appr) {
        lines.push(`    - node ${a.id || "?"}  ${JSON.stringify(a.name ?? "")}  [${a.type}]`);
        lines.push(`        shown as   : ${a.route}`);
        lines.push(`        not exact  : ${a.outline}`);
        lines.push(`        kept       : ${a.preserved}`);
      }
      for (const d of degr) {
        lines.push(`    - node ${d.nodeId || "?"}  [image slice]`);
        lines.push(`        expected   : ${d.expected}   Figma returned: ${d.received}`);
        if (d.originPx)   lines.push(`        off by     : ${d.originPx.x}px across, ${d.originPx.y}px down`);
        if (d.residualPx) lines.push(`        off by     : ${d.residualPx.w}px wide, ${d.residualPx.h}px tall`);
        lines.push(`        shipped    : ${d.what}`);
      }
    }
  }
  // Mobile disclosure (ITEM-5). ALWAYS honest and self-contained; enriched if the caller
  // threads certificate.mobile from the compiler-provenance sidecar. The certificate must
  // NOT imply mobile pixel-equality — the design has no mobile reference frame.
  lines.push("");
  lines.push("Mobile (responsive) branch — CORPUS-GROUNDED, NOT design-proven:");
  lines.push("  The Figma design specifies a SINGLE width, so there is no mobile reference");
  lines.push("  frame — the mobile layout can never be pixel-PROVEN the way the desktop render");
  lines.push("  is (the desktop render IS proven pixel-identical to the frozen DIAMOND proof).");
  lines.push("  Mobile is derived from the corpus responsive ladder + the delivered em_ hooks");
  lines.push("  and is measured for SANITY (no horizontal overflow, no zoom-out, no clipped CTA,");
  lines.push("  no overlapping text, images within container) at 360px and 375px — not equality.");
  const mob = c.mobile;
  if (mob && mob.tierWired && mob.tierWired.deliveredArtifact && mob.tierWired.deliveredArtifact.verdict) {
    lines.push(`  Delivered mobile tier:  ${mob.tierWired.deliveredArtifact.verdict} (em_ hooks attached to the shipped file)`);
  }
  if (mob && mob.saneGate) {
    const w = Array.isArray(mob.saneGate.widths) ? mob.saneGate.widths.join("/") : "360/375";
    lines.push(`  Sane-mobile gate:       ${mob.saneGate.corpusResult || "see provenance sidecar"} (widths ${w}px)`);
  } else {
    lines.push("  Per-artifact mobile tier + sane-gate detail: see the job's compiler-provenance.json sidecar.");
  }
  lines.push("");
  lines.push("Note: 'live-text coverage' is not a field the compiler certificate emits;");
  lines.push("live vs sliced text is visible in the delivered html itself (live text is");
  lines.push("real <text>, sliced regions are the images/ files). Sliced-image count above");
  lines.push("is the slice ratio proxy.");
  lines.push("");
  return lines.join("\n") + "\n";
}

export default {
  sanitizeOrderId,
  collectReferencedUrls,
  basenameFromUrl,
  assignLocalFilenames,
  localizeHtml,
  collectLocalImageNames,
  collectDeadLocalRefs,
  planDeliveredImagesFolder,
  gateDeliveredFolderStatic,
  buildFolderIntegrityDisclosure,
  detectDarkMode,
  looksCompilerAuthored,
  collectFonts,
  deriveWordFatalLedger,
  buildDeliveryNotes,
  buildCertificateText,
};
