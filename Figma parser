// =====================================================================
// MAVELOPER FIGMA PARSER — v6.0.0
// Converts a Figma frame node into the v5.5.0 designSpec JSON format.
// Bypasses Stage 1 vision entirely. Stage 2 + post-processors unchanged.
//
// INPUT:  Figma share URL + Figma API token
// OUTPUT: designSpec object (same shape as Stage 1's output) — fed into
//         the existing STAGE2_PROMPT pipeline.
//
// DESIGN PHILOSOPHY:
// - Typography is exact (Figma gives fontSize, lineHeightPx, weight verbatim)
// - Colors are exact (Figma gives RGB triplets verbatim)
// - Layout is detected: auto-layout fast-path OR absolute-positioning path
// - Image refs are recorded; actual export is Phase B
// =====================================================================

const FIGMA_API_BASE = "https://api.figma.com/v1";
const FIGMA_API_TIMEOUT_MS = 30 * 1000;
const VALID_EMAIL_WIDTHS = [600, 640, 650, 680, 700];
const EMAIL_WIDTH_TOLERANCE = 5; // px — allows 595 / 605 / 645 / etc.

// Figma node types we care about (subset of the full Figma type system)
const TEXT_TYPES = new Set(["TEXT"]);
const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "INSTANCE", "SECTION"]);
const RECT_TYPES = new Set(["RECTANGLE", "ELLIPSE", "VECTOR", "STAR", "POLYGON", "REGULAR_POLYGON", "BOOLEAN_OPERATION"]);

// =====================================================================
// 1. URL PARSING — extract file_key + node_id from any Figma share URL
// =====================================================================

/**
 * Parse a Figma share URL into { fileKey, nodeId } or throw on malformed input.
 *
 * Supported URL forms:
 *   https://www.figma.com/design/{key}/{slug}?node-id=1-13&...
 *   https://www.figma.com/file/{key}/{slug}?node-id=1-13&...
 *   https://www.figma.com/design/{key}?node-id=1-13
 *   https://figma.com/design/{key}/...?node-id=1:13
 *
 * Node IDs in URLs use hyphens ("1-13") and must be converted to colons
 * ("1:13") for the REST API.
 */
export function parseFigmaUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("Figma URL is empty or not a string.");
  }

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Figma URL is not a valid URL.");
  }

  if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
    throw new Error(`Expected a figma.com URL, got "${url.hostname}".`);
  }

  // Path forms: /design/{key}/{slug}, /file/{key}/{slug}, /design/{key}, /file/{key}
  const segments = url.pathname.split("/").filter(Boolean);
  const typeIdx = segments.findIndex((s) => s === "design" || s === "file" || s === "proto");
  if (typeIdx === -1 || typeIdx + 1 >= segments.length) {
    throw new Error("Figma URL is missing the file key segment (expected /design/{key}/... or /file/{key}/...).");
  }
  const fileKey = segments[typeIdx + 1];
  if (!/^[A-Za-z0-9]{10,}$/.test(fileKey)) {
    throw new Error(`Figma file key "${fileKey}" looks malformed.`);
  }

  const rawNodeId = url.searchParams.get("node-id");
  if (!rawNodeId) {
    throw new Error("Figma URL is missing the ?node-id parameter. Right-click the email frame in Figma → Copy link to selection.");
  }

  // URL form uses hyphen: "1-13"; API uses colon: "1:13"
  const nodeId = rawNodeId.replace(/-/g, ":");
  if (!/^\d+:\d+$/.test(nodeId)) {
    throw new Error(`Figma node-id "${rawNodeId}" is malformed (expected format like 1-13).`);
  }

  return { fileKey, nodeId };
}

// =====================================================================
// 2. FIGMA API CLIENT — fetches node tree with timeout + clear errors
// =====================================================================

