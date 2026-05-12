// =====================================================================
// MAVELOPER FIGMA IMAGE EXPORT — v6.1.0
//
// Calls Figma's /v1/images endpoint to render selected nodes as PNGs,
// downloads them, and returns them in the same {filename, buffer} shape
// the existing uploadImagesToDropbox function expects.
//
// Why a separate module: keeps server.js focused; lets us test in
// isolation; reuses zero state from the parser (just consumes its
// imageRefs[] output).
//
// Figma /v1/images contract recap:
//   GET /v1/images/{fileKey}?ids=NODE_ID,NODE_ID,...&format=png&scale=2
//   Returns: { images: { "NODE_ID": "https://signed-url" } }
//   - URLs valid ~30 days (we download immediately, no caching)
//   - Limit: 100 node IDs per call (we batch if needed)
//   - Some nodes may return null (rare, treat as soft failure)
// =====================================================================

const FIGMA_API_BASE = "https://api.figma.com/v1";
const FIGMA_API_TIMEOUT_MS = 60 * 1000;  // images can take longer than node fetch
const FIGMA_RENDER_SCALE = 2;             // 2x for retina-friendly email
const FIGMA_BATCH_SIZE = 50;              // well under Figma's 100 limit
const PNG_DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const PNG_DOWNLOAD_CONCURRENCY = 5;       // parallel downloads from signed URLs

/**
 * Render and download Figma nodes as PNG buffers.
 *
 * @param {Object} opts
 * @param {string} opts.fileKey         - Figma file key
 * @param {string[]} opts.nodeIds       - array of node IDs (Figma format, e.g. "191:50")
 * @param {string} opts.token           - Figma personal access token
 * @param {Function} [opts.logFn]       - optional logger (level, msg, meta)
 * @param {Function} [opts.fetchImpl]   - inject fetch for testing
 * @returns {Promise<Map<string, Buffer>>}  Map of nodeId → PNG Buffer.
 *                                          Missing/failed nodes are simply
 *                                          omitted from the map (caller decides
 *                                          what to do; soft-fail philosophy).
 */
export async function renderFigmaNodes({ fileKey, nodeIds, token, logFn = noop, fetchImpl = fetch }) {
  if (!nodeIds || nodeIds.length === 0) return new Map();
  if (!fileKey) throw new Error("renderFigmaNodes: fileKey is required");
  if (!token) throw new Error("renderFigmaNodes: token is required");

  // Step 1: ask Figma to render the nodes. Returns signed S3 URLs.
  const urlMap = await fetchRenderUrls({ fileKey, nodeIds, token, logFn, fetchImpl });

  // Step 2: download each PNG in parallel (bounded concurrency).
  const bufferMap = await downloadAll(urlMap, logFn, fetchImpl);

  return bufferMap;
}

/**
 * Build a clean image filename from a Figma node name + dimensions.
 * Used so Dropbox URLs are human-readable in the ZIP.
 *
 * Examples:
 *   "Hero Image" 600x300 → hero-image-600x300.png
 *   "Frame 12345"       → frame-12345.png
 *   ""                  → image.png  (fallback for unnamed nodes)
 *
 * Collision handling: caller passes a Set of names already used; we
 * append -2, -3, etc. if needed.
 */
export function makeFilename(rawName, width, height, takenSet) {
  let base = (rawName || "image")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!base) base = "image";

  let candidate = `${base}.png`;
  let n = 2;
  while (takenSet.has(candidate)) {
    candidate = `${base}-${n}.png`;
    n++;
  }
  takenSet.add(candidate);
  return candidate;
}

/**
 * Convenience: given parser imageRefs + Dropbox imageUrlMap, walk the
 * designSpec and patch each image element's src field. Mutates spec
 * in-place. Also strips the internal _figmaNodeId tracker field after
 * patching so Stage 2 sees a clean spec.
 *
 * @param {Object} designSpec
 * @param {Map<string,string>} nodeIdToFilename  - from buildNodeIdToFilename()
 * @param {Object} imageUrlMap                   - { filename: directUrl } from Dropbox
 * @returns {{patched: number, missing: number}} count summary
 */
