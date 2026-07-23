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
export function collectReferencedUrls(html) {
  if (!html || typeof html !== "string") return [];
  const urls = new Set();
  // <img src="..."> / src='...'
  const srcRe = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let m;
  while ((m = srcRe.exec(html)) !== null) {
    const u = (m[1] || m[2] || "").trim();
    if (/^https?:\/\//i.test(u)) urls.add(u);
  }
  // CSS background url(...) — background:url(...) / background-image:url("...")
  const urlRe = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+))\s*\)/gi;
  while ((m = urlRe.exec(html)) !== null) {
    const u = (m[1] || m[2] || m[3] || "").trim();
    if (/^https?:\/\//i.test(u)) urls.add(u);
  }
  return [...urls];
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

// ── HTML localisation ─────────────────────────────────────────────────
// Swap each absolute URL for its local `images/<filename>` path so the folder's
// html references the co-located files (owner requirement). NEVER mutates the
// caller's string in place — returns a new one — so the ABSOLUTE-URL email copy
// the backend keeps is untouched (the deliberate two-copy split: email = absolute
// Dropbox URLs, folder = local images/). Longest URLs first so a URL that is a
// prefix of another is not partially replaced.
export function localizeHtml(html, urlToFilename) {
  let out = html;
  const entries = Object.entries(urlToFilename).sort((a, b) => b[0].length - a[0].length);
  for (const [url, filename] of entries) {
    out = out.split(url).join(`images/${filename}`);
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
export function buildDeliveryNotes({ orderId, esp, darkMode, fonts, ledger, generatedBy, imageCount, generatedAt } = {}) {
  const lines = [];
  lines.push("MAVELOPER — DELIVERY NOTES");
  lines.push("==========================");
  lines.push(`Order ID:      ${orderId || "(unknown)"}`);
  lines.push(`Generated by:  ${generatedBy || "unknown"}`);
  if (generatedAt) lines.push(`Delivered at:  ${generatedAt}`);
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
  return lines.join("\n") + "\n";
}

// ── certificate.txt ───────────────────────────────────────────────────
// For a COMPILER order with a forwarded certificate → the real proof numbers.
// For a compiler order whose certificate could not be located → say so plainly.
// For an LLM order → state clearly that NO certificate exists (never fabricate).
export function buildCertificateText({ generatedBy, certificate, orderId } = {}) {
  const lines = [];
  lines.push("MAVELOPER — DELIVERY CERTIFICATE");
  lines.push("================================");
  if (orderId) lines.push(`Order ID: ${orderId}`);
  lines.push("");

  if (generatedBy !== "compiler") {
    lines.push("No certificate exists for this order.");
    lines.push("");
    lines.push("This email was produced by the LLM generation path, which does not");
    lines.push("emit a deterministic proof. There are no measured numbers to report —");
    lines.push("stating otherwise would be fabrication. Review the delivered html");
    lines.push("against the design manually.");
    lines.push("");
    return lines.join("\n") + "\n";
  }

  lines.push("Engine:  deterministic compiler (geometry-compiled from the Figma design)");
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
  localizeHtml,
  detectDarkMode,
  looksCompilerAuthored,
  collectFonts,
  deriveWordFatalLedger,
  buildDeliveryNotes,
  buildCertificateText,
};