/**
 * Fetch a single node's tree from Figma's REST API.
 * Returns the raw API response object (with .nodes[nodeId].document at root).
 *
 * Errors:
 * - 401/403 → invalid or scope-limited token
 * - 404 → file or node does not exist or token has no access
 * - 429 → rate limited (caller decides whether to retry)
 */
export async function fetchFigmaNode({ fileKey, nodeId, token, fetchImpl = fetch }) {
  if (!token) throw new Error("FIGMA_API_TOKEN is not set on the backend.");

  const url = `${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIGMA_API_TIMEOUT_MS);

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { "X-Figma-Token": token },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Figma API request timed out after 30 seconds.");
    }
    throw new Error(`Figma API request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Figma API rejected the token (401/403). Check FIGMA_API_TOKEN env var has File content read scope.");
  }
  if (response.status === 404) {
    throw new Error("Figma file or node not found (404). Check the URL and that the token has access to the file.");
  }
  if (response.status === 429) {
    throw new Error("Figma API rate-limited (429). Wait a minute and retry.");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Figma API returned ${response.status}: ${body.substring(0, 300)}`);
  }

  const json = await response.json();
  const nodeWrap = json?.nodes?.[nodeId];
  if (!nodeWrap || !nodeWrap.document) {
    throw new Error(`Figma API returned no document for node ${nodeId}. The node may not exist in this file.`);
  }
  return {
    document: nodeWrap.document,
    components: nodeWrap.components || {},
    styles: nodeWrap.styles || {},
    fileName: json.name,
  };
}

// =====================================================================
// 3. FRAME VALIDATION — confirm the node is a usable email frame
// =====================================================================

/**
 * Walk into a node looking for the actual email content frame.
 *
 * Mavlers' Figma convention varies across projects:
 *  - Direct FRAME at email size (Kenect)
 *  - CANVAS containing one or more email FRAMEs (Member-Travel)
 *  - CANVAS containing a SECTION containing the email FRAME (Loudoun, Super-Nova)
 *  - SECTION containing the email FRAME directly (Arsenal Pulse)
 *
 * Strategy: collect all email-shaped FRAMEs descending through CANVAS and
 * SECTION containers. If exactly one is found, use it. If multiple, list
 * them so the user can specify. If none, give a clear directive.
 *
 * Note: we DO NOT descend into FRAMEs themselves — once we hit a frame,
 * we evaluate it as a candidate (avoids false-positives on inner frames
 * like buttons or cards that happen to be ~600px wide).
 */
export function locateEmailFrame(rootNode) {
  if (!rootNode) throw new Error("Figma node is empty.");

  // CASE 1: Direct FRAME or COMPONENT at email size
  if ((rootNode.type === "FRAME" || rootNode.type === "COMPONENT") && isEmailWidth(getNodeWidth(rootNode))) {
    if (getNodeHeight(rootNode) < 300) {
      throw new Error(
        `Figma frame "${rootNode.name}" is ${Math.round(getNodeHeight(rootNode))}px tall — too short to be an email design (must be ≥ 300px). Right-click the actual email frame in Figma → Copy link to selection.`
      );
    }
    return rootNode;
  }

  // CASE 2: CANVAS or SECTION — recursively find email-shaped FRAMEs
  if (rootNode.type === "CANVAS" || rootNode.type === "SECTION") {
    const candidates = collectEmailFrames(rootNode);

    if (candidates.length === 0) {
      throw new Error(
        `The pasted Figma URL points to a ${rootNode.type.toLowerCase()} that contains no email-shaped frames (600/640/650/680/700px wide, ≥ 300px tall). In Figma, right-click the email design frame → Copy link to selection, and paste that URL.`
      );
    }
    if (candidates.length > 1) {
      const list = candidates
        .map((c) => `"${c.name}" (${Math.round(getNodeWidth(c))}×${Math.round(getNodeHeight(c))})`)
        .join(", ");
      const err = new Error(
        `The pasted Figma URL contains ${candidates.length} email frames: ${list}. Right-click the SPECIFIC email frame you want in Figma → Copy link to selection.`
      );
      // Attach structured data so the UI can offer a picker (Phase B)
      err.code = "MULTIPLE_EMAIL_FRAMES";
      err.candidates = candidates.map((c) => ({
        nodeId: c.id,
        name: c.name,
        width: Math.round(getNodeWidth(c)),
        height: Math.round(getNodeHeight(c)),
      }));
      throw err;
    }
    return candidates[0];
  }

  // CASE 3: User pasted a non-frame node (TEXT, GROUP, RECTANGLE, etc.)
  throw new Error(
    `The pasted Figma URL points to a ${rootNode.type} ("${rootNode.name}"), not an email design frame. ` +
    `In Figma, click the FRAME that contains your full email design (the tall 600/640/650/680/700px frame), ` +
    `then right-click → Copy link to selection.`
  );
}

/**
 * Recursively collect all email-shaped FRAMEs descending through CANVAS
 * and SECTION nodes. Stops descending once an email-shaped FRAME is found
 * (does not look inside it for nested email frames — those would be cards
 * or buttons).
 */
function collectEmailFrames(node, out = []) {
  if (!node) return out;
  // Skip invisible
  if (node.visible === false) return out;

  if (node.type === "FRAME" || node.type === "COMPONENT") {
    if (isEmailWidth(getNodeWidth(node)) && getNodeHeight(node) >= 300) {
      out.push(node);
      return out; // don't descend further into a confirmed email frame
    }
    // Frame too small / wrong width — could be a header annotation, skip
    return out;
  }

  // Containers we walk through: CANVAS, SECTION, GROUP
  if (node.type === "CANVAS" || node.type === "SECTION" || node.type === "GROUP") {
    for (const child of node.children || []) {
      collectEmailFrames(child, out);
    }
  }
  return out;
}

function getNodeWidth(node) {
  return node?.absoluteBoundingBox?.width ?? 0;
}

function getNodeHeight(node) {
  return node?.absoluteBoundingBox?.height ?? 0;
}

function isEmailWidth(width) {
  return VALID_EMAIL_WIDTHS.some((w) => Math.abs(width - w) <= EMAIL_WIDTH_TOLERANCE);
}

// =====================================================================
// 4. CONTENT ROOT — find the deepest single-child wrapper
// =====================================================================

/**
 * Real-world Figma email frames often nest the actual content one or
 * two FRAMEs deep (e.g., outer "Design" 600x6115 → inner "Frame 626154"
 * 600x5706 with 7 sections). Walk through single-child wrappers until
 * we hit a node whose children are the actual email rows.
 */
export function findContentRoot(emailFrame) {
  let cursor = emailFrame;
  // Limit walk depth to avoid pathological loops
  for (let depth = 0; depth < 5; depth++) {
    const children = cursor.children || [];
    if (children.length !== 1) break;
    const sole = children[0];
    if (!CONTAINER_TYPES.has(sole.type)) break;
    cursor = sole;
  }
  return cursor;
}

// =====================================================================
// 5. SECTION DETECTION — group top-level children into email rows
// =====================================================================

/**
 * Sort the content root's top-level children by absolute Y. Each becomes
 * one section in the designSpec — UNLESS a child is itself an auto-layout
 * VERTICAL frame, in which case we flatten its children up to this level.
 *
 * Why: real Mavlers Figma files often nest 3-5 logical email rows inside
 * a single auto-layout vertical container (e.g., the Kenect newsletter's
 * "Frame 626161" 600×3748 holds Customer Success + multiple body rows +
 * the actual footer). Treating that as one section produces a 60-element
 * blob that Stage 2 can't lay out correctly.
 *
 * We flatten ONE level down for any tall (>= 400px) vertical auto-layout
 * frame, recursively. Decorative vertical layouts (small icon stacks,
 * button rows) are not expanded.
 */
export function detectSections(contentRoot) {
  const expanded = expandVerticalAutoLayout(contentRoot.children || []);
  // Sort by absolute Y, then absolute X for tie-breaking
  expanded.sort((a, b) => {
    const ay = a.absoluteBoundingBox?.y ?? 0;
    const by = b.absoluteBoundingBox?.y ?? 0;
    if (Math.abs(ay - by) > 0.5) return ay - by;
    const ax = a.absoluteBoundingBox?.x ?? 0;
    const bx = b.absoluteBoundingBox?.x ?? 0;
    return ax - bx;
  });
  return expanded.filter(isVisibleNode);
}

/**
 * Walk a list of candidate sections; if any is a tall vertical auto-layout
 * frame, replace it with its children. Iterates until stable.
 */
function expandVerticalAutoLayout(nodes) {
  const out = [];
  for (const n of nodes) {
    if (
      n.type === "FRAME" &&
      n.layoutMode === "VERTICAL" &&
      getNodeHeight(n) >= 400 &&
      Array.isArray(n.children) &&
      n.children.length >= 2
    ) {
      // Flatten one level. Its children may themselves be vertical
      // auto-layout containers — recurse to keep flattening.
      const sub = expandVerticalAutoLayout(n.children);
      for (const c of sub) out.push(c);
    } else {
      out.push(n);
    }
  }
  return out;
}

function isVisibleNode(node) {
  if (node.visible === false) return false;
  const w = getNodeWidth(node);
  const h = getNodeHeight(node);
  if (w <= 0 || h <= 0) return false;
  return true;
}

// =====================================================================
// 6. COLOR + STYLE EXTRACTION
// =====================================================================

/**
 * Convert Figma's RGBA color object {r,g,b,a} (each 0..1) into "#RRGGBB".
 * Alpha is dropped — email HTML doesn't reliably support rgba colors.
 */
function figmaColorToHex(color) {
  if (!color) return null;
  const r = Math.round((color.r ?? 0) * 255);
  const g = Math.round((color.g ?? 0) * 255);
  const b = Math.round((color.b ?? 0) * 255);
  const hex = [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
  return `#${hex.toUpperCase()}`;
}

