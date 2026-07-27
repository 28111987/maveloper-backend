// ─────────────────────────────────────────────────────────────────────────────
// order-confirmation.js — THE ORDER-CONFIRMATION EMAIL, as pure functions.
//
// WHY THIS FILE HAS NO I/O. Everything here is a pure transform: (facts) → bytes.
// No Dropbox, no Supabase, no network, no fs, no Express. That is what makes the
// two REQUIRED renderings (compiler + LLM-fallback) provable from a test file
// without credentials, and it is why a transport failure cannot reach this code.
// The sending half lives in order-confirmation-transport.js.
//
// ─── WHAT A LEAD IS OWED, AND WHY EACH PIECE IS HERE ────────────────────────
// A lead who submits an order currently hears NOTHING until they go and look in
// Dropbox. This email is the order announcing itself. Three rules shape it:
//
//  1. ★ TRANSLATE PROVENANCE INTO LEAD-READABLE LANGUAGE. A lead does not know
//     what "slice ratio" means. Every numeric block is preceded by a plain
//     English sentence that says what it means for them. The exact numbers are
//     kept — leading with the sentence is not the same as hiding the number.
//
//  2. ★ IF THE ORDER FELL BACK TO THE LLM, SAY SO PLAINLY AND NAME THE REASON.
//     Two weeks of LLM artifacts were once judged as compiler output because
//     nothing a human saw said which engine produced the file. An email that
//     smooths over a fallback re-creates that failure in the lead's inbox, which
//     is a worse place to have it than a delivery folder. The fallback callout is
//     therefore NOT a footnote: it displaces the compiler paragraph entirely and
//     names the guard and the verbatim reason.
//
//  3. ★ THE PLACEHOLDER-LINK COUNT MUST BE PROMINENT. Master templates ship with
//     href="#" placeholders and the email is NOT SENDABLE until a lead replaces
//     them. So the count goes in THREE places a reader cannot route around: the
//     SUBJECT LINE, an amber block above the fold, and the facts table.
//
// ─── WHERE THE PROVENANCE FIELD NAMES COME FROM ─────────────────────────────
// The record is authored in ONE place — route-provenance.mjs, PROVENANCE_SCHEMA 2,
// buildProvenanceCore() — in the bridge repo, which the backend cannot import.
// The paths below are read from that source, not inferred:
//
//   engine ("compiler"|"llm") · engineLabel · diamondTag · schema
//   compiler.{exit, proven, shipped, refusalGuard, refusalReason,
//             notAttemptedBecause}
//   fallback.{occurred, from, to, guard, reason, mode, flag, note}
//   quality.{liveTextCoverage, sliceRatioNodes, sliceRatioArea,
//            propertyAccuracyFloor, propertyAccuracyCeiling,
//            divergenceCount, divergenceBreakdown, textNodes,
//            slicedTextNodes, wordFatalCount, source}
//   delivery.{espTarget, espTargetRecognised, espTokensApplied, darkMode}
//   secondsElapsed · deliveredVerification.ok · banner · humanBlock
//
// ★ TWO UNIT FACTS THAT WOULD OTHERWISE BE GUESSED WRONG:
//   1. Every quality ratio is 0-1, NOT 0-100 (route-provenance.mjs formats them
//      as `(v*100).toFixed(2)+"%"`). Reading 1 as "1%" would turn a perfect
//      live-text score into a catastrophic-looking one.
//   2. Property accuracy is a RANGE (floor..ceiling), not a point, because some
//      properties are unmeasurable headlessly. Printing one bound as "the
//      accuracy" would present a bound as a measurement.
//
// Each reader still tries the verified path FIRST and then a short tolerance list
// (a schema-1 record, a rename) and then the CERTIFICATE, whose spelling is
// verified in this repo at delivery-folder.js:560-581. Anything that resolves
// nowhere OMITS its row rather than printing a guess — the discipline shipped
// code already sets at delivery-folder.js:554: "Reported numbers are omitted
// rather than guessed." A confirmation email that invents a proof number is worse
// than one that admits a gap, because a lead cannot tell the two apart.
//
// ─── THE TEMPLATE IS MAVELOPER-GENERATED (a dogfood test) ───────────────────
// Lime #C1FF72, "Born at Mavlers", per MAVELOPER_DESIGN_TOKENS_v1 / the /os UI
// system (src/components/os/preview/previewStyles.ts:60-70 for the exact tiers).
// It is a REAL email: Outlook-safe tables, NO flexbox, NO grid, every style
// inline, sharp edges (the /os sharp-edge system — which is also the Word
// engine's only reliable corner), and it renders in a dark client.
// ─────────────────────────────────────────────────────────────────────────────

// ── BRAND TOKENS ──────────────────────────────────────────────────────────────
// Lifted verbatim from /os so the confirmation cannot drift from the console the
// owner looks at. Emails cannot use CSS custom properties (Outlook/Gmail strip
// them), so the /os `var(--lime)` indirection is resolved to its hex here.
export const TOKENS = {
  LIME: "#C1FF72", // /os --lime · previewStyles.ts:65 LIME_HEX
  AMBER: "#e8c07d", // previewStyles.ts:66 AMBER_HEX
  BG: "#08080a", // previewStyles.ts:60 BG
  CARD: "#000000", // /os panels/cards are pure black
  INK: "#ffffff", // previewStyles.ts:61
  MUT: "#ececf2", // previewStyles.ts:62
  MUT2: "#d2d2d8", // previewStyles.ts:63
  FAINT: "#b8b8be", // previewStyles.ts:64 — dimmest tier allowed to carry text
  LINE: "#22222a",
  INK_ON_LIME: "#0a0a0a",
};

// Email-safe stacks. /os uses Syne (display), JetBrains Mono (telemetry) and
// Inter (body); none are web-safe in mail, so each degrades to a stack every
// client has. Named first anyway: Apple Mail and iOS honour locally-installed
// fonts, so the brand shows where it can and falls back cleanly where it cannot.
const FONT_BODY = "Inter, -apple-system, 'Segoe UI', Arial, Helvetica, sans-serif";
const FONT_MONO = "'JetBrains Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace";
const FONT_DISP = "Syne, Inter, -apple-system, 'Segoe UI', Arial, Helvetica, sans-serif";

/** The Content-ID the inline preview is referenced by. */
export const PREVIEW_CID = "maveloper-preview";

// ── escaping ─────────────────────────────────────────────────────────────────
/** HTML-escape a value for text content and quoted attribute values. */
export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape for an href. Only http(s), mailto and cid survive; anything else is
 * dropped to "#". A confirmation email interpolates a Figma URL and Dropbox URLs
 * that arrive from the DB, so a javascript: value must not become a live link in
 * the lead's client.
 */
export function safeHref(u) {
  if (typeof u !== "string") return "";
  const t = u.trim();
  if (!/^(https?:\/\/|mailto:|cid:)/i.test(t)) return "";
  return esc(t);
}

/**
 * Decode HTML entities into display text. Used on link text lifted out of the
 * DELIVERED html — that text is then re-escaped by esc() before it reaches the
 * email, so decoding here cannot introduce markup.
 *
 * Zero-width entities are removed rather than translated: &zwnj; / &zwj; /
 * &#8203; appear in real deliverables as anti-auto-link padding inside dates,
 * and a lead reading "Mar 18, 2026" should not see the padding.
 */
export function decodeEntitiesForDisplay(s) {
  if (!s) return "";
  const named = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    bull: "•", middot: "·", hellip: "…", mdash: "—", ndash: "–",
    rarr: "→", larr: "←", times: "×", copy: "©", reg: "®", trade: "™",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
    zwnj: "", zwj: "", shy: "", ensp: " ", emsp: " ", thinsp: " ",
  };
  return String(s)
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
      const k = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, k) ? named[k] : " ";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => codePointOrSpace(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => codePointOrSpace(parseInt(dec, 10)));
}

/** A numeric entity → its character, with zero-width code points dropped. */
function codePointOrSpace(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return " ";
  // zero-width space / non-joiner / joiner / BOM / soft hyphen
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff || cp === 0xad) return "";
  try { return String.fromCodePoint(cp); } catch { return " "; }
}

