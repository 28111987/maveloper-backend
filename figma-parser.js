// =====================================================================
// MAVELOPER FIGMA PARSER — v6.1.0-rtl
// Converts a Figma frame node into the v5.5.0 designSpec JSON format.
// v6.1.0-rtl (RTL Phase 2): detectTextDirection() — deterministic Unicode-range scan
//   over already-captured el.text sets designSpec.text_direction (default "ltr", so
//   every existing LTR email is unchanged) + per-run el.ltr_hint for latin/numeric/URL
//   islands inside an RTL email. Self-contained, no new Figma dependency. NOT deployed
//   to prod (Railway) until end-to-end RTL is proven on a real Hebrew/Arabic Figma design.
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
const EMAIL_WIDTH_MIN = 500;
const EMAIL_WIDTH_MAX = 800;
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
    // D15: a FIXED frame may declare less than it paints. Judge the painted
    // extent; report the disagreement rather than letting it pass unrecorded.
    const paintedH = getPaintedHeight(rootNode);
    const declaredH = getNodeHeight(rootNode);
    if (Math.abs(paintedH - declaredH) > 0.5) {
      console.warn(
        `[EXTENT_DISAGREEMENT] ${rootNode.id} "${rootNode.name}": declared ${declaredH.toFixed(3)}px, ` +
        `paints ${paintedH.toFixed(3)}px (clips=${!!rootNode.clipsContent}, sizing=${rootNode.primaryAxisSizingMode || "none"})`
      );
    }
    if (paintedH < 300) {
      throw new Error(
        `Figma frame "${rootNode.name}" is ${Math.round(paintedH)}px tall — too short to be an email design (must be ≥ 300px). Right-click the actual email frame in Figma → Copy link to selection.`
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
    // D15: judged on painted extent, not the declared box. Width rule untouched.
    if (isEmailWidth(getNodeWidth(node)) && getPaintedHeight(node) >= 300) {
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

// DEFECT 15 (C75) — PAINTED EXTENT.
// absoluteBoundingBox is the frame's DECLARED box, which a FIXED-size frame may
// state smaller than what it paints. absoluteRenderBounds is no better: on
// liesl_1_253 both read 255 while Figma renders 585.467 — a 331px second footer
// variant below the declared edge, 56% of the section.
//
// This was filed as TWO defects and ranked separately: DEFECT 4 (regions omitted
// under a clean certificate) and DEFECT 5 (proof corpus outside the production
// input domain). They are one bug. The ">= 300px" admission gate below reads the
// declared 255, rejects the design as "too short to be an email", and the corpus
// looks disjoint from the input domain as a consequence.
//
// Both clipsContent and a mask genuinely remove what lies outside, so both
// terminate the union. Omitting the mask case over-reports a "Mask group" by ~19%
// and would re-route icon content — the near-miss D13 recorded one defect over.
function paintedExtent(node) {
  const own = node?.absoluteBoundingBox;
  if (!own) return null;
  let b = { x: own.x, y: own.y, width: own.width, height: own.height };
  const masked = (node.children || []).some((c) => c.isMask === true && c.visible !== false);
  if (node.clipsContent || masked) return b;
  for (const c of node.children || []) {
    if (c.visible === false) continue;
    const cb = paintedExtent(c);
    if (!cb) continue;
    const x0 = Math.min(b.x, cb.x), y0 = Math.min(b.y, cb.y);
    const x1 = Math.max(b.x + b.width, cb.x + cb.width);
    const y1 = Math.max(b.y + b.height, cb.y + cb.height);
    b = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  return b;
}

// The height an admission gate must judge: what the frame PAINTS, never what it
// declares. Deliberately NOT applied to getNodeHeight() itself — that function
// feeds layout arithmetic throughout the parser, and silently enlarging every
// frame there is a compiler-wide blast radius this change does not take on.
function getPaintedHeight(node) {
  const pe = paintedExtent(node);
  return pe ? pe.height : getNodeHeight(node);
}

function isEmailWidth(width) {
  return width >= EMAIL_WIDTH_MIN && width <= EMAIL_WIDTH_MAX;
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
 * Is a #RRGGBB background "dark"? Uses relative luminance (Rec.709) on a 0–255
 * scale; dark when luminance < ~64 (≈0.25 of full). Drives designSpec.dark_mode
 * so the framework's dark-mode scaffold (DSF-3 / validator) fires for natively
 * dark designs (Arsenal #060605 → dark) but not for light/cream bases
 * (#FFFFFF / #F6F4EE → light). Unparseable input → not dark (false).
 */
function isDarkBackground(hex) {
  if (typeof hex !== "string") return false;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 64;
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
 * Layer-A capture: dominant SOLID stroke color + weight on a node.
 * Mirrors extractBgHex's paint-array loop, but over node.strokes[] (same
 * { type:"SOLID", color:{r,g,b,a} } paint shape). Returns { hex, weight }
 * where weight = node.strokeWeight (or null if absent), or null when the
 * node has no visible SOLID stroke. Capture-only — affects nothing else.
 */
function extractStrokeHex(node) {
  const strokes = node.strokes;
  if (!Array.isArray(strokes)) return null;
  for (const stroke of strokes) {
    if (stroke.visible === false) continue;
    if (stroke.type === "SOLID") {
      return {
        hex: figmaColorToHex(stroke.color),
        weight: typeof node.strokeWeight === "number" ? node.strokeWeight : null,
      };
    }
  }
  return null;
}

/**
 * Layer-A (Fix 3): build a ready-to-paste, email-safe CSS background string
 * from a captured gradient {kind, stops, handles}. ADDITIVE — it never alters
 * the captured kind/stops/handles. Returns { css, fallback_hex } or null when
 * there are no usable stops.
 *
 * - fallback_hex = the stop covering the largest area (position span). When
 *   every stop shares one hex (e.g. the Arsenal closing 2-stop, both #F05A28),
 *   that hex is used. A bgcolor / Outlook fallback should be set to this.
 * - css ALWAYS leads with `background-color:<fallback_hex>` so non-supporting
 *   clients (incl. Outlook) get the solid colour, then `background:<…>-gradient(…)`
 *   overrides it where supported.
 * - RADIAL: centre derived from handles[0] (handle[0] is the centre); else 50% 50%.
 * - LINEAR: angle derived from the handles[0]→handles[1] vector via atan2
 *   (CSS convention: 0deg = up, increasing clockwise; Figma y is downward);
 *   else 180deg.
 * - All percentages and the angle are rounded to whole numbers.
 */
function buildGradientCss(kind, stops, handles) {
  if (!Array.isArray(stops) || stops.length === 0) return null;

  // --- solid fallback: stop with the largest area (position span) presence ---
  const allSameHex = stops.every((s) => s.hex && s.hex === stops[0].hex);
  let fallback_hex;
  if (allSameHex) {
    fallback_hex = stops[0].hex;
  } else {
    const sorted = stops
      .map((s) => ({ pos: s.pos ?? 0, hex: s.hex }))
      .sort((a, b) => a.pos - b.pos);
    let best = sorted[0];
    let bestSpan = -1;
    for (let j = 0; j < sorted.length; j++) {
      const left = j === 0 ? 0 : (sorted[j - 1].pos + sorted[j].pos) / 2;
      const right = j === sorted.length - 1 ? 1 : (sorted[j].pos + sorted[j + 1].pos) / 2;
      const span = right - left;
      if (span > bestSpan) { bestSpan = span; best = sorted[j]; }
    }
    fallback_hex = best.hex || stops[0].hex;
  }

  // --- stop list "<hex> <pos%>" ---
  const stopStr = stops
    .map((s) => `${s.hex} ${Math.round((s.pos ?? 0) * 100)}%`)
    .join(", ");

  let grad;
  if (kind === "GRADIENT_RADIAL") {
    let cx = 50, cy = 50;
    if (Array.isArray(handles) && handles[0] && typeof handles[0].x === "number") {
      cx = Math.round(handles[0].x * 100);
      cy = Math.round((handles[0].y ?? 0.5) * 100);
    }
    grad = `radial-gradient(circle at ${cx}% ${cy}%, ${stopStr})`;
  } else {
    // GRADIENT_LINEAR (and any other gradient kind) → linear with derived angle.
    let angle = 180;
    if (Array.isArray(handles) && handles[0] && handles[1]
        && typeof handles[0].x === "number" && typeof handles[1].x === "number") {
      const dx = handles[1].x - handles[0].x;
      const dy = (handles[1].y ?? 0) - (handles[0].y ?? 0);
      // CSS angle: 0deg = up, increasing clockwise; Figma y increases downward.
      angle = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
    }
    grad = `linear-gradient(${angle}deg, ${stopStr})`;
  }

  return {
    css: `background-color:${fallback_hex}; background:${grad};`,
    fallback_hex,
  };
}

/**
 * Layer-A capture: first gradient fill on a node. Captures DATA (kind, stops,
 * handles) and ALSO attaches a pre-rendered, email-safe `css` string plus a
 * `fallback_hex` (Fix 3) so the model can paste the gradient verbatim.
 * Scans node.fills for the first visible fill whose type starts with
 * "GRADIENT_". Returns:
 *   { kind: <GRADIENT_* type>,
 *     stops: [{ pos: gradientStops[i].position, hex: <stop color hex> }, ...],
 *     handles: gradientHandlePositions,
 *     css: <ready-to-paste background string>,     // NEW, additive
 *     fallback_hex: <solid fallback colour> }       // NEW, additive
 * or null if the node has no gradient fill.
 */
function extractGradient(node) {
  const fills = node.fills;
  if (!Array.isArray(fills)) return null;
  for (const fill of fills) {
    if (fill.visible === false) continue;
    if (typeof fill.type === "string" && fill.type.startsWith("GRADIENT_")) {
      const stops = Array.isArray(fill.gradientStops)
        ? fill.gradientStops.map((s) => ({ pos: s.position, hex: figmaColorToHex(s.color) }))
        : [];
      const gradient = {
        kind: fill.type,
        stops,
        handles: fill.gradientHandlePositions || null,
      };
      const built = buildGradientCss(gradient.kind, gradient.stops, gradient.handles);
      if (built) {
        gradient.css = built.css;
        gradient.fallback_hex = built.fallback_hex;
      }
      return gradient;
    }
  }
  return null;
}

/**
 * Layer-A (L-2a) capture: INNER containers deeper than the section root.
 *
 * Purely additive metadata. Does its OWN read-only walk of the section
 * subtree — it never touches collect() or content[], so the content
 * flattening output is structurally unchanged.
 *
 * A node qualifies as a captured container when it is a FRAME/GROUP/
 * RECTANGLE/INSTANCE (and is NOT the section root) carrying at least one of:
 *   - a visible SOLID stroke with strokeWeight > 0  (wt:0 invisible-leftover
 *     paints are filtered out and never produce a border)
 *   - cornerRadius > 0
 *   - a GRADIENT_ fill
 *   - a SOLID bg fill that differs from the enclosing section's bg
 *
 * Association: for each container we record content[] indices whose source
 * node sits geometrically inside it (center-point containment), matched by
 * value signature → node bbox, so cc-runner knows what each wrapper holds.
 */
const CONTAINER_CAPTURE_TYPES = new Set(["FRAME", "GROUP", "RECTANGLE", "INSTANCE"]);

function captureContainers(sectionNode, sectionBg, content) {
  // 1. Index content-leaf nodes by value signature → bbox(es).
  const sigToBboxes = new Map();
  const addSig = (key, bbox) => {
    if (!bbox) return;
    if (!sigToBboxes.has(key)) sigToBboxes.set(key, []);
    sigToBboxes.get(key).push(bbox);
  };
  (function indexLeaves(n) {
    if (!n || n.visible === false) return;
    const bb = n.absoluteBoundingBox;
    if (n.type === "TEXT" && typeof n.characters === "string" && n.characters.trim() !== "") {
      addSig(`text:${n.characters}`, bb);
    }
    const imf = extractImageFill(n);
    if ((imf && imf.imageRef) || isAtomicVisualUnit(n)) {
      addSig(`img:${n.name || "Image"}`, bb);
    }
    for (const c of n.children || []) indexLeaves(c);
  })(sectionNode);

  const itemBbox = (item) => {
    let key = null;
    if (item.el === "text") key = `text:${item.text}`;
    else if (item.el === "cta") key = `text:${item.cta_text}`;
    else if (item.el === "image") key = `img:${item.alt}`;
    if (!key) return null;
    const arr = sigToBboxes.get(key);
    return arr && arr.length ? arr[0] : null;
  };

  const inside = (b, C) => {
    if (!b) return false;
    const cx = (b.x ?? 0) + (b.width ?? 0) / 2;
    const cy = (b.y ?? 0) + (b.height ?? 0) / 2;
    return cx >= C.x - 1 && cx <= C.x + C.w + 1 && cy >= C.y - 1 && cy <= C.y + C.h + 1;
  };

  // 2. Walk the subtree; collect qualifying containers.
  const containers = [];
  (function walk(n) {
    if (!n || n.visible === false) return;
    if (n !== sectionNode && CONTAINER_CAPTURE_TYPES.has(n.type)) {
      const stroke = extractStrokeHex(n);
      const hasBorder = !!(stroke && typeof stroke.weight === "number" && stroke.weight > 0);
      const radius = extractRadius(n);
      const gradient = extractGradient(n);
      const ownBg = extractBgHex(n);
      const bgDiffers = !!(ownBg && ownBg !== sectionBg);
      if (hasBorder || radius > 0 || gradient || bgDiffers) {
        const bb = n.absoluteBoundingBox || {};
        const C = {
          x: Math.round(bb.x ?? 0),
          y: Math.round(bb.y ?? 0),
          w: Math.round(bb.width ?? 0),
          h: Math.round(bb.height ?? 0),
        };
        const desc = { _figmaNodeId: n.id, name: n.name, bg: ownBg || null, bbox: C };
        if (hasBorder) desc.stroke = { hex: stroke.hex, weight: stroke.weight };
        if (radius > 0) desc.radius = radius;
        if (gradient) desc.gradient = gradient;
        const assoc = [];
        content.forEach((item, i) => { if (inside(itemBbox(item), C)) assoc.push(i); });
        desc.content_indices = assoc;
        containers.push(desc);
      }
    }
    for (const c of n.children || []) walk(c);
  })(sectionNode);

  return containers;
}

/** Median of a numeric array (0 for empty). */
function gridMedian(arr) {
  const a = arr.filter((x) => typeof x === "number").slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Cluster a set of similar-sized tiles into rows by shared Y, then derive
 * cols (max items in any row), rows, and gutter (median horizontal gap
 * between adjacent items within a row).
 */
function clusterGridRows(members) {
  const sorted = members.slice().sort((a, b) => (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x));
  const medH = gridMedian(members.map((m) => m.bbox.h));
  const ytol = Math.max(8, 0.25 * medH);
  const rows = [];
  for (const m of sorted) {
    let row = rows.find((r) => Math.abs(r.y - m.bbox.y) <= ytol);
    if (!row) { row = { y: m.bbox.y, items: [] }; rows.push(row); }
    row.items.push(m);
  }
  const cols = Math.max(...rows.map((r) => r.items.length));
  const gaps = [];
  for (const r of rows) {
    const xs = r.items.slice().sort((a, b) => a.bbox.x - b.bbox.x);
    for (let i = 1; i < xs.length; i++) {
      gaps.push(xs[i].bbox.x - (xs[i - 1].bbox.x + xs[i - 1].bbox.w));
    }
  }
  const gutter = gaps.length ? Math.round(gridMedian(gaps)) : 0;
  return { cols, rows: rows.length, gutter };
}

/**
 * Layer-A (L-2b): derive grid geometry for multi-item rows from the L-2a
 * containers[]. Additive — reads section.containers + the node tree only.
 *
 * Method: cluster captured containers by similar size (greedy, tolerance-
 * based), build a row/col grid for each cluster with >= 2 members, and pick
 * the cluster with the LARGEST item area among those with cols >= 2 (the
 * repeated content tiles, not the small inner sub-wrappers). Geometry is
 * primary; Figma parent layoutMode / itemSpacing are recorded for cross-
 * check only and never override the geometry (conflicts noted in _note).
 *
 * Returns a grid descriptor or null when there is no >=2-column multi-item
 * row (single items / non-grid sections produce no grid).
 */
function deriveSectionGrid(sectionNode, containers) {
  const items = (containers || []).filter((c) => c.bbox && c.bbox.w > 0 && c.bbox.h > 0);
  if (items.length < 2) return null;

  // 1. Size-cluster (greedy, tolerance-based).
  const clusters = [];
  for (const it of items) {
    const w = it.bbox.w, h = it.bbox.h;
    let placed = null;
    for (const cl of clusters) {
      const wtol = Math.max(6, 0.06 * cl.w);
      const htol = Math.max(8, 0.06 * cl.h);
      if (Math.abs(w - cl.w) <= wtol && Math.abs(h - cl.h) <= htol) { placed = cl; break; }
    }
    if (placed) {
      placed.members.push(it);
      placed.w = gridMedian(placed.members.map((m) => m.bbox.w));
      placed.h = gridMedian(placed.members.map((m) => m.bbox.h));
    } else {
      clusters.push({ w, h, members: [it] });
    }
  }

  // 2. Best grid = largest-area cluster with cols >= 2.
  let best = null;
  for (const cl of clusters) {
    if (cl.members.length < 2) continue;
    const g = clusterGridRows(cl.members);
    if (!g || g.cols < 2) continue;
    const area = cl.w * cl.h;
    if (!best || area > best.area) best = { ...g, area, members: cl.members, w: cl.w, h: cl.h };
  }
  if (!best) return null;

  // L-2c guard: emit a grid ONLY for genuine tile grids; suppress sparse /
  // incidental pairs. Require all of: cols >= 2; item_width >= 60px; gutter
  // smaller than a tile (a real grid's gap < its cells); and similar-width
  // tiles (max width within ~15% of the median). Containers[] is unaffected.
  const widths = best.members.map((m) => m.bbox.w);
  const medW = gridMedian(widths);
  const maxW = Math.max(...widths);
  const itemWidth = Math.round(best.w);
  const similarWidth = medW > 0 && maxW <= medW * 1.15;
  if (!(best.cols >= 2 && itemWidth >= 60 && best.gutter <= itemWidth && similarWidth)) {
    return null;
  }

  const result = {
    cols: best.cols,
    rows: best.rows,
    item_width: itemWidth,
    gutter: best.gutter,
  };

  // 3. Corroborate with Figma parent layout (cross-check only; geometry wins).
  const pmap = buildParentMap(sectionNode);
  const parents = new Set();
  for (const m of best.members) {
    const p = pmap.get(m._figmaNodeId);
    if (p) parents.add(p);
  }
  let layoutParent = null;
  for (const p of parents) {
    if (p.layoutMode === "HORIZONTAL" || typeof p.itemSpacing === "number") { layoutParent = p; break; }
  }
  if (!layoutParent) {
    for (const p of parents) {
      const gp = pmap.get(p.id);
      if (gp && (gp.layoutMode === "HORIZONTAL" || typeof gp.itemSpacing === "number")) { layoutParent = gp; break; }
    }
  }
  if (layoutParent) {
    if (layoutParent.layoutMode) result.figma_layoutMode = layoutParent.layoutMode;
    if (typeof layoutParent.itemSpacing === "number") result.figma_itemSpacing = Math.round(layoutParent.itemSpacing);
    const notes = [];
    if (typeof result.figma_itemSpacing === "number" && Math.abs(result.figma_itemSpacing - result.gutter) > 4) {
      notes.push(`geometry gutter=${result.gutter}px differs from figma itemSpacing=${result.figma_itemSpacing}px; geometry wins`);
    }
    if (result.figma_layoutMode && result.figma_layoutMode !== "HORIZONTAL") {
      notes.push(`figma parent layoutMode=${result.figma_layoutMode} (not HORIZONTAL) but geometry shows ${result.cols} columns; geometry wins`);
    }
    if (notes.length) result._note = notes.join("; ");
  }

  return result;
}

// =====================================================================
// 6b. CLASS B — TWO-COLUMN IMAGE+TEXT ROW DETECTION (column_split)
// =====================================================================

/**
 * Is a node an image COLUMN — i.e. it renders as a single <img> (an image-fill
 * RECTANGLE/FRAME, or a captured atomic visual unit)? Used by the column_split
 * detector to tell a real image column apart from the text node beside it.
 * ctx is intentionally omitted so the large-decoration branch (which needs
 * section context) never fires here — a column image is a flow image, not an
 * A2 background shape.
 */
function isImageColumnNode(node) {
  if (!node || node.visible === false) return false;
  const imf = extractImageFill(node);
  if (imf && imf.imageRef) return true;
  return isAtomicVisualUnit(node);
}

/**
 * CLASS B (L-2d): detect HORIZONTAL two-column image+text rows and emit a
 * section.column_split descriptor scoped to the two content[] indices the row's
 * children became. Mirrors how section.grid is attached — purely additive
 * metadata; content[] is NEVER modified or re-split (the renderer maps the
 * indices, which is what avoids the flat-list duplicate-text bug).
 *
 * A row qualifies when a FRAME with layoutMode "HORIZONTAL" has EXACTLY two
 * visible children that are (a) a TEXT node and (b) an image column (image-fill
 * RECTANGLE/FRAME or a captured image element), at ~the same top y (≤8px),
 * non-overlapping, side-by-side left-to-right. The image column must be a real
 * block (≥60×60) so an inline icon/adornment (a label with a trailing 10px
 * arrow) does NOT count as a two-column row — mirrors the grid item_width≥60
 * guard.
 *
 * GATES (anti-over-trigger):
 *   - never fires when section.grid is set (the row is a real tile grid)
 *   - exactly 2 children (>2 → not a clean two-column row)
 *   - must be TEXT + image (two text nodes, or two images, do NOT qualify)
 *   - non-overlapping bboxes (overlap → CLASS A2 background-decoration, not a column)
 *
 * Descriptor (scoped to ONE row; any heading above / card below stays
 * full-width because only these two indices are referenced):
 *   { content_indices:[textIdx,imageIdx], widths:[textW,imageW],
 *     gutter:<itemSpacing>, order:"text-left"|"image-left" }
 *
 * Returns a single descriptor for one row, an array for multiple rows in the
 * same section, or null when there is no qualifying row.
 */
function detectColumnSplits(sectionNode, content, grid) {
  if (grid) return null;                                  // GATE: real tile grid
  if (!sectionNode || !Array.isArray(content) || content.length < 2) return null;

  // content signature → the single content index with that signature
  // (unique-only; an ambiguous duplicate signature bails to keep scoping exact).
  const indexForSig = (sig) => {
    let found = -1;
    for (let i = 0; i < content.length; i++) {
      const it = content[i];
      let key = null;
      if (it.el === "text") key = `text:${it.text}`;
      else if (it.el === "cta") key = `text:${it.cta_text}`;
      else if (it.el === "image") key = `img:${it.alt}`;
      if (key === sig) {
        if (found !== -1) return -1; // duplicate signature → ambiguous → bail
        found = i;
      }
    }
    return found;
  };

  const matches = [];
  (function walk(n) {
    if (!n || n.visible === false) return;
    if (n.type === "FRAME" && n.layoutMode === "HORIZONTAL") {
      const kids = (n.children || []).filter((c) => {
        const b = c && c.visible !== false && c.absoluteBoundingBox;
        return b && (b.width ?? 0) > 0 && (b.height ?? 0) > 0;
      });
      if (kids.length === 2) {
        const textKid = kids.find(
          (c) => c.type === "TEXT" && typeof c.characters === "string" && c.characters.trim() !== ""
        );
        const imgKid = kids.find((c) => c !== textKid && isImageColumnNode(c));
        if (textKid && imgKid) {
          const tb = textKid.absoluteBoundingBox;
          const ib = imgKid.absoluteBoundingBox;
          const textW = Math.round(tb.width ?? 0);
          const imgW = Math.round(ib.width ?? 0);
          const imgH = Math.round(ib.height ?? 0);
          // column-size guard: a real image column, not an inline icon.
          const columnSized = imgW >= 60 && imgH >= 60 && textW >= 60;
          const sameTop = Math.abs((tb.y ?? 0) - (ib.y ?? 0)) <= 8;
          const noOverlap = !bboxOverlap(tb, ib);          // A2 guard (not behind/stacked)
          const leftRight =
            (tb.x + (tb.width ?? 0)) <= (ib.x ?? 0) + 1 ||
            ((ib.x ?? 0) + (ib.width ?? 0)) <= (tb.x ?? 0) + 1; // disjoint x-ranges
          if (columnSized && sameTop && noOverlap && leftRight) {
            const textIdx = indexForSig(`text:${textKid.characters}`);
            const imgIdx = indexForSig(`img:${imgKid.name || "Image"}`);
            if (textIdx >= 0 && imgIdx >= 0 && textIdx !== imgIdx) {
              const order = (tb.x ?? 0) <= (ib.x ?? 0) ? "text-left" : "image-left";
              const gutter =
                typeof n.itemSpacing === "number"
                  ? Math.round(n.itemSpacing)
                  : Math.max(
                      0,
                      order === "text-left"
                        ? Math.round((ib.x ?? 0) - (tb.x + (tb.width ?? 0)))
                        : Math.round((tb.x ?? 0) - (ib.x + (ib.width ?? 0)))
                    );
              matches.push({
                content_indices: [textIdx, imgIdx],
                widths: [textW, imgW],
                gutter,
                order,
              });
            }
          }
        }
      }
    }
    for (const c of n.children || []) walk(c);
  })(sectionNode);

  if (matches.length === 0) return null;
  // de-dup identical index pairs (defensive)
  const seen = new Set();
  const uniq = [];
  for (const m of matches) {
    const k = m.content_indices.join(",");
    if (!seen.has(k)) { seen.add(k); uniq.push(m); }
  }
  return uniq.length === 1 ? uniq[0] : uniq;
}

/**
 * v6.3.0: Walk up the parent chain to find the nearest ancestor with a
 * solid bg fill. Used when a section's immediate frame has no fill —
 * the section visually inherits the bg of its enclosing email frame,
 * not the default white.
 *
 * Mavlers designs commonly use this pattern: email frame has dark fill,
 * sections inside are transparent (no fill), text inside sections is
 * white. Without ancestor walk, the parser produced bg=#FFFFFF for these
 * sections → white-on-white invisible text in the output.
 *
 * parentMap: built by buildParentMap() during initial node walk.
 */
function extractEffectiveBg(node, parentMap, fallback = "#FFFFFF") {
  // Own fill always wins — an explicit section colour is never overridden.
  //
  // DEFECT 10 (second path): "own fill" presupposes the node HAS an interior to
  // fill. When a bare TEXT node is promoted to a section — 1:210 "Recap Title",
  // black glyphs inside a #F2F2F2 frame — its `fills` is the glyph colour, and
  // returning it here paints the section black behind its own black text. The
  // v6.3.0 ancestor walk above was written to stop white-on-white; this stops
  // the black-on-black the same confusion produces from the other direction.
  // Falling through lets the covering-child and ancestor rules find the real
  // background (#F2F2F2 from parent 1:209).
  const own = GLYPH_PAINT_TYPES.has(node.type) ? null : extractBgHex(node);
  if (own) return own;

  // DEFECT 8: before falling back to an ANCESTOR, consult a fully-covering
  // painted DESCENDANT. This is the mirror of the v6.3.0 case: there, a
  // transparent section inherited a dark ancestor; here, a transparent section
  // is painted by a child that covers it edge to edge. That child's paint is
  // what the recipient actually sees, and an ancestor fallback silently
  // overwrites it with a WRONG value — worse than a dropped node, because a
  // wrong value looks verified to every downstream oracle.
  //
  // Measured on usaa_1_188: 1:272 has fills:[] and a single child 1:273 with
  // bbox identical to it (0,2636 650x374) painting #F0F0F0. The old walk
  // returned the email frame's white. Also corrects 1:206 (black, read white).
  const covered = coveringChildBg(node);
  if (covered) return covered;

  let cur = parentMap.get(node.id);
  while (cur) {
    const ownBg = extractBgHex(cur);
    if (ownBg) return ownBg;
    cur = parentMap.get(cur.id);
  }
  return fallback;
}

/**
 * DEFECT 8 helper. Descend the chain of children that cover `host` edge to
 * edge and return the first solid fill found.
 *
 * Only EDGE-TO-EDGE covers count: a child painting part of the section is
 * content, not background, and treating it as background would invent a colour
 * for the uncovered remainder. The 0.5px tolerance absorbs Figma's fractional
 * bounds without admitting a genuinely smaller box.
 */
function coveringChildBg(host) {
  const s = host.absoluteBoundingBox;
  if (!s) return null;
  const covers = (c) => {
    const b = c.absoluteBoundingBox;
    if (!b) return false;
    return b.x <= s.x + 0.5 && b.y <= s.y + 0.5 &&
           b.x + b.width >= s.x + s.width - 0.5 &&
           b.y + b.height >= s.y + s.height - 0.5;
  };
  let cur = host;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    // DEFECT 10: filter on TYPE as well as geometry. `fills` only means
    // BACKGROUND on a node with an interior to fill. On TEXT it is the glyph
    // colour; on VECTOR/LINE/STAR/POLYGON it is the artwork's own paint.
    // Adopting either as a background is how 1:206 — a transparent frame whose
    // single covering child is its own black body text — came to be painted
    // #000000 and render black-on-black. The filter also gates the DESCENT:
    // we may only tunnel through transparent CONTAINERS.
    const kids = (cur.children || []).filter(
      (c) => c.visible !== false && !GLYPH_PAINT_TYPES.has(c.type) && covers(c)
    );
    const painted = kids.find((c) => extractBgHex(c));
    if (painted) return extractBgHex(painted);
    cur = kids[0]; // keep descending through transparent covering wrappers
  }
  return null;
}

/**
 * DEFECT 10. Node types whose `fills` is artwork or glyph paint rather than a
 * background. Their colour is real and must still be rendered AS artwork — it
 * simply may never be promoted to a container's background.
 */
const GLYPH_PAINT_TYPES = new Set([
  "TEXT", "VECTOR", "LINE", "STAR", "POLYGON", "BOOLEAN_OPERATION",
]);

/**
 * Build a Map from nodeId → parent node, so we can walk ancestor chains
 * without Figma providing parent pointers (their API doesn't include them).
 * Called once at the top of figmaToDesignSpec().
 */
function buildParentMap(root) {
  const map = new Map();
  function walk(node, parent) {
    if (parent) map.set(node.id, parent);
    for (const c of node.children || []) walk(c, node);
  }
  walk(root, null);
  return map;
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

// ─── v6.1.0-rtl (Phase 2): deterministic text-direction detection ────────────
// Self-contained Unicode-range scan over already-captured text — NO new Figma
// dependency. RTL-script LETTERS vs total LETTER content (digits / latin /
// punctuation / whitespace / symbols are neutral and EXCLUDED from the
// denominator). RTL-letters / letter-total > 0.4 => "rtl". Deterministic:
// same text => same result. Default "ltr" so every existing LTR email is
// unchanged. NOT deployed to prod until end-to-end is proven on a real RTL design.
function isRtlChar(cp) {
  return (cp >= 0x0590 && cp <= 0x05FF) ||   // Hebrew
         (cp >= 0x0600 && cp <= 0x06FF) ||   // Arabic
         (cp >= 0x0750 && cp <= 0x077F) ||   // Arabic Supplement
         (cp >= 0xFB1D && cp <= 0xFB4F) ||   // Hebrew Presentation Forms
         (cp >= 0xFB50 && cp <= 0xFDFF) ||   // Arabic Presentation Forms-A
         (cp >= 0xFE70 && cp <= 0xFEFF);     // Arabic Presentation Forms-B
}
function isLtrLetter(cp) {
  return (cp >= 0x0041 && cp <= 0x005A) ||   // A-Z
         (cp >= 0x0061 && cp <= 0x007A) ||   // a-z
         (cp >= 0x00C0 && cp <= 0x024F) ||   // Latin-1 Supplement + Latin Extended-A/B
         (cp >= 0x0370 && cp <= 0x03FF) ||   // Greek
         (cp >= 0x0400 && cp <= 0x04FF);     // Cyrillic
}
function countDirection(text, acc) {
  if (typeof text !== "string") return;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isRtlChar(cp)) { acc.rtl++; acc.letters++; }
    else if (isLtrLetter(cp)) { acc.letters++; }
    // neutral (digits, punctuation, whitespace, symbols) excluded from denominator
  }
}
function detectTextDirection(text) {
  const acc = { rtl: 0, letters: 0 };
  countDirection(text, acc);
  if (acc.letters === 0) return "ltr";          // no letters (digits/punct/empty) => ltr
  return (acc.rtl / acc.letters) > 0.4 ? "rtl" : "ltr";
}
// Email-level: aggregate ALL text/cta runs across sections; the email is "rtl"
// if its DOMINANT letter content is RTL (same 0.4 threshold over the aggregate).
function computeSpecDirection(sections) {
  const acc = { rtl: 0, letters: 0 };
  for (const s of (sections || [])) {
    for (const c of (s.content || [])) {
      if (typeof c.text === "string") countDirection(c.text, acc);
      if (typeof c.cta_text === "string") countDirection(c.cta_text, acc);
    }
  }
  return (acc.letters > 0 && acc.rtl / acc.letters > 0.4) ? "rtl" : "ltr";
}
// Within an RTL email, flag purely-LTR runs (latin / numeric / URL islands) so
// the framework (§DSF-RTL rule #2) can wrap them dir="ltr".
function markLtrIslands(sections) {
  for (const s of (sections || [])) {
    for (const c of (s.content || [])) {
      if (typeof c.text === "string" && c.text.trim() && detectTextDirection(c.text) === "ltr") {
        c.ltr_hint = true;
      }
    }
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
 * Constants for atomic-visual-unit detection (v6.2.0).
 * An "atomic visual unit" is a node that should be rasterized via Figma's
 * /v1/images endpoint and emitted as a single <img> in the HTML, rather
 * than walked-into. Examples: icons (vector arrows, location pins),
 * component instances (sector tags, status pills, ticker bars),
 * decorative shape compositions.
 */
const ATOMIC_VECTOR_MAX_SIZE = 200;       // small VECTORs (icons) get rasterized
const ATOMIC_GROUP_MAX_SIZE = 300;        // small vector-only GROUPs get rasterized

/**
 * Walk a section subtree and emit content[] elements.
 * Order is determined by absolute Y (top-down), then absolute X (left-right).
 *
 * imageRefs: collected as a side-effect — caller uses these in Phase B
 * to call Figma's /v1/images endpoint and upload to Dropbox.
 *
 * v6.2.0 changes:
 *   - Image-fill frames no longer early-return; their overlay text/CTA
 *     children are extracted (set as section bg_image at the orchestrator
 *     level so HTML renders `<td background="...">`).
 *   - Atomic visual units (INSTANCE, COMPONENT, small VECTOR/GROUP) are
 *     captured as exportable images instead of being walked-into.
 */
function walkSection(sectionNode, ctx) {
  const elements = [];
  // CLASS A (decorative-shape capture): expose this section's geometry + paint
  // order so the walker can (a) reject section-sized backgrounds and (b) decide
  // whether a large shape sits BEHIND later-painted content. Reset per section.
  ctx.section = sectionNode.absoluteBoundingBox || null;
  ctx.sectionRoot = sectionNode;
  ctx._paintOrder = null;
  collect(sectionNode, elements, ctx, /* isRoot */ true);
  return collapseRepeats(elements);
}

/**
 * Detect and collapse exact-repeat patterns in a content array.
 *
 * Why: Real-world Figma files (e.g., Kenect newsletter) contain hidden
 * duplicate layers from designer iterations. The walker visits both copies
 * because they aren't marked visible:false. Without this collapse, Stage 2
 * faithfully renders content twice.
 *
 * Two patterns handled:
 *   1. WHOLE-ARRAY REPEAT: [A,B,C,A,B,C] → [A,B,C]
 *   2. HEADER + REPEATING TAIL: [H, A,B,C, A,B,C] → [H, A,B,C]
 *      (e.g., Kenect "New Release" section with title + 2x duplicated card)
 *
 * Safety: legitimate layouts with DIFFERENT text per repeat (e.g., the
 * common Mavlers stat-grid pattern "47% IRR" / "0.40x DPI") are NOT
 * collapsed because contentEquals returns false on different text.
 * Only EXACT character-for-character repeats fold.
 */
function collapseRepeats(content) {
  const len = content.length;
  if (len < 2) return content;

  // Pattern 1: whole-array period
  for (let n = 1; n <= Math.floor(len / 2); n++) {
    if (len % n !== 0) continue;
    if (isPeriodic(content, 0, len, n)) {
      return content.slice(0, n);
    }
  }

  // Pattern 2: header (length k) + repeating tail (period n)
  for (let k = 1; k <= len - 2; k++) {
    const tailLen = len - k;
    for (let n = 1; n <= Math.floor(tailLen / 2); n++) {
      if (tailLen % n !== 0) continue;
      if (isPeriodic(content, k, len, n)) {
        return content.slice(0, k + n);
      }
    }
  }

  return content;
}

/**
 * Check whether content[start..end] consists of a period-n pattern repeated.
 * Requires (end - start) % n === 0.
 */
function isPeriodic(content, start, end, n) {
  for (let i = start + n; i < end; i++) {
    if (!contentEquals(content[i], content[start + ((i - start) % n)])) {
      return false;
    }
  }
  return true;
}

/**
 * Strict equality check for content elements. Used by collapseRepeats and
 * the cross-section dedup pass. Two elements are equal only if they would
 * render identically.
 */
function contentEquals(a, b) {
  if (!a || !b) return false;
  if (a.el !== b.el) return false;
  if (a.el === "text") {
    return a.text === b.text && a.size === b.size && a.color === b.color && a.weight === b.weight;
  }
  if (a.el === "cta") {
    return a.cta_text === b.cta_text && a.cta_bg === b.cta_bg && a.cta_color === b.cta_color;
  }
  if (a.el === "image") {
    return a.alt === b.alt && a.width === b.width && a.height === b.height;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Cross-section dedup: if section N and section N+1 have identical
 * content arrays AND same bg, drop the duplicate.
 *
 * Why: in some Figma files, an entire section is duplicated (e.g., Kenect's
 * Audi North Park testimonial card appearing twice in adjacent positions).
 * Within a section, collapseRepeats handles intra-section repeats; this
 * function handles section-level repeats.
 */
function dedupAdjacentSections(sections) {
  const out = [];
  for (const s of sections) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.bg === s.bg &&
      prev.type === s.type &&
      prev.content.length === s.content.length &&
      prev.content.every((c, i) => contentEquals(c, s.content[i]))
    ) {
      continue; // identical to previous — skip
    }
    out.push(s);
  }
  return out;
}

function collect(node, out, ctx, isRoot = false) {
  if (!node || node.visible === false) return;

  // ------ CLIP-BOUNDS guard (additive) ------
  // Drop a node only when its bounding box lies ENTIRELY outside the fixed-size
  // email frame on either axis — content the frame's clipsContent crops away and
  // never renders (e.g. the phantom 6th sector tab in an 822px ticker that
  // overflows the 600px frame at x=622). Nodes that straddle an edge (partially
  // visible) are KEPT — we never clip partial content. Missing bbox or frame
  // geometry → skip the check (never drop for missing data). 1px tolerance so a
  // node flush at an edge is kept.
  if (ctx && ctx.clip && node.absoluteBoundingBox) {
    const bb = node.absoluteBoundingBox;
    const TOL = 1;
    const left = bb.x - ctx.clip.originX;
    const right = left + (bb.width ?? 0);
    const top = bb.y - ctx.clip.originY;
    const bottom = top + (bb.height ?? 0);
    if (
      right <= -TOL || left >= ctx.clip.width + TOL ||
      bottom <= -TOL || top >= ctx.clip.height + TOL
    ) {
      return;
    }
  }

  // ------ TEXT ------
  if (TEXT_TYPES.has(node.type)) {
    const el = textNodeToSpec(node);
    if (el) out.push(el);
    return;
  }

  // ------ ATOMIC VISUAL UNITS (v6.2.0) ------
  // INSTANCE, COMPONENT, small VECTOR, and vector-only GROUP are designed
  // atomic units (icons, sector tags, dividers, decorative graphics).
  // Rasterize them via Figma /v1/images rather than walking into them.
  // Skip for root nodes (a section root shouldn't become a single image).
  if (!isRoot && isAtomicVisualUnit(node, ctx)) {
    // CLASS A: a large decorative shape that sits BEHIND later-painted content
    // (or bleeds off the frame) is emitted as a BACKGROUND decoration (composited
    // behind the overlapping content), not as a flow image that would push
    // content down. Standalone shapes keep the A1 flow-image behavior.
    const largeDeco = isLargeDecorationShape(node, ctx);
    const asBackground = largeDeco && (isBehindLaterContent(node, ctx) || overhangsFrame(node, ctx));
    pushImageElement(node, out, ctx, {
      source: largeDeco ? "decoration" : "atomic",
      background: asBackground,
    });
    return;
  }

  // ------ IMAGE FILL on a CONTAINER (v6.2.0 fix for Bug 1A) ------
  // Previously: image-fill frames early-returned, dropping overlay text.
  // Now: emit image element AND continue walking children for overlay
  // content. Section-level bg_image is set by the orchestrator if the
  // image fill is on the section root (handled separately in figmaToDesignSpec).
  const imgFill = extractImageFill(node);
  if (imgFill && imgFill.imageRef) {
    pushImageElement(node, out, ctx, { source: "fill" });
    // CRITICAL: do NOT return — keep walking children for overlay text/CTA.
    // (Pre-v6.2.0 had `return;` here, which dropped hero text like
    // "The Outliers Waiting For You" in Arsenal Pulse.)
  }

  // ------ LINE → divider (CLASS A1 leftover) ------
  // A Figma LINE is a 1-D rule (one dimension ~0) carrying a STROKE, not a fill.
  // It was previously dropped by the silent-return below (not a CONTAINER, no
  // image fill, and not in the atomic vector-family list). Emit it as a divider
  // element so the framework renders a 1px bgcolor row/column — NOT an image.
  if (node.type === "LINE") {
    const d = lineToDivider(node);
    if (d) out.push(d);
    return;
  }

  // ------ DEFECT 9: thin solid-filled RECTANGLE → divider ------
  // A designer draws a rule two ways: as a LINE with a stroke, or as a thin
  // RECTANGLE with a fill. Only the first was handled. The second matched
  // neither the gate above nor CONTAINER_TYPES, so it fell into the silent
  // `return` below and was DROPPED WITH NO RECORD — O1 counts 4 such bars on
  // usaa_1_188 alone (1:243, 1:252, 1:261, 1:271 — 65x2, #FFCF06).
  // lineToDivider() already falls back to a solid fill internally, so only this
  // call-site gate was wrong.
  //
  // BOUNDED DELIBERATELY to 1-D bars. A solid SQUARE is not a rule: routing one
  // here would render a 77x77 block as a 77px stripe — a worse defect than
  // dropping it. Squares, ellipses and gradient bands stay dropped until the
  // schema gains a box element kind (PARSER_DEFECTS.md D7 rank 1), which is a
  // compiler-side decision, not a parser patch. Pinned by control D9-4.
  if (node.type === "RECTANGLE" && !imgFill) {
    const w = getNodeWidth(node), h = getNodeHeight(node);
    const thin = Math.min(w, h), long = Math.max(w, h);
    if (thin >= 1 && thin <= 4 && long >= thin * 8) {
      const d = lineToDivider(node);
      if (d) { out.push(d); return; }
    }
  }

  // ------ DEFECT 13: zero-width stroked VECTOR → divider ------
  // A designer draws a rule THREE ways: a LINE with a stroke (handled above), a
  // thin RECTANGLE with a fill (D9, above), or a VECTOR path with a stroke and a
  // DEGENERATE bbox — the pen-tool case. usaa_1_188's 1:353/1:355 are 0 x 19
  // vertical separators, the last 2 P0 dropped nodes on that design.
  //
  // Why they reach here at all: isAtomicVisualUnit() rasterises a small vector
  // behind `w > 0 && h > 0` (:1599), which a zero-width path fails. It is then
  // neither a LINE nor a RECTANGLE nor a CONTAINER, so it hits the silent
  // `return` immediately below. lineToDivider() already handles it — it rejects
  // only BOTH dims being ~0 and reads colour from the stroke.
  //
  // BOUNDED TO THE DEGENERATE CASE ON PURPOSE. Gating on `thin <= 1` instead
  // would also match 1:350 (0.86 x 32.24) — but that node passes `w > 0`, so the
  // atomic path ALREADY emits it as an el:image and it is not dropped. Widening
  // to `<= 1` would steal a 32px icon from the image path and render it as a 1px
  // stripe. Gating on `thin <= 0` makes this EXACTLY complementary to the :1599
  // rejection: the two sets provably cannot overlap. Pinned by control D13-4.
  //
  // A visible stroke is REQUIRED: a zero-width shape has no fill area, so the
  // stroke is the only thing that renders. `long >= 8` excludes degenerate specks.
  if (node.type === "VECTOR" && !imgFill) {
    const w = getNodeWidth(node), h = getNodeHeight(node);
    const thin = Math.min(w, h), long = Math.max(w, h);
    if (thin <= 0 && long >= 8 && extractStrokeHex(node)) {
      const d = lineToDivider(node);
      if (d) { out.push(d); return; }
    }
  }

  // ------ Non-container RECTANGLE / VECTOR without image fill: skip ------
  // (Vectors and rectangles handled above as atomic units if they qualify.)
  if (!CONTAINER_TYPES.has(node.type) && !imgFill) {
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

  return;
}

// ─── CLASS A — DECORATIVE-SHAPE CAPTURE (v6.x) ──────────────────────────────
// Non-rectangular shape types that can carry a solid/gradient decoration (e.g.
// the Liesl hero's yellow curve, VECTOR 978×985 #FFD447 behind the headline).
// ELLIPSE and LINE were previously unhandled — included here.
const DECORATION_SHAPE_TYPES = new Set([
  "VECTOR", "STAR", "REGULAR_POLYGON", "POLYGON", "BOOLEAN_OPERATION", "ELLIPSE", "LINE",
]);

// Does the node have at least one VISIBLE solid-or-gradient fill (NOT image)?
function hasVisibleNonImageFill(node) {
  if (!Array.isArray(node.fills)) return false;
  return node.fills.some(
    (f) => f && f.visible !== false &&
      (f.type === "SOLID" || (typeof f.type === "string" && f.type.startsWith("GRADIENT")))
  );
}

// Does this node's bbox extend OUTSIDE the email frame on any axis (an organic
// shape bleeding off-frame, e.g. the curve at x=-170..808)? Such a shape is a
// decoration, not a flat section background.
function overhangsFrame(node, ctx) {
  const c = ctx && ctx.clip;
  const b = node && node.absoluteBoundingBox;
  if (!c || !b || !c.width || !c.height) return false;
  const TOL = 2;
  const left = b.x - c.originX, top = b.y - c.originY;
  const right = left + (b.width ?? 0), bottom = top + (b.height ?? 0);
  return left < -TOL || top < -TOL || right > c.width + TOL || bottom > c.height + TOL;
}

// BACKGROUND-SIZE GUARD: is this large shape actually a SECTION BACKGROUND (so
// we must NOT export it as a decoration)? A bg is contained within the section
// and ~fills it. A shape that OVERHANGS the section bounds (bleeds off) is an
// organic decoration, not a bg. Missing geometry → treat as NOT a bg (allow).
function isSectionSizedBackground(node, ctx) {
  const s = ctx && ctx.section;
  const b = node && node.absoluteBoundingBox;
  if (!s || !b || !s.width || !s.height || !b.width || !b.height) return false;
  const TOL = 2;
  const overhangs =
    b.x < s.x - TOL || b.y < s.y - TOL ||
    b.x + b.width > s.x + s.width + TOL || b.y + b.height > s.y + s.height + TOL;
  if (overhangs) return false; // bleeds off the section → organic decoration
  const areaRatio = (b.width * b.height) / (s.width * s.height);
  if (areaRatio >= 0.85) return true; // fills most of the section → background
  return (
    Math.abs(b.x - s.x) <= TOL && Math.abs(b.y - s.y) <= TOL &&
    Math.abs(b.width - s.width) <= TOL && Math.abs(b.height - s.height) <= TOL
  );
}

// A LARGE non-rectangular decorative shape: above the small-icon cap, with a
// visible solid/gradient fill, NOT a section background. Gated on section
// context (ctx.section) so non-walker callers (dedup index) are unaffected.
function isLargeDecorationShape(node, ctx) {
  if (!ctx || !ctx.section) return false;
  if (!node || node.visible === false) return false;
  if (!DECORATION_SHAPE_TYPES.has(node.type)) return false;
  const w = getNodeWidth(node), h = getNodeHeight(node);
  if (w <= 0 || h <= 0) return false;
  if (w <= ATOMIC_VECTOR_MAX_SIZE && h <= ATOMIC_VECTOR_MAX_SIZE) return false; // small → A1
  if (!hasVisibleNonImageFill(node)) return false;
  if (isSectionSizedBackground(node, ctx)) return false;
  return true;
}

// bbox overlap (absolute coords)
function bboxOverlap(a, b) {
  if (!a || !b || a.x == null || b.x == null) return false;
  return !(
    a.x + a.width <= b.x || a.x >= b.x + b.width ||
    a.y + a.height <= b.y || a.y >= b.y + b.height
  );
}

// Does the node itself render visible content (TEXT or a photo/image fill)?
function rendersOwnContent(n) {
  if (!n || n.visible === false) return false;
  if (n.type === "TEXT" && typeof n.characters === "string" && n.characters.trim()) return true;
  if (extractImageFill(n)) return true;
  return false;
}

// LAYERING: does any content node painted AFTER `node` (later in the section's
// pre-order paint order = on top) overlap its bbox? If so the shape sits BEHIND
// content (A2). Uses section-level paint order, not just immediate siblings,
// because the shape may be nested (the curve is the sole child of a GROUP).
function isBehindLaterContent(node, ctx) {
  const root = ctx && ctx.sectionRoot;
  const nb = node && node.absoluteBoundingBox;
  if (!root || !nb) return false;
  if (!ctx._paintOrder) {
    const list = [];
    (function pre(n) {
      if (!n || n.visible === false) return;
      list.push(n);
      for (const c of n.children || []) pre(c);
    })(root);
    ctx._paintOrder = list;
  }
  const order = ctx._paintOrder;
  const myIdx = order.indexOf(node);
  if (myIdx < 0) return false;
  const descendants = new Set();
  (function d(n) { for (const c of n.children || []) { descendants.add(c); d(c); } })(node);
  for (let i = myIdx + 1; i < order.length; i++) {
    const other = order[i];
    if (descendants.has(other)) continue;       // its own children are part of it
    if (!rendersOwnContent(other)) continue;
    if (bboxOverlap(nb, other.absoluteBoundingBox)) return true;
  }
  return false;
}

/**
 * Detect whether a node is an "atomic visual unit" — a designed graphical
 * atom that should be rasterized rather than walked into.
 *
 * Heuristics (v6.2.0):
 *   - INSTANCE: ALWAYS atomic (designer chose to make it reusable)
 *   - COMPONENT: ALWAYS atomic (same reason)
 *   - VECTOR: atomic if both dimensions ≤ 200px (typical icon size)
 *   - GROUP: atomic if entirely composed of VECTOR/RECTANGLE/ELLIPSE
 *     (no text, no nested frames) and ≤ 300px on either axis
 *   - CLASS A (v6.x): a LARGE non-rect shape (VECTOR/STAR/POLYGON/BOOLEAN/
 *     ELLIPSE/LINE) with a solid/gradient fill that is NOT a section bg.
 *
 * NOT atomic:
 *   - Any FRAME (these are layout containers — walk into them)
 *   - Large vectors with no fill / image fill, or section-sized backgrounds
 *   - Groups containing text or frames (not visual atoms)
 *
 * `ctx` (optional) carries section geometry; the large-decoration branch only
 * fires when it is present (i.e. from the section walker, not the dedup index).
 *
 * Why not capture standalone RECTANGLEs without image fills: those are
 * usually section dividers / accent bars / button bgs handled by the
 * CTA detector. Capturing every solid-fill rectangle would produce dozens
 * of tiny images per email.
 */
function isAtomicVisualUnit(node, ctx = null) {
  if (!node || node.visible === false) return false;

  // Components and instances are atomic ONLY if they have no TEXT descendants.
  // Pure visual instances (icons, decorative graphics) get rasterized; instances
  // that contain text (link/button components like "VIEW FULL PROFILE",
  // status pills like "ACTIVELY EXPLORING") are walked into so their text is
  // extracted and CTA detection can fire.
  if (node.type === "COMPONENT" || node.type === "INSTANCE") {
    if (getNodeWidth(node) <= 0 || getNodeHeight(node) <= 0) return false;
    return !hasTextDescendant(node);
  }

  // Small vectors are icons (UNCHANGED behavior + size cap). If a vector-family
  // shape is LARGER than the cap, do NOT return false here — fall through to the
  // CLASS A large-decoration check below.
  // CLASS A1: ELLIPSE included so a small (≤ cap) standalone solid ellipse
  // (bullet dot / colored circle) rasterizes via the atomic/image path like
  // every other small shape, instead of being silently dropped. LINE is NOT
  // here — it renders as a divider (lineToDivider), not a 1px PNG. Large
  // ellipses (> cap) still fall through to the A2 large-decoration path.
  if (node.type === "VECTOR" || node.type === "STAR" || node.type === "REGULAR_POLYGON" ||
      node.type === "POLYGON" || node.type === "BOOLEAN_OPERATION" || node.type === "ELLIPSE") {
    const w = getNodeWidth(node);
    const h = getNodeHeight(node);
    if (w > 0 && h > 0 && w <= ATOMIC_VECTOR_MAX_SIZE && h <= ATOMIC_VECTOR_MAX_SIZE) return true;
  }

  // Vector-only groups are decorative compositions
  if (node.type === "GROUP") {
    const w = getNodeWidth(node);
    const h = getNodeHeight(node);
    if (w > ATOMIC_GROUP_MAX_SIZE || h > ATOMIC_GROUP_MAX_SIZE) return false;
    if (w <= 0 || h <= 0) return false;
    // Walk descendants: must be vector-shape only
    let allVectorShape = true;
    (function check(n) {
      if (!allVectorShape) return;
      if (n.visible === false) return;
      if (n === node) {
        for (const c of n.children || []) check(c);
        return;
      }
      if (n.type === "TEXT" || n.type === "FRAME" || n.type === "INSTANCE" || n.type === "COMPONENT") {
        allVectorShape = false;
        return;
      }
      for (const c of n.children || []) check(c);
    })(node);
    return allVectorShape;
  }

  // CLASS A (v6.x): large non-rectangular decorative shape (VECTOR/STAR/POLYGON/
  // BOOLEAN/ELLIPSE/LINE) above the small cap, with a solid/gradient fill, that
  // is NOT a section background. Only fires with section context (ctx).
  if (isLargeDecorationShape(node, ctx)) return true;

  return false;
}

/**
 * Helper: check if any descendant (skipping the node itself) is a TEXT node.
 * Used by atomic-unit detection to skip rasterizing instances that contain text.
 */
function hasTextDescendant(node) {
  for (const c of node.children || []) {
    if (c.visible === false) continue;
    if (c.type === "TEXT") return true;
    if (hasTextDescendant(c)) return true;
  }
  return false;
}

/**
 * Helper: push an image element to out[] and register it in imageRefs
 * for Phase B export. Used by both atomic-unit and image-fill paths.
 */
function pushImageElement(node, out, ctx, { source, background = false }) {
  const w = Math.round(getNodeWidth(node));
  const h = Math.round(getNodeHeight(node));
  if (w <= 0 || h <= 0) return;

  // For image-fill nodes, use the existing imageRef from the fill.
  // For atomic units (instances/vectors/groups), there's no imageRef in
  // the Figma data — we just record the nodeId and Phase B will call
  // /v1/images to render whatever it is.
  const imgFill = source === "fill" ? extractImageFill(node) : null;

  // v6.4.0: renderKey for dedup. Two INSTANCEs of the same component at
  // the same size render to the same PNG; emit one render, reuse URL.
  //   - INSTANCE: key by componentId+size (Figma instances share master)
  //   - Image-fill nodes: key by imageRef+size (same imageRef = same bitmap)
  //   - Everything else: key by nodeId (always unique)
  let renderKey;
  if (node.type === "INSTANCE" && node.componentId) {
    renderKey = `instance:${node.componentId}:${w}x${h}`;
  } else if (imgFill?.imageRef) {
    renderKey = `imageref:${imgFill.imageRef}:${w}x${h}`;
  } else {
    renderKey = `node:${node.id}`;
  }

  ctx.imageRefs.push({
    nodeId: node.id,
    imageRef: imgFill?.imageRef ?? null,
    renderKey,                                  // v6.4.0
    width: w,
    height: h,
    name: node.name,
    source, // "fill" or "atomic" — for diagnostics
  });

  const el = {
    el: "image",
    src: "", // Phase B fills this with Dropbox URL after export
    alt: node.name || "Image",
    width: w,
    height: h,
    _figmaNodeId: node.id,
    _imageRef: imgFill?.imageRef ?? null, // v6.5.0: raw imageRef for bg_image extraction
  };

  // CLASS A2: a decorative shape that sits behind content is marked so the
  // framework composites it as a cell background-image with the overlapping
  // content layered ON TOP — NOT rendered as its own flow row.
  if (background) {
    el.role = "bg_decoration";
    el.layer = "background";
    const b = node.absoluteBoundingBox;
    if (b) {
      const ox = ctx && ctx.clip ? ctx.clip.originX : 0;
      const oy = ctx && ctx.clip ? ctx.clip.originY : 0;
      el.bbox = {
        x: Math.round(b.x - ox), y: Math.round(b.y - oy),
        w: Math.round(b.width), h: Math.round(b.height),
      };
    }
    if (ctx && ctx._paintOrder) {
      const zi = ctx._paintOrder.indexOf(node);
      if (zi >= 0) el.z_order = zi; // lower = further back
    }
  }

  out.push(el);
}

// CLASS C — non-destructive merge-field HINT (option B). The parser NEVER
// alters design text (verbatim-faithfulness is load-bearing); it only FLAGS a
// likely personalization placeholder so the ESP layer can later map the role to
// the chosen ESP's token (see esp-registry.md). Detection is deliberately
// conservative — a false positive corrupts meaning, a false negative is safe.
const _MF_SALUT_RE = /^(hallo|hi|hello|hey|dear|liebe[rs]?|bonjour|hola)\b\s+(\S+)$/i;
const _MF_KNOWN_STUBS = new Set(["xy", "xyz", "x", "name", "firstname", "fname", "recipient", "vorname", "first_name"]);
// already a REAL merge token ({{…}} / %%…%% / ${…} / *|…|*) → handled verbatim, NOT a placeholder.
const _MF_REAL_TOKEN_RE = /\{\{[^}]+\}\}|%%[^%]+%%|\$\{[^}]+\}|\*\|[^|]+\|\*/;

/**
 * Detect a personalization placeholder WITHOUT touching the text. Matches ONLY a
 * salutation followed by EXACTLY one short non-name stub (the whole string is
 * "<salutation> <stub>", nothing else). Returns { role, placeholder, reason } or
 * null. Conservative by design: "Hi there" / "Hallo Welt" / "Dear Team" /
 * "Hello again" / any salutation + a plausible real word or vowel-bearing short
 * name (Al, Ed, Jo) → NOT flagged. Real tokens are excluded.
 */
function detectMergeFieldHint(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (_MF_REAL_TOKEN_RE.test(t)) return null;       // already a real merge token
  const m = _MF_SALUT_RE.exec(t);
  if (!m) return null;                              // not "<salutation> <one-token>"
  const stub = m[2];
  const lower = stub.toLowerCase();
  let isStub = false;
  if (_MF_KNOWN_STUBS.has(lower)) isStub = true;                               // known stub (xy, name, fname…)
  else if (/^[[<{].+[\]>}]$/.test(stub)) isStub = true;                        // bracket/placeholder token: [name] <name> {name}
  else if (/^[a-z]{1,2}$/i.test(stub) && !/[aeiou]/i.test(stub)) isStub = true; // 1–2 char consonant-only stub (xy, x) — excludes real short names (Al, Ed, Jo)
  if (!isStub) return null;
  return { role: "first_name", placeholder: stub, reason: "salutation+stub" };
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
    // DEFECT 6: carry Figma node identity, exactly as pushImageElement already
    // does. Without it O1 can identity-match only the image path, so
    // DROPPED_NODE / PHANTOM_NODE are inexpressible over every text node.
    // Purely additive: contentEquals compares text elements field-wise (not by
    // JSON.stringify), so collapseRepeats and dedupAdjacentSections are
    // unaffected, and cc-runner's METADATA_KEYS already excludes _figmaNodeId.
    _figmaNodeId: node.id,
  };
  if (transform) el.transform = transform;
  if (typeof style.letterSpacing === "number" && style.letterSpacing !== 0) {
    el.letter_spacing = Number(style.letterSpacing.toFixed(2));
  }

  // ── ADDITIVE: per-run (per-character-range) colour/weight capture ──────────
  // Figma stores in-node style runs as characterStyleOverrides (one override id
  // per character; 0/absent = base) + styleOverrideTable (id -> partial style).
  // Mixed-style text (a coloured or bolded word inside a line) is otherwise lost
  // by the single flat color/weight above. We segment the characters into runs
  // of constant effective (color, weight) and attach item.spans — ONLY when the
  // node is genuinely mixed (>1 run, with a run differing from the base). The
  // flat color/weight stay as the node's dominant/base value; spans is additive.
  try {
    // CLASS D: node-level hyperlink (the WHOLE text line is a link, set at
    // node.style.hyperlink) — applies whether or not the node has per-character
    // style overrides, so it must NOT be gated behind characterStyleOverrides.
    // Decode percent-encoding so merge-field tokens stay literal; never invent.
    if (node.style && node.style.hyperlink && typeof node.style.hyperlink.url === "string") {
      try { el.href = decodeURIComponent(node.style.hyperlink.url); }
      catch (_) { el.href = node.style.hyperlink.url; }
    }

    const cso = node.characterStyleOverrides;
    const sot = node.styleOverrideTable || {};
    if (Array.isArray(cso) && cso.length > 0) {
      const chars = characters.split("");
      const baseColor = color;     // node base fill hex (== flat color field)
      const baseWeight = weight;   // node base fontWeight (== flat weight field)

      const resolveColor = (ov) => {
        const o = ov && sot[ov];
        if (o && Array.isArray(o.fills)) {
          const solid = o.fills.find(
            (f) => f && f.visible !== false && f.type === "SOLID" && f.color
          );
          if (solid) return figmaColorToHex(solid.color);
        }
        return baseColor;
      };
      const resolveWeight = (ov) => {
        const o = ov && sot[ov];
        return (o && typeof o.fontWeight === "number") ? o.fontWeight : baseWeight;
      };
      // CLASS D: capture a real per-run hyperlink (Figma stores it on the style
      // override as hyperlink:{ type:"URL", url:"..." }). Decode percent-encoding
      // so merge-field tokens become literal again ({{customer.email}}) and work
      // in the ESP — never invent a URL, only emit what the design carries.
      const resolveHyperlink = (ov) => {
        const o = ov && sot[ov];
        const url = o && o.hyperlink && typeof o.hyperlink.url === "string" ? o.hyperlink.url : null;
        if (!url) return null;
        try { return decodeURIComponent(url); } catch (_) { return url; }
      };

      const runs = [];
      for (let i = 0; i < chars.length; i++) {
        const ov = cso[i] || 0;
        const c = resolveColor(ov);
        const w = resolveWeight(ov);
        const h = resolveHyperlink(ov);
        const last = runs[runs.length - 1];
        if (last && last.color === c && last.weight === w && last.href === h) {
          last.text += chars[i];
        } else {
          runs.push({ text: chars[i], color: c, weight: w, href: h });
        }
      }

      const anyHref = runs.some((r) => r.href);
      const mixed =
        runs.length > 1 &&
        runs.some((r) => r.color !== baseColor || r.weight !== baseWeight);
      // Emit spans when genuinely mixed by colour/weight OR when a run carries a
      // hyperlink (so a partial inline link surfaces even on uniform-styled text).
      if (mixed || anyHref) {
        el.spans = runs.map((r) => {
          const span = { text: r.text, color: r.color, weight: r.weight };
          if (r.href) span.href = r.href; // include href ONLY on linked runs
          return span;
        });
      }
    }
  } catch (_) {
    /* defensive: never let span capture break the flat text element */
  }

  // CLASS C: non-destructive personalization hint. el.text stays EXACTLY the
  // verbatim design text; we only ATTACH a hint when a placeholder is detected.
  const _mfHint = detectMergeFieldHint(characters);
  if (_mfHint) el.suspected_merge_field = _mfHint;

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

/**
 * CLASS A1 (LINE → divider): convert a Figma LINE node into a divider spec
 * element. A LINE is a 1-D rule — one bbox dimension is ~0 — whose visible
 * colour comes from its STROKE (lines have no fill). Email renders this as a
 * 1px (or thickness-px) high <tr><td> with bgcolor = the stroke colour (a thin
 * <td> column when vertical), NOT a rasterized image — lighter and Outlook-safe.
 *
 * Returns { el:"divider", orientation, color, thickness, length } or null when
 * the node is invisible, has no visible stroke AND no solid fill, or is
 * degenerate (both dims ~0). The clip-guard in collect() has already run.
 */
function lineToDivider(node) {
  if (!node || node.visible === false) return null;
  const w = getNodeWidth(node), h = getNodeHeight(node);
  if (w < 1 && h < 1) return null; // degenerate (both dims ~0) → nothing to draw

  // Visible colour: stroke first (the normal LINE case), then a solid fill as a
  // fallback (a thin shape drawn with a fill rather than a stroke).
  const stroke = extractStrokeHex(node);
  let color = stroke ? stroke.hex : null;
  let weight = stroke && typeof stroke.weight === "number" ? stroke.weight : null;
  if (!color) {
    const fillHex = extractBgHex(node);
    if (fillHex) { color = fillHex; if (weight == null) weight = Math.min(w, h) || 1; }
  }
  if (!color) return null; // no visible stroke AND no solid fill → nothing to render

  const orientation = w >= h ? "horizontal" : "vertical";
  return {
    // DEFECT 9 / DEFECT 6: dividers were the last element kind emitted WITHOUT
    // node identity. Emitting the bars without this raised content coverage but
    // DROPPED O1's identity ratio 100.00% -> 92.98% (4 UNMATCHED) — the parser
    // would have been more correct and less PROVABLE at the same time.
    _figmaNodeId: node.id,
    el: "divider",
    orientation,
    color,
    thickness: Math.max(1, Math.round(weight || 1)),
    length: Math.round(orientation === "horizontal" ? w : h),
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
// 9b. SLICE ROUTING — MANDATE line 48. Added C77 / DEFECT 17.
//
//   "blend modes, gaussian blur, masks, boolean ops and rotation CANNOT be
//    expressed in email HTML. Detect them at parse time and route those
//    sections STRAIGHT TO SLICE — do not waste repair cycles."
//
// Until now this parser had NO slice concept: `grep -i slice` returned only
// Array.prototype.slice. Every one of the 66 nodes the design routes on
// usaa_1_188 compiled FLAT — a masked group emitted as a plain box, a rotated
// node emitted at its axis-aligned bounding box. That class of wrongness is
// INVISIBLE to every other oracle here, because the geometry is right and only
// the PAINT is wrong: O2 compares boxes and finds nothing to report.
//
// STRICTLY ADDITIVE. This is a read-only pass over the frame that appends ONE
// new top-level field, `designSpec._sliceRouted`. It does not alter emission,
// does not remove a node, and nothing downstream consumes it yet — routing is
// REPORTED here so O1 and the O9 roadmap can count it. Making the compiler act
// on it is a separate change with a real blast radius, deliberately not taken
// on in the same edit that introduces the detection.
//
// THE RULE IS A PORT, NOT A NEW ONE. It mirrors oracle/figma-rest.mjs
// `sliceReasons`, including BOTH hard-won suppressions, because an independent
// second rule would drift from the one the rest of the pipeline routes on:
//
//   C20/C53  a zero-thickness axis-aligned LINE/VECTOR with a solid stroke is a
//            BORDER, not a vector. Routing those re-slices the rules C53 freed
//            and taints their parent frame, costing live text — measured at 3
//            TEXT nodes on FRAME 1:351 alone.
//   C56      a full, solid, unstroked ELLIPSE is `border-radius:50%`, not
//            boolean geometry. arcData is what distinguishes a disc from a
//            wedge, so it is read rather than assumed.
//
// Over-routing is the failure mode to fear here, and it is a QUIET one: a slice
// is exact by definition, so slicing more raises the O9 slice ratio while every
// accuracy check stays green. d17-sliceconcept-failsfirst pins both
// suppressions as controls for exactly that reason.
//
// The walk does NOT short-circuit at a routed node. Each node is judged on its
// own properties, matching buildDoc — a routed ancestor does not excuse its
// children from being counted.
// =====================================================================

const _SR_TAU = Math.PI * 2;
const _SR_BOOLEAN_OPS = new Set(["BOOLEAN_OPERATION", "VECTOR", "STAR", "POLYGON", "LINE", "ELLIPSE"]);
const _SR_RULE_CAPABLE = new Set(["LINE", "VECTOR"]);

const _srFirstVisible = (arr) => (arr || []).find((p) => p.visible !== false) || null;

/** Rotation in degrees, derived from relativeTransform (Figma emits no angle). */
function _srRotation(node) {
  const t = node.relativeTransform;
  if (!t || !t[0] || !t[1]) return 0;
  const deg = (Math.atan2(t[1][0], t[0][0]) * 180) / Math.PI;
  return Math.abs(deg) < 1e-9 ? 0 : Math.round(deg * 1000) / 1000;
}

/** Stroke weight, ZERO when the node carries no strokes at all. */
function _srStrokeWidth(node) {
  return (node.strokes || []).length ? (node.strokeWeight ?? 0) : 0;
}

/** C20/C53 — degenerate on exactly one axis, unrotated, solid stroke => border. */
function _srIsAxisAlignedRule(node) {
  if (!_SR_RULE_CAPABLE.has(node.type)) return false;
  if (_srRotation(node)) return false;                  // diagonal -> real vector
  const stroke = _srFirstVisible(node.strokes);
  if (!_srStrokeWidth(node) || !stroke || stroke.type !== "SOLID") return false;
  // A FILLED vector is arbitrary shape geometry (an icon outline), not a rule.
  // LINE is exempt: it has no fill by construction, so the test would be inert.
  if (node.type === "VECTOR" && _srFirstVisible(node.fills)) return false;
  const bb = node.absoluteBoundingBox || { width: 0, height: 0 };
  const degenerateY = Math.abs(bb.height ?? 0) < 0.5;
  const degenerateX = Math.abs(bb.width ?? 0) < 0.5;
  return degenerateY !== degenerateX;                   // exactly one axis collapsed
}

/** C56 — a full solid unstroked ellipse is a border-radius box. */
function _srIsRadiusBox(node) {
  if (node.type !== "ELLIPSE") return false;
  const a = node.arcData;
  const full = !a || (Math.abs(a.startingAngle ?? 0) < 1e-6 &&
                      Math.abs((a.endingAngle ?? _SR_TAU) - _SR_TAU) < 1e-6 &&
                      (a.innerRadius ?? 0) === 0);
  if (!full) return false;                              // wedge / donut -> real geometry
  const fill = _srFirstVisible(node.fills);
  if (!fill || fill.type !== "SOLID") return false;     // unfilled or non-SOLID paint
  if (_srStrokeWidth(node)) return false;               // border box, not this path
  const bb = node.absoluteBoundingBox;
  if (!bb || !(bb.width > 0) || !(bb.height > 0)) return false;
  const isCircle = Math.abs(bb.width - bb.height) < 0.5;
  // A circle is invariant under rotation — geometric fact, not a tolerance.
  // A rotated OVAL genuinely changes its painted shape, so it stays routed.
  if (_srRotation(node) && !isCircle) return false;
  return true;
}

/**
 * Why this node cannot be expressed in email HTML. Empty array = expressible.
 * Each reason is NAMED so MANDATE O9 can rank the capabilities that would
 * convert slices back to live text.
 */
export function sliceReasonsForNode(node) {
  const reasons = [];
  if (_srIsAxisAlignedRule(node)) return reasons;       // C20/C53 — short-circuits

  const blend = node.blendMode ?? "PASS_THROUGH";
  if (blend !== "PASS_THROUGH" && blend !== "NORMAL")
    reasons.push({ property: "effect.blendMode", value: blend,
                   why: "no CSS mix-blend-mode support in email clients" });

  const blurs = (node.effects || []).filter((e) => e.visible !== false && /BLUR$/.test(e.type));
  if (blurs.length)
    reasons.push({ property: "effect.blur",
                   value: blurs.map((b) => `${b.type}:${b.radius ?? 0}`).join(","),
                   why: "no CSS filter support in email clients" });

  if (node.isMask === true)
    reasons.push({ property: "effect.mask", value: true,
                   why: "no CSS mask support in email clients" });

  const rot = _srRotation(node);
  if (rot)
    reasons.push({ property: "effect.rotation", value: rot,
                   why: "no CSS transform support in email clients; AABB geometry would certify clean while the render is wrong" });

  // C56 suppresses ONLY this reason — a masked or blurred ellipse has already
  // accumulated its own reason above and still routes.
  if (_SR_BOOLEAN_OPS.has(node.type) && !_srIsRadiusBox(node))
    reasons.push({ property: "node.type", value: node.type,
                   why: "vector/boolean geometry has no HTML equivalent" });

  return reasons;
}

/** Read-only pass over the frame. Hidden nodes are not routed — nothing paints them. */
function collectSliceRouting(root) {
  const out = [];
  (function walk(node) {
    if (!node || node.visible === false) return;
    const reasons = sliceReasonsForNode(node);
    if (reasons.length) out.push({ id: node.id, name: node.name, type: node.type, reasons });
    for (const child of node.children || []) walk(child);
  })(root);
  return out;
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

  // v6.3.0: build parent map for ancestor-aware bg resolution. Without
  // this, sections with no fill default to white even when the email
  // frame's actual bg is dark — causing white-on-white invisible text.
  const parentMap = buildParentMap(emailFrame);

  // 7. Walk each section into spec form
  // Clip-bounds: thread the email frame geometry so the content walker can drop
  // nodes the fixed-size frame clips away entirely (clipsContent overflow — e.g.
  // a ticker/marquee tab positioned past the frame's right edge). null when the
  // frame geometry is absent or degenerate → the guard is skipped (we never drop
  // a node just because geometry is missing).
  const _efbb = emailFrame.absoluteBoundingBox || null;
  const _efh = Math.round(_efbb?.height ?? 0);
  const ctx = {
    imageRefs: [],
    clip: (_efbb && emailWidth > 0 && _efh > 0) ? {
      originX: _efbb.x ?? 0,
      originY: _efbb.y ?? 0,
      width: emailWidth,
      height: _efh,
    } : null,
  };
  const sections = [];
  const frameOrigin = emailFrame.absoluteBoundingBox?.y ?? 0;
  // v6.3.0: email frame's bg becomes the fallback for sections without
  // their own fill (matches how Figma visually renders nested frames).
  const emailFallbackBg = extractBgHex(emailFrame) || "#FFFFFF";

  sectionNodes.forEach((node, idx) => {
    const content = walkSection(node, ctx);
    if (content.length === 0) return; // empty section — skip

    const bbox = node.absoluteBoundingBox || {};
    const yStart = Math.round((bbox.y ?? 0) - frameOrigin);
    const yEnd = Math.round(yStart + (bbox.height ?? 0));
    // v6.3.0: ancestor-aware bg. If the section frame has no fill,
    // walk up the parent chain until we find one. Final fallback is
    // the email frame's bg, then white.
    const bg = extractEffectiveBg(node, parentMap, emailFallbackBg);
    const pad = extractPadding(node);
    const align = mapTextAlign((node.children || [])[0]?.style?.textAlignHorizontal); // best guess

    const section = {
      n: sections.length + 1,
      // DEFECT 6: the section frame's Figma identity. See textNodeToSpec.
      _figmaNodeId: node.id,
      type: "body_text", // re-assigned below
      bg,
      pad,
      align,
      y_start: yStart,
      y_end: yEnd,
      content,
      height: Math.round(bbox.height ?? 0), // used by inferSectionType, then deleted
    };

    // --- Layer-A capture (additive; does NOT touch bg/layout/flattening) ---
    // Emit stroke / radius / gradient only when present & non-default.
    const _stroke = extractStrokeHex(node);
    if (_stroke) {
      section.stroke = _stroke;
      section.card_border = _stroke.hex; // mirror into existing palette-read field
    }
    const _radius = extractRadius(node);
    if (_radius > 0) section.radius = _radius;
    const _gradient = extractGradient(node);
    if (_gradient) section.gradient = _gradient;
    // Debug ground-truth: the section node's raw fills (type + SOLID hex),
    // so we can see whether bg came from a real fill or a fallback.
    section._raw_fills = Array.isArray(node.fills)
      ? node.fills.map((f) => ({
          type: f.type,
          hex: f.type === "SOLID" ? figmaColorToHex(f.color) : null,
          visible: f.visible !== false,
        }))
      : [];

    // v6.2.0: promote section-spanning image to bg_image. If the section's
    // FIRST content element is an image that covers ~the full section width,
    // it's a background image (hero pattern). The overlay text/CTA remain
    // in content[]; Stage 2 renders <td background="..."> with content inside.
    if (content.length > 0 && content[0].el === "image") {
      const img = content[0];
      const sectionWidth = bbox.width ?? 0;
      // bg image: covers ≥85% of section width AND there's other content after it
      if (img.width >= sectionWidth * 0.85 && content.length > 1) {
        section.bg_image = {
          _figmaNodeId: img._figmaNodeId,
          _imageRef: img._imageRef,   // v6.5.0: enables raw image URL extraction
          src: "",                    // populated by Phase B
          width: img.width,
          height: img.height,
          alt: img.alt,
        };
        // remove from inline content - it's now the section background
        content.shift();
      }
    }

    // L-2a: inner-container capture (additive metadata; content[] untouched).
    // Computed AFTER the bg_image shift so content_indices align with the
    // final content[] order.
    section.containers = captureContainers(node, bg, content);

    // L-2b: grid geometry for multi-item rows (additive; derived from the
    // L-2a containers + node layout fields; content[] untouched).
    const _grid = deriveSectionGrid(node, section.containers);
    if (_grid) section.grid = _grid;

    // CLASS B (L-2d): two-column image+text rows → section.column_split.
    // Additive; content[] is untouched. Gated OFF when a grid was derived
    // (a tile grid is not a two-column image+text row).
    const _split = detectColumnSplits(node, content, _grid);
    if (_split) section.column_split = _split;

    section.type = inferSectionType(section, idx, sectionNodes.length, content);
    delete section.height;
    sections.push(section);
  });

  if (sections.length === 0) {
    throw new Error("Parsed Figma frame produced zero content sections. Check the frame contains visible text/images.");
  }

  // v6.0.1: cross-section dedup. Removes adjacent sections with identical
  // content + bg + type (e.g., Kenect's Audi North Park testimonial card
  // duplicated by hidden layers in the source file).
  const dedupedSections = dedupAdjacentSections(sections);
  // Renumber after dedup so 'n' fields stay sequential
  dedupedSections.forEach((s, i) => { s.n = i + 1; });

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
    // RC-3: derive dark_mode from the DOMINANT/email-wrapper bg (NOT per-section
    // bgs — one light §3 band must not flip the verdict). emailFallbackBg is the
    // email frame's own fill (extractBgHex(emailFrame)), the page's base colour.
    dark_mode: isDarkBackground(emailFallbackBg),
    sections: dedupedSections,
    band_count: dedupedSections.length,
  };

  // v6.1.0-rtl (Phase 2): deterministic RTL detection over already-captured text.
  // Default "ltr" (every existing LTR email is byte-unchanged). When "rtl", flag
  // purely-LTR runs as ltr_hint for the framework's dir="ltr" islands (§DSF-RTL).
  // NOT deployed to prod until end-to-end is proven on a real RTL Figma design.
  designSpec.text_direction = computeSpecDirection(dedupedSections);
  if (designSpec.text_direction === "rtl") {
    markLtrIslands(dedupedSections);
  }

  // RC-1 brand-font wiring: also emit brand_font + font_stack so the framework's
  // existing brand-font machinery (DSF-1, the @import, the validator's hard
  // brand-font check) keys off a populated field instead of staying dormant.
  // ONLY when a REAL family was detected from text nodes — never when
  // detectedFont fell back to the hardcoded "Arial" default, so we never
  // force-enforce "Arial" as if it were a brand font. font_body/font_heading
  // are left exactly as-is (this is purely additive).
  if (detectedFont && detectedFont !== "Arial") {
    designSpec.brand_font = detectedFont;
    designSpec.font_stack = `'${detectedFont}', Arial, Helvetica, sans-serif`;
  }

  designSpec._palette = buildPalette(designSpec);
  designSpec.palette_used = designSpec._palette;

  // C77 / DEFECT 17 — MANDATE line 48. Additive: a new top-level field, read by
  // O1 and the O9 roadmap. Walked from the EMAIL FRAME (not contentRoot) so the
  // node universe matches the REST doc the oracle compares against. Nothing in
  // the emission path reads this yet — see the section 9b header for why acting
  // on it is deliberately a separate change.
  designSpec._sliceRouted = collectSliceRouting(emailFrame);

  // v6.1.0: _figmaNodeId on image elements is intentionally left in the spec
  // here. The server's Phase B image-export step uses it to match Dropbox
  // URLs back to spec elements, then strips it before sending to Stage 2.
  // (Previously stripped in v6.0.x because Phase A had no use for it.)

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