/**
 * Extract the dominant solid background fill from a node. Returns hex or null.
 * Skips IMAGE / GRADIENT fills — those are handled separately as image elements.
 */
function extractBgHex(node) {
  const fills = node.fills;
  if (!Array.isArray(fills)) return null;
  for (const fill of fills) {
    if (fill.visible === false) continue;
    if (fill.type === "SOLID") {
      return figmaColorToHex(fill.color);
    }
  }
  return null;
}

/**
 * Returns the first IMAGE fill (if any) on a node, plus the imageRef.
 * imageRef is what Figma's /v1/images endpoint takes to export the asset.
 */
function extractImageFill(node) {
  const fills = node.fills;
  if (!Array.isArray(fills)) return null;
  for (const fill of fills) {
    if (fill.visible === false) continue;
    if (fill.type === "IMAGE") {
      return {
        imageRef: fill.imageRef,
        scaleMode: fill.scaleMode,
      };
    }
  }
  return null;
}

/**
 * Extract solid text color from a TEXT node's fills array.
 */
function extractTextColor(node) {
  return extractBgHex(node) || "#000000";
}

/**
 * Map Figma's textAlignHorizontal → spec's "align" field.
 * LEFT / CENTER / RIGHT / JUSTIFIED → left / center / right / left
 */