// ── ★ PLACEHOLDER LINKS ──────────────────────────────────────────────────────
/**
 * Count and identify every href="#" placeholder in the delivered HTML.
 *
 * ★ HONEST SCOPE NOTE. The spec says these are "disclosed by node id". They are
 * NOT, and cannot be, from the delivered bytes: `nodeId` exists in server.js only
 * to drive Figma image export (server.js:5826-5963) and is never emitted as an
 * attribute into the HTML. So we disclose by the identifier the bytes actually
 * carry, in descending order of usefulness:
 *   1. an `id` or any `data-*`-style id attribute on the anchor, when present
 *   2. the anchor's visible link text (what the lead will click)
 *   3. its document ordinal
 * Reporting the ordinal as if it were a node id would be a lie a lead cannot
 * detect, and the count — the part that gates sendability — is exact either way.
 *
 * Matches href="#", href='#' and href=# (unquoted), which is what the master
 * templates emit (server.js:2943, 3091, 3100, 3112, 3129, 3137, 3147, 3353,
 * 3609, 3612, 3864, 3866).
 */
export function countPlaceholderLinks(html) {
  const items = [];
  if (!html || typeof html !== "string") return { count: 0, items, identifiedBy: "none" };

  // Whole <a ...> open tag, then its content up to </a> (non-greedy, so nested
  // markup like an <img> inside the anchor is captured as the anchor's content).
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  let ordinal = 0;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || "";
    const inner = m[2] || "";
    // href="#" / href='#' / href=#  (allow surrounding whitespace inside quotes)
    if (!/\bhref\s*=\s*(?:"\s*#\s*"|'\s*#\s*'|#(?=[\s>]|$))/i.test(attrs)) continue;
    ordinal++;

    const idAttr =
      (attrs.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1] ||
      (attrs.match(/\bdata-(?:node-?id|em-node|figma-node)\s*=\s*["']([^"']+)["']/i) || [])[1] ||
      null;

    // Visible link text: strip tags, decode entities, squash whitespace. An
    // image-only anchor yields "" → we fall back to its alt text.
    //
    // The entity handling is general, not a short allow-list. Real delivered HTML
    // is full of typographic and zero-width entities (&zwnj; peppered through
    // dates to stop Gmail auto-linking them, &bull;, &nbsp;, &#8217;), and a
    // partial decode leaks them raw into the lead's email as "&zwnj;Mar 18&zwnj;"
    // — which is exactly what a first read of the rendered output showed.
    let text = decodeEntitiesForDisplay(inner.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      const alt = (inner.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1];
      if (alt && alt.trim()) text = `[image: ${alt.trim()}]`;
    }
    if (text.length > 60) text = text.slice(0, 57) + "…";

    items.push({
      ordinal,
      id: idAttr,
      text: text || null,
      label: idAttr || text || `placeholder link #${ordinal}`,
    });
  }

  const identifiedBy = items.some((i) => i.id)
    ? "id-attribute"
    : items.some((i) => i.text)
      ? "link-text"
      : items.length
        ? "ordinal"
        : "none";
  return { count: items.length, items, identifiedBy };
}

// ── provenance reading, tolerantly and honestly ───────────────────────────────
/** Walk a dotted path. Returns undefined for any missing hop. */
function at(obj, path) {
  let cur = obj;
  for (const k of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Try each candidate path in order; return { value, source } for the first that
 * resolves to something usable, else null. `source` names WHERE the number came
 * from so the email (and the report) can say so — a number without a source is
 * how a heuristic gets read as a measurement.
 */
function readFirst(sources, candidates, accept = (v) => v !== null && v !== undefined && v !== "") {
  for (const [sourceName, obj] of sources) {
    if (!obj || typeof obj !== "object") continue;
    for (const path of candidates) {
      const v = at(obj, path);
      if (accept(v)) return { value: v, source: `${sourceName}.${path}` };
    }
  }
  return null;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Assemble every measured fact the email may print, each tagged with its source.
 * A field that resolves nowhere is null and its row is OMITTED from the email.
 *
 * VERIFIED-SPELLING fields read directly (consumers cited in the header block):
 *   engine, banner, humanBlock, diamondTag, fallback.*
 * UNVERIFIED-SPELLING fields go through readFirst() over candidate paths and
 * then the certificate, whose field names ARE verified.
 */
export function readProvenanceFacts({ provenance, certificate, deliveredHtml, imageCount } = {}) {
  const p = provenance && typeof provenance === "object" ? provenance : null;
  const c = certificate && typeof certificate === "object" ? certificate : null;
  const sources = [
    ["provenance", p],
    ["certificate", c],
  ];

  // ── engine: the record's OWN statement, which outranks every heuristic.
  //    Same precedence rule as delivery-folder.js:520.
  const engine = p && typeof p.engine === "string" ? p.engine.toLowerCase() : null;

  // fallback.{occurred,guard,reason,mode,flag,note} are all set by
  // buildProvenanceCore. compiler.refusalGuard/refusalReason carry the same two
  // strings at a second path, so they are read as a backstop: a record that names
  // the guard in only one of the two places must still name it in the email.
  const fb = p && p.fallback && typeof p.fallback === "object" ? p.fallback : null;
  const fallback = fb && fb.occurred
    ? {
        occurred: true,
        guard: (typeof fb.guard === "string" ? fb.guard : null) || at(p, "compiler.refusalGuard") || null,
        reason: (typeof fb.reason === "string" ? fb.reason : null) || at(p, "compiler.refusalReason") || null,
        mode: typeof fb.mode === "string" ? fb.mode : null,
        flag: typeof fb.flag === "string" ? fb.flag : null,
        note: typeof fb.note === "string" ? fb.note : null,
      }
    : null;

  // ── THE PROOF NUMBERS, at their VERIFIED paths ────────────────────────────
  // The primary path in each list below is read from route-provenance.mjs
  // itself (PROVENANCE_SCHEMA 2, buildProvenanceCore). The later entries are
  // kept as tolerance for a schema-1 record or a future rename; the certificate
  // (whose spelling is verified in delivery-folder.js:560-581) is the last
  // resort. Anything that resolves nowhere is null and its row is OMITTED.
  //
  // ★ ALL RATIO FIELDS ARE 0-1, NOT 0-100. route-provenance.mjs:350 formats them
  //   as `(v*100).toFixed(2) + "%"`. Treating 1 as "1%" instead of "100%" would
  //   turn a perfect live-text score into a catastrophic-looking one, so this is
  //   the one unit assumption in the file worth stating twice.
  const exitCode = readFirst(sources, ["compiler.exit", "exitCode", "exit_code"], isNum);

  const coverage = readFirst(
    sources,
    ["quality.liveTextCoverage", "liveTextCoverage", "coverage"],
    (v) => isNum(v) || (typeof v === "string" && v.trim() !== ""),
  );

  const sliceRatio = readFirst(
    sources,
    ["quality.sliceRatioNodes", "sliceRatioNodes", "sliceRatio"],
    (v) => isNum(v) || (typeof v === "string" && v.trim() !== ""),
  );
  const sliceRatioArea = readFirst(sources, ["quality.sliceRatioArea", "sliceRatioArea"], isNum);

  // ★ ACCURACY IS A RANGE, NOT A POINT. route-provenance.mjs records a floor and
  //   a ceiling (propertyAccuracyFloor/.Ceiling, printed as "floor .. ceiling")
  //   because some properties are unmeasurable headlessly, so the true accuracy
  //   is bracketed rather than known. Collapsing it to one number would present a
  //   bound as a measurement — so both bounds travel, and the email says "between".
  const accuracyFloor = readFirst(sources, ["quality.propertyAccuracyFloor", "propertyAccuracyFloor"], isNum);
  const accuracyCeiling = readFirst(sources, ["quality.propertyAccuracyCeiling", "propertyAccuracyCeiling"], isNum);
  const accuracy = readFirst(sources, ["accuracy", "propertyAccuracy"], (v) => isNum(v) || (typeof v === "string" && v.trim() !== ""));

  const divergences = readFirst(
    sources,
    ["quality.divergenceCount", "divergenceCount", "divergences"],
    isNum,
  );
  const divergenceBreakdown =
    at(p, "quality.divergenceBreakdown") && typeof at(p, "quality.divergenceBreakdown") === "object"
      ? at(p, "quality.divergenceBreakdown")
      : null;

  const seconds = readFirst(sources, ["secondsElapsed", "seconds", "elapsedSeconds"], isNum);

  // Text-node counts — the single most lead-readable pair in the whole record:
  // "108 text blocks are live editable text, 0 had to become images."
  const textNodes = readFirst(sources, ["quality.textNodes", "textNodes"], isNum);
  const slicedTextNodes = readFirst(sources, ["quality.slicedTextNodes", "slicedTextNodes"], isNum);

  // ESP target and dark mode as the ENGINE recorded them (delivery.*). The caller
  // also passes the os_queue values; where the engine recorded its own, that is
  // the more truthful number because it reports what the pipeline actually did.
  const espTargetRecorded = at(p, "delivery.espTarget") ?? null;
  const darkModeRecorded = at(p, "delivery.darkMode");

  // ── DERIVED fallbacks, each LABELLED as derived so nothing reads as measured.
  // Property accuracy IS computable from two certificate fields whose spelling is
  // verified (delivery-folder.js:566-569 does exactly this arithmetic).
  let accuracyDerived = null;
  if (!accuracy && c && isNum(c.checksRun) && isNum(c.divergenceCount) && c.checksRun > 0) {
    accuracyDerived = {
      value: Number((((c.checksRun - c.divergenceCount) / c.checksRun) * 100).toFixed(2)),
      matched: c.checksRun - c.divergenceCount,
      total: c.checksRun,
      source: "computed from certificate.checksRun and certificate.divergenceCount",
    };
  }

  // Live text: delivery-folder.js:604-607 states in shipped code that the
  // compiler certificate does NOT emit a coverage percentage. So when provenance
  // carries no coverage we derive a PROXY from the delivered bytes and say so.
  let liveTextDerived = null;
  if (!coverage && typeof deliveredHtml === "string" && deliveredHtml) {
    const stripped = deliveredHtml
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = stripped ? stripped.split(" ").filter(Boolean).length : 0;
    if (words > 0) {
      liveTextDerived = {
        words,
        chars: stripped.length,
        source: "counted from the delivered HTML (the compiler certificate emits no coverage percentage — delivery-folder.js:604)",
      };
    }
  }

  // Sliced-image count: the certificate's own slice-ratio proxy per
  // delivery-folder.js:606-607, else the folder's materialised image count.
  const slicedImages = isNum(c?.imagesTotal)
    ? { value: c.imagesTotal, source: "certificate.imagesTotal" }
    : isNum(imageCount)
      ? { value: imageCount, source: "images bundled into the delivery folder" }
      : null;

  // Mobile: only the verified certificate paths (delivery-folder.js:594-599).
  const mobileTier = at(c, "mobile.tierWired.deliveredArtifact.verdict") || null;
  const mobileSaneGate = at(c, "mobile.saneGate.corpusResult") || null;
  const mobileWidths = at(c, "mobile.saneGate.widths");

  // proven / delivered-verification: the provenance record's own fields first
  // (compiler.proven, deliveredVerification.ok), then the certificate's.
  const proven = at(p, "compiler.proven") ?? (c && c.proven != null ? c.proven : null);
  const deliveredVerified = at(p, "deliveredVerification.ok") ?? (c && c.deliveredVerified != null ? c.deliveredVerified : null);

  return {
    hasProvenanceRecord: !!p,
    hasCertificate: !!c,
    schema: p && p.schema != null ? p.schema : null,
    engine,
    engineLabel: p && typeof p.engineLabel === "string" ? p.engineLabel : null,
    banner: p && typeof p.banner === "string" ? p.banner : null,
    humanBlock: p && typeof p.humanBlock === "string" ? p.humanBlock : null,
    diamondTag: p && p.diamondTag !== undefined && p.diamondTag !== null ? p.diamondTag : null,
    fallback,
    // compiler.notAttemptedBecause distinguishes "the compiler refused" from
    // "the compiler was never asked" — two very different things to tell a lead.
    notAttemptedBecause: at(p, "compiler.notAttemptedBecause") || null,
    exitCode,
    coverage,
    sliceRatio,
    sliceRatioArea,
    accuracy,
    accuracyFloor,
    accuracyCeiling,
    accuracyDerived,
    divergences,
    divergenceBreakdown,
    seconds,
    textNodes,
    slicedTextNodes,
    espTargetRecorded,
    darkModeRecorded: typeof darkModeRecorded === "boolean" ? darkModeRecorded : null,
    liveTextDerived,
    slicedImages,
    verdict: c && c.verdict != null ? c.verdict : null,
    proven,
    deliveredVerified,
    mobileTier,
    mobileSaneGate,
    mobileWidths: Array.isArray(mobileWidths) ? mobileWidths : null,
  };
}

// ── formatting ───────────────────────────────────────────────────────────────
/**
 * A timestamp in IST, matching the /os console's own formatter
 * (src/lib/queueEstimates.ts:73-83 fmtIST) so the email and the UI never quote
 * the same deadline two different ways.
 */
export function fmtIST(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return (
    d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }) + " IST"
  );
}

/**
 * "150s" / "2 min 30s" — generation time, in seconds, as the spec asks.
 * Sub-second values return null: an email build is never under a second, so a
 * "0s" build time is a missing measurement wearing a number's clothes. A first
 * read of the LLM-fallback rendering showed exactly that ("Build time: 0s"),
 * because the fallback record carries secondsElapsed 0 when the compiler
 * refused before the clock meant anything.
 */
export function fmtSeconds(sec) {
  if (!isNum(sec) || sec < 1) return null;
  const s = Math.round(sec);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r}s (${s}s)` : `${m} min (${s}s)`;
}

/** Percent-ish value → "97.4%". Accepts 0-1 ratios and 0-100 numbers. */
function fmtPct(v) {
  if (typeof v === "string") return v.trim();
  if (!isNum(v)) return null;
  const n = v > 0 && v <= 1 ? v * 100 : v;
  return `${Number(n.toFixed(2))}%`;
}

// ── ★ THE LEAD-READABLE TRANSLATION ──────────────────────────────────────────
/**
 * Turn provenance into sentences a lead can act on. This is the heart of the
 * spec: keep the exact numbers, but LEAD with plain language.
 *
 * Returns { engineLabel, headline, paragraphs[], tone } where tone drives the
 * accent colour: "lime" for a clean compiler ship, "amber" for a fallback or an
 * unproven/unknown route. A fallback is never rendered lime.
 */
export function buildLeadSummary(facts, { placeholderCount = 0 } = {}) {
  const isCompiler = facts.engine === "compiler";
  const fellBack = !!(facts.fallback && facts.fallback.occurred);
  const paragraphs = [];

  let engineLabel;
  let headline;
  let tone;

  if (fellBack) {
    // ★ A FALLBACK SAYS SO, PLAINLY, AND NAMES THE REASON. This displaces the
    //   compiler paragraph — it is not appended after it.
    engineLabel = "Maveloper LLM (compiler fallback)";
    headline = "This email was built by our LLM, not the deterministic compiler.";
    tone = "amber";
    paragraphs.push(
      "Your design was sent to our deterministic compiler first, and the compiler declined it. " +
        "Our LLM built the email instead. We are telling you this directly because the two engines " +
        "give you different guarantees, and you should know which one made the file you are about to send.",
    );
    const bits = [];
    if (facts.fallback.guard) bits.push(`the check that stopped it was <strong>${esc(facts.fallback.guard)}</strong>`);
    if (facts.fallback.reason) bits.push(`the reason it gave was &ldquo;${esc(facts.fallback.reason)}&rdquo;`);
    if (bits.length) paragraphs.push(`In plain terms: ${bits.join(", and ")}.`);
    paragraphs.push(
      "What this means for you: there is no pixel-level proof for this build, so the layout has not been " +
        "measured against your design automatically. Please review it against the Figma file before you send it.",
    );
  } else if (isCompiler) {
    engineLabel = facts.diamondTag
      ? `Maveloper deterministic compiler (${facts.diamondTag})`
      : "Maveloper deterministic compiler";
    headline = "This email was built by our deterministic compiler, straight from your Figma design.";
    // ★ A compiler ship is not automatically a clean one. certify exit 1 means it
    //   shipped WITH known divergences (per OUTPUT POLICY §8), and a lead reading
    //   "built by our deterministic compiler" would otherwise reasonably assume
    //   proven-exact. So the tone stays lime but the sentence tells the truth.
    const unproven = facts.proven === false || (facts.exitCode && facts.exitCode.value === 1);
    tone = "lime";
    paragraphs.push(
      "That means the layout was measured against your design rather than described to a model &mdash; " +
        "the geometry comes from the Figma file itself.",
    );
    if (facts.textNodes && isNum(facts.textNodes.value) && facts.slicedTextNodes && facts.slicedTextNodes.value === 0) {
      paragraphs.push(
        `All ${facts.textNodes.value} text blocks in your design came through as live, editable text &mdash; ` +
          "not pictures of text. You can change any of the copy in your ESP without coming back to us.",
      );
    } else {
      paragraphs.push(
        "Headings and paragraphs are live, editable text rather than pictures of text, so you can change " +
          "the copy in your ESP without coming back to us.",
      );
    }
    if (unproven) {
      const n = facts.divergences && isNum(facts.divergences.value) ? facts.divergences.value : null;
      paragraphs.push(
        n
          ? `One honest caveat: the build did not come out pixel-perfect. ${n} checked propert${n === 1 ? "y" : "ies"} ` +
            "still differ from the design, and we shipped it rather than hold your deadline. The differences are " +
            "itemised below and in certificate.txt in your folder."
          : "One honest caveat: the build did not come out pixel-perfect &mdash; some checked properties still " +
            "differ from the design. They are itemised in certificate.txt in your folder.",
      );
    }
  } else {
    engineLabel = "Maveloper LLM";
    headline = "This email was built by our LLM generation path.";
    tone = "amber";
    // ★ "The compiler refused" and "the compiler was never asked" are different
    //   facts and a lead should not have to guess which one happened.
    if (facts.notAttemptedBecause) {
      paragraphs.push(
        "Your design did not go through our deterministic compiler on this order &mdash; it was not routed there. " +
          "Our LLM built it instead, which means there is no pixel-level proof for this build.",
      );
    } else {
      paragraphs.push(
        "This order was not compiled deterministically, so there is no pixel-level proof for it.",
      );
    }
    paragraphs.push("Please review the build against your Figma design before you send it.");
    if (!facts.hasProvenanceRecord) {
      paragraphs.push(
        "We also could not read an engine record for this order, so the line above is our best " +
          "reading of the delivered file rather than a statement from the engine itself.",
      );
    }
  }

  // ★ The sendability sentence. Same wording in every branch, because it is true
  //   in every branch and a lead should learn it once.
  if (placeholderCount > 0) {
    paragraphs.push(
      `<strong>Before you send this, you must replace ${placeholderCount} placeholder ` +
        `link${placeholderCount === 1 ? "" : "s"}.</strong> They currently point nowhere. ` +
        "The email is not sendable until they are real URLs.",
    );
  } else {
    paragraphs.push(
      "We found no placeholder links in this build &mdash; every link in the file points somewhere. " +
        "Still worth a click-through before you send.",
    );
  }

  return { engineLabel, headline, paragraphs, tone, fellBack, isCompiler };
}

// ── the facts table rows ─────────────────────────────────────────────────────
/**
 * Build the ordered label/value rows. A row whose value could not be READ is
 * omitted entirely rather than rendered as "unknown" — except where absence is
 * itself the message (the placeholder count, the engine).
 * Each row may carry { note } — the lead-readable gloss for a technical number.
 */
export function buildFactRows(input) {
  const {
    orderId,
    figmaUrl,
    tatHours,
    bufferedDeadlineIST,
    rawDeadlineIST,
    esp,
    darkMode,
    engineLabel,
    generationSeconds,
    facts,
    placeholder,
    emailOnAcidUrl,
  } = input;

  const rows = [];
  // `raw` marks a value that already contains entities (&mdash;, &times;) and
  // must NOT be escaped again. Everything else is escaped at render time, which
  // is what keeps a DB-sourced string from injecting markup into a lead's inbox.
  const push = (label, value, note, raw = false) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value, note: note || null, raw });
  };

  push("Order ID", orderId);
  push("Figma design", figmaUrl ? { href: figmaUrl, text: "Open the Figma file" } : null);
  if (isNum(tatHours)) {
    push("TAT requested", `${Number(tatHours)}h`);
  }
  push(
    "Your deadline",
    bufferedDeadlineIST,
    bufferedDeadlineIST && rawDeadlineIST && bufferedDeadlineIST !== rawDeadlineIST
      ? `This is the buffered deadline &mdash; it is deliberately earlier than the ${esc(rawDeadlineIST)} TAT deadline so you have review time.`
      : "The buffered deadline, set earlier than your raw TAT so you have review time.",
  );
  push("ESP target", esp && String(esp).toLowerCase() !== "none" ? esp : "Generic / no ESP specified");
  push("Colour scheme", darkMode ? "Dark mode supported" : "Light only");
  // No gloss: engineLabel already carries the build tag in parentheses, and a
  // "(Build tag DIAMOND-46.)" note under "…compiler (DIAMOND-46)" is pure noise.
  push("Generated by", engineLabel);
  push("Build time", generationSeconds);

  // ── the proof numbers, each with its plain-English gloss ──────────────────
  if (facts.coverage) {
    // The lead-readable gloss carries the node counts when the record has them:
    // "108 text blocks, 0 had to ship as images" is actionable; "100.00%" alone
    // is a score. Both are shown — the number is never dropped.
    const nodeGloss =
      facts.textNodes && isNum(facts.textNodes.value)
        ? ` In this build ${facts.textNodes.value} text block${facts.textNodes.value === 1 ? "" : "s"} came through as live text` +
          (facts.slicedTextNodes && isNum(facts.slicedTextNodes.value)
            ? facts.slicedTextNodes.value === 0
              ? ", and none had to ship as an image."
              : `, and ${facts.slicedTextNodes.value} had to ship as an image (you cannot edit those).`
            : ".")
        : "";
    push(
      "Live-text coverage",
      fmtPct(facts.coverage.value) || String(facts.coverage.value),
      "How much of the email is real, editable text rather than a picture of text. Higher is better for you." + nodeGloss,
    );
  } else if (facts.liveTextDerived) {
    push(
      "Live editable text",
      `${facts.liveTextDerived.words} words`,
      "Real text you can edit in your ESP, counted from the delivered file. We do not report this as a percentage because the compiler does not measure one.",
    );
  }

  if (facts.sliceRatio) {
    const areaBit =
      facts.sliceRatioArea && isNum(facts.sliceRatioArea.value)
        ? ` (${fmtPct(facts.sliceRatioArea.value)} of the visual area)`
        : "";
    push(
      "Slice ratio",
      (fmtPct(facts.sliceRatio.value) || String(facts.sliceRatio.value)) + areaBit,
      "The share of your design that had to ship as images because it could not be rebuilt as text &mdash; " +
        "typically logos, photos and gradients. Lower means more of the email is editable.",
    );
  } else if (facts.slicedImages) {
    push(
      "Images in the build",
      `${facts.slicedImages.value}`,
      "Parts of the design that ship as images rather than text &mdash; usually logos, photos and effects that cannot be reproduced with text.",
    );
  }

  // ★ A RANGE, PRESENTED AS A RANGE. The compiler brackets accuracy between a
  //   floor and a ceiling because some properties cannot be measured headlessly.
  //   Printing one of the two bounds as "the accuracy" would present a bound as a
  //   measurement, which is the specific way a proof number becomes a lie.
  if (facts.accuracyFloor && facts.accuracyCeiling) {
    push(
      "Layout accuracy",
      `${fmtPct(facts.accuracyFloor.value)} to ${fmtPct(facts.accuracyCeiling.value)}`,
      "How closely the built email measured against your Figma design. It is a range, not a single number, " +
        "because a few properties cannot be measured automatically &mdash; the true figure sits between the two.",
    );
  } else if (facts.accuracy) {
    push(
      "Layout accuracy",
      fmtPct(facts.accuracy.value) || String(facts.accuracy.value),
      "How closely the built email measured against your Figma design.",
    );
  } else if (facts.accuracyDerived) {
    push(
      "Layout accuracy",
      `${facts.accuracyDerived.value}% (${facts.accuracyDerived.matched} of ${facts.accuracyDerived.total} checks matched)`,
      "How closely the built email measured against your Figma design.",
    );
  }

  if (facts.divergences && isNum(facts.divergences.value)) {
    // ★ THE BREAKDOWN, NOT JUST THE COUNT. "59 differences" is a number;
    //   "29 link.href + 29 type.runs + 1 type.lineCount" tells a lead that most
    //   of it is the placeholder links they already have to fix — which changes
    //   what they do next. The breakdown is named in lead language where the
    //   check name has an obvious meaning, and verbatim where it does not.
    let gloss = null;
    if (facts.divergences.value > 0) {
      const bd = facts.divergenceBreakdown;
      if (bd && Object.keys(bd).length) {
        const parts = Object.entries(bd)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([k, v]) => {
            const friendly =
              k === "link.href" ? "link targets" : k === "type.runs" ? "text styling runs" : k === "type.lineCount" ? "line wrapping" : k;
            return `${v} &times; ${esc(friendly)}`;
          });
        gloss = `Mostly ${parts.join(", ")}. ` +
          (bd["link.href"]
            ? "The link-target differences are the placeholder links above &mdash; they resolve when you set the real URLs. "
            : "") +
          "Every one is listed in certificate.txt inside your Dropbox folder.";
      } else {
        gloss = "These are listed in certificate.txt inside your Dropbox folder.";
      }
    }
    push(
      "Known differences",
      facts.divergences.value === 0
        ? "None &mdash; every checked property matched"
        : `${facts.divergences.value} checked propert${facts.divergences.value === 1 ? "y" : "ies"} differ from the design`,
      gloss,
      true, // the value carries an &mdash;
    );
  }

  if (facts.deliveredVerified === true) {
    push(
      "Final-file check",
      "Passed",
      "We re-checked the exact file in your folder, not just the one we built in memory.",
    );
  }

  // ★ Placeholder count in the table too — third of three placements.
  rows.push({
    label: "Placeholder links",
    value:
      placeholder.count > 0
        ? `${placeholder.count} &mdash; must be replaced before sending`
        : "None found",
    // "Listed below" was wrong: the itemised list is in the amber block at the
    // TOP of the email, above this table, in both the HTML and the text part.
    note:
      placeholder.count > 0
        ? "Itemised at the top of this email. The email is not sendable until these point to real URLs."
        : null,
    emphasis: placeholder.count > 0 ? "amber" : null,
    raw: true,
  });

  if (emailOnAcidUrl) {
    push("Email on Acid test", { href: emailOnAcidUrl, text: "Open the test results" });
  }

  return rows;
}

// ── HTML rendering ───────────────────────────────────────────────────────────
// Every construct below is chosen for the Word rendering engine (Outlook
// 2007-2019): nested tables with role="presentation", explicit width/bgcolor
// ATTRIBUTES alongside inline styles, no flexbox, no grid, no border-radius, no
// CSS shorthand Outlook drops, no external stylesheet, no <style> dependency for
// anything load-bearing. The single <style> block carries ONLY progressive
// enhancement (dark-mode hints and a mobile stack) that the email is correct
// without.

const cellPad = "16px 24px";

function row(label, value, note, opts = {}) {
  const emphasis = opts.emphasis;
  const labelColor = TOKENS.FAINT;
  const valueColor = emphasis === "amber" ? TOKENS.AMBER : TOKENS.INK;
  const valueHtml =
    value && typeof value === "object" && value.href
      ? `<a href="${safeHref(value.href)}" style="color:${TOKENS.LIME};text-decoration:underline;">${esc(value.text || value.href)}</a>`
      : opts.raw
        ? String(value)
        : esc(value);

  return `
              <tr>
                <td align="left" valign="top" style="padding:12px 0 0 0;border-top:1px solid ${TOKENS.LINE};font-family:${FONT_MONO};font-size:12px;line-height:18px;color:${labelColor};text-transform:uppercase;letter-spacing:0.08em;" width="42%">${esc(label)}</td>
                <td align="right" valign="top" style="padding:12px 0 0 0;border-top:1px solid ${TOKENS.LINE};font-family:${FONT_MONO};font-size:13px;line-height:18px;color:${valueColor};font-weight:${emphasis ? "700" : "400"};">${valueHtml}</td>
              </tr>${
                note
                  ? `
              <tr>
                <td colspan="2" align="left" valign="top" style="padding:4px 0 12px 0;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${TOKENS.MUT2};">${note}</td>
              </tr>`
                  : `
              <tr><td colspan="2" style="font-size:0;line-height:0;height:12px;">&nbsp;</td></tr>`
              }`;
}

/** A lime block-level CTA that survives Outlook (table cell, not a styled <a>). */
function button(href, text, { primary = true } = {}) {
  const bg = primary ? TOKENS.LIME : "transparent";
  const fg = primary ? TOKENS.INK_ON_LIME : TOKENS.MUT;
  const border = primary ? TOKENS.LIME : TOKENS.LINE;
  return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><tr>
                    <td align="center" valign="middle" bgcolor="${bg}" height="44" style="height:44px;background-color:${bg};border:1px solid ${border};font-family:${FONT_BODY};font-size:14px;font-weight:700;padding:0 22px;">
                      <a href="${safeHref(href)}" target="_blank" style="color:${fg};text-decoration:none;display:block;line-height:44px;">${esc(text)}</a>
                    </td>
                  </tr></table>`;
}

/**
 * Render the confirmation email as HTML.
 * `previewSrc` is normally "cid:<PREVIEW_CID>" so the preview renders INLINE and
 * survives a client that blocks remote images; a caller with no preview bytes
 * may pass an absolute URL instead, which is still inline in the body (it is
 * never an attachment either way).
 */
export function renderConfirmationHtml(view) {
  const {
    orderId,
    summary,
    rows,
    placeholder,
    dropboxFolderUrl,
    dropboxHtmlUrl,
    previewSrc,
    previewNote,
    outlookCaveat,
    mobileStatus,
    fromAddress,
  } = view;

  const accent = summary.tone === "amber" ? TOKENS.AMBER : TOKENS.LIME;

  const placeholderList =
    placeholder.count > 0
      ? placeholder.items
          .slice(0, 25)
          .map(
            (i) =>
              `<tr><td align="left" valign="top" style="padding:3px 0;font-family:${FONT_MONO};font-size:12px;line-height:17px;color:${TOKENS.MUT};">${esc(
                i.id ? `#${i.ordinal}  id="${i.id}"` : `#${i.ordinal}  ${i.text || "(no link text)"}`,
              )}</td></tr>`,
          )
          .join("\n")
      : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="dark light" />
<meta name="supported-color-schemes" content="dark light" />
<title>${esc(orderId)} &mdash; your email is built</title>
<!--[if mso]>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml>
<![endif]-->
<style type="text/css">
  /* PROGRESSIVE ENHANCEMENT ONLY. The email is correct with this block stripped:
     the base design is already dark with explicit hex on every element, so a
     dark client needs no inversion and a light client shows the brand's dark
     card intentionally. These rules only stop Gmail/iOS from "helpfully"
     re-colouring text, and stack the two-column rows on a narrow screen. */
  :root { color-scheme: dark light; supported-color-schemes: dark light; }
  a { color: ${TOKENS.LIME}; }
  @media (prefers-color-scheme: dark) {
    .mv-ink   { color: ${TOKENS.INK} !important; }
    .mv-mut   { color: ${TOKENS.MUT} !important; }
    .mv-card  { background-color: ${TOKENS.CARD} !important; }
    .mv-page  { background-color: ${TOKENS.BG} !important; }
  }
  @media only screen and (max-width: 520px) {
    .mv-wrap { width: 100% !important; }
    .mv-pad  { padding-left: 18px !important; padding-right: 18px !important; }
    .mv-stack { display: block !important; width: 100% !important; text-align: left !important; padding-left: 0 !important; }
  }
</style>
</head>
<body class="mv-page" bgcolor="${TOKENS.BG}" style="margin:0;padding:0;background-color:${TOKENS.BG};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;font-size:1px;color:${TOKENS.BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Order ${esc(orderId)} is built. ${placeholder.count > 0 ? `${placeholder.count} placeholder link${placeholder.count === 1 ? "" : "s"} to replace before sending.` : "No placeholder links to replace."}</div>
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${TOKENS.BG}" style="background-color:${TOKENS.BG};border-collapse:collapse;">
  <tr>
    <td align="center" valign="top" style="padding:32px 12px;">

      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" class="mv-wrap" style="width:600px;max-width:600px;border-collapse:collapse;">

        <!-- ── brand lockup ────────────────────────────────────────────── -->
        <tr>
          <td align="left" valign="middle" style="padding:0 0 18px 0;font-family:${FONT_DISP};font-size:19px;font-weight:700;letter-spacing:-0.01em;color:${TOKENS.INK};">
            <span style="color:${TOKENS.LIME};">&#9670;</span>&nbsp;Maveloper
            <span style="font-family:${FONT_MONO};font-size:11px;font-weight:400;color:${TOKENS.FAINT};letter-spacing:0.14em;text-transform:uppercase;">&nbsp;&nbsp;Born at Mavlers</span>
          </td>
        </tr>

        <!-- ── the card ────────────────────────────────────────────────── -->
        <tr>
          <td class="mv-card" bgcolor="${TOKENS.CARD}" valign="top" style="background-color:${TOKENS.CARD};border:1px solid ${TOKENS.LINE};">

            <!-- headline block -->
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
              <tr>
                <td class="mv-pad" align="left" valign="top" style="padding:${cellPad};border-bottom:1px solid ${TOKENS.LINE};">
                  <div style="font-family:${FONT_MONO};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${accent};padding-bottom:10px;">// order confirmed</div>
                  <div class="mv-ink" style="font-family:${FONT_DISP};font-size:26px;line-height:32px;font-weight:700;color:${TOKENS.INK};padding-bottom:8px;">Your email is built.</div>
                  <div style="font-family:${FONT_MONO};font-size:15px;line-height:22px;color:${TOKENS.LIME};">${esc(orderId)}</div>
                </td>
              </tr>

              <!-- ★ AUTOMATED / DO-NOT-REPLY, stated explicitly and early -->
              <tr>
                <td class="mv-pad" align="left" valign="top" style="padding:12px 24px;border-bottom:1px solid ${TOKENS.LINE};font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${TOKENS.FAINT};">
                  This is an automated confirmation from Maveloper. <strong style="color:${TOKENS.MUT2};">Please do not reply to this message</strong> &mdash; replies to ${esc(fromAddress)} are not monitored for order questions.
                </td>
              </tr>

              ${
                placeholder.count > 0
                  ? `
              <!-- ★★ THE PLACEHOLDER GATE. Above the fold, amber, unmissable. -->
              <tr>
                <td class="mv-pad" align="left" valign="top" bgcolor="#1d1708" style="padding:${cellPad};background-color:#1d1708;border-bottom:1px solid ${TOKENS.LINE};border-left:3px solid ${TOKENS.AMBER};">
                  <div style="font-family:${FONT_DISP};font-size:20px;line-height:26px;font-weight:700;color:${TOKENS.AMBER};padding-bottom:6px;">${placeholder.count} placeholder link${placeholder.count === 1 ? "" : "s"} to replace</div>
                  <div style="font-family:${FONT_BODY};font-size:14px;line-height:21px;color:${TOKENS.MUT};">
                    <strong>This email is not sendable yet.</strong> ${placeholder.count === 1 ? "One link" : `${placeholder.count} links`} in the build still point to <code style="font-family:${FONT_MONO};color:${TOKENS.AMBER};">#</code> instead of a real URL. Replace ${placeholder.count === 1 ? "it" : "them"} in your ESP before you send.
                  </div>
                  ${
                    placeholderList
                      ? `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-top:12px;">
                    <tr><td style="font-family:${FONT_MONO};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${TOKENS.FAINT};padding-bottom:6px;">Which links${placeholder.identifiedBy === "id-attribute" ? " (by id)" : placeholder.identifiedBy === "link-text" ? " (by link text)" : ""}</td></tr>
                    ${placeholderList}
                    ${placeholder.count > 25 ? `<tr><td style="font-family:${FONT_MONO};font-size:11px;color:${TOKENS.FAINT};padding-top:6px;">&hellip;and ${placeholder.count - 25} more. All of them are in the HTML file.</td></tr>` : ""}
                  </table>`
                      : ""
                  }
                </td>
              </tr>`
                  : ""
              }

              <!-- ★ THE LEAD-READABLE PROVENANCE TRANSLATION -->
              <tr>
                <td class="mv-pad" align="left" valign="top" style="padding:${cellPad};border-bottom:1px solid ${TOKENS.LINE};${summary.fellBack ? `border-left:3px solid ${TOKENS.AMBER};` : ""}">
                  <div style="font-family:${FONT_MONO};font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:${TOKENS.FAINT};padding-bottom:8px;">// how it was built</div>
                  <div style="font-family:${FONT_DISP};font-size:17px;line-height:25px;font-weight:700;color:${summary.fellBack ? TOKENS.AMBER : TOKENS.INK};padding-bottom:10px;">${summary.headline}</div>
                  ${summary.paragraphs
                    .map(
                      (p) =>
                        `<div class="mv-mut" style="font-family:${FONT_BODY};font-size:14px;line-height:21px;color:${TOKENS.MUT};padding-bottom:10px;">${p}</div>`,
                    )
                    .join("\n                  ")}
                </td>
              </tr>

              <!-- ── the two links: folder AND the direct HTML file ──────── -->
              <tr>
                <td class="mv-pad" align="left" valign="top" style="padding:${cellPad};border-bottom:1px solid ${TOKENS.LINE};">
                  <div style="font-family:${FONT_MONO};font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:${TOKENS.FAINT};padding-bottom:12px;">// your files</div>
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                    <tr>
                      <td valign="middle" style="padding:0 10px 10px 0;" class="mv-stack">${dropboxFolderUrl ? button(dropboxFolderUrl, "Open the Dropbox folder") : ""}</td>
                      <td valign="middle" style="padding:0 0 10px 0;" class="mv-stack">${dropboxHtmlUrl ? button(dropboxHtmlUrl, "Open the HTML file", { primary: false }) : ""}</td>
                    </tr>
                  </table>
                  <div style="font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${TOKENS.MUT2};padding-top:2px;">
                    The folder holds the HTML, every image, delivery notes and the build certificate. The second link opens the HTML file on its own.
                  </div>
                </td>
              </tr>

              ${
                previewSrc
                  ? `
              <!-- ── ★ preview.png, INLINE in the body (never an attachment) ── -->
              <tr>
                <td align="center" valign="top" style="padding:0;border-bottom:1px solid ${TOKENS.LINE};">
                  <img src="${safeHref(previewSrc) || esc(previewSrc)}" width="598" alt="Full-length preview of the built email for order ${esc(orderId)}" border="0" style="display:block;width:100%;max-width:598px;height:auto;border:0;outline:none;text-decoration:none;" />
                </td>
              </tr>
              ${
                previewNote
                  ? `<tr><td class="mv-pad" align="left" valign="top" style="padding:10px 24px;border-bottom:1px solid ${TOKENS.LINE};font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${TOKENS.MUT2};">${previewNote}</td></tr>`
                  : ""
              }`
                  : ""
              }

              <!-- ── the numbers ────────────────────────────────────────── -->
              <tr>
                <td class="mv-pad" align="left" valign="top" style="padding:${cellPad};">
                  <div style="font-family:${FONT_MONO};font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:${TOKENS.FAINT};padding-bottom:14px;">// the build, in detail</div>
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                    ${rows.map((r) => row(r.label, r.value, r.note, { emphasis: r.emphasis, raw: r.raw })).join("")}
                  </table>
                </td>
              </tr>

              <!-- ── the caveats a lead must be told ───────────────────── -->
              <tr>
                <td class="mv-pad" align="left" valign="top" style="padding:${cellPad};border-top:1px solid ${TOKENS.LINE};">
                  <div style="font-family:${FONT_MONO};font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:${TOKENS.FAINT};padding-bottom:10px;">// before you send</div>
                  <div class="mv-mut" style="font-family:${FONT_BODY};font-size:13px;line-height:20px;color:${TOKENS.MUT};padding-bottom:10px;"><strong style="color:${TOKENS.INK};">Outlook on Windows.</strong> ${outlookCaveat}</div>
                  <div class="mv-mut" style="font-family:${FONT_BODY};font-size:13px;line-height:20px;color:${TOKENS.MUT};"><strong style="color:${TOKENS.INK};">On mobile.</strong> ${mobileStatus}</div>
                </td>
              </tr>

            </table>
          </td>
        </tr>

        <!-- ── footer ─────────────────────────────────────────────────── -->
        <tr>
          <td align="center" valign="top" style="padding:20px 12px 0 12px;font-family:${FONT_MONO};font-size:11px;line-height:17px;color:${TOKENS.FAINT};letter-spacing:0.06em;">
            Maveloper &middot; Born at Mavlers<br />
            <span style="color:#6f6f78;">Automated order confirmation &middot; do not reply</span>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;
}

/**
 * Plain-text alternative. Not decoration: a text/plain part is what keeps this
 * out of a spam classifier's "HTML-only" bucket, and it is the copy that a
 * screen reader and a text-mode client actually get. The placeholder gate leads
 * here too.
 */
export function renderConfirmationText(view) {
  const { orderId, summary, rows, placeholder, dropboxFolderUrl, dropboxHtmlUrl, outlookCaveat, mobileStatus, fromAddress } = view;
  const strip = (s) =>
    String(s)
      .replace(/<[^>]*>/g, "")
      .replace(/&mdash;/g, "—")
      .replace(/&ldquo;|&rdquo;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&hellip;/g, "…")
      .replace(/&times;/g, "×")
      .replace(/&rarr;/g, "→")
      .replace(/&nbsp;/g, " ")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');

  const L = [];
  L.push("MAVELOPER — ORDER CONFIRMED");
  L.push("===========================");
  L.push(`Order ${orderId} — your email is built.`);
  L.push("");
  L.push(`This is an automated confirmation from Maveloper. Please do not reply to`);
  L.push(`this message — replies to ${fromAddress} are not monitored for order questions.`);
  L.push("");
  if (placeholder.count > 0) {
    L.push(`★ ${placeholder.count} PLACEHOLDER LINK${placeholder.count === 1 ? "" : "S"} TO REPLACE — NOT SENDABLE YET`);
    L.push(
      `  ${placeholder.count === 1 ? "One link" : `${placeholder.count} links`} still point to "#" instead of a real URL.`,
    );
    for (const i of placeholder.items.slice(0, 25)) {
      L.push(`  - #${i.ordinal}  ${i.id ? `id="${i.id}"` : i.text || "(no link text)"}`);
    }
    if (placeholder.count > 25) L.push(`  ...and ${placeholder.count - 25} more, all in the HTML file.`);
    L.push("");
  } else {
    L.push("No placeholder links found — every link in the build points somewhere.");
    L.push("");
  }
  L.push("HOW IT WAS BUILT");
  L.push("----------------");
  L.push(strip(summary.headline));
  L.push("");
  for (const p of summary.paragraphs) L.push(strip(p));
  L.push("");
  L.push("YOUR FILES");
  L.push("----------");
  if (dropboxFolderUrl) L.push(`Dropbox folder: ${dropboxFolderUrl}`);
  if (dropboxHtmlUrl) L.push(`HTML file:      ${dropboxHtmlUrl}`);
  L.push("");
  L.push("THE BUILD, IN DETAIL");
  L.push("--------------------");
  for (const r of rows) {
    const v = r.value && typeof r.value === "object" && r.value.href ? r.value.href : strip(r.value);
    L.push(`${r.label}: ${v}`);
    if (r.note) L.push(`  (${strip(r.note)})`);
  }
  L.push("");
  L.push("BEFORE YOU SEND");
  L.push("---------------");
  L.push(`Outlook on Windows: ${strip(outlookCaveat)}`);
  L.push(`On mobile: ${strip(mobileStatus)}`);
  L.push("");
  L.push("Maveloper · Born at Mavlers");
  L.push("Automated order confirmation · do not reply");
  return L.join("\n") + "\n";
}

