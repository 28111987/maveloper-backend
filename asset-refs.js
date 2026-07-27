/**
 * asset-refs.mjs — THE ONE ASSET-REFERENCE EXTRACTOR.
 *
 * ★ WHY THIS FILE EXISTS.
 * TEST27-1800 (job_1785155572780_4b4c1919) — the first live compiler order —
 * shipped a Dropbox folder whose images/ held 79 files while the delivered html
 * needed 86. The 7 missing files were the hero band, four news-list thumbnails
 * and two section graphics, and every one of them was reached ONLY by
 * `background-image:url(...)`.
 *
 * The cause was not one bug. It was FOUR INDEPENDENT COPIES of "find the images"
 * in two repos, each written to a slightly different regex, and the FIRST one in
 * the chain was `<img src>`-only:
 *
 *   compiler-assets.mjs:53   /\bsrc\s*=\s*["']([^"']+)["']/gi        IMG ONLY  <- origin
 *   server.js:1010           /\bsrc\s*=\s*["']([^"']+)["']/gi        IMG ONLY
 *   delivery-folder.js:44    src=  +  url(...)                       url()-aware
 *   shipped-artifact.mjs:58  <img src>  +  url(...)                  url()-aware
 *
 * Because link 1 never collected the 7 backgrounds, they were never uploaded,
 * never rewritten to an absolute URL, and so link 3's `^https?://` filter dropped
 * them too — which is why fixing only the delivery-folder collector would have
 * changed nothing at all.
 *
 * ★ SO THE FIX IS ONE FUNCTION, NOT FOUR REGEXES. Everything that asks "which
 * assets does this document reference?" now asks HERE. If a mechanism is missed,
 * it is missed in one place and fixed in one place, and the gate that measures
 * the result cannot disagree with the collector that produced it.
 *
 * ★ MIRRORED, NOT SHARED — AND THE MIRROR IS GUARDED.
 * The bridge and the backend are separate repos with separate deploys, so there
 * is no import path between them. The block between the CANONICAL markers below
 * is byte-identical in:
 *
 *   C:/maveloper-bridge/asset-refs.mjs               (this file)
 *   <maveloper-backend>/asset-refs.js
 *
 * `asset-refs.test.mjs` in EACH repo hashes that block and compares it against
 * ASSET_REF_CANON_SHA — pinned to the same constant in both — and then runs the
 * same golden vectors. Edit one copy and BOTH repos' tests go red. That is the
 * cheapest honest substitute for a shared package.
 *
 * ★ WHAT IT DELIBERATELY DOES NOT DO. It does not render. The delivered-folder
 * gate renders Chrome and reads COMPUTED `background-image`, which catches
 * anything a static scan cannot see (a background injected by a `<style>` rule,
 * a shorthand this file mis-parses). The two are complementary on purpose: this
 * file is what the collector CAN run on Railway, the gate is the backstop that
 * proves the collector was right. A miss here becomes a RED gate, never a silent
 * short folder.
 */

// ==== BEGIN CANONICAL (byte-identical across repos — see ASSET_REF_CANON_SHA) ====

// Bumped whenever the extraction BEHAVIOUR changes, so a stale mirror is
// identifiable from its output alone and not only from the file hash.
export const ASSET_REF_CANON_VERSION = 2;