function mapTextAlign(figmaAlign) {
  switch (figmaAlign) {
    case "CENTER": return "center";
    case "RIGHT": return "right";
    case "LEFT":
    case "JUSTIFIED":
    default: return "left";
  }
}

/**
 * Map Figma's textCase → spec's "transform" field.
 */
function mapTextTransform(figmaCase) {
  switch (figmaCase) {
    case "UPPER": return "uppercase";
    case "LOWER": return "lowercase";
    case "TITLE": return "capitalize";
    default: return undefined;
  }
}

/**
 * Read padding from a Figma frame. Auto-layout frames have explicit
 * paddingTop/Right/Bottom/Left. Non-auto-layout frames have no padding
 * concept — we return 0s in that case (caller may compute from coordinates).
 */
function extractPadding(node) {
  const t = node.paddingTop ?? 0;
  const r = node.paddingRight ?? 0;
  const b = node.paddingBottom ?? 0;
  const l = node.paddingLeft ?? 0;
  return `${Math.round(t)} ${Math.round(r)} ${Math.round(b)} ${Math.round(l)}`;
}

/**
 * Extract corner radius from a node (used for CTAs and cards).
 * Figma supports per-corner radius — we return the largest, which is
 * what email HTML border-radius approximates anyway.
 */
function extractRadius(node) {
  if (typeof node.cornerRadius === "number") return Math.round(node.cornerRadius);
  if (Array.isArray(node.rectangleCornerRadii)) {
    return Math.round(Math.max(...node.rectangleCornerRadii));
  }
  return 0;
}