// ── the caveat copy ──────────────────────────────────────────────────────────
/**
 * The Outlook caveat, in lead language, tightened by what the delivered bytes
 * actually contain. `ledger` is deriveWordFatalLedger(html) from
 * delivery-folder.js — the SAME heuristic the delivery folder already discloses,
 * so the email and delivery-notes.txt cannot contradict each other.
 */
export function buildOutlookCaveat(ledger) {
  const n = Array.isArray(ledger) ? ledger.length : 0;
  if (n === 0) {
    return (
      "We scanned the build and found none of the constructs that break in Outlook's older " +
      "rendering engine. Outlook still renders differently from Gmail and Apple Mail &mdash; " +
      "rounded corners square off, and some spacing shifts &mdash; so a test send is always worth it."
    );
  }
  const names = ledger
    .slice(0, 4)
    .map((i) => esc(i.construct))
    .join(", ");
  return (
    `Outlook 2007-2019 on Windows uses Microsoft Word to draw email, and this build uses ` +
    `${n} construct${n === 1 ? "" : "s"} that Word handles differently (${names}${n > 4 ? ", and others" : ""}). ` +
    `The email will still be readable, but expect spacing and corners to shift. ` +
    `Every one of them is listed in delivery-notes.txt in your Dropbox folder. Test-send before you go live.`
  );
}