// Minimal HTML entity decode. The only case that has actually bitten us is
// `&amp;` inside an attribute value: job_1779773959367_5508db1a carries the SAME
// Dropbox URL raw inside `url(...)` and entity-encoded inside `background="…"`,
// so a collector that keys on the decoded form materialises the file while a
// pure string-swap localiser leaves the attribute absolute — one logical URL,
// two byte forms, one swapped, an undeclared MIXED document.
export function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#0*34;/gi, '"')
    .replace(/&#0*38;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

// The inverse, applied ONLY to `&`, so a caller can reconstruct the encoded byte
// form of a decoded URL for a byte-exact replacement.
export function encodeAmp(s) {
  return String(s).replace(/&/g, "&amp;");
}

// A reference that resolves on its own and must never be uploaded or localised.
export function isRemoteRef(u) {
  return /^(?:https?:|data:|cid:|mailto:|tel:|blob:|about:|\/\/)/i.test(String(u).trim());
}

// A reference that is not a URL at all — an ESP merge token, a templating
// placeholder, an empty value. Never collectable, never a defect.
export function isTokenRef(u) {
  const s = String(u).trim();
  if (!s) return true;
  if (/^#/.test(s)) return true;
  if (/^%%.*%%$/.test(s)) return true;              // %%unsub_center_url%%
  if (/[{][{%]|[%}][}]/.test(s)) return true;       // {{ handlebars }} / {% liquid %}
  if (/^\$\{/.test(s)) return true;                 // ${interpolation}
  if (/^\[%|%\]$/.test(s)) return true;             // [%acoustic%]
  return false;
}

// The local filename a reference maps to: the basename of the path, query and
// fragment stripped, percent-decoded when that is safe.
export function assetBasename(u, index = 0) {
  try {
    const noQuery = String(u).split("?")[0].split("#")[0];
    const base = noQuery.split("/").filter(Boolean).pop() || "";
    let decoded = base;
    try { decoded = decodeURIComponent(base); } catch { /* keep raw */ }
    if (decoded) return decoded;
  } catch { /* fall through */ }
  return `image_${index + 1}.png`;
}

/**
 * Every asset reference the document makes, in document order, by EVERY
 * mechanism an HTML email can carry one.
 *
 * Mechanisms, and why each is here rather than assumed absent:
 *   src           — `<img>`, and `<v:fill src>` / `<v:image src>` fall out of the
 *                   same attribute scan, so the Outlook VML background technique
 *                   is covered without a second regex.
 *   srcset        — a retina candidate list; the URL is the first token of each
 *                   comma-separated candidate.
 *   background    — the HTML4 `background="…"` attribute on `<td>`/`<body>`.
 *                   ★ MEASURED, NOT ASSUMED: 5 of 103 surveyed LLM artifacts
 *                   reference a real Dropbox image THIS WAY AND NO OTHER WAY.
 *                   It is invisible to both `src=` and `url(…)`.
 *   css-url       — `url(…)`, quoted or unquoted, in an inline `style` attribute
 *                   or a `<style>` block. This is the population that shipped
 *                   short on TEST27-1800.
 *   poster        — `<video poster>`; cheap to include, silently broken if not.
 *
 * @param {string} html
 * @returns {Array<{raw:string, url:string, mech:string, index:number}>}
 *   `raw`   the EXACT byte substring as it appears in `html` (entity encoding
 *           and all) — a localiser must replace THIS, not the decoded form.
 *   `url`   the decoded, trimmed logical URL — what a map should be keyed by.
 *   `mech`  which mechanism found it.
 *   `index` byte offset of `raw` in `html`.
 */
export function extractAssetRefs(html) {
  if (!html || typeof html !== "string") return [];
  const out = [];

  const push = (raw, mech, index) => {
    const trimmed = String(raw).trim();
    if (!trimmed) return;
    const url = decodeHtmlEntities(trimmed);
    if (isTokenRef(url)) return;
    out.push({ raw: trimmed, url, mech, index });
  };

  // Attribute-valued mechanisms. Quoted forms first in the alternation so an
  // unquoted branch can never swallow a quote.
  const ATTRS = [
    { mech: "src", re: /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi },
    { mech: "background", re: /\bbackground\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi },
    { mech: "poster", re: /\bposter\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi },
  ];
  for (const a of ATTRS) {
    a.re.lastIndex = 0;
    let m;
    while ((m = a.re.exec(html)) !== null) {
      const v = m[1] ?? m[2] ?? m[3] ?? "";
      push(v, a.mech, m.index);
    }
  }

  // srcset: "u1 1x, u2 2x" — the URL is the first whitespace-delimited token of
  // each candidate. Offsets are approximated to the attribute start; a srcset
  // localiser replaces the URL substring, not the whole attribute.
  const ssRe = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let sm;
  while ((sm = ssRe.exec(html)) !== null) {
    const list = sm[1] ?? sm[2] ?? "";
    for (const cand of list.split(",")) {
      const first = cand.trim().split(/\s+/)[0];
      if (first) push(first, "srcset", sm.index);
    }
  }

  // CSS url(...) — quoted or unquoted, anywhere.
  const uRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi;
  let um;
  while ((um = uRe.exec(html)) !== null) {
    const v = um[1] ?? um[2] ?? um[3] ?? "";
    push(v, "css-url", um.index);
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * The distinct LOGICAL asset URLs the document references, in first-appearance
 * order, optionally filtered.
 *
 * @param {string} html
 * @param {(ref:{url:string,mech:string}) => boolean} [predicate]
 * @returns {string[]} distinct decoded URLs
 */
export function distinctAssetUrls(html, predicate) {
  const seen = new Set();
  const out = [];
  for (const ref of extractAssetRefs(html)) {
    if (predicate && !predicate(ref)) continue;
    if (seen.has(ref.url)) continue;
    seen.add(ref.url);
    out.push(ref.url);
  }
  return out;
}

/**
 * Replace one logical URL everywhere it appears, in EVERY byte form the document
 * used for it. A pure `split(url).join(next)` misses the entity-encoded form —
 * that is the second defect this module exists to close.
 *
 * @param {string} html
 * @param {string} url          the decoded logical URL
 * @param {string} replacement  what to put in its place
 * @returns {{html:string, replaced:number}}
 */
export function replaceAssetUrl(html, url, replacement) {
  let out = html;
  let replaced = 0;
  // Longest byte form first so a shorter form cannot partially consume it.
  const forms = [...new Set([encodeAmp(url), url])].sort((a, b) => b.length - a.length);
  for (const form of forms) {
    if (!form) continue;
    const parts = out.split(form);
    if (parts.length > 1) {
      replaced += parts.length - 1;
      out = parts.join(replacement);
    }
  }
  return { html: out, replaced };
}

/**
 * Rewrite every LOCAL asset reference whose basename is a key of `byName` to the
 * URL that key maps to — by EXACT BASENAME, never positionally.
 *
 * ★ This exists so `server.js`'s non-`src` rewrite and the proof harness that
 * verifies it are literally the same code. The original defect was four copies
 * of "find the images" that disagreed; a fix that adds a fifth copy inside a
 * 7,000-line server file, unreachable from any test, would be the same mistake
 * with a better comment.
 *
 * Remote refs are skipped, so this is idempotent and a no-op on a document whose
 * assets are already absolute (every LLM-path delivery).
 *
 * @param {string} html
 * @param {Object<string,string>} byName  lower-cased basename -> replacement URL
 * @param {{skipMechs?: string[], skipBasenames?: RegExp}} [opts]
 * @returns {{html:string, replaced:number, unmatched:Array<{basename:string,mech:string}>}}
 */
export function rewriteRefsByBasename(html, byName, opts = {}) {
  const skipMechs = new Set(opts.skipMechs || []);
  const skipBasenames = opts.skipBasenames || /^spacer\.gif$/i;
  const rawToUrl = new Map();
  const unmatched = [];
  for (const ref of extractAssetRefs(html)) {
    if (skipMechs.has(ref.mech)) continue;
    if (isRemoteRef(ref.url)) continue;
    const fn = assetBasename(ref.url);
    if (!fn || skipBasenames.test(fn)) continue;
    const next = byName[fn.toLowerCase()];
    if (!next) { unmatched.push({ basename: fn, mech: ref.mech }); continue; }
    rawToUrl.set(ref.raw, next);              // key by the exact BYTE form
  }
  let out = html;
  let replaced = 0;
  // Longest byte form first so one raw form cannot partially consume another.
  for (const raw of [...rawToUrl.keys()].sort((a, b) => b.length - a.length)) {
    const parts = out.split(raw);
    if (parts.length > 1) {
      replaced += parts.length - 1;
      out = parts.join(rawToUrl.get(raw));
    }
  }
  return { html: out, replaced, unmatched };
}

// ==== END CANONICAL ====

// sha256 of the CANONICAL block above, pinned identically in both repos'
// asset-refs.test.mjs. Computed by `node asset-refs.test.mjs --print-sha`.
export const ASSET_REF_CANON_SHA_NOTE =
  "see asset-refs.test.mjs — ASSET_REF_CANON_SHA";

export default {
  ASSET_REF_CANON_VERSION,
  decodeHtmlEntities, encodeAmp, isRemoteRef, isTokenRef, assetBasename,
  extractAssetRefs, distinctAssetUrls, replaceAssetUrl, rewriteRefsByBasename,
};