// =====================================================================
// 7. CONTENT WALKER — recursive node → spec elements
// =====================================================================

/**
 * Walk a section subtree and emit content[] elements.
 * Order is determined by absolute Y (top-down), then absolute X (left-right).
 *
 * imageRefs: collected as a side-effect — caller uses these in Phase B
 * to call Figma's /v1/images endpoint and upload to Dropbox.
 */
function walkSection(sectionNode, ctx) {
  const elements = [];
  collect(sectionNode, elements, ctx, /* isRoot */ true);
  return elements;
}

function collect(node, out, ctx, isRoot = false) {
  if (!node || node.visible === false) return;

  // ------ TEXT ------
  if (TEXT_TYPES.has(node.type)) {
    const el = textNodeToSpec(node);
    if (el) out.push(el);
    return;
  }

  // ------ IMAGE FILL on a RECTANGLE / FRAME ------
  const imgFill = extractImageFill(node);
  if (imgFill && imgFill.imageRef) {
    const w = Math.round(getNodeWidth(node));
    const h = Math.round(getNodeHeight(node));
    // Track for Phase B export
    ctx.imageRefs.push({
      nodeId: node.id,
      imageRef: imgFill.imageRef,
      width: w,
      height: h,
      name: node.name,
    });
    out.push({
      el: "image",
      src: "", // Phase B fills this with Dropbox URL after export
      alt: node.name || "Image",
      width: w,
      height: h,
      _figmaNodeId: node.id, // internal — stripped before Stage 2
    });
    return;
  }

  // ------ CTA HEURISTIC ------
  // A CTA in Figma is typically: a frame/rectangle with solid fill + corner
  // radius, containing exactly one TEXT node. Treat that pattern as a CTA.
  if (CONTAINER_TYPES.has(node.type) && !isRoot) {
    const cta = tryDetectCta(node);
    if (cta) {
      out.push(cta);
      return;
    }
  }

  // ------ CONTAINER: recurse into children ------
  if (CONTAINER_TYPES.has(node.type)) {
    const children = (node.children || []).slice();
    children.sort((a, b) => {
      const ay = a.absoluteBoundingBox?.y ?? 0;
      const by = b.absoluteBoundingBox?.y ?? 0;
      if (Math.abs(ay - by) > 0.5) return ay - by;
      const ax = a.absoluteBoundingBox?.x ?? 0;
      const bx = b.absoluteBoundingBox?.x ?? 0;
      return ax - bx;
    });
    for (const child of children) {
      collect(child, out, ctx, false);
    }
    return;
  }

  // ------ Decorative shapes: ignore in v6.0.0 (handled by post-processors) ------
  // VECTOR / RECTANGLE without image fill, no children = decorative element.
  // Skipped to keep the spec clean. Future: detect dividers (thin rect spanning width).
  return;
}