/**
 * Mobile status, in lead language. Uses only the certificate paths whose
 * spelling is verified (delivery-folder.js:594-599) and NEVER implies mobile
 * pixel-equality — the Figma design specifies a single width, so there is no
 * mobile reference frame to be equal to. That constraint is stated in shipped
 * code at delivery-folder.js:586-592 and is repeated here in lead language
 * rather than quietly dropped.
 */
export function buildMobileStatus(facts, { isCompiler } = {}) {
  if (!isCompiler) {
    return (
      "The build carries a responsive layout, but we have not measured it automatically on this route. " +
      "Open it on a phone before you send."
    );
  }
  const widths = facts.mobileWidths && facts.mobileWidths.length ? facts.mobileWidths.join("px and ") + "px" : "360px and 375px";
  const parts = [
    `Your design specifies one width, so there is no mobile version of it to compare against &mdash; ` +
      `we cannot prove the phone layout the way we prove the desktop one. What we do instead is check it ` +
      `behaves: no sideways scrolling, no zoomed-out text, no clipped buttons, at ${widths}.`,
  ];
  if (facts.mobileSaneGate) parts.push(`That check came back <strong>${esc(String(facts.mobileSaneGate))}</strong>.`);
  if (facts.mobileTier) parts.push(`Mobile tier on the delivered file: <strong>${esc(String(facts.mobileTier))}</strong>.`);
  return parts.join(" ");
}