export function patchSpecImageSrcs(designSpec, nodeIdToFilename, imageUrlMap) {
  let patched = 0;
  let missing = 0;

  for (const section of designSpec.sections || []) {
    for (const el of section.content || []) {
      if (el.el !== "image") continue;
      const nodeId = el._figmaNodeId;
      const filename = nodeId ? nodeIdToFilename.get(nodeId) : null;
      const url = filename ? imageUrlMap[filename] : null;
      if (url) {
        el.src = url;
        patched++;
      } else {
        missing++;
      }
      delete el._figmaNodeId;  // strip internal marker regardless
    }
  }
  return { patched, missing };
}

// =====================================================================
// INTERNAL: Figma /v1/images call (batched + retry)
// =====================================================================

async function fetchRenderUrls({ fileKey, nodeIds, token, logFn, fetchImpl }) {
  const urlMap = new Map();  // nodeId → signed S3 URL

  // Batch into groups of FIGMA_BATCH_SIZE
  for (let i = 0; i < nodeIds.length; i += FIGMA_BATCH_SIZE) {
    const batch = nodeIds.slice(i, i + FIGMA_BATCH_SIZE);
    const idsParam = batch.join(",");
    const url = `${FIGMA_API_BASE}/images/${fileKey}?ids=${encodeURIComponent(idsParam)}&format=png&scale=${FIGMA_RENDER_SCALE}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FIGMA_API_TIMEOUT_MS);

    let response;
    try {
      response = await fetchImpl(url, {
        headers: { "X-Figma-Token": token },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new Error(`Figma /v1/images timed out after ${FIGMA_API_TIMEOUT_MS / 1000}s on batch of ${batch.length} nodes.`);
      }
      throw new Error(`Figma /v1/images request failed: ${err.message}`);
    }
    clearTimeout(timer);

    if (response.status === 429) {
      // Figma's rate limit: backoff once, retry this batch
      logFn("warn", "Figma /v1/images rate-limited (429); waiting 5s then retrying batch");
      await sleep(5000);
      const retryResponse = await fetchImpl(url, { headers: { "X-Figma-Token": token } });
      if (!retryResponse.ok) {
        throw new Error(`Figma /v1/images still rate-limited after retry: ${retryResponse.status}`);
      }
      response = retryResponse;
    }
    if (response.status === 404) {
      throw new Error("Figma file or nodes not found (404) during image render.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("Figma API rejected token during image render (401/403).");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Figma /v1/images returned ${response.status}: ${body.substring(0, 300)}`);
    }

    const json = await response.json();
    if (json.err) {
      throw new Error(`Figma /v1/images error: ${json.err}`);
    }
    const images = json.images || {};
    for (const [nodeId, signedUrl] of Object.entries(images)) {
      if (signedUrl) urlMap.set(nodeId, signedUrl);
      // null URLs are valid - Figma couldn't render that node. Silently skip.
    }
  }

  logFn("info", `Figma rendered ${urlMap.size}/${nodeIds.length} nodes`, { fileKey });
  return urlMap;
}

// =====================================================================
// INTERNAL: parallel PNG download with bounded concurrency
// =====================================================================

async function downloadAll(urlMap, logFn, fetchImpl) {
  const entries = Array.from(urlMap.entries());
  const bufferMap = new Map();

  // Simple semaphore-style concurrency
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const idx = cursor++;
      const [nodeId, signedUrl] = entries[idx];
      try {
        const buf = await downloadOne(signedUrl, fetchImpl);
        bufferMap.set(nodeId, buf);
      } catch (err) {
        logFn("warn", `Figma image download failed for node ${nodeId}`, { error: err.message });
      }
    }
  }

  const workers = Array.from({ length: Math.min(PNG_DOWNLOAD_CONCURRENCY, entries.length) }, worker);
  await Promise.all(workers);

  logFn("info", `Figma downloaded ${bufferMap.size}/${entries.length} PNGs`);
  return bufferMap;
}

async function downloadOne(signedUrl, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PNG_DOWNLOAD_TIMEOUT_MS);
  try {
    const r = await fetchImpl(signedUrl, { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const arrayBuf = await r.arrayBuffer();
    return Buffer.from(arrayBuf);
  } finally {
    clearTimeout(timer);
  }
}

// =====================================================================
// UTILITIES
// =====================================================================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function noop() {}