/**
 * Convert a Figma TEXT node into a spec text element.
 * Uses verbatim characters, fontSize, fontWeight, lineHeightPx.
 */
function textNodeToSpec(node) {
  const characters = node.characters;
  if (!characters || characters.trim() === "") return null;

  const style = node.style || {};
  const size = Math.round(style.fontSize ?? 14);
  const weight = style.fontWeight ?? 400;

  // lineHeightPx is the absolute pixel value; lineHeightPercent is %
  let lh = size; // sensible default
  if (typeof style.lineHeightPx === "number" && style.lineHeightPx > 0) {
    lh = Math.round(style.lineHeightPx);
  } else if (typeof style.lineHeightPercent === "number" && style.lineHeightPercent > 0) {
    lh = Math.round(size * (style.lineHeightPercent / 100));
  }

  const color = extractTextColor(node);
  const align = mapTextAlign(style.textAlignHorizontal);
  const transform = mapTextTransform(style.textCase);

  const el = {
    el: "text",
    text: characters,
    size,
    weight,
    lh,
    color,
    align,
  };
  if (transform) el.transform = transform;
  if (typeof style.letterSpacing === "number" && style.letterSpacing !== 0) {
    el.letter_spacing = Number(style.letterSpacing.toFixed(2));
  }
  return el;
}

/**
 * If a container is a CTA-shaped frame (fill + radius + 1 text child),
 * return a spec cta element. Otherwise null.
 */
function tryDetectCta(node) {
  const bg = extractBgHex(node);
  const radius = extractRadius(node);
  if (!bg) return null;
  if (radius < 2) return null; // need some rounding to be a button

  // Reject if the frame has an IMAGE fill (then it's a rounded image, not a CTA)
  if (extractImageFill(node)) return null;

  // Find the descendant TEXT nodes (not just direct children — Figma often
  // wraps text in another frame inside the button)
  const textNodes = [];
  (function walk(n) {
    if (n.visible === false) return;
    if (n.type === "TEXT") {
      textNodes.push(n);
      return;
    }
    for (const c of n.children || []) walk(c);
  })(node);

  if (textNodes.length !== 1) return null;
  const t = textNodes[0];
  const ctaText = t.characters?.trim();
  if (!ctaText) return null;

  // Sanity bounds — based on real-world Mavlers CTA dimensions:
  // Kenect (50px tall, 6px radius), Super-Nova (80–123px tall, 10px radius)
  const h = getNodeHeight(node);
  const w = getNodeWidth(node);
  if (h > 160) return null; // hero blocks and full sections are taller
  if (w > 620) return null; // wider than max email width — not a button

  // Reject huge text blocks masquerading as CTAs (e.g., a heading in a
  // colored box with rounded corners). CTAs are short labels.
  if (ctaText.length > 60) return null;

  const ctaColor = extractTextColor(t);
  const ctaSize = Math.round(t.style?.fontSize ?? 16);
  const ctaWeight = t.style?.fontWeight ?? 600;
  const align = mapTextAlign(t.style?.textAlignHorizontal); // CTA's own align

  return {
    el: "cta",
    cta_text: ctaText,
    cta_bg: bg,
    cta_color: ctaColor,
    cta_radius: radius,
    cta_h: Math.round(h),
    cta_size: ctaSize,
    cta_weight: ctaWeight,
    align,
  };
}

// =====================================================================
// 8. SECTION TYPE INFERENCE — heuristic classification
// =====================================================================

/**
 * Guess a section's "type" from its content. The Stage 2 prompt uses this
 * for layout decisions but accepts any of the allowed types.
 *
 * Heuristics (cheap, transparent — improve over time):
 *  - First section + small height + has text → preheader
 *  - Last section + has links → footer
 *  - Large image dominates → hero_image
 *  - Has CTA → cta (or compound; cta wins)
 *  - Has bullet markers → bullet_list (not detected in v6.0.0)
 *  - Otherwise → body_text or heading by content shape
 */