// ── the assembled message ────────────────────────────────────────────────────
/**
 * Build the complete message from the REAL row + the REAL provenance.
 * Pure: hand it data, get bytes. Every field it reads is named in
 * ORDER_EMAIL_COMPLETE.md with its source column.
 *
 * @returns {{subject,from,to,bcc,replyTo,html,text,inlineImages,diagnostics}}
 */
export function buildOrderConfirmation(input) {
  const {
    // os_queue (supabase-setup.sql:197-224)
    orderId,
    leadEmail,
    figmaUrl,
    esp,
    darkMode,
    tatHours,
    deadline,
    effectiveDeadline,
    // /approve, at the send site
    deliveredHtml,
    dropboxFolderUrl,
    dropboxHtmlUrl,
    previewUrl,
    hasInlinePreviewBytes = false,
    previewStatus,
    imageCount,
    ledger,
    // maveloper_jobs.delivery_meta
    provenance,
    certificate,
    // derived elsewhere / optional
    generationSeconds,
    emailOnAcidUrl = null,
    fromAddress = "shrujal@mavlers.com",
    bccAddress = "shrujal@mavlers.com",
  } = input;

  const facts = readProvenanceFacts({ provenance, certificate, deliveredHtml, imageCount });
  const placeholder = countPlaceholderLinks(deliveredHtml);
  const summary = buildLeadSummary(facts, { placeholderCount: placeholder.count });

  const bufferedDeadlineIST = fmtIST(effectiveDeadline);
  const rawDeadlineIST = fmtIST(deadline);

  // Generation time in SECONDS, as the spec asks. Prefer the provenance record's
  // own number; fall back to the caller's measurement (started_at→finished_at).
  // `> 0` matters: a refused compile records secondsElapsed 0, and preferring
  // that over the real os_queue span would report a 150-second order as instant.
  const secs =
    facts.seconds && isNum(facts.seconds.value) && facts.seconds.value > 0
      ? facts.seconds.value
      : generationSeconds;

  const rows = buildFactRows({
    orderId,
    figmaUrl,
    tatHours,
    bufferedDeadlineIST,
    rawDeadlineIST,
    esp,
    darkMode,
    engineLabel: summary.engineLabel,
    generationSeconds: fmtSeconds(secs),
    facts,
    placeholder,
    emailOnAcidUrl,
  });

  // ★ INLINE, NOT ATTACHED. A cid: reference renders in the body even when the
  //   client blocks remote images, so it is the strongest form of "inline". When
  //   we could not get the bytes we fall back to the absolute Dropbox URL, which
  //   is still inline in the body and still not an attachment — and we say so,
  //   rather than letting a broken image box stand in for a preview.
  const previewSrc = hasInlinePreviewBytes ? `cid:${PREVIEW_CID}` : previewUrl || null;
  const previewNote = !previewSrc
    ? null
    : hasInlinePreviewBytes
      ? null
      : "The preview above loads from Dropbox. If your client blocks images, open the folder link to see it.";

  const view = {
    orderId,
    summary,
    rows,
    placeholder,
    dropboxFolderUrl,
    dropboxHtmlUrl,
    previewSrc,
    previewNote,
    outlookCaveat: buildOutlookCaveat(ledger),
    mobileStatus: buildMobileStatus(facts, { isCompiler: summary.isCompiler && !summary.fellBack }),
    fromAddress,
  };

  // ★ THE PLACEHOLDER COUNT IS IN THE SUBJECT — the one line a lead reads before
  //   deciding whether to open anything. This is placement 1 of 3.
  const subject =
    placeholder.count > 0
      ? `${orderId} is built — ${placeholder.count} link${placeholder.count === 1 ? "" : "s"} to replace before sending`
      : `${orderId} is built — ready to send`;

  return {
    subject,
    from: fromAddress,
    to: leadEmail,
    bcc: bccAddress, // ★ BCC shrujal@mavlers.com, per spec
    replyTo: null, // no-reply is stated in the body; no reply-to is set
    html: renderConfirmationHtml(view),
    text: renderConfirmationText(view),
    // For the STUB's browser copy only: a cid: src cannot resolve in a browser,
    // so the stub rewrites it to this absolute URL. The .eml keeps its cid.
    previewUrlForBrowser: previewUrl || null,
    inlineImages: hasInlinePreviewBytes ? [{ cid: PREVIEW_CID, filename: "preview.png", contentType: "image/png" }] : [],
    diagnostics: {
      engine: facts.engine,
      fellBack: summary.fellBack,
      fallbackGuard: facts.fallback ? facts.fallback.guard : null,
      placeholderCount: placeholder.count,
      placeholderIdentifiedBy: placeholder.identifiedBy,
      hasProvenanceRecord: facts.hasProvenanceRecord,
      hasCertificate: facts.hasCertificate,
      previewMode: hasInlinePreviewBytes ? "inline-cid" : previewUrl ? "inline-remote-url" : "absent",
      previewStatus: previewStatus || null,
      emailOnAcid: emailOnAcidUrl ? "present" : "no-field-exists",
      // Which numbers we actually READ, and from where. This is what makes the
      // email auditable: a reader can tell a measurement from a derivation.
      sources: {
        exitCode: facts.exitCode ? facts.exitCode.source : null,
        coverage: facts.coverage ? facts.coverage.source : facts.liveTextDerived ? "DERIVED: " + facts.liveTextDerived.source : null,
        sliceRatio: facts.sliceRatio ? facts.sliceRatio.source : facts.slicedImages ? "DERIVED: " + facts.slicedImages.source : null,
        accuracy: facts.accuracy ? facts.accuracy.source : facts.accuracyDerived ? "DERIVED: " + facts.accuracyDerived.source : null,
        divergences: facts.divergences ? facts.divergences.source : null,
        seconds: facts.seconds ? facts.seconds.source : generationSeconds != null ? "caller: started_at → finished_at" : null,
      },
    },
  };
}

// ── RFC822 assembly (so the STUB proof is a real, openable email) ────────────
/** Fold a header value so no line exceeds the 998-octet RFC limit. */
function foldHeader(name, value) {
  const v = String(value).replace(/[\r\n]+/g, " ");
  return `${name}: ${v}`;
}

/** RFC2047 encode a header value when it is not pure ASCII (e.g. an em dash). */
function encodeHeaderValue(v) {
  const s = String(v);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

/** Break a base64 string into 76-char lines, as MIME requires. */
function b64lines(buf) {
  const b = Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(buf).toString("base64");
  return (b.match(/.{1,76}/g) || []).join("\r\n");
}

/**
 * Assemble a full RFC822 message.
 *
 * Structure — this is what makes the preview INLINE rather than an attachment:
 *   multipart/related               ← ties the image to the HTML that references it
 *     multipart/alternative
 *       text/plain
 *       text/html                   ← <img src="cid:maveloper-preview">
 *     image/png; Content-Disposition: INLINE; Content-ID: <maveloper-preview>
 *
 * With no preview bytes it degrades to a plain multipart/alternative.
 *
 * `date` and `messageId` are INJECTED, never generated here, so a test can
 * produce byte-identical output twice. A renderer that quietly reads the clock
 * cannot be regression-tested.
 */
export function buildRfc822(message, { date, messageId, previewBytes } = {}) {
  const hasImg = !!(previewBytes && previewBytes.length && message.inlineImages && message.inlineImages.length);
  const bAlt = "----=_mav_alt_b1a2c3d4";
  const bRel = "----=_mav_rel_e5f6a7b8";

  const H = [];
  H.push(foldHeader("From", `Maveloper <${message.from}>`));
  H.push(foldHeader("To", message.to));
  if (message.bcc) H.push(foldHeader("Bcc", message.bcc));
  H.push(foldHeader("Subject", encodeHeaderValue(message.subject)));
  H.push(foldHeader("Date", date || "Mon, 27 Jul 2026 12:00:00 +0530"));
  H.push(foldHeader("Message-ID", messageId || "<order-confirmation@maveloper.local>"));
  H.push(foldHeader("MIME-Version", "1.0"));
  // An automated notice is stated in the BODY per spec; these headers say the
  // same thing to machines, which is what keeps a vacation responder and a
  // mailing-list detector from treating a confirmation as conversation.
  H.push(foldHeader("Auto-Submitted", "auto-generated"));
  H.push(foldHeader("X-Auto-Response-Suppress", "All"));
  H.push(foldHeader("X-Maveloper-Order", message.subject.split(" ")[0]));

  const alt =
    `Content-Type: multipart/alternative; boundary="${bAlt}"\r\n` +
    `\r\n` +
    `--${bAlt}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${b64lines(Buffer.from(message.text, "utf-8"))}\r\n` +
    `--${bAlt}\r\n` +
    `Content-Type: text/html; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${b64lines(Buffer.from(message.html, "utf-8"))}\r\n` +
    `--${bAlt}--\r\n`;

  if (!hasImg) {
    return H.join("\r\n") + "\r\n" + alt;
  }

  const img = message.inlineImages[0];
  const body =
    `Content-Type: multipart/related; type="multipart/alternative"; boundary="${bRel}"\r\n` +
    `\r\n` +
    `--${bRel}\r\n` +
    alt +
    `--${bRel}\r\n` +
    `Content-Type: ${img.contentType}; name="${img.filename}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-ID: <${img.cid}>\r\n` +
    `Content-Disposition: inline; filename="${img.filename}"\r\n\r\n` +
    `${b64lines(previewBytes)}\r\n` +
    `--${bRel}--\r\n`;

  return H.join("\r\n") + "\r\n" + body;
}

export default {
  TOKENS,
  PREVIEW_CID,
  esc,
  safeHref,
  countPlaceholderLinks,
  readProvenanceFacts,
  fmtIST,
  fmtSeconds,
  buildLeadSummary,
  buildFactRows,
  renderConfirmationHtml,
  renderConfirmationText,
  buildOutlookCaveat,
  buildMobileStatus,
  buildOrderConfirmation,
  buildRfc822,
};