function inferSectionType(section, idx, total, content) {
  const isFirst = idx === 0;
  const isLast = idx === total - 1;
  const isNearLast = idx >= total - 2;
  const height = section.height || 0;

  const ctaCount = content.filter((c) => c.el === "cta").length;
  const imgCount = content.filter((c) => c.el === "image").length;
  const textCount = content.filter((c) => c.el === "text").length;
  const total_els = content.length;

  // Preheader: first section, short, has text
  if (isFirst && height < 100 && textCount > 0) return "preheader";

  // Logo / nav: first section, short, image-only or image + 1 link
  if (isFirst && imgCount > 0 && textCount === 0 && ctaCount === 0) return "logo";

  // Footer: last section, has links/text — and either has many social-style
  // small text items OR is just text
  if (isLast && textCount > 0) return "footer";

  // Hero image: image dominates, no/minimal text
  if (imgCount > 0 && textCount === 0 && ctaCount === 0) return "hero_image";

  // Pure CTA: section is mostly the button (≤ 1 supporting text + 1 CTA)
  if (ctaCount >= 1 && textCount <= 1 && imgCount === 0) return "cta";

  // Closing CTA: near-last position, has CTA, has heading-style text
  if (isNearLast && ctaCount >= 1) return "closing_cta";

  // Heading-only: 1-2 text elements, all heading-style (large or bold)
  if (textCount > 0 && ctaCount === 0 && imgCount === 0 && total_els <= 2) {
    const allHeadingLike = content.every(
      (c) => c.el !== "text" || c.weight >= 600 || c.size >= 22
    );
    if (allHeadingLike) return "heading";
  }

  // Default: body_text covers compound sections (heading + body + button + image)
  return "body_text";
}

// =====================================================================
// 9. PALETTE EXTRACTION
// =====================================================================

/**
 * Walk the entire emitted spec and collect every unique hex value used.
 * Stage 2 uses _palette as a constraint ("only colors from this list").
 */
function buildPalette(spec) {
  const set = new Set();
  function add(hex) {
    if (typeof hex === "string" && /^#[0-9A-F]{6}$/i.test(hex)) {
      set.add(hex.toUpperCase());
    }
  }
  for (const s of spec.sections || []) {
    add(s.bg);
    for (const c of s.content || []) {
      add(c.color);
      add(c.cta_bg);
      add(c.cta_color);
      add(c.card_bg);
      add(c.card_border);
      if (Array.isArray(c.spans)) {
        for (const sp of c.spans) add(sp.color);
      }
    }
  }
  return Array.from(set);
}

// =====================================================================
// 10. MAIN ENTRY — figmaToDesignSpec()
// =====================================================================

/**
 * Top-level orchestrator. Caller passes the Figma URL + token; receives a
 * designSpec ready to feed to the existing Stage 2 pipeline.
 *
 * Returns:
 *   {
 *     designSpec,           // JSON spec, same shape as Stage 1 output
 *     imageRefs,            // [{ nodeId, imageRef, width, height, name }]
 *     fileName,             // Figma file name (for logging)
 *     warnings              // string[] — things we noticed but didn't error on
 *   }
 *
 * Throws on unrecoverable errors (bad URL, bad token, no email frame).
 */
export async function figmaToDesignSpec({ figmaUrl, token, fetchImpl = fetch, devOverrides = {} }) {
  const warnings = [];

  // 1. Parse URL
  const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);

  // 2. Fetch from API
  const { document: rawNode, fileName } = await fetchFigmaNode({
    fileKey,
    nodeId,
    token,
    fetchImpl,
  });

  // 3. Locate the email frame (descend through CANVAS / wrappers)
  const emailFrame = locateEmailFrame(rawNode);
  const emailWidth = Math.round(getNodeWidth(emailFrame));

  // 4. Find content root
  const contentRoot = findContentRoot(emailFrame);
  if ((contentRoot.children || []).length === 0) {
    throw new Error(`Figma email frame "${emailFrame.name}" has no content. Check the URL points to the right frame.`);
  }

  // 5. Detect layout mode (informational; affects spacing accuracy)
  const layoutMode = contentRoot.layoutMode || "NONE";
  if (layoutMode === "NONE") {
    warnings.push(
      "Email uses absolute-positioned layout, not auto-layout. Spacing accuracy may be slightly less precise — consider converting to auto-layout in Figma for best results."
    );
  }

  // 6. Detect sections
  const sectionNodes = detectSections(contentRoot);

  // 7. Walk each section into spec form
  const ctx = { imageRefs: [] };
  const sections = [];
  const frameOrigin = emailFrame.absoluteBoundingBox?.y ?? 0;

  sectionNodes.forEach((node, idx) => {
    const content = walkSection(node, ctx);
    if (content.length === 0) return; // empty section — skip

    const bbox = node.absoluteBoundingBox || {};
    const yStart = Math.round((bbox.y ?? 0) - frameOrigin);
    const yEnd = Math.round(yStart + (bbox.height ?? 0));
    const bg = extractBgHex(node) || "#FFFFFF";
    const pad = extractPadding(node);
    const align = mapTextAlign((node.children || [])[0]?.style?.textAlignHorizontal); // best guess

    const section = {
      n: sections.length + 1,
      type: "body_text", // re-assigned below
      bg,
      pad,
      align,
      y_start: yStart,
      y_end: yEnd,
      content,
      height: Math.round(bbox.height ?? 0), // used by inferSectionType, then deleted
    };
    section.type = inferSectionType(section, idx, sectionNodes.length, content);
    delete section.height;
    sections.push(section);
  });

  if (sections.length === 0) {
    throw new Error("Parsed Figma frame produced zero content sections. Check the frame contains visible text/images.");
  }

  // 8. Detect fonts from text nodes (most-frequent wins)
  const fontCounts = new Map();
  (function countFonts(n) {
    if (n.type === "TEXT" && n.style?.fontFamily) {
      const fam = n.style.fontFamily;
      fontCounts.set(fam, (fontCounts.get(fam) || 0) + 1);
    }
    for (const c of n.children || []) countFonts(c);
  })(contentRoot);
  const sortedFonts = Array.from(fontCounts.entries()).sort((a, b) => b[1] - a[1]);
  const detectedFont = sortedFonts[0]?.[0] || "Arial";

  // 9. Assemble spec
  const designSpec = {
    width: devOverrides.emailWidth || emailWidth,
    font_body: devOverrides.primaryFont || detectedFont,
    font_heading: devOverrides.secondaryFont || detectedFont,
    sections,
    band_count: sections.length,
  };
  designSpec._palette = buildPalette(designSpec);
  designSpec.palette_used = designSpec._palette;

  // Strip internal-only fields (_figmaNodeId tracks image nodes for Phase B
  // export). These are not understood by Stage 2's prompt and would confuse it.
  for (const s of designSpec.sections) {
    for (const c of s.content) {
      delete c._figmaNodeId;
    }
  }

  return {
    designSpec,
    imageRefs: ctx.imageRefs,
    fileName,
    fileKey,
    nodeId,
    warnings,
    layoutMode,
    sourceFrame: { id: emailFrame.id, name: emailFrame.name, width: emailWidth },
  };
}

// =====================================================================
// 11. INTERNAL EXPORTS (for unit testing)
// =====================================================================
export const __internals = {
  figmaColorToHex,
  extractBgHex,
  extractRadius,
  mapTextAlign,
  mapTextTransform,
  textNodeToSpec,
  tryDetectCta,
  inferSectionType,
  buildPalette,
  isEmailWidth,
  isVisibleNode,
};
