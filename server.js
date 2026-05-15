import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pdfToPng } from "pdf-to-png-converter";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import AdmZip from "adm-zip";
import { Dropbox } from "dropbox";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { detectBands, buildColorPalette, samplePixelColor, cropBand, postProcessOcr } from "./band-detector.js";
import { figmaToDesignSpec } from "./figma-parser.js";
import { renderFigmaNodes, makeFilename, patchSpecImageSrcs, fetchRawImageRefUrls } from "./figma-image-export.js";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";
import { Agent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

// v9.1.2: set a process-wide long-timeout dispatcher for the bridge fetch.
// Previous v9.1.1 used per-call `dispatcher` option with .close() in finally,
// but Node's fetch reads the response body lazily — closing the Agent before
// .json() reads the body kills the in-flight read. Global dispatcher avoids
// this entirely; the agent stays alive for the process lifetime.
const BRIDGE_LONG_TIMEOUT_MS = 45 * 60 * 1000;
const _bridgeAgent = new Agent({
  headersTimeout: BRIDGE_LONG_TIMEOUT_MS,
  bodyTimeout: BRIDGE_LONG_TIMEOUT_MS,
  connectTimeout: 30 * 1000,
  keepAliveTimeout: 60 * 1000,
  keepAliveMaxTimeout: BRIDGE_LONG_TIMEOUT_MS,
});
setGlobalDispatcher(_bridgeAgent);

// =====================================================================
// STARTUP VALIDATION
// =====================================================================
if (!process.env.CLAUDE_API_KEY) {
  console.error("FATAL: CLAUDE_API_KEY environment variable is not set.");
  console.error("Set it in Railway -> maveloper-backend -> Variables.");
  process.exit(1);
}

const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY;
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET;
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;

const dropboxConfigured = Boolean(DROPBOX_APP_KEY && DROPBOX_APP_SECRET && DROPBOX_REFRESH_TOKEN);

if (!dropboxConfigured) {
  console.warn("WARNING: Dropbox credentials not fully configured. Image upload and ZIP delivery will be disabled.");
  console.warn("Set DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN in Railway Variables.");
}

// v6.0.0: Figma API token for the /generate-from-figma endpoint.
// Optional — if not set, only the PDF /generate endpoint is available.
const FIGMA_API_TOKEN = process.env.FIGMA_API_TOKEN;
const figmaConfigured = Boolean(FIGMA_API_TOKEN);
if (!figmaConfigured) {
  console.warn("WARNING: FIGMA_API_TOKEN not set. /generate-from-figma will return 503 until configured.");
}

// =====================================================================
// CONFIGURATION
// =====================================================================
const PORT = process.env.PORT || 3000;
// v7.0.0: Default to Claude Opus 4.7 for stronger layout reasoning from
// the multimodal Stage 2 input (JSON spec + Figma render image). To switch
// back to Sonnet without redeploy: set CLAUDE_MODEL=claude-sonnet-4-5 in
// Railway env vars and restart. Cost trade-off: Opus is ~10× per generation
// but materially better at multi-step layout reasoning.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-7";

// =====================================================================
// v8.0.0 — REFERENCE HTML LIBRARY
//
// Map Figma fileKey → human-coded HTML reference path. When a request
// arrives for one of these files, Stage 2 receives the human-coded
// HTML as a few-shot example, instructed to MATCH ITS STYLISTIC
// PATTERNS (bordered cards, capsule pills, vertical-line dividers,
// red status colors, side-by-side layouts) while adapting structure
// and content to the new spec.
//
// To add a new reference:
//   1. Drop the human-coded HTML into ./references/<name>.html
//   2. Map the Figma fileKey to that path in REFERENCE_LIBRARY below
//   3. Restart the server (references load at boot)
// =====================================================================
const __dirname_v8 = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_LIBRARY = {
  // Arsenal Pulse — Candidate Intelligence Report
  "GPBtdVIKA5RMOHK3TITYvZ": path.join(__dirname_v8, "references", "arsenal-pulse.html"),
  // Add more entries as human-coded references become available
};

const REFERENCE_CACHE = new Map();
for (const [fileKey, refPath] of Object.entries(REFERENCE_LIBRARY)) {
  try {
    if (existsSync(refPath)) {
      const content = readFileSync(refPath, "utf-8");
      REFERENCE_CACHE.set(fileKey, content);
      console.log(`[v8.0.0] Loaded reference HTML for ${fileKey}: ${refPath} (${Math.round(content.length / 1024)}KB)`);
    } else {
      console.warn(`[v8.0.0] Reference path missing: ${refPath}`);
    }
  } catch (err) {
    console.warn(`[v8.0.0] Failed to load reference ${refPath}:`, err.message);
  }
}

const MAX_PDF_BYTES = 5 * 1024 * 1024;        // 5 MB
const MAX_ZIP_BYTES = 25 * 1024 * 1024;        // 25 MB for image assets ZIP
const MAX_PAGES = 10;
const RASTERIZE_TIMEOUT_MS = 60 * 1000;
const ANTHROPIC_TIMEOUT_MS = 480 * 1000;   // 8 min — complex emails with 32K max_tokens need more time
const SERVER_TIMEOUT_MS = 600 * 1000;      // 10 min — must exceed Anthropic timeout + Dropbox upload time
const RASTERIZE_SCALE = 1.6;
const ALLOWED_IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

// v5.5.0 tunables — extracted from inline magic numbers
const STAGE1_MAX_RETRIES = 3;
const STAGE1_RETRY_INITIAL_BACKOFF_MS = 3000;
const DROPBOX_BATCH_SIZE = 3;
const DROPBOX_BATCH_RETRY_DELAY_MS = 2000;
const DROPBOX_RETRY_INTERVAL_MS = 500;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const IMAGE_DOWNLOAD_CONCURRENCY = 5;
const STAGE1_RETRY_API_TIMEOUT_MS = 240 * 1000;     // 4 min for clean-regenerate retry
const SHUTDOWN_DRAIN_TIMEOUT_MS = 180 * 1000;       // 3 min — must allow in-flight Stage 2 to finish

const ALLOWED_ORIGINS = [
  "https://maveloper.vercel.app",
  "https://maveloper.lovable.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

// =====================================================================
// MODULE-LEVEL UTILITIES (v5.5.0)
// =====================================================================

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Strip markdown code fences and isolate the JSON object substring.
 * Returns the candidate JSON string (between first { and last } if present),
 * or empty string if no { is found.
 */
function extractJsonFromMarkdown(text) {
  if (!text) return "";
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  const firstBrace = stripped.indexOf("{");
  if (firstBrace === -1) return "";
  const lastBrace = stripped.lastIndexOf("}");
  return lastBrace > firstBrace
    ? stripped.substring(firstBrace, lastBrace + 1)
    : stripped.substring(firstBrace);
}

/**
 * fetch() wrapped with AbortController so a hung server cannot
 * stall the request past the configured timeout.
 */
async function fetchWithTimeout(url, timeoutMs = IMAGE_DOWNLOAD_TIMEOUT_MS, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded-concurrency parallel map. Preserves input order in the output array.
 * Used to parallelize image downloads without overwhelming the network.
 */
async function mapWithConcurrency(items, concurrency, asyncFn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await asyncFn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Classify an Anthropic SDK error as transient (worth retrying) vs permanent.
 * Per CLAUDE.md the SDK has maxRetries=0 by design, so this layer handles it
 * explicitly only for the calls where retry is safe.
 */
function isRetriableAnthropicError(err) {
  if (!err) return false;
  const status = err.status;
  if (status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const code = err.code || err.cause?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNABORTED" || code === "EAI_AGAIN") {
    return true;
  }
  const msg = err.message || "";
  if (/timed out|timeout|socket hang up|network/i.test(msg)) return true;
  return false;
}

/**
 * Strip tokens / signed-URL query params for safer logging. Dropbox shared
 * links carry rlkey + st tokens that grant read access.
 */
function redactUrl(url) {
  if (!url || typeof url !== "string") return url;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

// =====================================================================
// ANTHROPIC CLIENT
// =====================================================================
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
  timeout: ANTHROPIC_TIMEOUT_MS,
  maxRetries: 0,
});

// =====================================================================
// DROPBOX CLIENT
// =====================================================================
let dbx = null;
if (dropboxConfigured) {
  dbx = new Dropbox({
    clientId: DROPBOX_APP_KEY,
    clientSecret: DROPBOX_APP_SECRET,
    refreshToken: DROPBOX_REFRESH_TOKEN,
  });
}

// =====================================================================
// SUPABASE CONFIG (Phase 1: Auth + Cloud Drafts)
// =====================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const supabaseConfigured = Boolean(
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_JWT_SECRET
);

if (!supabaseConfigured) {
  console.warn(
    "WARNING: Supabase env vars missing — auth middleware will reject all protected requests. " +
    "Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_JWT_SECRET in Railway Variables."
  );
}

// Admin Supabase client — used server-side for writes that bypass RLS.
// Only reach for this when necessary (audit logs, orchestrated multi-table writes).
// Prefer user-scoped queries from the frontend whenever possible.
const supabaseAdmin = supabaseConfigured
  ? createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// =====================================================================
// AUTH MIDDLEWARE (Phase 1)
// =====================================================================

/**
 * Verifies a Supabase JWT sent in the `Authorization: Bearer <token>` header.
 * On success, populates `req.user` with `{ id, email, role }` and calls next().
 * On failure, returns 401.
 *
 * Use on routes that require auth:
 *   app.post('/api/drafts/save-generated', requireAuth, handler);
 */
function requireAuth(req, res, next) {
  if (!SUPABASE_JWT_SECRET) {
    return res.status(503).json({
      error: "Auth not configured",
      details: "Backend is missing SUPABASE_JWT_SECRET. Contact admin.",
    });
  }

  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) {
    return res.status(401).json({ error: "Missing Authorization: Bearer <token> header" });
  }

  try {
    const decoded = jwt.verify(match[1], SUPABASE_JWT_SECRET, {
      algorithms: ["HS256"],
      audience: "authenticated",
    });
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
    };
    return next();
  } catch (err) {
    return res.status(401).json({
      error: "Invalid or expired token",
      details: err.message,
    });
  }
}

/**
 * Populates `req.user` if a valid token is present, but never rejects the
 * request. Use on /generate so existing clients keep working while also
 * tagging generation output with user_id when a user is identified.
 */
function optionalAuth(req, res, next) {
  if (!SUPABASE_JWT_SECRET) return next();

  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) return next();

  try {
    const decoded = jwt.verify(match[1], SUPABASE_JWT_SECRET, {
      algorithms: ["HS256"],
      audience: "authenticated",
    });
    req.user = { id: decoded.sub, email: decoded.email, role: decoded.role };
  } catch {
    // Ignore — treat as anonymous.
  }
  next();
}

// =====================================================================
// DROPBOX HELPERS
// =====================================================================

/**
 * Get the Dropbox folder path for an order.
 * Format: /maveloper/MM-YYYY/ORDER_ID
 */
function getDropboxFolderPath(orderId) {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  return `/maveloper/${mm}-${yyyy}/${orderId}`;
}

/**
 * Upload a single file buffer to Dropbox and return its direct URL.
 */
async function uploadToDropbox(filePath, fileBuffer) {
  const uploadResult = await dbx.filesUpload({
    path: filePath,
    contents: fileBuffer,
    mode: { ".tag": "overwrite" },
    mute: true,
  });

  // Create a shared link
  let sharedUrl;
  try {
    const linkResult = await dbx.sharingCreateSharedLinkWithSettings({
      path: filePath,
      settings: { requested_visibility: { ".tag": "public" }, audience: { ".tag": "public" } },
    });
    sharedUrl = linkResult.result.url;
  } catch (linkErr) {
    // If link already exists, retrieve it
    if (linkErr?.error?.error?.[".tag"] === "shared_link_already_exists") {
      const existing = await dbx.sharingListSharedLinks({ path: filePath, direct_only: true });
      if (existing.result.links.length > 0) {
        sharedUrl = existing.result.links[0].url;
      } else {
        throw new Error(`Could not retrieve existing shared link for ${filePath}`);
      }
    } else {
      throw linkErr;
    }
  }

  // Convert to direct-access URL
  // Modern Dropbox shared links: https://www.dropbox.com/scl/fi/HASH/filename.jpg?rlkey=KEY&st=TOKEN&dl=0
  // Direct access: replace dl=0 with dl=1 (or raw=1) and swap domain
  let directUrl = sharedUrl;
  
  // Method 1: Replace dl=0 with raw=1 (keeps all other params intact)
  if (directUrl.includes("dl=0")) {
    directUrl = directUrl.replace("dl=0", "raw=1");
  } else {
    // If no dl param, append raw=1
    directUrl += (directUrl.includes("?") ? "&" : "?") + "raw=1";
  }
  
  // Swap to direct download domain
  directUrl = directUrl.replace("www.dropbox.com", "dl.dropboxusercontent.com");

  return { dropboxPath: uploadResult.result.path_display, directUrl, sharedUrl };
}

/**
 * Upload all images to Dropbox for a given order.
 * Uploads in parallel batches of 3 with retry logic for rate-limited requests.
 * Returns a map: { "hero.jpg": "https://dl.dropboxusercontent.com/..." }
 */
async function uploadImagesToDropbox(orderId, images, logFn) {
  const folderPath = getDropboxFolderPath(orderId);
  const imageUrlMap = {};
  const failedImages = [];

  logFn("info", `Uploading ${images.length} images to Dropbox (parallel, batch size ${DROPBOX_BATCH_SIZE})`, { orderId });

  for (let i = 0; i < images.length; i += DROPBOX_BATCH_SIZE) {
    const batch = images.slice(i, i + DROPBOX_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (img) => {
        const dropboxFilePath = `${folderPath}/images/${img.filename}`;
        const { directUrl, sharedUrl } = await uploadToDropbox(dropboxFilePath, img.buffer);
        logFn("info", `Dropbox URL for ${img.filename}`, {
          sharedUrl: redactUrl(sharedUrl),
          directUrl: redactUrl(directUrl),
        });
        return { filename: img.filename, directUrl };
      })
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        imageUrlMap[result.value.filename] = result.value.directUrl;
      } else {
        logFn("warn", `Upload failed for ${batch[j].filename}, queued for retry`, { error: result.reason?.message || String(result.reason) });
        failedImages.push(batch[j]);
      }
    }
  }

  // Retry failed images one at a time with a delay
  if (failedImages.length > 0) {
    logFn("info", `Retrying ${failedImages.length} failed uploads after ${DROPBOX_BATCH_RETRY_DELAY_MS}ms delay`);
    await sleepMs(DROPBOX_BATCH_RETRY_DELAY_MS);

    for (const img of failedImages) {
      try {
        const dropboxFilePath = `${folderPath}/images/${img.filename}`;
        const { directUrl } = await uploadToDropbox(dropboxFilePath, img.buffer);
        imageUrlMap[img.filename] = directUrl;
        logFn("info", `Retry succeeded for ${img.filename}`);
      } catch (retryErr) {
        logFn("error", `Retry also failed for ${img.filename}`, { error: retryErr.message });
      }
      await sleepMs(DROPBOX_RETRY_INTERVAL_MS);
    }
  }

  logFn("info", `Dropbox upload complete: ${Object.keys(imageUrlMap).length}/${images.length} succeeded`, { orderId });
  return imageUrlMap;
}

/**
 * Upload the final ZIP to Dropbox and return the shareable link.
 */
async function uploadZipToDropbox(orderId, zipBuffer, logFn) {
  const folderPath = getDropboxFolderPath(orderId);
  const zipPath = `${folderPath}.zip`;

  logFn("info", `Uploading ZIP to Dropbox: ${zipPath}`, { sizeKB: Math.round(zipBuffer.length / 1024) });

  const { directUrl } = await uploadToDropbox(zipPath, zipBuffer);

  // For the ZIP we want the regular Dropbox share link (nicer UX), not direct download
  let shareUrl;
  try {
    const linkResult = await dbx.sharingCreateSharedLinkWithSettings({
      path: zipPath,
      settings: { requested_visibility: { ".tag": "public" }, audience: { ".tag": "public" } },
    });
    shareUrl = linkResult.result.url;
  } catch (linkErr) {
    if (linkErr?.error?.error?.[".tag"] === "shared_link_already_exists") {
      const existing = await dbx.sharingListSharedLinks({ path: zipPath, direct_only: true });
      shareUrl = existing.result.links.length > 0 ? existing.result.links[0].url : directUrl;
    } else {
      shareUrl = directUrl;
    }
  }

  return shareUrl;
}

// =====================================================================
// IMAGE EXTRACTION FROM PDF
// =====================================================================

/**
 * Attempt to extract embedded raster images from a PDF buffer.
 * Uses heuristic byte-marker scanning, then validates each image with Sharp
 * to filter out screenshots, PDF artifacts, and non-email-asset images.
 * Returns array of { filename, buffer } or empty array if extraction fails.
 */
async function extractImagesFromPdf(pdfBuffer) {
  const rawImages = [];
  let imgIndex = 0;

  // --- JPEG extraction ---
  const JPEG_SOI = Buffer.from([0xFF, 0xD8, 0xFF]);
  const JPEG_EOI = Buffer.from([0xFF, 0xD9]);
  let searchStart = 0;

  while (searchStart < pdfBuffer.length - 3) {
    const soiPos = pdfBuffer.indexOf(JPEG_SOI, searchStart);
    if (soiPos === -1) break;

    const eoiPos = pdfBuffer.indexOf(JPEG_EOI, soiPos + 3);
    if (eoiPos === -1) {
      searchStart = soiPos + 3;
      continue;
    }

    const jpegEnd = eoiPos + 2;
    const jpegLen = jpegEnd - soiPos;

    // Only keep images larger than 2KB (skip tiny thumbnails/artifacts)
    if (jpegLen > 2048) {
      imgIndex++;
      const imgBuffer = pdfBuffer.subarray(soiPos, jpegEnd);
      rawImages.push({
        filename: `img-${String(imgIndex).padStart(2, "0")}.jpg`,
        buffer: Buffer.from(imgBuffer),
      });
    }

    searchStart = jpegEnd;
  }

  // --- PNG extraction ---
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const PNG_IEND = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
  searchStart = 0;

  while (searchStart < pdfBuffer.length - 8) {
    const sigPos = pdfBuffer.indexOf(PNG_SIG, searchStart);
    if (sigPos === -1) break;

    const iendPos = pdfBuffer.indexOf(PNG_IEND, sigPos + 8);
    if (iendPos === -1) {
      searchStart = sigPos + 8;
      continue;
    }

    const pngEnd = iendPos + 8;
    const pngLen = pngEnd - sigPos;

    if (pngLen > 2048) {
      imgIndex++;
      const imgBuffer = pdfBuffer.subarray(sigPos, pngEnd);
      rawImages.push({
        filename: `img-${String(imgIndex).padStart(2, "0")}.png`,
        buffer: Buffer.from(imgBuffer),
      });
    }

    searchStart = pngEnd;
  }

  // --- Validate each extracted image using Sharp ---
  const validatedImages = [];
  const MAX_EMAIL_IMAGE_WIDTH = 1200;   // Email images are never wider than ~1200px
  const MAX_EMAIL_IMAGE_HEIGHT = 2000;  // Email images are rarely taller than 2000px
  const MIN_IMAGE_SIZE = 5 * 1024;      // Skip images under 5KB (icons/spacers extracted as noise)
  // Common screenshot aspect ratios to reject (16:10, 16:9, and close variants)
  const SCREENSHOT_RATIOS = [
    { ratio: 16 / 10, tolerance: 0.05 },  // 1440x900, 1280x800
    { ratio: 16 / 9, tolerance: 0.05 },   // 1920x1080, 1366x768
    { ratio: 4 / 3, tolerance: 0.05 },    // 1024x768 (if >1000px wide, likely screenshot)
  ];

  for (const img of rawImages) {
    try {
      const metadata = await sharp(img.buffer).metadata();
      const { width, height, size } = metadata;

      if (!width || !height) continue;

      // Filter 1: Skip images smaller than 5KB (noise, spacers, artifacts)
      if (img.buffer.length < MIN_IMAGE_SIZE) continue;

      // Filter 2: Skip images wider than 1200px (screenshots, full-page captures)
      if (width > MAX_EMAIL_IMAGE_WIDTH) continue;

      // Filter 3: Skip images taller than 2000px (full-page screenshots)
      if (height > MAX_EMAIL_IMAGE_HEIGHT) continue;

      // Filter 4: Skip images with screenshot-like dimensions
      // Screenshots are typically >900px wide AND match common screen ratios
      if (width > 900) {
        const aspectRatio = width / height;
        const isScreenshotRatio = SCREENSHOT_RATIOS.some(
          (sr) => Math.abs(aspectRatio - sr.ratio) < sr.tolerance
        );
        if (isScreenshotRatio) continue;
      }

      // Filter 5: Skip very large file sizes (>500KB) combined with large dimensions
      // These are usually high-res screenshots or full-page captures
      if (img.buffer.length > 500 * 1024 && width > 800 && height > 600) continue;

      validatedImages.push(img);
    } catch {
      // If Sharp can't read the image, skip it (corrupted or not a real image)
      continue;
    }
  }

  // Re-number the validated images sequentially
  return validatedImages.map((img, idx) => ({
    filename: `img-${String(idx + 1).padStart(2, "0")}${path.extname(img.filename)}`,
    buffer: img.buffer,
  }));
}

/**
 * Extract images from a user-uploaded ZIP file.
 * Returns array of { filename, buffer }.
 */
async function extractImagesFromZip(zipBase64) {
  const zipBuffer = Buffer.from(zipBase64.replace(/^data:[^;]+;base64,/, ""), "base64");

  if (zipBuffer.length > MAX_ZIP_BYTES) {
    throw new Error(`ZIP file too large. Maximum is ${MAX_ZIP_BYTES / 1024 / 1024} MB.`);
  }

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const images = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const ext = path.extname(entry.entryName).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.includes(ext)) continue;

    // Get just the filename, stripping any nested folder paths
    const filename = path.basename(entry.entryName);

    // Skip macOS resource fork files
    if (filename.startsWith("._") || entry.entryName.includes("__MACOSX")) continue;

    const buffer = entry.getData();
    if (buffer.length === 0) continue;

    // Read true pixel dimensions via sharp metadata. This is authoritative —
    // the developer receives image assets that match the design proportions,
    // but their exact pixel dimensions may be 2× (retina) or different from
    // the placeholder size in the design PDF. v5.2.2 post-processor uses these
    // to clamp <img width> to min(placeholder, original).
    let originalWidth = null;
    let originalHeight = null;
    try {
      const meta = await sharp(buffer).metadata();
      originalWidth = meta.width || null;
      originalHeight = meta.height || null;
    } catch (err) {
      // GIF or corrupted — fall through; image will still be uploaded but
      // without dimension metadata. fixImageDimensions will skip it.
    }

    images.push({ filename, buffer, originalWidth, originalHeight });
  }

  if (images.length === 0) {
    throw new Error("No valid images found in ZIP. Supported formats: JPG, PNG, GIF, WEBP.");
  }

  return images;
}

// =====================================================================
// ZIP PACKAGING
// =====================================================================

/**
 * Build the final deliverable ZIP containing:
 * - ORDER_ID.html (with relative image paths)
 * - images/ folder with all image files
 */
function buildDeliveryZip(orderId, htmlWithDropboxUrls, imageUrlMap, images) {
  const zip = new AdmZip();

  // Swap Dropbox URLs back to relative paths in the HTML
  let localHtml = htmlWithDropboxUrls;
  for (const [filename, dropboxUrl] of Object.entries(imageUrlMap)) {
    // Replace all occurrences of the Dropbox URL with relative path
    localHtml = localHtml.split(dropboxUrl).join(`images/${filename}`);
  }

  // Add HTML file
  zip.addFile(`${orderId}.html`, Buffer.from(localHtml, "utf-8"));

  // Add images
  for (const img of images) {
    zip.addFile(`images/${img.filename}`, img.buffer);
  }

  return zip.toBuffer();
}

// =====================================================================
// ORDER ID EXTRACTION
// =====================================================================

/**
 * Extract Order ID from the uploaded PDF filename.
 * Expected format: "OID9924641912.pdf" → "OID9924641912"
 * Also accepts: "OID9924641912" (without extension)
 */
function extractOrderId(filename) {
  if (!filename || typeof filename !== "string") return null;

  // Strip .pdf extension
  const name = filename.replace(/\.pdf$/i, "").trim();

  // Reject generic/empty filenames
  const genericNames = ["design", "untitled", "document", "file", "upload", "email", "test", "sample", "new"];
  if (!name || genericNames.includes(name.toLowerCase())) return null;

  return name;
}


// =====================================================================
// POST-PROCESSING PIPELINE (v5.1.0) — Deterministic fix-ups after Stage 2
// =====================================================================
// These fix failures that prompt rules alone cannot reliably solve:
//  1. Image URL replacement (local paths -> Dropbox URLs)
//  2. Near-white normalization (JPEG-shifted near-white -> pure white)
//  3. Alert-bar text contrast (force readable text color)
//  4. Activity-feed detection (strip bullet-list wrapping of day/time patterns)
//  5. Hallucinated thin band removal (drop non-palette thin bands)
//  6. Cream/accent preservation (already handled by palette lock, no-op here)
//
// Universal. No brand-specific strings or hex values.
// =====================================================================

function hexToRgbTriplet(hex) {
  if (!hex || !/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.substring(1, 3), 16),
    parseInt(hex.substring(3, 5), 16),
    parseInt(hex.substring(5, 7), 16),
  ];
}

function isNearWhite(hex) {
  const rgb = hexToRgbTriplet(hex);
  if (!rgb) return false;
  return rgb[0] >= 248 && rgb[1] >= 248 && rgb[2] >= 248 && hex.toUpperCase() !== "#FFFFFF";
}

function isBrightWarm(hex) {
  // Orange / yellow / warm red bgs typically have R > B, G > B, and R+G > 300
  const rgb = hexToRgbTriplet(hex);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return r > b + 30 && r + g > 300 && (r + g + b) > 400;
}

function isDarkColor(hex) {
  const rgb = hexToRgbTriplet(hex);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  // Luminance approx
  return (r * 0.299 + g * 0.587 + b * 0.114) < 90;
}

function saturationOfHex(hex) {
  const rgb = hexToRgbTriplet(hex);
  if (!rgb) return 0;
  return Math.max(...rgb) - Math.min(...rgb);
}

/**
 * Fix 1: Replace relative image paths with Dropbox URLs.
 * Scans for src="...filename" where filename matches a key in imageUrlMap.
 * Reliable string replace, zero Claude guessing.
 */
function fixImageUrls(html, imageUrlMap, imageDimensionsMap) {
  if (!imageUrlMap || Object.keys(imageUrlMap).length === 0) {
    return { html, replaced: 0, unmatched: [], sequentialFallbacks: 0, fallbackUsed: [] };
  }

  let replaced = 0;
  let sequentialFallbacks = 0;
  const unmatched = [];
  const fallbackUsed = []; // {invented, actual, url} for each sequential fallback
  let output = html;

  // Build a case-insensitive lookup by filename
  const byName = {};
  for (const [filename, url] of Object.entries(imageUrlMap)) {
    byName[filename.toLowerCase()] = url;
  }

  // v5.4.2: Build an ORDERED list of available image filenames + URLs.
  // Used as a positional fallback when filename match fails.
  // Sort by filename (case-insensitive) so order is stable and predictable.
  const orderedImages = Object.entries(imageUrlMap)
    .map(([filename, url]) => ({
      filename,
      url,
      width: imageDimensionsMap?.[filename]?.width || null,
      height: imageDimensionsMap?.[filename]?.height || null,
    }))
    .sort((a, b) => a.filename.toLowerCase().localeCompare(b.filename.toLowerCase()));

  // First pass: exact filename matches
  output = output.replace(/\bsrc\s*=\s*["']([^"']+)["']/gi, (match, src) => {
    // Skip already-good URLs (http/https/data/cid)
    if (/^(https?:|data:|cid:)/i.test(src)) return match;

    // Extract filename (last segment of path)
    const filename = src.split("/").pop();
    if (!filename) return match;

    const lookupKey = filename.toLowerCase();
    const dropboxUrl = byName[lookupKey];

    if (dropboxUrl) {
      replaced++;
      return `src="${dropboxUrl}"`;
    }

    // No exact match — leave for second pass to handle
    return match;
  });

  // v5.4.2: Second pass — sequential positional fallback.
  // For any remaining relative-path images, replace with images from the
  // ORDERED list in order of appearance in the HTML. This guarantees real
  // working URLs even when Stage 2 invented filenames that don't match the ZIP.
  // Logic:
  //   - Walk through remaining src="images/..." attrs in document order.
  //   - For each, assign the next available image from orderedImages.
  //   - Skip spacer.gif (intentionally local).
  //   - If we run out of images, mark as unmatched.
  let imageCursor = 0;
  output = output.replace(/\bsrc\s*=\s*["']([^"']+)["']/gi, (match, src) => {
    if (/^(https?:|data:|cid:)/i.test(src)) return match;

    const filename = src.split("/").pop();
    if (!filename) return match;

    // Skip spacer.gif intentionally (these are framework-internal placeholders)
    if (/^spacer\.gif$/i.test(filename)) return match;

    if (imageCursor < orderedImages.length) {
      const fallback = orderedImages[imageCursor];
      imageCursor++;
      sequentialFallbacks++;
      fallbackUsed.push({
        invented: filename,
        actual: fallback.filename,
        url: fallback.url,
      });
      return `src="${fallback.url}"`;
    }

    unmatched.push(filename);
    return match;
  });

  return {
    html: output,
    replaced,
    sequentialFallbacks,
    fallbackUsed,
    unmatched,
  };
}

/**
 * Fix 2: Normalize near-white colors to pure white.
 * If a hex is R,G,B all >= 248 but not exactly #FFFFFF, it's a JPEG-shifted
 * near-white artifact. Replace with #FFFFFF throughout.
 */
function fixNearWhite(html, palette) {
  // Find near-white hex values that appear in the html
  const hexRegex = /#([0-9A-Fa-f]{6})\b/g;
  const seen = new Set();
  const matches = [...html.matchAll(hexRegex)];
  for (const m of matches) {
    const hex = "#" + m[1].toUpperCase();
    if (isNearWhite(hex)) seen.add(hex);
  }

  let output = html;
  let replaced = 0;
  for (const hex of seen) {
    // Replace in all case forms
    const upper = hex.toUpperCase();
    const lower = hex.toLowerCase();
    // Count occurrences before replacement
    const upperRe = new RegExp(upper.replace("#", "#"), "g");
    const lowerRe = new RegExp(lower.replace("#", "#"), "g");
    const upperCount = (output.match(upperRe) || []).length;
    const lowerCount = (output.match(lowerRe) || []).length;
    output = output.split(upper).join("#FFFFFF");
    output = output.split(lower).join("#FFFFFF");
    replaced += upperCount + lowerCount;
  }

  return { html: output, normalizedColors: [...seen], count: replaced };
}

/**
 * Fix 3: Alert bar text contrast.
 * Scan for sections annotated with alert_bar. If bg is bright-warm, force text to
 * black. If bg is dark, force text to white.
 */
function fixAlertBarContrast(html) {
  let output = html;
  let fixes = 0;

  // Match <!-- Section_N: alert_bar --> ... <!-- // Section_N -->
  const alertBarRegex = /<!--\s*Section[^>]*alert[_ ]bar[^>]*-->[\s\S]*?<!--\s*\/\/[^>]*-->/gi;

  output = output.replace(alertBarRegex, (block) => {
    // Extract bgcolor from the content (first bgcolor we find in the block)
    const bgMatch = block.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/i);
    if (!bgMatch) return block;
    const bg = bgMatch[1].toUpperCase();

    // Determine correct text color based on bg
    let textColor;
    if (isDarkColor(bg)) {
      textColor = "#FFFFFF";
    } else {
      // For bright/warm or light bgs, text should be black for contrast
      textColor = "#000000";
    }

    // Replace any color: #XXXXXX in inline styles with textColor
    // Parse style attributes and replace color values within them.
    // Use lookbehind-safe pattern to avoid matching background-color.
    const fixed = block.replace(
      /style\s*=\s*"([^"]*)"/gi,
      (attrMatch, styleVal) => {
        const updated = styleVal.replace(
          /(^|[^\-])\bcolor\s*:\s*#[0-9A-Fa-f]{6}/g,
          (m, prefix) => `${prefix}color: ${textColor}`
        );
        return `style="${updated}"`;
      }
    );
    if (fixed !== block) fixes++;
    return fixed;
  });

  return { html: output, fixes };
}

/**
 * Fix 4: Strip bullet-list wrapping from activity-feed patterns.
 * If a <ul>...</ul> block contains <li> items matching day+time patterns
 * (e.g., "Mon/Tue/Wed ... 2.45pm" or "Jan 15 4pm"), unwrap to plain <td> rows.
 */
function fixActivityFeed(html) {
  let output = html;
  let fixes = 0;

  // Detect <ul>...</ul> blocks
  const ulRegex = /<ul\b[^>]*>([\s\S]*?)<\/ul>/gi;
  output = output.replace(ulRegex, (ulBlock, inner) => {
    // Extract li items
    const liMatches = [...inner.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)];
    if (liMatches.length < 2) return ulBlock;

    // Check if items match activity-feed pattern:
    // day-of-week (Mon|Tue|Wed|...) OR time pattern (e.g. "2.45pm", "4pm", "10:30am")
    const dayRegex = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(day)?\b/i;
    const timeRegex = /\b\d{1,2}[.:]?\d{0,2}\s*(am|pm)\b/i;

    let matches = 0;
    for (const li of liMatches) {
      const text = li[2].replace(/<[^>]+>/g, "").trim();
      if (dayRegex.test(text) || timeRegex.test(text)) matches++;
    }

    // If majority of items match, treat as activity feed — unwrap
    if (matches / liMatches.length < 0.5) return ulBlock;

    fixes++;
    // Convert each <li> to a <tr><td>...</td></tr> as plain text row
    const rows = liMatches
      .map((m) => {
        const liAttrs = m[1] || "";
        // Extract style from li attrs to preserve font styling
        const styleMatch = liAttrs.match(/style\s*=\s*["']([^"']*)["']/i);
        const style = styleMatch ? styleMatch[1] : "";
        const content = m[2].trim();
        return `<tr><td align="left" valign="top" style="${style}">${content}</td></tr>`;
      })
      .join("\n");
    return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%">\n${rows}\n</table>`;
  });

  return { html: output, fixes };
}

/**
 * Fix 5: Remove hallucinated thin bands.
 * Hallucinated thin bands are <tr> blocks whose only purpose is a tiny colored
 * stripe with a bgcolor that doesn't appear as a REAL section bg anywhere else
 * in the design.
 *
 * Trust rule: a thin-band color is REAL if it either:
 *  (a) is #FFFFFF, #000000, or a very-dark color (true footer/header dividers)
 *  (b) appears as the bgcolor on a NON-thin section elsewhere in the HTML
 *      (i.e., it's a color the design actually uses for content backgrounds)
 *
 * A thin_colored_band whose color satisfies neither is dropped as noise.
 */
function fixThinBands(html, palette, bandMap) {
  // Step 1: collect bgcolors used on REAL content sections (not thin-band-only sections).
  // Strategy: iterate over thin_colored_band SECTION comment blocks and capture
  // their bgcolors as "thin-only colors". Any color that appears as bgcolor
  // ONLY inside thin_colored_band sections is hallucinated noise; any color
  // that also appears elsewhere is a real design color.
  //
  // v5.4.0: Also reject bands flagged as "is_likely_artifact" by the band
  // detector (thin + low coverage + low saturation). These are JPEG compression
  // artifacts at section boundaries, not real design elements — even if their
  // color happens to overlap with a real palette color.
  //
  // This avoids the nested <tr> regex problem entirely.

  // Build a y-range -> artifact lookup from the band map
  const artifactColors = new Set();
  if (Array.isArray(bandMap)) {
    for (const b of bandMap) {
      if (b.is_likely_artifact) {
        artifactColors.add((b.bg_hex || "").toUpperCase());
      }
    }
  }

  const thinBandSectionRegex = /<!--\s*Section[^>]*thin[_ ]colored[_ ]band[^>]*-->[\s\S]*?<!--\s*\/\/[^>]*-->/gi;
  const thinBandColors = new Set();
  const thinBandBlockList = [];
  for (const match of html.matchAll(thinBandSectionRegex)) {
    const block = match[0];
    thinBandBlockList.push(block);
    const bgs = [...block.matchAll(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/gi)];
    for (const m of bgs) thinBandColors.add(m[1].toUpperCase());
  }

  // Remove all thin-band blocks from a temporary copy to find "other" bgcolors
  let htmlWithoutThinBands = html;
  for (const block of thinBandBlockList) {
    htmlWithoutThinBands = htmlWithoutThinBands.replace(block, "");
  }

  // Collect bgcolors that appear OUTSIDE thin-band sections (real design colors)
  const realBgColors = new Set();
  const bgRegex = /bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/gi;
  for (const m of htmlWithoutThinBands.matchAll(bgRegex)) {
    realBgColors.add(m[1].toUpperCase());
  }
  // Always trust pure white and pure black
  realBgColors.add("#FFFFFF");
  realBgColors.add("#000000");

  let output = html;
  let removed = 0;

  // Re-scan and remove thin bands whose bgcolor is NOT a real design color
  // OR which are flagged as likely artifacts by the band detector
  const thinBandRemoveRegex = /<!--\s*Section[^>]*thin[_ ]colored[_ ]band[^>]*-->[\s\S]*?<!--\s*\/\/[^>]*-->\s*/gi;

  output = output.replace(thinBandRemoveRegex, (block) => {
    const bgMatch = block.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/i);
    if (!bgMatch) return block;
    const bg = bgMatch[1].toUpperCase();

    // v5.4.0: Drop if band detector flagged this color as a likely artifact
    if (artifactColors.has(bg)) {
      removed++;
      return "";
    }

    // Trust if this color appears elsewhere as a real section bg
    if (realBgColors.has(bg)) return block;

    // Trust if color is very dark (legit footer dividers)
    if (isDarkColor(bg)) return block;

    // Trust if color is within distance 20 of any real color
    const bgRgb = hexToRgbTriplet(bg);
    for (const t of realBgColors) {
      const tRgb = hexToRgbTriplet(t);
      if (!tRgb) continue;
      const dist = Math.sqrt(
        (bgRgb[0] - tRgb[0]) ** 2 +
        (bgRgb[1] - tRgb[1]) ** 2 +
        (bgRgb[2] - tRgb[2]) ** 2
      );
      if (dist < 20) return block;
    }

    // Drop it — hallucinated thin band
    removed++;
    return "";
  });

  return { html: output, removed };
}

/**
 * Fix 6 (NEW in v5.2.0): Rebind section bgcolors using band_map + y-range in comments.
 *
 * Every section comment emitted by Stage 2 contains y=Y1-Y2 (e.g. "Section_8_alert_bar y=345-380").
 * We parse that y-range, look up the DOMINANT band color covering that range, and override
 * the section's bgcolor attribute. This is fully deterministic — no Claude guessing.
 *
 * Why this exists: Stage 1 Claude sometimes collapses distinct design colors into a
 * single palette color (e.g. cream off-white shades rendered as pure white). Stage 2 then uses
 * that wrong color. This function restores the correct color from pixel-sampled data.
 */
function rebindSectionColors(html, bandMap, palette) {
  if (!Array.isArray(bandMap) || bandMap.length === 0) {
    return { html, rebound: 0, checked: 0, skipped: "no band map" };
  }

  let rebound = 0;
  let checked = 0;

  // Normalize band_map to a sorted array of { y_start, y_end, hex }
  const bands = bandMap
    .map((b) => {
      const y = b.y || [0, 0];
      const y_start = Array.isArray(y) ? y[0] : b.y_start || 0;
      const y_end = Array.isArray(y) ? y[1] : b.y_end || 0;
      return {
        y_start: Number(y_start) || 0,
        y_end: Number(y_end) || 0,
        hex: (b.bg || b.bg_hex || "").toUpperCase(),
      };
    })
    .filter((b) => b.y_end > b.y_start && /^#[0-9A-F]{6}$/.test(b.hex))
    .sort((a, b) => a.y_start - b.y_start);

  if (bands.length === 0) {
    return { html, rebound: 0, checked: 0, skipped: "band map empty after normalize" };
  }

  // Build palette hex set for validation
  const paletteSet = new Set(
    (palette || [])
      .map((p) => (typeof p === "string" ? p : p?.hex || "").toUpperCase())
      .filter((h) => /^#[0-9A-F]{6}$/.test(h))
  );

  // Section block regex matches: <!-- Section_N_type y=Y1-Y2 --> ... <!-- // Section_N_type -->
  const sectionRegex =
    /(<!--\s*Section_(\d+)_([a-zA-Z_]+)\s+y=(\d+)-(\d+)\s*-->)([\s\S]*?)(<!--\s*\/\/\s*Section_\2(?:_\3)?\s*-->)/g;

  const output = html.replace(sectionRegex, (match, openTag, n, stype, y1, y2, body, closeTag) => {
    checked++;
    const y_start = parseInt(y1, 10);
    const y_end = parseInt(y2, 10);
    if (!(y_end > y_start)) return match;

    // Find dominant band color in this y-range (weighted by pixel coverage)
    const coverage = new Map();
    for (const band of bands) {
      const overlap = Math.max(0, Math.min(band.y_end, y_end) - Math.max(band.y_start, y_start));
      if (overlap <= 0) continue;
      coverage.set(band.hex, (coverage.get(band.hex) || 0) + overlap);
    }
    if (coverage.size === 0) return match;

    // Skip the content color if the section is a CONTENT-heavy band pattern — thin-colored-bands
    // already have their bg correctly set by type semantics; don't rebind them.
    if (stype === "thin_colored_band") return match;

    // Find the MOST-COVERED non-grayscale-muddy color first; fall back to overall dominant
    let domHex = null;
    let domCov = 0;
    for (const [hex, cov] of coverage) {
      if (cov > domCov) {
        domCov = cov;
        domHex = hex;
      }
    }
    if (!domHex) return match;

    // Only rebind if dominant color is actually in the palette (prevents binding to
    // JPEG shift artifacts the palette already filtered out)
    if (paletteSet.size > 0 && !paletteSet.has(domHex)) {
      // Try to find closest palette color by RGB distance
      const domRgb = hexToRgbTriplet(domHex);
      let best = null;
      let bestD = Infinity;
      for (const p of paletteSet) {
        const pRgb = hexToRgbTriplet(p);
        if (!pRgb) continue;
        const d = Math.sqrt(
          (domRgb[0] - pRgb[0]) ** 2 +
            (domRgb[1] - pRgb[1]) ** 2 +
            (domRgb[2] - pRgb[2]) ** 2
        );
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best && bestD < 30) {
        domHex = best;
      } else {
        return match; // dominant color not meaningfully in palette; leave Stage 2's choice
      }
    }

    // Extract current bgcolor in the section's outer wrapper (first bgcolor inside body)
    const bgMatch = body.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/);
    if (!bgMatch) return match;
    const currentBg = bgMatch[1].toUpperCase();

    // Don't rebind if Stage 2's choice is already correct
    if (currentBg === domHex) return match;

    // Don't rebind when dominant is pure white and current is pure white — no-op
    if (currentBg === "#FFFFFF" && domHex === "#FFFFFF") return match;

    // Replace the FIRST bgcolor and background-color occurrence in the section body
    let newBody = body;
    let replaced = false;
    newBody = newBody.replace(
      /bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/,
      (bgM) => {
        if (replaced) return bgM;
        if (bgM.toUpperCase().includes(currentBg)) {
          replaced = true;
          return `bgcolor="${domHex}"`;
        }
        return bgM;
      }
    );
    // Replace the matching background-color in the first inline style that contains currentBg
    newBody = newBody.replace(
      new RegExp(`background-color\\s*:\\s*${currentBg}`, "i"),
      `background-color: ${domHex}`
    );

    if (newBody !== body) rebound++;
    return openTag + newBody + closeTag;
  });

  return { html: output, rebound, checked };
}

/**
 * Fix 7 (NEW in v5.2.0): Force alert_bar sections to use a warm palette color if available.
 * Many designs use orange/yellow alert bars. If Stage 2 rendered an alert_bar on white,
 * check the palette for a bright-warm color and force it.
 */
function forceAlertBarWarmBg(html, palette) {
  let fixes = 0;
  if (!palette || palette.length === 0) return { html, fixes };

  // Find warmest color in palette (high saturation, R > B)
  const warm = (palette || [])
    .map((p) => (typeof p === "string" ? p : p?.hex || "").toUpperCase())
    .filter((h) => /^#[0-9A-F]{6}$/.test(h))
    .filter((h) => {
      const rgb = hexToRgbTriplet(h);
      if (!rgb) return false;
      const [r, g, b] = rgb;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      return sat > 100 && r > b + 40 && r + g > 300; // bright warm (orange/yellow/red)
    });

  if (warm.length === 0) return { html, fixes };
  const warmColor = warm[0];

  const alertBarRegex =
    /(<!--\s*Section_(\d+)_alert_bar(?:\s+y=\d+-\d+)?\s*-->)([\s\S]*?)(<!--\s*\/\/\s*Section_\2(?:_alert_bar)?\s*-->)/g;

  const output = html.replace(alertBarRegex, (match, openTag, n, body, closeTag) => {
    const bgMatch = body.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/);
    if (!bgMatch) return match;
    const currentBg = bgMatch[1].toUpperCase();
    if (currentBg === warmColor) return match;
    // Only override if current bg is white/near-white (likely wrong default)
    const rgb = hexToRgbTriplet(currentBg);
    if (!rgb) return match;
    const avg = (rgb[0] + rgb[1] + rgb[2]) / 3;
    if (avg < 220) return match; // current bg is not light — don't touch

    let newBody = body.replace(
      /bgcolor\s*=\s*["']?#[0-9A-Fa-f]{6}["']?/,
      `bgcolor="${warmColor}"`
    );
    newBody = newBody.replace(
      new RegExp(`background-color\\s*:\\s*${currentBg}`, "i"),
      `background-color: ${warmColor}`
    );
    if (newBody !== body) fixes++;
    return openTag + newBody + closeTag;
  });

  return { html: output, fixes };
}

/**
 * Fix 8 (NEW in v5.2.0): Universal luminance-based text contrast.
 *
 * For every section, compute bg luminance. If bg is DARK, force every inline
 * `color: #XYZ` inside that section to #FFFFFF. If bg is LIGHT, force every
 * text color currently set to near-white to #000000.
 *
 * This eliminates the recurring "white text on bright bg" readability failure.
 */
function universalTextContrast(html) {
  let fixes = 0;

  const sectionRegex =
    /(<!--\s*Section_(\d+)_([a-zA-Z_]+)(?:\s+y=\d+-\d+)?\s*-->)([\s\S]*?)(<!--\s*\/\/\s*Section_\2(?:_\3)?\s*-->)/g;

  const output = html.replace(sectionRegex, (match, openTag, n, stype, body, closeTag) => {
    // Skip thin bands and spacers — no text
    if (stype === "thin_colored_band" || stype === "spacer" || stype === "divider") {
      return match;
    }

    // Determine section bg from FIRST bgcolor in the body (outer wrapper)
    const bgMatch = body.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/);
    if (!bgMatch) return match;
    const bg = bgMatch[1].toUpperCase();
    const bgRgb = hexToRgbTriplet(bg);
    if (!bgRgb) return match;

    // Luminance (perceived brightness). < 128 = dark bg, >= 128 = light bg
    const lum = 0.299 * bgRgb[0] + 0.587 * bgRgb[1] + 0.114 * bgRgb[2];
    const isDarkBg = lum < 128;

    let newBody = body;

    // Rewrite any `color: #XXX` inside style="..." to the correct contrast color.
    // Use (^|[^\-]) lookbehind to avoid matching background-color / border-color / outline-color.
    newBody = newBody.replace(/style\s*=\s*"([^"]*)"/gi, (attrMatch, styleVal) => {
      const updated = styleVal.replace(
        /(^|[^\-])\bcolor\s*:\s*(#[0-9A-Fa-f]{6})/g,
        (colorMatch, prefix, colorHex) => {
          const cRgb = hexToRgbTriplet(colorHex);
          if (!cRgb) return colorMatch;
          const cLum = 0.299 * cRgb[0] + 0.587 * cRgb[1] + 0.114 * cRgb[2];
          const isDarkColor = cLum < 128;
          // If text color is incompatible with bg (same luminance band), invert it
          if (isDarkBg && isDarkColor) {
            return `${prefix}color: #FFFFFF`;
          }
          if (!isDarkBg && !isDarkColor) {
            return `${prefix}color: #000000`;
          }
          // Acceptable contrast — keep as-is. This preserves spec colors like
          // brand-green accent text on white bg (green is mid-luminance but
          // intentional). Only fix when both are same-luminance-band.
          return colorMatch;
        }
      );
      return `style="${updated}"`;
    });

    // Also fix color attributes on <font> tags (rare, but some devs use them)
    // skipped — master framework forbids <font>

    if (newBody !== body) fixes++;
    return openTag + newBody + closeTag;
  });

  return { html: output, fixes };
}

/**
 * Fix 9 (NEW in v5.2.0): Add a warning HTML comment if no images were uploaded.
 * Helps devs spot when they forgot the ZIP and got local paths in output.
 */

/**
 * Fix 10 (NEW in v5.2.2): CTA auto-contrast.
 *
 * When Stage 2 emits CTAs without a valid cta_color, it often defaults to #000000
 * on a dark brand bgcolor — producing illegible black-on-dark buttons.
 * This deterministic post-processor finds every CTA table (em_cta or matching the
 * CTA pattern) and forces readable contrast based on luminance of the CTA bg.
 *
 * Universal. Works on any brand's dark/light CTA color.
 */
function fixCtaContrast(html) {
  let fixes = 0;

  // CTAs in Mavlers framework always have bgcolor AND border-radius on the SAME
  // opening <table> tag. We match only these — prevents matching outer wrapper
  // tables which also have bgcolor but no border-radius.
  //
  // Non-greedy regex means we match the INNERMOST such table, which is always
  // the CTA (since outer wrappers don't have border-radius).
  const ctaRegex =
    /<table\b([^>]*?)bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?([^>]*?border-radius[^>]*?)>([\s\S]*?)<\/table>/gi;

  const output = html.replace(ctaRegex, (match, pre, bgHex, post, body) => {
    const hasAnchor = /<a\s+[^>]*href\s*=/i.test(body);
    const hasButtonHeight = /\bheight\s*=\s*["']?\d{2,3}["']?/i.test(body);
    if (!hasAnchor || !hasButtonHeight) return match;

    const bg = bgHex.toUpperCase();
    const rgb = hexToRgbTriplet(bg);
    if (!rgb) return match;

    const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    const wantedTextColor = lum < 128 ? "#FFFFFF" : "#000000";

    // Rewrite text-color in the body. Match `color:` NOT preceded by `-`
    let newBody = body.replace(/style\s*=\s*"([^"]*)"/gi, (attrM, styleVal) => {
      let updated = styleVal.replace(
        /(^|[^\-])\bcolor\s*:\s*#[0-9A-Fa-f]{6}/g,
        (m, prefix) => `${prefix}color: ${wantedTextColor}`
      );
      return `style="${updated}"`;
    });

    if (newBody !== body) fixes++;
    return `<table${pre}bgcolor="${bg}"${post}>${newBody}</table>`;
  });

  return { html: output, fixes };
}

/**
 * Fix 11 (NEW in v5.2.2): Font stack quote sanitizer.
 *
 * When the developer-input secondary font field contains a comma-separated list
 * (e.g. "Arial, Helvetica, sans-serif"), Stage 2 sometimes wraps the WHOLE thing
 * in single quotes: 'Arial, Helvetica, sans-serif' — one malformed font name.
 * This function detects that pattern and splits into proper comma-separated stack.
 *
 * Universal. Handles any font fallback string.
 */
function fixFontStackQuotes(html) {
  let fixes = 0;

  // Only act inside font-family declarations found in element `style="..."` attributes.
  // This avoids over-touching CSS inside <style> blocks, MSO conditional styles,
  // or @import rules.
  const output = html.replace(
    /style\s*=\s*"([^"]*)"/g,
    (attrMatch, styleVal) => {
      if (!/font-family\s*:/i.test(styleVal)) return attrMatch;

      // Normalize font-family declarations inside this style attribute
      const updated = styleVal.replace(
        /font-family\s*:\s*([^;]+)/gi,
        (m, rawValue) => {
          const value = rawValue.trim();

          // Tokenize: match either 'quoted' or "quoted" or bareword-until-comma
          const tokenRegex = /'([^']*)'|"([^"]*)"|([^,]+)/g;
          const tokens = [];
          let tm;
          while ((tm = tokenRegex.exec(value)) !== null) {
            const raw = (tm[1] ?? tm[2] ?? tm[3] ?? "").trim();
            if (!raw) continue;
            // If token contains commas internally (from the 'Arial, Helvetica, sans-serif' case),
            // split it into its pieces
            if (raw.includes(",")) {
              for (const sub of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
                tokens.push(sub);
              }
            } else {
              tokens.push(raw);
            }
          }

          // Filter out tokens that are CSS !important markers or malformed entries
          const cleaned = tokens
            .map((t) => t.replace(/!important$/i, "").trim())
            .filter((t) => t.length > 0 && !/^!important$/i.test(t));

          // De-duplicate case-insensitively, preserving first-seen order
          const seen = new Set();
          const uniq = [];
          for (const t of cleaned) {
            const key = t.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            uniq.push(t);
          }

          if (uniq.length === 0) return m; // safety: don't produce empty font-family

          // Quote only names containing spaces; keep single-word/hyphenated names bare.
          const generic = new Set([
            "serif", "sans-serif", "monospace", "cursive", "fantasy",
            "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace",
          ]);
          const rebuilt = uniq
            .map((t) => {
              const lower = t.toLowerCase();
              if (generic.has(lower)) return lower;
              if (/\s/.test(t)) return `'${t}'`;
              return t;
            })
            .join(", ");

          // Preserve !important if present in original
          const importantSuffix = /!important/i.test(value) ? " !important" : "";

          if (rebuilt + importantSuffix !== value) fixes++;
          return `font-family: ${rebuilt}${importantSuffix}`;
        }
      );

      return `style="${updated}"`;
    }
  );

  return { html: output, fixes };
}

/**
 * Fix 12 (NEW in v5.2.2): OCR capital-I repair.
 *
 * Tesseract frequently misreads capital I as lowercase l in font glyphs where
 * they're visually similar (Inter, Helvetica, Arial at certain sizes).
 * Example: "AI Integration" → "Al Integration".
 *
 * Strategy: scan visible text in HTML for tokens matching /\b[A-Z]l(?=[\s.,;:!?]|$)/ — a capital
 * letter followed by lowercase l ending the word. Replace with the capital-I
 * equivalent UNLESS the token is a valid English word on an exclusion list.
 *
 * Universal. Works on any content; does NOT modify attribute values or URLs.
 */
function fixOcrCapitalI(html) {
  // Exclusion list — real English words that legitimately start with capital + lowercase L
  const exclusions = new Set([
    "Al", // valid as name (e.g. "Al Pacino") — but in pharma/tech contexts usually wrong
    // We leave "Al" in because context-aware logic is hard. Instead, we only fix when
    // followed by another capitalized word (suggests acronym usage)
  ]);

  let fixes = 0;

  // Walk the HTML. Only rewrite text content, never inside tags or attributes.
  // Simple state machine: outside-tag vs inside-tag.
  let output = "";
  let i = 0;
  let inTag = false;
  let textBuffer = "";

  const flushTextBuffer = () => {
    if (textBuffer.length === 0) return;
    // Apply regex to this text chunk
    // Match: "Al" followed by space and capital letter (indicating acronym followed by word)
    //   e.g., "Al Integration" → "AI Integration"
    //         "Al plugs"       → "AI plugs"
    //         "Al can"         → "AI can"
    //         "Al-driven"      → "AI-driven"
    //         "Al boosts"      → "AI boosts"
    // Criteria: "Al" standalone as acronym (start of sentence or after space) AND next non-space char is lowercase letter (word start) OR capital letter (proper noun / another acronym) OR a hyphen/apostrophe
    const fixed = textBuffer.replace(
      /\bAl(?=[\s\-'][A-Za-z])/g,
      (match) => {
        fixes++;
        return "AI";
      }
    );
    output += fixed;
    textBuffer = "";
  };

  while (i < html.length) {
    const c = html[i];
    if (!inTag) {
      if (c === "<") {
        flushTextBuffer();
        inTag = true;
        output += c;
      } else {
        textBuffer += c;
      }
    } else {
      output += c;
      if (c === ">") inTag = false;
    }
    i++;
  }
  flushTextBuffer();

  return { html: output, fixes };
}

/**
 * Fix 13 (NEW in v5.2.2): Accent-bg dark-text rule.
 *
 * When a section has a saturated brand accent bgcolor (not pure white, not pure
 * black, not near-white), and the text inside is white but the brand's darkest
 * palette color would provide better readability + match brand intent, swap text
 * to the darkest palette color.
 *
 * This fixes the pattern where alert bars or accent sections were rendered with
 * white text instead of brand-dark text (e.g. white text on a brand accent bg instead of
 * dark-green on green).
 *
 * Universal — uses palette to find darkest non-black brand color.
 */
function fixAccentBgText(html, palette) {
  let fixes = 0;
  if (!palette || palette.length === 0) return { html, fixes };

  // Find the DARKEST non-black, non-white color in the palette
  const paletteHex = (palette || [])
    .map((p) => (typeof p === "string" ? p : p?.hex || "").toUpperCase())
    .filter((h) => /^#[0-9A-F]{6}$/.test(h));

  const darkest = paletteHex
    .filter((h) => {
      const rgb = hexToRgbTriplet(h);
      if (!rgb) return false;
      const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      // Not pure black, not near-white
      return lum > 20 && lum < 100;
    })
    .sort((a, b) => {
      const la = (() => {
        const r = hexToRgbTriplet(a);
        return 0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2];
      })();
      const lb = (() => {
        const r = hexToRgbTriplet(b);
        return 0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2];
      })();
      return la - lb;
    })[0];

  if (!darkest) return { html, fixes };

  // Walk each section. For each, check if the section bg is a saturated accent color.
  const sectionRegex =
    /(<!--\s*Section_(\d+)_([a-zA-Z_]+)(?:\s+y=\d+-\d+)?\s*-->)([\s\S]*?)(<!--\s*\/\/\s*Section_\2(?:_\3)?\s*-->)/g;

  const output = html.replace(sectionRegex, (match, openTag, n, stype, body, closeTag) => {
    if (stype === "thin_colored_band" || stype === "spacer" || stype === "divider" || stype === "footer") {
      return match;
    }

    const bgMatch = body.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/);
    if (!bgMatch) return match;
    const bg = bgMatch[1].toUpperCase();
    const rgb = hexToRgbTriplet(bg);
    if (!rgb) return match;

    const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    const sat = Math.max(...rgb) - Math.min(...rgb);

    // Is this a saturated accent bg (not white, not black, meaningfully saturated)?
    const isAccent = sat >= 60 && lum >= 80 && lum <= 200;
    if (!isAccent) return match;

    // Darkest-color-on-accent vs white-on-accent:
    // Developers usually pick the BRAND DARK color for text on a brand accent bg
    // (matches overall branding) even if white would have slightly higher raw contrast.
    // We prefer brand-dark as long as it stays readable (luminance distance > 70).
    const darkRgb = hexToRgbTriplet(darkest);
    const darkLum = 0.299 * darkRgb[0] + 0.587 * darkRgb[1] + 0.114 * darkRgb[2];
    const darkContrast = Math.abs(lum - darkLum);

    // Brand-dark wins if it's sufficiently readable (contrast >= 70 is comfortable)
    const READABLE_CONTRAST_THRESHOLD = 70;
    if (darkContrast < READABLE_CONTRAST_THRESHOLD) return match;

    // Replace all `color: #FFFFFF` and `color:#ffffff` inside this section's body with darkest.
    // Use (^|[^\-]) lookbehind to avoid matching background-color.
    let newBody = body.replace(/style\s*=\s*"([^"]*)"/gi, (attrM, styleVal) => {
      const updated = styleVal.replace(
        /(^|[^\-])\bcolor\s*:\s*#(?:FFFFFF|ffffff|FFF|fff)\b/g,
        (m, prefix) => `${prefix}color: ${darkest}`
      );
      return `style="${updated}"`;
    });

    if (newBody !== body) fixes++;
    return openTag + newBody + closeTag;
  });

  return { html: output, fixes };
}

function addMissingZipWarning(html, imageUrlMap, hadRelativePaths) {
  if (Object.keys(imageUrlMap || {}).length > 0) return html;
  if (!hadRelativePaths) return html;

  const warning = `\n<!-- ⚠ MAVELOPER WARNING: No image ZIP was uploaded. Image paths in this HTML are placeholders. Re-run generation with the image ZIP to get working Dropbox URLs. -->\n`;
  // Insert right after <body ...>
  return html.replace(/(<body[^>]*>)/i, `$1${warning}`);
}
/**
 * Main post-processing entry point (v5.2.2).
 * Runs all deterministic fixes in order and returns the fixed HTML + a report.
 *
 * Order matters:
 *  1. fixImageUrls — replace local image paths with Dropbox URLs
 *  2. rebindSectionColors — fix section bgcolors using band_map y-ranges (must run BEFORE fixNearWhite)
 *  3. fixNearWhite — normalize JPEG-shifted near-whites to pure #FFFFFF
 *  4. forceAlertBarWarmBg — ensure alert bars use warm palette color if available
 *  5. fixAlertBarContrast — alert bar text contrast (black on warm, white on dark)
 *  6. fixAccentBgText — use brand-dark text on saturated brand-accent bgs (v5.2.2)
 *  7. universalTextContrast — fix all text-on-bg contrast globally
 *  8. fixCtaContrast — auto-invert CTA text color based on CTA bg luminance (v5.2.2)
 *  9. fixFontStackQuotes — un-nest malformed single-quoted font stacks (v5.2.2)
 *  10. fixOcrCapitalI — repair "Al" OCR misread back to "AI" in content text (v5.2.2)
 *  11. fixActivityFeed — unwrap day+time bullet lists to plain rows
 *  12. fixThinBands — drop hallucinated thin stripes whose color isn't used elsewhere
 *  13. addMissingZipWarning — visible comment if no image ZIP was uploaded
 */
/**
 * Fix 14 (NEW in v5.2.2): Strip inline SVG/data-URL backgrounds from styles.
 *
 * When Stage 2 generates bullet icons using `background: url('data:image/svg+xml;utf8,<svg ...>')`,
 * the inner double-quote characters inside the SVG break the HTML style attribute
 * parsing — browsers show raw SVG code as visible text. This is a CRITICAL bug.
 *
 * Fix: detect `background: url('data:image/svg...` or similar inside style attributes,
 * strip the entire background declaration, and add a `list-style-type: disc` fallback.
 * This is safe universally — bullets just render with default disc markers.
 */
function fixInlineSvgDataUrl(html) {
  let fixes = 0;
  let ulFixes = 0;

  // Step 1: Directly strip any `background: url('data:...')` or `background-image: url('data:...')`
  // declaration and everything up to the next `;` or the end of the style attr's closing quote.
  // This works even when the inner double-quotes of the SVG have already broken the style
  // attribute parsing — we just remove the toxic substring by pattern match, not by attr parsing.
  //
  // The data URL ends at the first `)` after the `url(` — even though the SVG contains internal
  // quotes, it does NOT contain literal `)` characters (the closing `/>` is not a paren).
  //
  // After stripping the url(...) part, also consume any trailing "no-repeat left 8px" style
  // keywords and the terminating ";" if present.
  let output = html.replace(
    /background(?:-image)?\s*:\s*url\s*\(\s*['"]?data:[^)]*\)(?:\s*(?:no-repeat|repeat|repeat-x|repeat-y|left|right|center|top|bottom|\d+(?:px|%)?))*\s*;?/gi,
    () => {
      fixes++;
      return "";
    }
  );

  // Step 2: Clean up any leftover double-semicolons or whitespace artifacts in styles.
  output = output.replace(/;\s*;+/g, ";").replace(/"\s*;\s*"/g, '";"');

  // Step 3: Any <ul> with list-style-type:none should switch to disc for a visible bullet.
  output = output.replace(
    /<ul([^>]*style\s*=\s*"[^"]*list-style-type\s*:\s*none[^"]*"[^>]*)>/gi,
    (match, attrs) => {
      const newAttrs = attrs.replace(
        /list-style-type\s*:\s*none/gi,
        "list-style-type: disc"
      );
      ulFixes++;
      return `<ul${newAttrs}>`;
    }
  );

  return { html: output, fixes, ulFixes };
}

/**
 * Fix 15 (NEW in v5.2.2): Clamp image widths to min(placeholder, original).
 *
 * Every <img> has a `width="N"` attribute and `max-width: Npx` in its inline
 * style — that's the placeholder width Stage 2 emitted from the spec. The ZIP
 * contains the actual source image at its original pixel dimensions. If the
 * original is SMALLER than the placeholder, we downsize the placeholder to the
 * original (upscaling a small source looks bad). If original is LARGER, we
 * keep the placeholder (renders crisp on retina).
 *
 * Aspect ratio is always preserved from the ZIP original.
 *
 * Universal. Executes on real measured pixel data.
 */
function fixImageDimensions(html, imageDimensionsMap) {
  let fixes = 0;
  if (!imageDimensionsMap || Object.keys(imageDimensionsMap).length === 0) {
    return { html, fixes, skipped: "no dimensions map" };
  }

  // Match each <img> tag. Capture src, width, and inline style so we can rewrite them.
  const imgRegex = /<img\b([^>]*)>/gi;
  const output = html.replace(imgRegex, (match, attrs) => {
    const srcMatch = attrs.match(/src\s*=\s*"([^"]+)"/i);
    if (!srcMatch) return match;
    const src = srcMatch[1];

    // Extract filename from src (strip URL params and path)
    const rawName = src.split("?")[0].split("/").pop();
    if (!rawName) return match;

    // Try exact match first, then case-insensitive
    let dims = imageDimensionsMap[rawName];
    if (!dims) {
      const lowered = rawName.toLowerCase();
      for (const key of Object.keys(imageDimensionsMap)) {
        if (key.toLowerCase() === lowered) {
          dims = imageDimensionsMap[key];
          break;
        }
      }
    }
    if (!dims || !dims.w || !dims.h) return match;

    const origW = dims.w;
    const origH = dims.h;

    // Read current placeholder width from width attr (prefer) or style max-width
    const widthAttrMatch = attrs.match(/\bwidth\s*=\s*["']?(\d+)["']?/i);
    const styleMatch = attrs.match(/style\s*=\s*"([^"]*)"/i);
    const maxWidthMatch = styleMatch ? styleMatch[1].match(/max-width\s*:\s*(\d+)px/i) : null;

    const placeholderW =
      (widthAttrMatch ? parseInt(widthAttrMatch[1], 10) : null) ||
      (maxWidthMatch ? parseInt(maxWidthMatch[1], 10) : null) ||
      origW;

    // Final width = min(placeholder, original). Only downsizes, never upsizes.
    const finalW = Math.min(placeholderW, origW);
    const finalH = Math.round((origH / origW) * finalW);

    // Nothing to change
    if (finalW === placeholderW && (!widthAttrMatch || parseInt(widthAttrMatch[1], 10) === finalW)) {
      return match;
    }

    let newAttrs = attrs;

    // Update width="..." attribute (set or replace)
    if (widthAttrMatch) {
      newAttrs = newAttrs.replace(
        /\bwidth\s*=\s*["']?\d+["']?/i,
        `width="${finalW}"`
      );
    } else {
      newAttrs = newAttrs.replace(/(<img\b)?/i, "") + ` width="${finalW}"`;
    }

    // Update max-width inside style attribute
    if (styleMatch) {
      const newStyle = styleMatch[1].replace(
        /max-width\s*:\s*\d+px/gi,
        `max-width: ${finalW}px`
      );
      if (newStyle !== styleMatch[1]) {
        newAttrs = newAttrs.replace(
          /style\s*=\s*"[^"]*"/i,
          `style="${newStyle}"`
        );
      }
    }

    // Add explicit height to help Outlook rendering (optional, but matches gold-standard)
    const heightAttrMatch = newAttrs.match(/\bheight\s*=\s*["']?(\d+)["']?/i);
    if (!heightAttrMatch && finalH > 0) {
      newAttrs = newAttrs + ` height="${finalH}"`;
    }

    fixes++;
    return `<img${newAttrs}>`;
  });

  return { html: output, fixes };
}

/**
 * Fix 16 (NEW in v5.2.2): Merge adjacent same-bg body_text/heading sections.
 *
 * When Stage 1 over-fragments a continuous body copy block into multiple
 * body_text sections, each becomes its own em_wrapper with redundant padding.
 * This post-processor detects adjacent sections with the SAME bgcolor AND
 * similar padding, and collapses them into one wrapper — the content rows
 * flow into a single table, reducing cumulative padding and matching dev
 * patterns.
 */
function mergeAdjacentSameBgSections(html) {
  let merges = 0;

  // Find every section open/close pair with y-range + bg attribute
  const sectionBlockRegex =
    /(<!--\s*Section_(\d+)_([a-zA-Z_]+)(?:\s+y=\d+-\d+)?\s*-->)([\s\S]*?)(<!--\s*\/\/\s*Section_\2(?:_\3)?\s*-->)/g;

  const MERGEABLE = new Set(["body_text", "heading", "bullet_list"]);

  // Parse all sections first
  const sections = [];
  let m;
  while ((m = sectionBlockRegex.exec(html)) !== null) {
    const bgMatch = m[4].match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/);
    sections.push({
      full: m[0],
      open: m[1],
      n: parseInt(m[2], 10),
      type: m[3],
      body: m[4],
      close: m[5],
      bg: bgMatch ? bgMatch[1].toUpperCase() : null,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  if (sections.length < 2) return { html, merges };

  // Find merge groups: adjacent sections where type is MERGEABLE AND bg matches
  const groups = [];
  let cur = [sections[0]];
  for (let i = 1; i < sections.length; i++) {
    const prev = cur[cur.length - 1];
    const s = sections[i];
    if (
      MERGEABLE.has(prev.type) &&
      MERGEABLE.has(s.type) &&
      prev.bg &&
      s.bg &&
      prev.bg === s.bg
    ) {
      cur.push(s);
    } else {
      if (cur.length > 1) groups.push(cur);
      cur = [s];
    }
  }
  if (cur.length > 1) groups.push(cur);

  if (groups.length === 0) return { html, merges };

  // Build new HTML by replacing each group with a merged single-wrapper section.
  // Extract the content rows (everything inside the inner <td class="em_pad*">
  // <table>...<tbody>...</tbody></table></td>) from each section and concatenate.
  let output = html;
  // Replace from bottom to top to keep indices valid
  for (const group of groups.reverse()) {
    const firstOpen = group[0].open;
    const lastClose = group[group.length - 1].close;

    // Extract the inner content rows from each section's body.
    // Pattern: <table ... class="em_wrapper..." ...><tbody><tr><td ... class="em_pad..."><table...><tbody>INNER_ROWS</tbody></table></td></tr></tbody></table>
    const innerRows = [];
    for (const s of group) {
      const innerMatch = s.body.match(
        /<table[^>]*class="em_wrapper[^"]*"[^>]*>[\s\S]*?<tbody>\s*<tr>\s*<td[^>]*class="em_pad[^"]*"[^>]*>\s*<table[^>]*>\s*<tbody>([\s\S]*?)<\/tbody>\s*<\/table>\s*<\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/i
      );
      if (innerMatch) innerRows.push(innerMatch[1].trim());
    }

    if (innerRows.length !== group.length) continue; // couldn't parse all — skip this group safely

    // Use the FIRST section's wrapper as the canonical wrapper
    const firstSection = group[0];
    const mergedInnerRows = innerRows.join("\n");
    const mergedWrapper = firstSection.body.replace(
      /(<table[^>]*class="em_wrapper[^"]*"[^>]*>[\s\S]*?<tbody>\s*<tr>\s*<td[^>]*class="em_pad[^"]*"[^>]*>\s*<table[^>]*>\s*<tbody>)([\s\S]*?)(<\/tbody>\s*<\/table>\s*<\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>)/i,
      `$1\n${mergedInnerRows}\n$3`
    );
    const mergedBlock = firstOpen + mergedWrapper + lastClose;

    // Replace the full range from group[0].start to group[end].end with mergedBlock
    const rangeStart = group[0].start;
    const rangeEnd = group[group.length - 1].end;
    output = output.slice(0, rangeStart) + mergedBlock + output.slice(rangeEnd);
    merges++;
  }

  return { html: output, merges };
}

/**
 * Fix 17 (NEW in v5.2.2): Diagnostic warning if ZIP was uploaded but Dropbox
 * returned empty imageUrlMap. Adds a LARGE visible comment block + visible banner.
 */
function addDropboxFailureWarning(html, imageUrlMap, hadRelativePaths, zipWasUploaded) {
  if (!zipWasUploaded) return html;
  if (Object.keys(imageUrlMap || {}).length > 0) return html;
  if (!hadRelativePaths) return html;

  const warningComment = `\n<!-- ============================================================\n⚠⚠⚠ MAVELOPER CRITICAL WARNING ⚠⚠⚠\nZIP file was uploaded but Dropbox image-URL map is EMPTY.\nThe Dropbox upload pipeline failed silently.\nAll image paths in this HTML are broken placeholders.\nACTION: Check Railway logs for \"uploadImagesToDropbox\" errors,\nverify DROPBOX_APP_KEY/SECRET/REFRESH_TOKEN in Railway env,\nand confirm the Dropbox app has files.content.write permission.\n============================================================ -->\n`;

  const warningBanner = `
<tr>
  <td align="center" valign="top" bgcolor="#FF0000" style="background-color: #FF0000; padding: 20px; font-family: Arial, sans-serif; font-size: 14px; color: #FFFFFF; text-align: center; font-weight: bold;">
    ⚠ MAVELOPER: Image upload pipeline failed. Image paths in this HTML are broken. Re-generate after checking Dropbox credentials and Railway logs.
  </td>
</tr>`;

  // Insert comment after <body>
  let output = html.replace(/(<body[^>]*>)/i, `$1${warningComment}`);
  // Insert banner inside em_main_table as first row
  output = output.replace(
    /(<table[^>]*class="em_main_table"[^>]*>\s*(?:<tbody>\s*)?)/i,
    `$1${warningBanner}`
  );

  return output;
}

// =====================================================================
// v5.4.2 — DETERMINISTIC POST-PROCESSORS (preserved into v5.5.0)
// =====================================================================
// These run on the generated HTML after Stage 2. They fix bugs that no
// amount of prompt rules can reliably eliminate, by acting on the actual
// generated HTML structure.

/**
 * v5.4.2 Fix: Strip the user-specified secondary font from body font-family
 * stacks. Stage 2 has been observed to incorrectly inline the secondary font
 * into every element's font-family, even though the user only intended
 * that font to be loaded but not used as body fallback.
 *
 * Universal: works for any quoted font name passed via `secondaryFont`.
 */
function fixSecondaryFontInBodyStack(html, secondaryFont) {
  if (!secondaryFont || typeof secondaryFont !== "string") {
    return { html, fixes: 0 };
  }
  const sf = secondaryFont.trim();
  if (sf.length === 0) return { html, fixes: 0 };

  let fixes = 0;
  // Match any quoted form: 'FontName', "FontName", or unquoted FontName surrounded by commas.
  const escapedSf = sf.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

  const output = html.replace(
    /font-family\s*:\s*([^;"]+)/gi,
    (match, value) => {
      if (!new RegExp(`\\b${escapedSf}\\b`, "i").test(value)) {
        return match;
      }
      // Tokenize the font-family value
      const tokens = value
        .split(",")
        .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
        .filter((t) => t.length > 0 && t.toLowerCase() !== sf.toLowerCase());

      if (tokens.length === 0) return match; // safety

      // Re-quote tokens with spaces; preserve generics
      const generic = new Set([
        "serif", "sans-serif", "monospace", "cursive", "fantasy",
        "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace",
      ]);
      const rebuilt = tokens
        .map((t) => {
          const lower = t.toLowerCase();
          if (generic.has(lower)) return lower;
          if (/\s/.test(t)) return `'${t}'`;
          return t;
        })
        .join(", ");

      fixes++;
      return `font-family: ${rebuilt}`;
    }
  );

  return { html: output, fixes };
}

/**
 * v5.4.2 Fix: Convert Google Fonts @import in <style> block to a proper <link>
 * tag in <head>. @import is slower and can be blocked by some email clients;
 * <link> is the recommended pattern.
 *
 * Universal: detects any @import url('https://fonts.googleapis.com/...') pattern.
 */
function convertGoogleFontImportToLink(html) {
  const importRegex = /@import\s+url\s*\(\s*['"]?(https:\/\/fonts\.googleapis\.com\/[^'")]+)['"]?\s*\)\s*;?/gi;
  const matches = [...html.matchAll(importRegex)];
  if (matches.length === 0) return { html, fixes: 0 };

  let output = html;
  const linkTags = [];
  for (const m of matches) {
    const fontUrl = m[1];
    linkTags.push(`<link href="${fontUrl}" rel="stylesheet" />`);
  }

  // Strip the @import lines
  output = output.replace(importRegex, "");

  // Strip empty <style>...</style> blocks left after stripping @import
  output = output.replace(/<style[^>]*>\s*<\/style>/gi, "");
  // Strip wrapping <!--[if !mso]><!--> ... <!--<![endif]--> if it now contains nothing meaningful
  output = output.replace(
    /<!--\[if !mso\]><!-->\s*<!--<!\[endif\]-->/gi,
    ""
  );

  // Insert link tags before the closing </head>
  const linkBlock = "  " + linkTags.join("\n  ") + "\n";
  output = output.replace(/(<\/head>)/i, `${linkBlock}$1`);

  return { html: output, fixes: matches.length };
}

/**
 * v5.4.2 Fix: Repair malformed self-closing img tags where Stage 2 emitted
 *   style="..."/ height="X">
 * The forward-slash got placed BEFORE the closing-tag bracket but other
 * attributes appear after it. Repair to:
 *   style="..." height="X"/>
 *
 * Universal: matches any <img> tag with /-misplaced.
 */
function fixMalformedSelfClosingImg(html) {
  let fixes = 0;
  const output = html.replace(
    /<img\s+([^>]*?)style\s*=\s*"([^"]*)"\s*\/\s+([^>]+?)\s*\/?\s*>/gi,
    (match, before, styleVal, afterAttrs) => {
      fixes++;
      return `<img ${before}style="${styleVal}" ${afterAttrs.trim()}/>`;
    }
  );
  return { html: output, fixes };
}

/**
 * v5.4.2 Fix: Merge stacked-color heading rows into a single cell with spans.
 *
 * Stage 2 frequently violates the spans rule, splitting a 2-color headline
 * (e.g., one phrase in dark color, another phrase in accent color, on adjacent
 * visual lines) into TWO adjacent <tr> rows with identical font but different
 * color. The developer reference always uses ONE cell with multiple <span>s.
 *
 * Heuristic: detect adjacent <tr><td...>TEXT</td></tr> pairs where:
 *   - Both <td>s have align="center"
 *   - Both have the same font-family + font-size + line-height + font-weight
 *   - Colors differ
 *   - Texts are short (<80 chars each)
 *   - No image or other complex content between them
 * Merge into one <td> with two <span>s.
 *
 * Universal: works for any 2-color split heading.
 */
function fixStackedHeadingRows(html) {
  let fixes = 0;
  const rowPairRegex =
    /<tr>\s*<td\s+align="center"\s+valign="top"\s+(class="[^"]*"\s+)?style="([^"]*)"\s*>([^<]{1,80})<\/td>\s*<\/tr>\s*<tr>\s*<td\s+align="center"\s+valign="top"\s+(class="[^"]*"\s+)?style="([^"]*)"\s*>([^<]{1,80})<\/td>\s*<\/tr>/gi;

  let output = html;
  let prev = null;
  // Loop because merging shrinks the HTML and may expose new pairs
  while (prev !== output) {
    prev = output;
    output = output.replace(
      rowPairRegex,
      (match, cls1, style1, text1, cls2, style2, text2) => {
        // Extract font + color from each style
        const extract = (s) => {
          const ff = (s.match(/font-family\s*:\s*([^;]+)/i) || [])[1]?.trim();
          const fs = (s.match(/font-size\s*:\s*([^;]+)/i) || [])[1]?.trim();
          const lh = (s.match(/line-height\s*:\s*([^;]+)/i) || [])[1]?.trim();
          const fw = (s.match(/font-weight\s*:\s*([^;]+)/i) || [])[1]?.trim();
          const col = (s.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i) || [])[1]?.trim();
          return { ff, fs, lh, fw, col };
        };
        const a = extract(style1);
        const b = extract(style2);

        // Must match font, size, line-height, weight; must differ on color
        if (!a.ff || a.ff !== b.ff) return match;
        if (a.fs !== b.fs) return match;
        if (a.lh !== b.lh) return match;
        if (a.fw !== b.fw) return match;
        if (!a.col || !b.col) return match;
        if (a.col.toLowerCase() === b.col.toLowerCase()) return match;

        // Text content sanity check: not empty
        if (!text1.trim() || !text2.trim()) return match;

        // Build the merged <td>: keep style1 (without color) on the td, use spans for colors
        const baseStyle = style1
          .replace(/(?:^|;)\s*color\s*:\s*[^;]+;?/i, "")
          .replace(/;;+/g, ";")
          .trim();
        const merged = `<tr>
                          <td align="center" valign="top" ${cls1 || ""}style="${baseStyle}"><span style="color: ${a.col};">${text1.trim()}</span><br /><span style="color: ${b.col};">${text2.trim()}</span></td>
                        </tr>`;
        fixes++;
        return merged;
      }
    );
  }

  return { html: output, fixes };
}

function postProcessHtml(html, { imageUrlMap, palette, bandMap, imageDimensionsMap, zipWasUploaded, secondaryFont }) {
  const report = {};
  const hadRelativePaths = /src="images\//i.test(html);

  // v5.4.2: fixImageUrls now has filename match + sequential positional fallback
  const r1 = fixImageUrls(html, imageUrlMap, imageDimensionsMap);
  html = r1.html;
  report.imageUrls = {
    replaced: r1.replaced,
    sequentialFallbacks: r1.sequentialFallbacks,
    fallbackUsed: r1.fallbackUsed,
    unmatched: r1.unmatched,
  };

  // v5.4.2: Convert Google Fonts @import to <link> in <head>
  const rGFont = convertGoogleFontImportToLink(html);
  html = rGFont.html;
  report.googleFontLinkConvert = { fixes: rGFont.fixes };

  // v5.4.2: Repair malformed self-closing img tags
  const rImgMal = fixMalformedSelfClosingImg(html);
  html = rImgMal.html;
  report.malformedImgFix = { fixes: rImgMal.fixes };

  // v5.4.2: Strip user-specified secondary font from body font-family stacks
  const rSecFont = fixSecondaryFontInBodyStack(html, secondaryFont);
  html = rSecFont.html;
  report.secondaryFontStrip = { fixes: rSecFont.fixes };

  // v5.4.2: Merge stacked-color heading rows into single cell with spans
  const rStacked = fixStackedHeadingRows(html);
  html = rStacked.html;
  report.stackedHeadingMerge = { fixes: rStacked.fixes };

  const r2 = rebindSectionColors(html, bandMap, palette);
  html = r2.html;
  report.rebindSectionColors = { rebound: r2.rebound, checked: r2.checked, skipped: r2.skipped };

  const r3 = fixNearWhite(html, palette);
  html = r3.html;
  report.nearWhite = { normalizedColors: r3.normalizedColors, count: r3.count };

  const r4 = forceAlertBarWarmBg(html, palette);
  html = r4.html;
  report.alertBarWarmBg = { fixes: r4.fixes };

  const r5 = fixAlertBarContrast(html);
  html = r5.html;
  report.alertBar = { fixes: r5.fixes };

  const r6 = universalTextContrast(html);
  html = r6.html;
  report.universalContrast = { fixes: r6.fixes };

  // Run accent-bg text AFTER universalTextContrast so brand-dark text isn't
  // reverted by the generic luminance rule.
  const r5b = fixAccentBgText(html, palette);
  html = r5b.html;
  report.accentBgText = { fixes: r5b.fixes };

  const r6b = fixCtaContrast(html);
  html = r6b.html;
  report.ctaContrast = { fixes: r6b.fixes };

  const r6c = fixFontStackQuotes(html);
  html = r6c.html;
  report.fontStackQuotes = { fixes: r6c.fixes };

  const r6d = fixOcrCapitalI(html);
  html = r6d.html;
  report.ocrCapitalI = { fixes: r6d.fixes };

  // v5.2.2: Strip inline SVG/data-URL backgrounds that break style attribute parsing
  const rSvg = fixInlineSvgDataUrl(html);
  html = rSvg.html;
  report.inlineSvgDataUrl = { fixes: rSvg.fixes, ulFixes: rSvg.ulFixes };

  // v5.2.2: Clamp image widths to min(placeholder, original)
  const rDims = fixImageDimensions(html, imageDimensionsMap);
  html = rDims.html;
  report.imageDimensions = { fixes: rDims.fixes, skipped: rDims.skipped };

  const r7 = fixActivityFeed(html);
  html = r7.html;
  report.activityFeed = { fixes: r7.fixes };

  const r8 = fixThinBands(html, palette, bandMap);
  html = r8.html;
  report.thinBands = { removed: r8.removed };

  // v5.2.2: Merge adjacent same-bg body_text / heading / bullet sections
  const rMerge = mergeAdjacentSameBgSections(html);
  html = rMerge.html;
  report.mergedSections = { merges: rMerge.merges };

  html = addMissingZipWarning(html, imageUrlMap, hadRelativePaths);
  // v5.2.2: Escalate to visible warning if ZIP was uploaded but upload failed
  html = addDropboxFailureWarning(html, imageUrlMap, hadRelativePaths, zipWasUploaded);

  return { html, report };
}



// =====================================================================
// STAGE 1 PROMPT (v5.0.0) — Full-design analysis with pixel palette
// Replaces v4.0.1's per-band classification. Claude now sees the full design
// once, with pixel-exact colors and OCR text provided as authoritative data.
// =====================================================================
const STAGE1_PROMPT = `You are analyzing an email design PDF to produce a structured JSON specification. You will receive:

1. ONE OR MORE TILE IMAGES showing the email design. Email designs are tall so they are split into overlapping horizontal tiles. Each tile is preceded by a text label like "--- TILE N of M — y_range=<y_start>-<y_end> ---" that tells you the tile's vertical position in the full design. Tiles overlap by ~300px so you can see continuity across boundaries. Treat the tiles as ONE continuous design.
2. A pixel-sampled COLOR PALETTE — these are the exact hex values that appear in the design's pixels. Use these VERBATIM for any color field in your JSON output. Do NOT round, approximate, or substitute colors. A dark-charcoal hex like #2A2623 is different from pure black #000000. A specific brand green like #1FC23D is different from neon green #00FF00. A cream off-white like #F7F3E4 is different from generic #F5F5F5. Match the exact palette hex, never a common default.
3. OCR-EXTRACTED TEXT — every piece of text visible in the design. Use this text VERBATIM for every "text" field. NEVER paraphrase, rewrite, or invent text. If you cannot match a piece of OCR text to a visible section, include it where it logically belongs.
4. A BAND MAP — pixel-exact positions (y_start, y_end, height, bg_hex) of every horizontal band detected in the design. Coordinates are in the FULL design's pixel space, not per-tile. Use this to verify you don't miss thin elements (colored stripes, narrow alert bars, divider lines).
5. An IMAGE ASSETS LIST — uploaded image files with filenames, dimensions, and Dropbox URLs. Match each visible image in the design to one of these files by content matching, and include the exact Dropbox URL in your output.
6. Developer-specified values (email width, fonts, ESP merge-tag style) — these are authoritative overrides.

Output ONLY a JSON object. No markdown fences. No explanation. Start with { end with }.

========================================
CORE RULES
========================================

A. LOGICAL SECTIONS (not raw bands)
   Group the design into LOGICAL content sections as a human email developer would. A "section" is a semantic unit: a heading + body + CTA block is ONE section. A two-column layout with its content is ONE section. A thin colored stripe on its own is ONE section.
   Do NOT produce one section per pixel-band. Do NOT fragment logical groups.
   Do NOT produce fake sections that aren't visible in the design (no hallucinated thin gray bars from JPEG compression).

B. BAND COVERAGE
   Every band in the BAND MAP must be accounted for in your sections array. Your sections array can have FEWER entries than the band map (because you merge related bands), but the visible y-range from band 1 to the last band must be fully covered by your sections in order.
   If a band with height >= 10px and a distinctive color (not white/gray near-white) exists but you don't have a section for it, you've missed something.

C. COLORS FROM PALETTE
   For every "bg", "color", "cta_bg", "cta_color" field: use an exact hex value from the supplied PALETTE. Do not invent new hex values. If you need a color not in the palette, pick the closest palette color.

D. TEXT FROM OCR
   For every "text" field: copy verbatim from the OCR output. Preserve case, punctuation, special characters.

E. MULTI-COLOR HEADINGS WITH SPANS
   When a single visible heading line has TWO OR MORE colors inline (e.g., the first part of a heading in one accent color + the second part in another color, all on one visual line/paragraph with no line break between them), represent this as ONE text element with a "spans" array:
   {
     "el": "text",
     "spans": [
       { "text": "[FIRST PART OF HEADING]", "color": "#<exact hex>" },
       { "text": " [SECOND PART OF HEADING]", "color": "#<exact hex>" }
     ],
     "size": 28, "weight": 700, "lh": 34, "align": "center", "transform": "uppercase"
   }
   Do NOT duplicate the text across two text elements with different colors.

F. IMAGES
   For every visible image in the design, inspect the IMAGE ASSETS LIST and pick the filename whose content description matches. Populate:
   {
     "el": "image",
     "src": "<exact Dropbox URL from the list>",
     "alt": "descriptive alt text based on what the image shows",
     "width": <dimension from list>
   }
   If no match exists, use { "el": "image", "src": "", "alt": "<description>", "width": <estimated> } and Claude in Stage 2 will use a placeholder.

G. ALIGNMENT
   For every text element, observe the actual visual alignment in the design (left, center, right). Never default to left if the design shows center.

H. REPEATED VARIANTS
   If the design shows the same content twice (e.g., dark-variant preheader + light-variant preheader, intentional), output both as separate sections.

I. TYPOGRAPHY MEASUREMENT (v5.4.0 — pixel-grounded measurement, not estimation)
   When you assign a "size" (font-size) to a text element, measure it from the actual pixel rendering in the tile, not from intuition. Use this method:
   - Identify a representative uppercase letter (or "x" for lowercase-only words) in the text
   - Visually measure its CAP-HEIGHT (top of capital letter to baseline) in pixels
   - font-size ≈ cap-height ÷ 0.7 (cap-height is roughly 70% of font-size for most fonts)
   - For line-height ("lh"): measure the vertical distance from baseline to baseline of two consecutive lines
   COMMON BENCHMARKS to ground your measurements:
   - Body copy at 14px ≈ 10px cap-height
   - Body copy at 16px ≈ 11-12px cap-height
   - Body copy at 18px ≈ 13px cap-height
   - Section heading at 24px ≈ 17px cap-height
   - Section heading at 28px ≈ 20px cap-height
   - Hero heading at 36px ≈ 25px cap-height
   - Hero heading at 46px ≈ 32px cap-height
   IF YOU ARE UNSURE BETWEEN TWO SIZES, PICK THE LARGER. Designers rarely use tiny text. Hero headlines are commonly 32-50px, NOT 24-28px. Section headings are commonly 24-32px, NOT 18-20px. Body copy is commonly 14-18px.
   NEVER default a hero headline to 28px without measuring. NEVER default body copy to 14px without measuring.

J. BODY TEXT COLOR — never pure black unless explicitly black
   Body copy and paragraph text in modern email designs is RARELY pure #000000. It's usually a dark gray.
   When extracting "color" for body text or paragraphs, scan the palette for the darkest non-pure-black gray that exists, and use THAT instead of defaulting to #000000.
   Pure #000000 is acceptable ONLY for: section headings if the design clearly uses pure black, footer copyright text on a colored bg, or text-on-light backgrounds where the palette has pure black.
   If the palette contains a near-black tint, that IS the body text color — use it verbatim, do not collapse to #000000.

K. BORDER-RADIUS DETECTION (v5.4.0 — measure, don't default to pill)
   For every CTA button and card container, measure the corner radius visually.
   COMMON RADII in modern email design: 4px, 6px, 8px, 12px, 16px, 24px, 30px (pill).
   "Pill" radius (≥ 20px) only when the corner curvature visibly equals or exceeds half the button height — i.e., the corners are fully rounded and the sides are straight semicircles.
   Slightly-rounded buttons (where you can clearly see straight edges in the corners) are typically 4px–12px, NOT 30px.
   When unsure, measure the visible curvature: a corner that consumes less than 1/4 of the button height is a small radius (4-8px), not pill.
   DO NOT default to "cta_radius": 30. Inspect every button and pick the actual radius.
   Apply the same logic to card containers (testimonial cards, feature cards, closing CTA cards, etc.) — they typically use 8px radii, occasionally 12-16px.

L. CARD CONTAINERS (v5.4.0 — detect bordered/colored sub-containers)
   When a section's content is visually contained inside a SUB-CONTAINER that has its own border, background color, or rounded corners (e.g., a testimonial inside a bordered rounded card, or a "ready to add Flows?" CTA inside a light-purple rounded card), this is a CARD CONTAINER and must be represented in the spec.
   Use the "card" property on a content element OR add a "container" object on the content array level. Recommended schema: add a "card" object to the content element that visually contains the card's children:
   {
     "el": "card",
     "card_bg": "#<exact hex from palette, e.g. a light tinted shade>",
     "card_border": "#<exact hex if visible border, else null>",
     "card_border_width": 1,
     "card_radius": 8,
     "card_pad": "T R B L",
     "content": [ <nested content elements like text, cta, image> ]
   }
   Alternatively, set "container" at the section level if the entire section is a card.
   Detection cues:
   - Visible 1-2px outlined border in any brand/accent color
   - Subtle bg tint (e.g., a light tinted shade) different from the section bg
   - Visible rounded corners on the inner block

M. FOOTER MULTI-COLUMN DETECTION (v5.4.0)
   Footers in modern email design are commonly TWO-COLUMN: logo + social icons on the LEFT, contact info / address / "Follow us on:" on the RIGHT (or vice versa). Single-column centered footers exist but are LESS common.
   When detecting a footer section:
   - If the design shows logo and contact info side-by-side (one on left, one on right), output a "columns" content element with two cols.
   - If a horizontal divider/line separates the upper logo+social+contact group from the lower legal links (Privacy/Email/Unsubscribe), include the divider explicitly.
   - The legal links bar at the bottom is typically a SINGLE row with separator pipes "|" between links.
   - Footer body text on a brand-colored bg is typically a light tint of that brand color, NOT pure white.

N. THIN BAND CAUTION (v5.4.0)
   The BAND MAP may contain entries for very thin (≤ 4px) bands of unique colors that DO NOT appear elsewhere in the design. These are likely JPEG compression artifacts at section transitions, NOT intentional design elements.
   Before adding a "thin_colored_band" section, verify visually in the tile image:
   - Does the thin band appear as a clear, intentional horizontal stripe in the design?
   - Is the band's color repeated elsewhere in the design (in headings, CTAs, accents)? If yes, it's likely real.
   - Is the band's color a unique tint that appears nowhere else? If yes, it's likely a JPEG artifact — DO NOT include it as a section.
   When in doubt, OMIT the thin band rather than fabricate one.

========================================
SCHEMA — output a JSON object with these fields. ALL fields are OPTIONAL except "width", "sections" (with at least one section). Use the keys you need; omit ones that don't apply. NEVER output placeholder strings like "<exact hex>" or "<number>" — always output real values OR omit the key.

EXAMPLE STRUCTURE (substitute real measured values for the design you are analyzing):

{
  "width": 600,
  "font_body": "PrimaryFont",
  "font_heading": "PrimaryFont",
  "band_count": 16,
  "sections": [
    {
      "n": 1,
      "type": "preheader",
      "bg": "#FFFFFF",
      "pad": "10 20 10 20",
      "align": "center",
      "dark_variant": false,
      "y_start": 0,
      "y_end": 70,
      "content": [
        { "el": "text", "text": "If you can't see this email", "size": 12, "weight": 300, "lh": 15, "color": "#3D3D3D", "align": "left" },
        { "el": "link", "text": "View Online", "size": 12, "weight": 400, "lh": 15, "color": "#AABBCC", "align": "right", "href": "{{view_as_page_url}}" }
      ]
    }
  ],
  "palette_used": ["#FFFFFF", "#000000", "#AABBCC"]
}

ALLOWED section types: thin_colored_band, preheader, nav, logo, hero_image, alert_bar, heading, body_text, cta, columns, divider, spacer, testimonial, image, phone_bar, closing_cta, bullet_list, footer, disclaimer, social, card

ALLOWED content[].el types: text, image, cta, divider, spacer, link, social_icons, columns, bullet_list, card

CONTENT FIELDS BY ELEMENT TYPE:
- text/heading/body: text, spans (optional, array of {text, color}), size, weight, lh, color, align, transform, letter_spacing
- image: src, alt, width, height, align
- cta: cta_text, cta_bg, cta_color, cta_radius, cta_h, cta_size, cta_weight, cta_pad, cta_border_color (optional), cta_border_width (optional), align
- bullet_list: bullets (array of strings)
- columns: cols (array of {w: "50%", content: [...]})
- social_icons: icons (array of {platform: "facebook", url: "#"})
- divider/spacer: height, color (for divider only)

CARD CONTAINER FIELDS (apply to a content element OR to section.container):
- card_bg: "#hex"
- card_border: "#hex" or null
- card_border_width: number (1-3 typical)
- card_radius: number (8 typical)
- card_pad: "T R B L"
- For card on content[]: also include "el": "card" and "content": [ ... nested elements ... ]

NOTE on cta_radius: there is NO default. Common values: 4, 6, 8, 12, 16, 24, 30. Do NOT default to 30 unless the button is a true pill shape.
NOTE on cta_h: there is NO default. Common heights: 38, 40, 44, 46, 48, 50.

CRITICAL JSON FORMATTING RULES:
- Output a SINGLE valid JSON object. No comments. No trailing commas.
- Every string value must be properly quoted with " and have its closing quote.
- Every URL value must NOT contain unescaped quotes — escape them with \".
- All hex colors are 6-character with # prefix: "#1A2B3C" not "1A2B3C" or "#1A2".
- Numbers do NOT have units: "size": 16 not "size": "16px".
- Boolean values: true or false (lowercase, no quotes).
- Validate your JSON mentally before outputting — count opening { vs closing }, opening [ vs closing ].

========================================
FINAL CHECKLIST (run before outputting)
========================================
- Do your sections cover the full vertical range from y=0 to the last band's y_end?
- Every "bg" and "color" is from the supplied palette?
- Every "text" is verbatim from OCR?
- Every image has a src that is a Dropbox URL from the assets list (or empty if no match)?
- Every text element has an "align" field matching the visible alignment?
- Multi-color inline headings use "spans" (not duplicated rows)?
- Colored stripes >= 5px in the band map have a thin_colored_band section (skip thinner ones unless clearly visible AND color used elsewhere)?
- No fake hallucinated sections not visible in the design image?
- SECTION GROUPING: Adjacent paragraphs of body copy or headings on the SAME background color MUST be grouped into a SINGLE section with multiple content[] entries. Create a NEW section boundary ONLY when one of these changes: (a) background color, (b) section semantic type (e.g. body→cta, heading→image), or (c) a visible horizontal divider in the design. NEVER split a continuous body copy paragraph group into separate body_text sections.
- TYPOGRAPHY: did you measure cap-heights against the benchmarks (rule I)? If a hero heading visually fills 30+ pixels of cap-height, it's at least 40px font-size, NOT 28px.
- BODY COLOR: did you pick the darkest non-pure-black gray from the palette (rule J)? If palette has a near-black tint, body text is THAT, not #000000.
- BORDER-RADIUS: did you measure each CTA's corner curvature (rule K)? Default of 30 is FORBIDDEN — measure each one.
- CARDS: did you check for bordered/colored sub-containers (rule L) and add card properties?
- FOOTER: if 2-column layout (rule M), use "columns" content with cols, not stacked rows.
- THIN BANDS: did you verify each thin band is real (rule N) and not a JPEG artifact?
`;

// =====================================================================
// STAGE 2 PROMPT — Code Generation (JSON spec → HTML)
// Contains the full Master Framework + GOLD STANDARD CODE EXAMPLES
// extracted from real developer-coded Mavlers emails.
// =====================================================================
const STAGE2_PROMPT = `## IDENTITY
You are the senior email developer at Mavlers. You receive a JSON design specification and produce production-ready HTML email code. The JSON spec contains analyzed design data — section structure, verbatim text, colors, spacing, image descriptions. Your job: convert this spec into Mavlers-grade HTML. Trust the spec. Generate HTML from it, not from guesswork.

## IMPORTANT — PIXEL-EXACT COLORS IN SPEC (v5.0.0)
The spec's section "bg" fields and all hex values in element "color", "cta_bg", "cta_color", and "spans[].color" fields are sampled DIRECTLY from the design image's pixels — NOT guessed from a compressed preview. Use these hex values VERBATIM. Do NOT round, substitute, or approximate. Do NOT change one brand color to another similar-looking color. Whatever hex the spec contains IS the correct color. The spec also includes a "_palette" array — only use colors from that palette for any color field.

## IMPORTANT — IMAGE URLs ARE EMBEDDED IN THE SPEC (v5.0.0)
Every image content element carries an "src" field with a full Dropbox URL. Use that URL VERBATIM as the img src attribute. NEVER substitute relative paths like "images/hero.jpg" when the spec has a URL. NEVER fabricate image URLs. If spec's src is empty string, use a descriptive alt and omit the src (do not invent a filename).

## IMPORTANT — MULTI-COLOR HEADINGS USE SPANS (v5.0.0)
When a text content element has a "spans" array, it means the visible heading in the design has multiple colors INLINE on the same line. Render as a SINGLE <td> containing multiple <span> elements:

Example spec content:
{
  "el": "text",
  "spans": [
    { "text": "[FIRST PART]", "color": "#COLOR_A" },
    { "text": " [SECOND PART].", "color": "#COLOR_B" }
  ],
  "size": 28, "weight": 700, "lh": 34, "align": "center"
}

Correct HTML output — ONE td, TWO spans:
<td align="center" valign="top" style="font-family: 'FONT_STACK'; font-size: 28px; line-height: 34px; font-weight: 700; text-align: center;">
  <span style="color: #COLOR_A;">[FIRST PART]</span><span style="color: #COLOR_B;"> [SECOND PART].</span>
</td>

NEVER split a "spans" element into two separate <td> rows. NEVER duplicate the heading text as two entirely-colored rows. This is the #1 failure of prior versions — the developer's reference code always uses inline spans, never stacked rows.

## ABSOLUTE OUTPUT RULES
1. Output ONLY the final HTML. Begin with <!DOCTYPE. End with </html>. Nothing else.
2. NO markdown code fences. NO explanations. NO commentary.
3. NO template comments. Production HTML only.
4. Clean, indented, human-readable formatting. Two-space indent.

## ABSOLUTE FIDELITY RULES
1. Use ALL text from the spec VERBATIM. Copy every word exactly. NEVER rewrite or paraphrase.
2. Use EXACT hex colors from the spec. Match every hex value as-is.
3. Use EXACT spacing from the spec. 33px ≠ 30px. NEVER round.
4. Output sections in the EXACT order from the spec. Do NOT rearrange, merge, or skip sections.
5. Every element goes in a <td> with inline styles. NEVER use <p>, <h1>-<h6>, or <div> (except the hidden preheader div and <ul>/<li> inside bullet_list sections).
6. TEXT ALIGNMENT — RESPECT THE SPEC'S "align" FIELD FOR EVERY ELEMENT: For every text element, set the <td>'s align attribute AND the inline style's text-align to match the spec's "align" value. If spec says align="center", the <td> must be align="center" with text-align:center in the style. NEVER default to "left" when the spec says otherwise.
7. CTA BORDER-RADIUS — Use spec.content[].cta_radius VERBATIM. Do NOT default to 30px (pill). Common values: 4, 6, 8, 12, 16, 24, 30. If spec says cta_radius is 8, output 8px. NEVER substitute 30px when the spec says otherwise.
8. CARD CONTAINERS (v5.4.0) — When a content element has "card_bg", "card_border", "card_radius", or "card_pad", OR when a content element has el="card", OR when section.container is set, render those properties as a wrapping <td> with bgcolor + border + border-radius + padding. See "GOLD STANDARD: CARD CONTAINER" below.
9. FONT STACK HYGIENE — Use spec.font_body as primary font followed by Arial as fallback in the form: font-family: 'PRIMARY_FONT', Arial, sans-serif. Do NOT include spec.font_heading (the secondary font) in the body stack unless the spec EXPLICITLY uses it for that element. Secondary fonts should ONLY be loaded via Google Fonts <link> tag and used in elements that explicitly call for them.

## GOLD STANDARD: SECTION WRAPPER PATTERN
Every section MUST follow this exact wrapper pattern — each section is an independent table block:

<!-- Section_N_type y=Y1-Y2 -->
<tr>
  <td align="center" valign="top"><table align="center" style="width: 600px;" class="em_wrapper em_dark" width="600" border="0" cellspacing="0" cellpadding="0" bgcolor="#ffffff">
      <tbody>
        <tr>
          <td align="center" valign="top" style="padding: 0px 50px 50px;" class="em_pad2"><table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
              <tbody>
                <!-- content rows go here -->
              </tbody>
            </table></td>
        </tr>
      </tbody>
    </table></td>
</tr>
<!-- // Section_N_type -->

CRITICAL RULES:
1. Each section gets its OWN em_wrapper table. Sections are NOT nested inside one shared wrapper.
2. The section comment MUST include the y-range from the spec in the format: "Section_N_type y=Y1-Y2" where Y1 is spec.sections[n].y_start and Y2 is spec.sections[n].y_end. Example: Section_8_alert_bar y=345-380. This y-range is MANDATORY and used by downstream post-processing. Without it, section colors cannot be verified.
3. Adjust padding, bgcolor, and dark-mode class per section based on the spec.
4. Name the section_type from the spec's "type" field (thin_colored_band, alert_bar, heading, cta, columns, testimonial, image, footer, etc.).

## GOLD STANDARD: CTA BUTTON
Every CTA button MUST follow this exact pattern (substitute values from spec):

<table align="left" bgcolor="#CTA_BG_HEX" border="0" cellspacing="0" cellpadding="0" style="background-color:#CTA_BG_HEX; border-radius: [SPEC_RADIUS]px;" class="em_border">
  <tr>
    <td class="em_defaultlink" align="center" valign="middle" height="[SPEC_HEIGHT]" style="font-size: [SPEC_SIZE]px; font-family: 'FONT_STACK'; font-weight:[SPEC_WEIGHT]; color: #CTA_TEXT_HEX; height:[SPEC_HEIGHT]px; padding:0px [SPEC_PAD]px;" ><a href="#" target="_blank" style="text-decoration:none; color:#CTA_TEXT_HEX; line-height:[SPEC_HEIGHT]px; display:block;">CTA TEXT</a></td>
  </tr>
</table>

## OUTLINED CTA BUTTON (white-bg with dark border, e.g. secondary "Learn more")
When spec.content[].cta_border_color is set, the button has a visible outlined border. Render with the border on the wrapper table:

<table align="center" bgcolor="#CTA_BG_HEX" border="0" cellspacing="0" cellpadding="0" style="background-color:#CTA_BG_HEX; border-radius: [SPEC_RADIUS]px; border: [SPEC_BORDER_WIDTH]px solid #SPEC_BORDER_COLOR;" class="em_border">
  <tr>
    <td class="em_defaultlink em_dm_txt_white" align="center" valign="middle" height="[SPEC_HEIGHT]" style="font-size: [SPEC_SIZE]px; font-family: 'FONT_STACK'; font-weight:[SPEC_WEIGHT]; color: #CTA_TEXT_HEX; height:[SPEC_HEIGHT]px; padding:0px [SPEC_PAD]px;"><a href="#" target="_blank" style="text-decoration:none; color:#CTA_TEXT_HEX; line-height:[SPEC_HEIGHT]px; display:block;">CTA TEXT</a></td>
  </tr>
</table>

MANDATORY CTA PROPERTIES — ALL values come from the spec, never from defaults:
- bgcolor + background-color: EXACT value from spec.cta_bg — NEVER substitute #000000 or a guess
- color (text): EXACT value from spec.cta_color — usually #FFFFFF on filled, often dark on outlined
- border-radius: spec.cta_radius value VERBATIM — NEVER default to 30px. Common values: 4, 6, 8, 12, 16, 24, 30. If spec says 8, output 8px. PILL (30px) is ONLY when spec says 30 AND the design clearly shows full-pill curvature.
- height: spec.cta_h value — commonly 38px, 40px, 44px, 46px, 48px, 50px
- font-size: spec.cta_size value — commonly 13px, 14px, 15px, 16px, 18px
- font-weight: spec.cta_weight value — commonly 400, 500, 600, or 700 (do NOT default to 700)
- padding: spec.cta_pad value — horizontal padding varies widely
- border (outlined buttons only): from spec.cta_border_color + spec.cta_border_width
- class="em_border" on the table (for dark mode border)
- class="em_defaultlink" on the td
- align="left" on the table for left-aligned CTAs, align="center" for centered
- For centered CTA: wrap in a <td align="center"> parent

CRITICAL: For an outlined CTA (cta_border_color is set), the BORDER goes on the wrapper TABLE's style, AND the TD inside should NOT have any border. The bgcolor on outlined buttons is typically white (#FFFFFF) with border-color being dark (e.g., #000000) or brand-colored.

## GOLD STANDARD: SECTION HEADING
Section headings use <td>, NOT <h1>-<h6>. ALL values from spec:

<td align="[SPEC_ALIGN]" valign="top" class="em_defaultlink em_dm_txt_white" style="font-family: 'FONT_STACK'; font-size: [SPEC_SIZE]px; line-height:[SPEC_LH]px; color: #TEXT_HEX; font-weight: [SPEC_WEIGHT]; ">[HEADING TEXT FROM SPEC]</td>

## GOLD STANDARD: BODY TEXT
Body copy uses <td>, NOT <p>. ALL values from spec:

<td align="[SPEC_ALIGN]" valign="top" class="em_defaultlink em_dm_txt_white" style="font-family: 'FONT_STACK'; font-size:[SPEC_SIZE]px; line-height:[SPEC_LH]px; color: #TEXT_HEX; font-weight: [SPEC_WEIGHT]; padding-bottom: [SPEC_PB]px;">[BODY TEXT FROM SPEC]</td>

## GOLD STANDARD: TWO-COLUMN CARD (content + image side-by-side)
Wrapped in a card with border + rounded corners + bg color from spec:

<td align="center" valign="top" style="border: 1px solid #BORDER_HEX; padding: [SPEC_PAD]; border-radius: [SPEC_RADIUS]px;" class="em_pad3 em_black" bgcolor="#CARD_BG_HEX"><table width="100%" align="center" border="0" cellspacing="0" cellpadding="0">
    <tbody>
      <tr>
        <th align="center" valign="top" class="em_clear"><table align="center" style="width: [COL1_W]px;" class="em_wrapper" width="[COL1_W]" border="0" cellspacing="0" cellpadding="0">
            <!-- Text column: heading, body, CTA -->
          </table>
        </th>
        <th align="center" valign="top" class="em_clear"><table style="width: [COL2_W]px;" class="em_wrapper" width="[COL2_W]" border="0" cellspacing="0" cellpadding="0">
            <!-- Image column -->
          </table>
        </th>
      </tr>
    </tbody>
  </table></td>

## GOLD STANDARD: DIVIDER
Dividers use spacer.gif on a colored bgcolor, NOT CSS border-top:

<td height="1" style="height: 1px; line-height: 0px; font-size: 0px;" class="em_white" bgcolor="#DIVIDER_HEX"><img src="images/spacer.gif" width="1" height="1" alt="" border="0" style/></td>

## GOLD STANDARD: TESTIMONIAL CARD
Testimonial cards with rounded corners and bg color from spec:

<td align="center" valign="top" bgcolor="#CARD_BG_HEX" style="padding: [SPEC_PAD]; border-radius: [SPEC_RADIUS]px;"><table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tbody>
      <tr>
        <td align="left" valign="top" style="padding-bottom: [SPEC_PB]px; padding-left: 5px;"><img src="images/quote_icon.png" width="32" alt="" border="0" style="display: block; max-width: 32px;"/></td>
      </tr>
      <tr>
        <td align="left" valign="top" class="em_defaultlink" style="font-family: 'FONT_STACK'; font-size:[SPEC_SIZE]px; line-height:[SPEC_LH]px; color: #TEXT_HEX; font-weight: 400; padding-bottom: [SPEC_PB]px;">[QUOTE TEXT FROM SPEC]</td>
      </tr>
      <tr>
        <td align="left" valign="top" class="em_defaultlink" style="font-family: 'FONT_STACK'; font-size:[SPEC_SIZE]px; line-height:[SPEC_LH]px; color: #TEXT_HEX; font-weight: 400;"><span style="font-weight: 600;">[ATTRIBUTION FROM SPEC]</span><br /><span style="font-size: [SPEC_SMALL]px;">[ROLE/SUBTITLE FROM SPEC]</span></td>
      </tr>
    </tbody>
  </table></td>

## GOLD STANDARD: CARD CONTAINER (v5.4.0 — for card_bg / card_border / card_radius)
When the spec has card properties (either at section.container OR on a content[] element with el="card" OR with card_bg/card_border/card_radius set), wrap the inner content in a <td> that carries the card properties. The card sits INSIDE the section's outer wrapper, NOT replacing it.

Pattern for a content[].card or el="card":
<tr>
  <td align="center" valign="top" style="padding: [SECTION_PAD];" class="em_pad2"><table width="100%" border="0" cellspacing="0" cellpadding="0" align="center" style="border: [CARD_BW]px solid #CARD_BORDER_HEX; border-radius: [CARD_RADIUS]px;" bgcolor="#CARD_BG_HEX" class="em_dark">
      <tr>
        <td align="center" valign="top" style="padding: [CARD_PAD];" class="em_aside15"><table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
            <!-- nested content here -->
          </table></td>
      </tr>
    </table></td>
</tr>

Pattern when section.container is set (entire section is a card):
The same pattern, where the OUTER em_wrapper td has the card border + radius + bg.

CRITICAL CARD RULES:
- If the spec has card_bg, card_border, card_radius, or card_pad — these MUST be rendered. NEVER drop card properties.
- The bordered/rounded/colored card structure is what visually distinguishes testimonial cards, "Ready to..." closing-CTA cards, feature cards, etc.
- The card's inner padding is SEPARATE from the section's outer padding. Apply both.
- When card_border is null but card_bg is set, render bgcolor + border-radius without border.
- When card_border is set but card_bg is null, render border + border-radius on transparent/white bg.

EXAMPLE — Testimonial card (accent-bordered rounded white card):
spec.section.content[0] = {
  "el": "card",
  "card_bg": "#FFFFFF",
  "card_border": "#ACCENT_HEX",
  "card_border_width": 1,
  "card_radius": 8,
  "card_pad": "30 30 30 30",
  "content": [
    { "el": "image", "src": "logo.png", "width": 182 },
    { "el": "text", "text": "...quote...", "size": 18, "lh": 30, "color": "#BODY_TEXT_HEX", "align": "center" },
    { "el": "text", "text": "- Author Name", "size": 16, "color": "#ACCENT_HEX", "align": "center", "weight": 500 }
  ]
}

Output (substitute spec values verbatim):
<tr>
  <td align="center" valign="top" style="padding: 0px 50px 50px;" class="em_pad2"><table width="100%" border="0" cellspacing="0" cellpadding="0" align="center" style="border: 1px solid #ACCENT_HEX; border-radius: 8px;" bgcolor="#FFFFFF" class="em_dark">
      <tr>
        <td align="center" valign="top" style="padding: 30px 30px;" class="em_aside15"><table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
            <tr><td align="center" valign="top"><img ... /></td></tr>
            <tr><td align="center" valign="top" style="font-family:..., font-size: 18px; line-height: 30px; color: #BODY_TEXT_HEX;">...quote...</td></tr>
            <tr><td align="center" valign="top" style="font-family:..., font-size: 16px; color: #ACCENT_HEX; font-weight: 500;">- Author Name</td></tr>
          </table></td>
      </tr>
    </table></td>
</tr>

EXAMPLE — Closing CTA card (light-tinted bg rounded):
spec.section.container = { "card_bg": "#CARD_BG_HEX", "card_border": null, "card_radius": 8, "card_pad": "30 25 30 25" }
This renders the entire section as a card with the spec'd light-tint bg + 8px radius.

## GOLD STANDARD: FOOTER (v5.4.0 — supports 2-column layouts)

When the spec's footer section uses a "columns" content element, render with the Mavlers dir="rtl" two-column trick. The dir-rtl trick swaps display order on small screens for proper stacking.

PATTERN — Two-column footer (logo+social on LEFT, contact on RIGHT):
<table dir="rtl" width="100%" border="0" cellspacing="0" cellpadding="0">
  <tbody>
    <tr>
      <!-- LEFT column (in dir-rtl, this comes second in source but renders first visually) -->
      <td align="left" valign="top" class="em_clear" dir="ltr"><table width="[COL1_W]" style="width: [COL1_W]px;" align="left" border="0" cellspacing="0" cellpadding="0">
          <tbody>
            <tr>
              <td align="right" valign="top"><table align="right" class="em_wrapper" border="0" cellspacing="0" cellpadding="0">
                  <tr><td align="left" valign="top"><a href="#" target="_blank" style="text-decoration: none;"><img src="[LOGO_URL]" width="[LOGO_W]" alt="Brand" border="0" style="display:block; max-width:[LOGO_W]px;"/></a></td></tr>
                </table></td>
            </tr>
            <tr>
              <td align="right" valign="top" class="em_defaultlink em_left" style="padding-top: 17px; font-family: 'FONT_STACK'; font-size:10px; line-height:15px; font-weight: 500; color:#TEXT_HEX; letter-spacing: 1.15px; text-transform: uppercase;">Follow us on:</td>
            </tr>
            <tr>
              <td align="right" valign="top" style="padding-top: 5px;"><table border="0" cellspacing="0" cellpadding="0" align="right" class="em_wrapper">
                  <tr>
                    <td align="left" valign="top"><a href="#"><img src="[ICON_URL]" width="14" alt="" border="0" style="display:block; max-width: 14px;"/></a></td>
                    <td width="9" style="width: 9px; line-height: 0px; font-size: 0px;"></td>
                    <!-- more icons -->
                  </tr>
                </table></td>
            </tr>
          </tbody>
        </table></td>
      <td width="[GUTTER_W]" style="width: [GUTTER_W]px;" class="em_clear em_hide"><img alt="" src="images/spacer.gif" height="1" width="1" style="display:block;" border="0" /></td>
      <!-- RIGHT column (renders second visually) -->
      <td align="left" valign="top" class="em_clear" dir="ltr"><table width="[COL2_W]" style="width: [COL2_W]px;" align="left" border="0" cellspacing="0" cellpadding="0">
          <tbody>
            <tr><td align="left" valign="top" class="em_defaultlink em_ptop" style="font-family: 'FONT_STACK'; font-size:10px; line-height:15px; font-weight: 500; color:#TEXT_HEX; text-transform: uppercase; text-decoration: underline;"><a href="#" target="_blank" style="text-decoration: underline; color:#TEXT_HEX;">Contact us</a></td></tr>
            <tr><td align="left" valign="top" class="em_defaultlink em_ptop" style="padding-top: 22px; font-family: 'FONT_STACK'; font-size:10px; line-height:16px; font-weight: 500; color:#TEXT_HEX; text-transform: uppercase;">[ADDRESS LINE FROM SPEC]</td></tr>
          </tbody>
        </table></td>
    </tr>
  </tbody>
</table>

PATTERN — Single-column footer (centered):
Footer has logo-left + social-icons-right in ONE row, then links row, then copyright bar:

<!-- Footer row 1: Logo + Social Icons -->
<table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
  <tr>
    <td align="center" valign="top"><table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
        <tbody>
          <tr>
            <td align="left" valign="top"><a href="#" target="_blank" style="text-decoration: none;"><img src="images/logo.png" width="122" alt="Brand" border="0" style="display: block; max-width: 122px;"/></a></td>
          </tr>
        </tbody>
      </table></td>
    <td width="210" style="width: 210px;" class="em_side15">&nbsp;</td>
    <td align="right" valign="top"><table border="0" cellspacing="0" cellpadding="0" align="right">
        <tbody>
          <tr>
            <td align="center" valign="top"><a href="#"><img src="images/icon.png" width="22" alt="" border="0" style="display: block; max-width: 22px;"/></a></td>
            <td width="14" style="width: 14px; line-height: 0px; font-size: 0px;">&nbsp;</td>
            <!-- more icons -->
          </tr>
        </tbody>
      </table></td>
  </tr>
</table>

<!-- Footer row 2: Links (URL left + unsubscribe/legal right) -->
<td align="left" valign="top" class="em_defaultlink em_dm_txt_white" style="font-family: 'FONT_STACK'; font-size: 14px; line-height: 16px; color: #TEXT_HEX; font-weight: 400;"><a href="#" style="text-decoration: underline; color: #TEXT_HEX;">[BRAND URL FROM SPEC]</a></td>
<td width="273" style="width: 273px;" class="em_side15"></td>
<td align="left" valign="top"><a href="{{ unsubscribe_link }}" style="text-decoration: underline; color: #TEXT_HEX;">Unsubscribe</a></td>

<!-- Footer row 3: Copyright bar on separate bg -->
<td align="center" valign="top" style="padding: 10px;" bgcolor="#COPYRIGHT_BG_HEX" class="em_black">
  <td align="center" valign="top" style="font-family: 'FONT_STACK'; font-size:12px; line-height:14px; color: #TEXT_HEX; font-weight: 400;">[COPYRIGHT TEXT FROM SPEC]</td>
</td>

## MANDATORY DOCTYPE + HEAD
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">

Note: Use xmlns WITHOUT lang="en" on the <html> tag — matching developer pattern.

## MANDATORY HEAD BLOCK
<head>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<title>[Brand Name]</title>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="viewport" content="width=device-width, initial-scale=1.0 " />
<meta name="format-detection" content="telephone=no"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>

FONT LOADING: Use <link> tag (NOT @import) for Google Fonts:
<link href="https://fonts.googleapis.com/css2?family=FontName:wght@200..1000&display=swap" rel="stylesheet">

## MANDATORY CSS RESET
<style type="text/css">
body { margin: 0 auto; padding: 0; -webkit-text-size-adjust: 100% !important; -ms-text-size-adjust: 100% !important; -webkit-font-smoothing: antialiased !important; }
img { border: 0 !important; outline: none !important; }
p { Margin: 0px !important; Padding: 0px !important; }
table { mso-table-lspace: 0px; mso-table-rspace: 0px; }
td, a, span { mso-line-height-rule: exactly; }
td { mso-hyphenate: none; word-break: keep-all; }
.ExternalClass * { line-height: 100%; }
.em_defaultlink a { color: inherit; text-decoration: none; }
.em_g_img + div { display: none; }
a[x-apple-data-detectors], u + .em_body a, #MessageViewBody a { color: inherit; text-decoration: none; font-size: inherit; font-family: inherit; font-weight: inherit; line-height: inherit; }

## MANDATORY RESPONSIVE
@media screen and (max-width: [WIDTH-1]px) {
  .em_main_table { width: 100% !important; }
  .em_wrapper { width: 100% !important; }
  .em_hide { display: none !important; }
  .em_full_img { width: 100% !important; height: auto !important; }
  .em_full_img img { width: 100% !important; height: auto !important; }
  .em_center { text-align: center !important; }
  .em_aside10 { padding: 0px 10px !important; }
  .em_aside15 { padding: 0px 15px !important; }
  .em_ptop { padding-top: 20px !important; }
  .em_pbottom { padding-bottom: 20px !important; }
  .em_h20 { height: 20px !important; font-size: 1px!important; line-height: 1px!important; }
  .em_mob_block { display: block !important; }
  .em_hauto { height: auto !important; }
  .em_clear { clear: both !important; width: 100% !important; display: block !important; }
  u+.em_body .em_full_wrap { width: 100%!important; width: 100vw!important; }
  .em_pad1 { padding: 20px 15px !important; }
  .em_pad2 { padding: 0px 15px 20px !important; }
  .em_pad3 { padding: 20px 15px 0px !important; }
}

## MANDATORY DARK MODE (when developer requests it)
@media screen and (prefers-color-scheme:dark) {
  .em_dm_txt_white { color: #FFFFFF!important; }
  .em_dm_txt_white a { color: #FFFFFF!important; }
  .em_dark, .em_full_wrap, .em_body { background-color: #000000!important; }
  .em_white { background-color: #fffffe!important; }
  .em_black { background-color: #333333!important; }
  .em_border { border: 1px solid #fffffe !important; }
}

Add design-specific dark mode classes as needed: em_dm_txt_blue, em_dm_txt_blue1, etc.

## MANDATORY BODY + MAIN TABLE
<body class="em_body" style="margin:0px auto; padding:0px; background-color:#ffffff;" bgcolor="#ffffff">
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" bgcolor="#ffffff" style="background-color:#ffffff; table-layout:fixed;">
  <tr>
    <td align="center" valign="top"><table align="center" width="600" border="0" cellspacing="0" cellpadding="0" class="em_main_table" style="width:600px; table-layout:fixed;">
        <!-- ALL SECTIONS GO HERE as independent <tr> blocks -->
      </table></td>
  </tr>
</table>
</body>

NOTE: The em_main_table directly contains section <tr> blocks. There is NO third em_wrapper table wrapping everything. Each section has its OWN em_wrapper table inside its <tr>.

## MSO FONT FALLBACK
<!--[if (gte mso 9)|(IE)]>
<style type="text/css">
  body, table, td { font-family:Arial, sans-serif !important; }
</style>
<![endif]-->

## IMAGE RULES
- Every img: src, width, alt, border="0", style="display: block; max-width: Wpx; font-size: 15px; color: #000000; line-height: 18px; font-family: Arial,sans-serif;"
- Full-width images: class="em_full_img" on parent td
- Banner images: NO height attribute (responsive)

## IMAGE URL HANDLING (v5.0.0)
Every image element in the spec's content arrays has an "src" field populated with the exact Dropbox URL to use. You must:
1. Use spec.content[].src VERBATIM as the img src attribute — never modify, never substitute with relative paths, never shorten.
2. Never invent image filenames like "images/hero.jpg" or "images/logo_img1.png".
3. If spec's src field is an empty string "", it means no matching uploaded asset exists — render the img tag with src="" and the descriptive alt from the spec. Do NOT fabricate a filename.
4. Width and height attributes come from spec.content[].width and spec.content[].height — use those values as numbers without "px" suffix.
5. Always include alt text from spec.content[].alt.
6. NEVER output img src values like "images/anything.png" — those are relative paths which break in every email client.

## SPECIAL SECTION TYPES (new in v3.3.0)

### thin_colored_band (thin horizontal band in any accent color)
A narrow horizontal bar, typically 2-10px tall, in any brand/accent color. Appears at the top, bottom, or between major sections. Render as a spacer-based divider using the bg color from the spec:
<td height="5" style="height: 5px; line-height: 0px; font-size: 0px;" bgcolor="#SPEC_BG_HEX"><img src="images/spacer.gif" width="1" height="1" alt="" border="0" style="display: block; max-width: 1px;"/></td>

Use whatever bg color the spec provides — could be any accent color (green, orange, red, blue, brand color, etc.). Height can be 2px, 5px, 8px, or 10px based on the spec's height_hint.

### alert_bar (orange/red/yellow notification strip)
A narrow bar with a bright background color and uppercase text:
<td align="center" valign="top" style="font-size: 10px; line-height: 14px; color: #000000; font-family:'FONT_STACK'; text-transform: uppercase; padding: 13px 15px;">ALERT TEXT HERE</td>
Use the bgcolor from the spec — alert bars use any bright accent color (orange, red, yellow, amber, teal, etc. — whatever the design shows).

### phone_bar (phone number in its own band, usually above footer)
<td align="center" valign="top" style="padding: 20px 40px;" bgcolor="#SPEC_BG_HEX">
  <td align="center" class="em_defaultlink em_dm_txt_white" style="font-family: 'FONT_STACK'; font-size: 14px; line-height: 16px; color: #SPEC_TEXT_HEX; font-weight: 400;">[PHONE NUMBER FROM SPEC VERBATIM]</td>
</td>

### closing_cta (prominent final call-to-action block before footer)
A high-emphasis closing section with large heading + CTA, often with a full-width colored background. Use the heading text, colors, and styling from the spec — do NOT hard-code any specific wording:
<td align="center" valign="top" style="padding: 50px 40px;" bgcolor="#SPEC_BG_HEX">
  <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td align="center" valign="top" class="em_defaultlink" style="font-family: 'FONT_STACK'; font-size: 36px; line-height: 42px; color: #SPEC_TEXT_HEX; font-weight: 700; padding-bottom: 24px;">[HEADING TEXT FROM SPEC]</td>
    </tr>
    <tr>
      <td align="center" valign="top">
        <!-- CTA button pattern here, using spec CTA values -->
      </td>
    </tr>
  </table>
</td>

### bullet_list (4+ stacked short items with bullet markers)
<td align="left" valign="top" style="padding: 0 40px 20px;">
  <ul style="margin: 0; padding: 0 0 0 20px; list-style-type: disc;">
    <li style="font-family: 'FONT_STACK'; font-size: 14px; line-height: 22px; color: #SPEC_TEXT_HEX; padding-bottom: 8px;">[BULLET TEXT FROM SPEC]</li>
    <li style="font-family: 'FONT_STACK'; font-size: 14px; line-height: 22px; color: #SPEC_TEXT_HEX; padding-bottom: 8px;">[BULLET TEXT FROM SPEC]</li>
  </ul>
</td>
Note: <ul>/<li> ARE acceptable for bullet lists (exception to the no-non-table-elements rule).

### job_listings (name + timestamp + action pattern)
Used for activity feeds, booking lists, etc. Each entry has name (bold), timestamp (light), action (gray):
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
  <tr>
    <td align="left" style="font-family: 'FONT_STACK'; font-size: 12px; font-weight: 600; color: #SPEC_PRIMARY_HEX; padding-bottom: 4px;">[NAME] [DAY] [DATE] [TIME]</td>
  </tr>
  <tr>
    <td align="left" style="font-family: 'FONT_STACK'; font-size: 12px; font-weight: 400; color: #SPEC_SECONDARY_HEX; padding-bottom: 12px;">[ACTION DESCRIPTION]</td>
  </tr>
</table>

### DARK/LIGHT DUPLICATE SECTIONS
Some designs show the SAME section twice — once styled for dark mode preview, once for light mode. When the spec shows two adjacent sections with similar content but different bg colors (e.g., black bg then white bg for the same logo/preheader), output BOTH sections. Tag them with classes:
- Dark version: bgcolor="#000000" with class="em_dark"
- Light version: bgcolor="#ffffff" with class="em_white1" or "em_white2"

## ANTI-PATTERNS — NEVER OUTPUT
1. <p> tags — use <td>
2. <h1>-<h6> tags — use <td> with inline font-size/weight
3. <div> tags (except hidden preheader)
4. <button> elements
5. CSS border-top/border-bottom for dividers — use spacer.gif + bgcolor
6. role="presentation" on layout tables (developer doesn't use it in this codebase)
7. Substituting common defaults (#000000, #FFFFFF, #00FF00, etc.) when the spec provides specific brand hex values — always use the exact hex from the spec
8. Neon/pure/saturated colors (like #00FF00, #FF0000, #0000FF) when spec shows a brand variant. Match the exact hex from spec — brand colors are almost always slightly off-pure (#1FC23D not #00FF00, #E41525 not #FF0000, #0A36A8 not #0000FF).
9. border-radius: 4px on CTAs (should be 6px or 30px based on spec)
10. @import for fonts (use <link> tag)
11. One giant em_wrapper nesting all sections (each section gets its own)
12. SKIPPING any section from the spec — if spec has N sections, output N sections
13. DEDUPLICATING sections — if spec shows the same content twice (dark+light, two variants), output both
14. Collapsing similar adjacent sections into one — preserve every section from the spec
15. **Splitting a "spans" element into two <td> rows** — the developer's reference code always renders multi-color headings as ONE <td> with multiple inline <span> elements. If spec content has a "spans" array, output ONE td with multiple spans. NEVER duplicate the heading text across multiple colored rows.
16. **Relative image paths** — img src="images/anything.png" is always wrong in v5. If spec has a URL, use it; if spec has empty src, use empty src. NEVER make up a filename.
17. **Inventing sections not in the spec** — if the spec has 23 sections, output exactly 23 sections. Do not add a "dark logo" or "decorative banner" that isn't in the spec.
18. **INLINE SVG OR DATA-URL IN STYLE ATTRIBUTES** — NEVER output any inline SVG, any "background: url('data:image/svg...')" declaration, any "background-image: url('data:...')" declaration, or any data URI inside an inline style attribute. The inner quote characters inside the data URI break HTML parsing and cause raw CSS to appear as visible text on the page. For bullets, use <ul>/<li> with list-style-type: disc OR render an icon as an <img> tag inside a 4-column table. NEVER embed SVG markup anywhere in the output.
19. **Background-image declarations on list items** — a <li> with style="background: url(...)" is always wrong. If an icon bullet is required, render it as a table with 4 columns: one cell for the icon img, one spacer cell, one text cell.

## MAVLERS PATTERN LIBRARY (v8.1.0 — generic patterns from production references)

These patterns are extracted from human-coded Mavlers production emails. They apply to ANY Mavlers email design, not just one specific file. Use them whenever the spec exhibits the matching characteristics. These patterns take PRECEDENCE over generic "stacked vertical" defaults.

### PATTERN 1: HEADER BAR WITH LOGO + RIGHT-ALIGNED DATE/ID PILLS
Trigger: spec has a header section with a logo on left AND short labels (issue number, date, version, ID) that should appear on the right.

\`\`\`html
<td align="center" valign="top" bgcolor="#SPEC_DARK_BG" style="background-color:#SPEC_DARK_BG;">
  <table align="center" width="600" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td style="padding:16px 26px 15px 26px; border-top:1px solid #SPEC_BORDER; border-bottom:1px solid #SPEC_BORDER;">
        <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <th align="left" valign="top" class="em_clear">
              <a href="#"><img src="LOGO_URL" width="203" alt="BRAND NAME" style="display:block;" border="0"/></a>
            </th>
            <th align="right" valign="top" class="em_clear em_ptop">
              <!-- pills: each pill in its own cell, spacer cells between -->
              <table align="right" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" valign="middle" height="22" style="font-family:'FONT_STACK'; font-size:10px; color:#SPEC_TEXT; font-weight:600; border:1px solid #SPEC_BORDER; padding:0 10px; background-color:#SPEC_PILL_BG; text-transform:uppercase; border-radius:11px; letter-spacing:1.4px;">PILL TEXT</td>
                  <td width="10">&nbsp;</td>
                  <td align="center" valign="middle" height="22" style="[same as above]">PILL TEXT 2</td>
                </tr>
              </table>
            </th>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td>
\`\`\`

### PATTERN 2: HERO WITH BG IMAGE + MIXED-WEIGHT HEADING + STATUS PILL
Trigger: spec section has bg_image + overlay text + a small badge/status indicator. Hero title typically uses font weight mixing for emphasis.

For font weight mixing in headings: when the spec's text content has DIFFERENT WORDS that look visually heavier in the rendered design (you can see this in the visual reference image), wrap those words in inline spans with higher font-weight:
\`\`\`html
<td style="font-family:'FONT_STACK'; color:#SPEC_HEADING_COLOR; font-size:90px; line-height:92px; font-weight:400;">
  <span style="font-weight:600;">The</span> Outliers Waiting <span style="font-weight:600;">For You</span>
</td>
\`\`\`
The default weight is the lighter one (400). The heavier weight (600) is applied selectively to specific words via inline span. Determine which words are heavy by examining the visual reference.

Status pill (e.g. "Issue 012 · Live") with red bullet indicator:
\`\`\`html
<td align="center" valign="middle" height="27" style="font-family:'FONT_STACK'; font-size:12px; color:#SPEC_TEXT; font-weight:500; border:1px solid #SPEC_BORDER; padding:0 10px; background-color:#SPEC_BG; border-radius:14px; letter-spacing:1.4px;">
  <span style="color:#FF2323; font-size:14px; font-weight:700;">&bull;</span>&nbsp; STATUS TEXT
</td>
\`\`\`
The red bullet (•) is achieved via a colored inline span at the start. Use this pattern for any "Live", "Active", "Now", or status-indicator pill.

### PATTERN 3: TICKER / CATEGORY BAR (horizontal items with hairline dividers)
Trigger: spec has 3-8 short uppercase labels arranged horizontally in a single row (e.g. industry sectors, categories, filters, tags).

CRITICAL: separator between items is NOT a bullet dot (•) and NOT a pipe (|). Use a 1-2px wide TD with bgcolor:

\`\`\`html
<td align="center" bgcolor="#SPEC_BAR_BG" style="background-color:#SPEC_BAR_BG;">
  <table align="center" width="600" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td style="border-top:1px solid #SPEC_BORDER; padding-top:11px; padding-bottom:11px;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <!-- Item 1 -->
            <th width="124" align="center" valign="middle" style="width:124px;">
              <td style="font-family:'FONT_STACK'; color:#CDCDCD; font-size:12px; line-height:15px; font-weight:700; letter-spacing:1.76px; text-transform:uppercase;">ITEM 1</td>
            </th>
            <!-- HAIRLINE DIVIDER: 2px-wide cell with bgcolor -->
            <th width="2" style="width:2px; font-size:0px; line-height:0px;" bgcolor="#SPEC_DIVIDER_COLOR">&nbsp;</th>
            <!-- Item 2 -->
            <th width="124" align="center" valign="middle">[ITEM 2]</th>
            <!-- Hairline divider -->
            <th width="2" bgcolor="#SPEC_DIVIDER_COLOR">&nbsp;</th>
            <!-- ...repeat for each item... -->
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td>
\`\`\`
Force single-row layout. NEVER use bullet dots or pipe characters between items.

### PATTERN 4: STATS ROW (4-column metric strip with vertical dividers)
Trigger: spec has 3-6 short data points each with a number and a small label (e.g. "6 / Profiles This Issue", "100% / Mission-Vetted").

\`\`\`html
<td align="center" valign="top" bgcolor="#SPEC_BG" style="background-color:#SPEC_BG;">
  <table align="center" width="600" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td style="border-top:1px solid #SPEC_BORDER; border-bottom:1px solid #SPEC_BORDER;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <!-- Stat 1 -->
            <th align="center" valign="top" width="149" style="width:149px;">
              <td align="center" style="padding:20px 10px;">
                <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
                  <tr><td align="center" style="font-family:'FONT_STACK'; color:#FFFFFF; font-size:30px; line-height:34px; font-weight:700;">[BIG NUMBER]</td></tr>
                  <tr><td align="center" style="font-family:'FONT_STACK'; color:#878787; font-size:12px; line-height:15px; font-weight:700; letter-spacing:1.3px; text-transform:uppercase; padding-top:6px;">[SMALL LABEL]</td></tr>
                </table>
              </td>
            </th>
            <!-- VERTICAL DIVIDER: 1px-wide cell with bgcolor -->
            <th width="1" style="width:1px; font-size:0px;" bgcolor="#SPEC_DIVIDER_COLOR">&nbsp;</th>
            <!-- Stat 2, divider, Stat 3, divider, Stat 4 -->
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td>
\`\`\`
NEVER render stats as floating inline numbers — always inside the bordered strip with vertical dividers between cells.

### PATTERN 5: SECTION LABEL (numbered section heading with horizontal line)
Trigger: spec has a section labeled "01", "02", "03" (or similar numbering) followed by an uppercase section title. Common in editorial / report-style emails.

This pattern has TWO VARIANTS depending on visual treatment:

**VARIANT A — Muted/secondary section labels (typically used for "01", "02"):**
3-cell horizontal layout — muted number left + hairline horizontal line middle + muted label right. Used when the section label is secondary navigation:
\`\`\`html
<td align="center" valign="top" bgcolor="#SPEC_BG">
  <table align="center" width="600" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td style="padding:37px 16px 16px 24px;">
        <table align="left" border="0" cellspacing="0" cellpadding="0" width="100%">
          <tr>
            <td width="29" align="left" valign="middle" style="font-family:'FONT_STACK'; font-size:14px; font-weight:700; line-height:17px; letter-spacing:2.20px; color:#4B4B4B; width:29px;">01</td>
            <td align="center" valign="middle" class="em_hide">
              <table align="center" width="300" border="0" cellspacing="0" cellpadding="0">
                <tr><td height="1" style="height:1px; line-height:0; font-size:0;" bgcolor="#181817"></td></tr>
              </table>
            </td>
            <td align="left" valign="middle" style="font-family:'FONT_STACK'; font-size:14px; font-weight:700; letter-spacing:2.20px; color:#4B4B4B; padding-left:7px;">SECTION TITLE</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td>
\`\`\`

**VARIANT B — Emphasized section labels (typically used for the FINAL numbered section like "03"):**
Number sits inside a SMALL BORDERED ROUNDED BOX, label is WHITE and visually heavier. Used when the section deserves more attention:
\`\`\`html
<td align="center" valign="top" bgcolor="#SPEC_BG">
  <table align="center" width="600" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td style="padding:20px 24px 0px 24px;">
        <table align="left" border="0" cellspacing="0" cellpadding="0" width="100%">
          <tr>
            <!-- Number in bordered rounded box -->
            <td align="center" valign="middle" width="38" style="width:38px;">
              <table width="38" align="left" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" valign="middle" style="font-family:'FONT_STACK'; font-size:14px; font-weight:700; line-height:17px; letter-spacing:2.20px; color:#878787; padding:2px; border:1px solid #1A1A19; border-radius:4px;">03</td>
                </tr>
              </table>
            </td>
            <!-- White uppercase label, weight 600 -->
            <td align="left" valign="middle" style="font-family:'FONT_STACK'; font-size:16px; font-weight:600; line-height:25px; letter-spacing:2.2px; text-transform:uppercase; color:#ffffff; padding-left:16px; padding-right:10px;">SECTION TITLE</td>
            <!-- Horizontal line on RIGHT, hides on mobile -->
            <td align="center" valign="middle" class="em_hide">
              <table align="center" width="210" border="0" cellspacing="0" cellpadding="0">
                <tr><td height="1" style="height:1px; line-height:0; font-size:0;" bgcolor="#181817"></td></tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td>
\`\`\`

Choose variant based on the visual reference. NEVER collapse the number and the title into a single text run. Always use the cellular layout with explicit divider.

### PATTERN 6: CARD GRID (3x2, 3x3, 2x2 grids of similar items)
Trigger: spec has 4+ similar items (cards) that should be arranged in a grid, not stacked vertically. Look at the visual reference to determine column count:
- 6+ items → typically 3 columns (3x2, 3x3)
- 4 items → typically 2 columns (2x2)
- 2-3 items → side-by-side single row

Use \`<th>\` for column cells with \`class="em_clear"\` so they stack on mobile:
\`\`\`html
<td align="center" valign="top" style="padding:16px;">
  <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
    <!-- Row 1: 3 cards -->
    <tr>
      <th width="182" align="left" valign="top" class="em_clear">[CARD 1]</th>
      <th width="11" class="em_hide">&nbsp;</th>
      <th width="182" align="left" valign="top" class="em_clear">[CARD 2]</th>
      <th width="11" class="em_hide">&nbsp;</th>
      <th width="182" align="left" valign="top" class="em_clear">[CARD 3]</th>
    </tr>
    <tr><td height="19">&nbsp;</td></tr>
    <!-- Row 2: 3 more cards -->
    <tr>
      <th width="182" valign="top" class="em_clear">[CARD 4]</th>
      <th width="11" class="em_hide">&nbsp;</th>
      <th width="182" valign="top" class="em_clear">[CARD 5]</th>
      <th width="11" class="em_hide">&nbsp;</th>
      <th width="182" valign="top" class="em_clear">[CARD 6]</th>
    </tr>
  </table>
</td>
\`\`\`
NEVER stack vertically when the visual reference shows a grid. Use the image to determine column count.

### PATTERN 7: CARD WITH BORDER FRAME (using bgcolor padding trick)
Trigger: spec card has a colored border visible in design.

Rather than \`border:1px solid #X\`, use the outer-bgcolor padding trick for better email-client support:
\`\`\`html
<!-- OUTER cell = the "border" color, padding:1px is the border thickness -->
<td align="center" valign="top" bgcolor="#BORDER_HEX" style="padding:1px;">
  <!-- INNER table = the actual card content with its own bgcolor -->
  <table align="left" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#CARD_BG_HEX">
    <tr>
      <td style="padding:6px;">[CARD CONTENT]</td>
    </tr>
  </table>
</td>
\`\`\`
If the border in the design is RED, use red here. If GREY, grey. NEVER add red borders that aren't in the design.

### PATTERN 8: CARD INTERNAL ELEMENTS (sector tag, status, view profile, etc.)
Card content patterns when the card represents a "candidate", "product", "item" with structured data:

Sector/category tag (top-right of card): small bordered rectangle, NOT a fully rounded pill:
\`\`\`html
<td align="right">
  <table align="right"><tr>
    <td align="center" valign="middle" height="15" style="font-family:'FONT_STACK'; font-size:7px; color:#SPEC_TAG_TEXT; font-weight:700; border:1px solid #SPEC_TAG_BORDER; padding:0 6px; background-color:#SPEC_TAG_BG; letter-spacing:0.84px; text-transform:uppercase;">[TAG TEXT]</td>
  </tr></table>
</td>
\`\`\`

Item ID label (e.g. "CANDIDATE #001", "ITEM #042"): muted color, uppercase, letter-spaced:
\`\`\`html
<td align="left" style="font-family:'FONT_STACK'; font-size:10px; font-weight:700; line-height:13px; letter-spacing:1.50px; color:#575755; text-transform:uppercase; padding-top:10px;">[ID LABEL]</td>
\`\`\`

Status label (e.g. "CANDIDATE STATUS", "AVAILABILITY"): uses RED color #FF2323 (or red from spec), uppercase:
\`\`\`html
<td align="left" style="font-family:'FONT_STACK'; font-size:12px; font-weight:500; line-height:15px; letter-spacing:2.00px; color:#FF2323; text-transform:uppercase; padding-top:12px;">CANDIDATE STATUS</td>
\`\`\`
NEVER render status labels in grey. They are red (or whatever brand red the spec uses) by design convention.

Red bullet item (e.g. "• Actively Interviewing", "• open to relocate"):
\`\`\`html
<table width="100%" align="left" border="0" cellspacing="0" cellpadding="0">
  <tr>
    <td width="4" align="right" valign="top" style="font-family:'FONT_STACK'; font-size:14px; line-height:18px; color:#FF2323; width:4px;">&bull;</td>
    <td width="4" style="width:4px;">&nbsp;</td>
    <td align="left" valign="top" style="font-family:'FONT_STACK'; font-size:14px; font-weight:400; line-height:18px; color:#C8C8C8;">[BULLET TEXT]</td>
  </tr>
</table>
\`\`\`
The bullet character is colored red via inline style, item text is light grey.

Action link with arrow icon (e.g. "VIEW FULL PROFILE →"):
\`\`\`html
<td style="border-top:1px solid #SPEC_DIVIDER; padding-top:6px;">
  <table align="left" border="0" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td align="left" style="font-family:'FONT_STACK'; font-size:12px; font-weight:700; line-height:15px; letter-spacing:1.08px; text-transform:uppercase; color:#FF2323;">
        <a href="#" style="color:#FF2323; text-decoration:none;">[ACTION TEXT]</a>
      </td>
      <td style="width:15px;">&nbsp;</td>
      <td align="right" valign="middle"><a href="#"><img src="ARROW_URL" width="10" alt="" border="0" style="display:block; max-width:10px;"/></a></td>
    </tr>
  </table>
</td>
\`\`\`
If no arrow image URL is available, fallback to \`&rarr;\` or \`→\` Unicode character in a colored span.

### PATTERN 9: FEATURED PROFILE CAPSULE TAGS (bordered rectangles in a row)
Trigger: spec has 4-8 short attribute labels arranged in 1-2 rows (location, role type, salary, requirements, etc.). These look like "pills" but are BORDERED RECTANGLES WITHOUT border-radius — flat-sided.

\`\`\`html
<table align="left" border="0" cellpadding="0" cellspacing="0">
  <tr>
    <th align="left" valign="top" class="em_clear">
      <table border="0" cellspacing="0" cellpadding="0">
        <tr>
          <td align="center" valign="middle" height="34" style="font-family:'FONT_STACK'; font-size:14px; color:#SPEC_TEXT; font-weight:400; border:1px solid #SPEC_BORDER; padding:0 15px; background-color:#SPEC_PILL_BG; letter-spacing:1px; text-transform:uppercase;">[TAG TEXT]</td>
        </tr>
      </table>
    </th>
    <th width="8" class="em_hide">&nbsp;</th>
    <th align="left" valign="top" class="em_clear em_ptop">[TAG 2]</th>
    <!-- ...more tags... -->
  </tr>
</table>
\`\`\`
NEVER add \`border-radius:50px\` to these. They are flat rectangles with hairline borders. Use border-radius ONLY on pill-shaped elements like CTAs and the small status indicators (Pattern 2 and Pattern 12).

### PATTERN 10: ACTIVELY EXPLORING-STYLE PILL (with red dot indicator)
Trigger: spec has a small badge/pill containing a status word (e.g. "ACTIVELY EXPLORING", "AVAILABLE NOW", "LIVE", "OPEN"). 

\`\`\`html
<td align="center" valign="middle" height="22" style="font-family:'FONT_STACK'; font-size:12px; color:#EBEBEB; font-weight:500; border:1px solid #3C3C3B; padding:0 10px; background-color:#1A1A19; border-radius:20px; letter-spacing:1.4px; text-transform:uppercase;">
  <span style="color:#FF2323; font-size:14px; font-weight:700;">&bull;</span>&nbsp; [STATUS TEXT]
</td>
\`\`\`
The red dot is mandatory for active-status pills. border-radius:20px makes it a true pill shape.

### PATTERN 11: TWO-COLUMN CARD WITH VERTICAL DIVIDER
Trigger: spec has two adjacent content blocks that should display side-by-side inside a single card frame (e.g. Profile Overview + Operating Impact, Pros + Cons, Features + Benefits).

Specific structural rules (verified against production reference):

\`\`\`html
<!-- Outer section wrapper: padding 20px 25px 0px 25px (top/sides only, no bottom) -->
<td align="center" valign="top" bgcolor="#SPEC_BG" style="border-top:1px solid #SPEC_BORDER;">
  <table align="center" width="600" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td style="padding:20px 25px 0px 25px;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <!-- BORDERED CARD CONTAINER -->
            <td align="center" valign="top" style="border:1px solid #5F5F5F; border-radius:14px; padding-top:19px; padding-bottom:19px;" bgcolor="#1A1A19">
              <table width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <!-- LEFT COLUMN (273px) -->
                  <th align="center" valign="top" class="em_clear">
                    <table align="center" width="273" border="0" cellspacing="0" cellpadding="0" style="width:273px;" class="em_wrapper">
                      <tr>
                        <td align="center" valign="top" style="padding:2px 12px 12px 19px;" class="em_pad2">
                          <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
                            <!-- Column heading: 26px-wide number cell + 18px spacer + label -->
                            <tr>
                              <td align="left" valign="top">
                                <table align="left" border="0" cellspacing="0" cellpadding="0">
                                  <tr>
                                    <td align="right" valign="middle" width="26" style="width:26px;">
                                      <table width="26" align="right" border="0" cellpadding="0" cellspacing="0">
                                        <tr><td align="right" valign="middle" style="font-family:'FONT_STACK'; font-size:16px; font-weight:700; line-height:19px; color:#878787;">01</td></tr>
                                      </table>
                                    </td>
                                    <td width="18" style="width:18px;">&nbsp;</td>
                                    <td align="left" valign="middle" style="font-family:'FONT_STACK'; font-size:16px; font-weight:600; line-height:19px; letter-spacing:2.20px; color:#FFFFFF; text-transform:uppercase;">COLUMN 1 LABEL</td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                            <!-- Bullet items below with red square markers -->
                            <tr><td style="padding-top:24px;"><!-- First bullet at 24px padding-top --></td></tr>
                            <tr><td style="padding-top:13px;"><!-- Subsequent bullets at 13px padding-top --></td></tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </th>
                  <!-- VERTICAL DIVIDER: 1px wide TH with bgcolor -->
                  <th width="1" style="width:1px; font-size:0px; line-height:0px;" bgcolor="#878787" class="em_clear">&nbsp;</th>
                  <!-- RIGHT COLUMN (274px) -->
                  <th align="center" valign="top" class="em_clear">
                    <table align="center" width="274" border="0" cellspacing="0" cellpadding="0" style="width:274px;" class="em_wrapper">
                      <tr>
                        <td align="center" valign="top" style="padding:2px 12px 0px 12px;" class="em_pad1">
                          <!-- Same heading + bullet structure as left, with "02" + bullets at 14px padding-top from heading, 9px between -->
                        </td>
                      </tr>
                    </table>
                  </th>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td>
\`\`\`

Critical specifics:
- Container bgcolor is dark \`#1A1A19\`, border is muted grey \`#5F5F5F\`, border-radius is 14px
- Top/bottom padding inside container is 19px
- LEFT column width is 273px, RIGHT column width is 274px (these are FIXED, not percentages)
- Vertical divider is 1px wide TH with bgcolor \`#878787\` (NOT dark grey — it's a visible mid-grey line)
- Column heading: number in \`#878787\` weight 700 + 18px spacer + label in \`#FFFFFF\` font-weight **600** (NOT 700)
- Bullets use the red square pattern (Pattern 12) with sqr.png or CSS fallback

NEVER render this as two separate floating columns without the wrapper card. NEVER use border-radius:0 on the wrapper.

### PATTERN 11B: FULL-WIDTH BULLETED LIST CARD
Trigger: spec has a section with 3-8 bullet points displayed in a single bordered card spanning the full content width (e.g. "What They're Exploring", "Key Features", "What's Included", "Things to Note"). Used for emphasized lists separate from 2-column patterns.

\`\`\`html
<td align="center" valign="top" bgcolor="#SPEC_BG">
  <table align="center" width="600" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td valign="top" align="center" style="padding:20px 25px 0px 25px;" class="em_pad1">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
          <tr>
            <!-- BORDERED CARD: full inner width -->
            <td align="center" valign="top" style="padding:18px 20px 18px 19px; border:1px solid #5F5F5F; border-radius:14px;" bgcolor="#1A1A19" class="em_pad">
              <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
                <!-- First bullet — no padding-top -->
                <tr>
                  <td valign="top" align="left">
                    <table width="100%" align="left" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td align="left" valign="top" width="5" style="width:5px; font-size:0; line-height:0;"><img src="SQR_URL" width="5" alt="" style="display:block; max-width:5px;" border="0"/></td>
                        <td width="10" style="width:10px;">&nbsp;</td>
                        <td align="left" valign="top" style="font-family:'FONT_STACK'; font-size:14px; font-weight:400; line-height:19px; color:#EBEBEB;">[FIRST BULLET TEXT]</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <!-- Subsequent bullets — padding-top:9px -->
                <tr>
                  <td valign="top" align="left" style="padding-top:9px;">
                    <!-- same bullet structure -->
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td>
\`\`\`

Specifics:
- Outer wrapper padding: \`20px 25px 0px 25px\` (top/sides, no bottom)
- Card padding: \`18px 20px 18px 19px\` (note slight asymmetry — left is 19px, right is 20px)
- Card border: 1px solid \`#5F5F5F\`, border-radius 14px, bgcolor \`#1A1A19\`
- Bullets: 5px sqr.png + 10px spacer + text in \`#EBEBEB\` 14px weight 400
- First bullet has no padding-top; subsequent bullets have \`padding-top:9px\`

### PATTERN 12: RED SQUARE BULLET (for value/feature bullets)
Trigger: spec bullet items where the marker is a small filled square (not a circle/disc).

If a square bullet image is available in spec:
\`\`\`html
<table width="100%" border="0" cellspacing="0" cellpadding="0">
  <tr>
    <td width="5" align="left" valign="top" style="width:5px; font-size:0px;"><img src="SQR_URL" width="5" alt="" style="display:block; max-width:5px;" border="0"/></td>
    <td width="11" style="width:11px;">&nbsp;</td>
    <td align="left" valign="top" style="font-family:'FONT_STACK'; font-size:14px; font-weight:400; line-height:19px; color:#EBEBEB;"><span style="font-weight:500; color:#ffffff;">Label:</span>&nbsp;&nbsp; [VALUE]</td>
  </tr>
</table>
\`\`\`

If no image available, CSS fallback for the square bullet:
\`\`\`html
<td width="5" align="left" valign="top" style="font-size:0; line-height:0;">
  <table border="0" cellpadding="0" cellspacing="0"><tr><td height="5" width="5" bgcolor="#FF2323" style="height:5px; width:5px; font-size:0; line-height:0;">&nbsp;</td></tr></table>
</td>
\`\`\`
The CSS version uses a 5x5 colored TD as the visible square.

### PATTERN 13: SIDE-BY-SIDE CARD CTA (text card LEFT + CTA card RIGHT)
Trigger: spec has a multi-line text block (typically a heading + checklist) adjacent to a prominent CTA button inside its own framed card. Common closing-CTA pattern.

Specific structural rules (verified against production reference):

\`\`\`html
<td align="center" valign="top" bgcolor="#SPEC_BG">
  <table align="center" width="600" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td valign="top" align="center" style="padding-top:32px; padding-bottom:0px;" class="em_ptop">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
          <tr>
            <td width="25" class="em_side15">&nbsp;</td>
            <td align="center" valign="top">
              <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <!-- LEFT: 386px text card -->
                  <th align="center" valign="top" class="em_clear">
                    <table align="center" width="386" border="0" cellspacing="0" cellpadding="0" style="width:386px;" class="em_wrapper">
                      <tr>
                        <td align="center" valign="top" style="padding:20px 20px 19px 19px; border:1px solid #5F5F5F; border-radius:14px;" bgcolor="#131312" class="em_pad">
                          <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
                            <!-- Heading -->
                            <tr><td align="left" style="font-family:'FONT_STACK'; font-size:18px; font-weight:500; line-height:22px; color:#FFFFFF;">[HEADING TEXT]</td></tr>
                            <!-- Subtitle -->
                            <tr><td align="left" style="font-family:'FONT_STACK'; font-size:12px; font-weight:400; line-height:15px; color:#878787; padding-top:7px;">[SUBTITLE]</td></tr>
                            <!-- Bullets WITH bottom borders between them -->
                            <tr>
                              <td valign="top" align="left" style="padding-top:23px; padding-bottom:5px; border-bottom:1px solid #2A2A29;">
                                <table width="100%" align="left" border="0" cellspacing="0" cellpadding="0">
                                  <tr>
                                    <td align="left" valign="top" width="4" style="width:4px; font-size:0;"><img src="SQR_URL" width="4" alt="" style="display:block; max-width:4px;" border="0"/></td>
                                    <td width="9" style="width:9px;">&nbsp;</td>
                                    <td align="left" valign="top" style="font-family:'FONT_STACK'; font-size:14px; font-weight:400; line-height:19px; color:#EBEBEB;">[BULLET 1]</td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                            <!-- More bullets — padding-top:9px each, same border-bottom -->
                          </table>
                        </td>
                      </tr>
                    </table>
                  </th>
                  <!-- 12px gap between cards, hides on mobile -->
                  <th width="12" class="em_hide">&nbsp;</th>
                  <!-- RIGHT: 152px CTA card -->
                  <th align="center" valign="top" class="em_clear em_ptop">
                    <table align="center" width="152" border="0" cellspacing="0" cellpadding="0" style="width:152px;" class="em_wrapper">
                      <tr>
                        <td align="center" valign="top" style="padding:18px 7px 18px 7px; border:1px solid #5F5F5F; border-radius:14px;" bgcolor="#000000" class="em_pad">
                          <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
                            <!-- Image / icon at top -->
                            <tr><td align="center"><img src="ICON_URL" width="100" height="109" alt="" style="display:block; max-width:100px;" border="0"/></td></tr>
                            <!-- Red pill button below image -->
                            <tr>
                              <td align="center" valign="top" style="padding-top:6px;">
                                <table align="center" border="0" cellspacing="0" style="border-radius:24px;" bgcolor="#FF2323" cellpadding="0">
                                  <tr><td height="10" style="height:10px; font-size:0;">&nbsp;</td></tr>
                                  <tr>
                                    <td align="center">
                                      <table align="center" border="0" cellspacing="0" cellpadding="0">
                                        <tr>
                                          <td width="13">&nbsp;</td>
                                          <td style="font-family:'FONT_STACK'; font-size:11px; color:#FFFFFF; font-weight:700; text-transform:uppercase; letter-spacing:1.1px;"><a href="#" style="color:#fff; text-decoration:none;">[CTA TEXT]&nbsp;</a></td>
                                          <td width="20">&nbsp;</td>
                                          <td align="center" valign="middle"><a href="#"><img src="ARROW_URL" width="17" alt="&rarr;" border="0" style="display:inline-block; max-width:17px;"/></a></td>
                                          <td width="13">&nbsp;</td>
                                        </tr>
                                      </table>
                                    </td>
                                  </tr>
                                  <tr><td height="10" style="height:10px; font-size:0;">&nbsp;</td></tr>
                                </table>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </th>
                </tr>
              </table>
            </td>
            <td width="25" class="em_side15">&nbsp;</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td>
\`\`\`

Critical specifics:
- LEFT card: width 386px, bgcolor \`#131312\` (very dark with warm tint), border 1px solid \`#5F5F5F\`, radius 14px, padding 20px 20px 19px 19px
- RIGHT card: width 152px, bgcolor \`#000000\` (pure black), same border/radius, padding 18px 7px 18px 7px
- Bullets in LEFT card have \`border-bottom:1px solid #2A2A29\` between each (creates a horizontal divider line under each item)
- Bullet sqr.png is 4px wide (not 5px), with 9px spacer (not 10px)
- First bullet has \`padding-top:23px\` (large gap from subtitle), subsequent bullets \`padding-top:9px\`
- Red pill button has border-radius:24px (NOT 22px — that's different from Pattern 14)
- 12px gap between LEFT and RIGHT cards, hides on mobile

NEVER render this as two stacked rows. NEVER omit the right CTA card frame — the red button SITS INSIDE a bordered card, not floating alone.

### PATTERN 14: GRADIENT BANNER CTA (Ready-to-Meet style)
Trigger: spec has a horizontal closing CTA banner where the left side has text and the right side has a CTA button.

\`\`\`html
<td align="center" valign="top" style="padding:22px 26px 21px 25px; border-top:2px solid #FF2323; border-left:1px solid #FF2323; border-bottom:1px solid #FF2323; border-right:1px solid #FF2323; border-radius:14px; background:linear-gradient(to right, rgba(120,40,10,0.35) 0%, rgba(40,40,40,0.9) 25%, #1A1A19 60%, #1A1A19 100%);" bgcolor="#1A1A19">
  <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <th align="left" valign="top" class="em_clear">
        <td style="font-family:'FONT_STACK'; font-size:20px; font-weight:400; line-height:25px; color:#SPEC_ACCENT;">
          <span style="color:#ffffff; font-weight:600;">[HEADING LINE 1]</span><br/>[HEADING LINE 2]
        </td>
      </th>
      <th align="right" valign="top" class="em_clear">
        <!-- Red CTA pill with arrow (same pattern as Pattern 13's red button) -->
        <table align="center" bgcolor="#FF2323" style="border-radius:22px;" border="0" cellspacing="0" cellpadding="0">
          <tr><td height="13">&nbsp;</td></tr>
          <tr><td><a href="#" style="color:#fff; text-decoration:none;">[CTA TEXT]&nbsp;&rarr;</a></td></tr>
          <tr><td height="13">&nbsp;</td></tr>
        </table>
      </th>
    </tr>
  </table>
</td>
\`\`\`
The red top-border (2px) plus thinner side borders is a signature treatment. Use a gradient bg for additional visual depth.

### PATTERN 15: FOOTER WITH MAIL/WEB ICONS + WORDMARK
Trigger: spec footer has contact methods (email, website) with small icons + a brand wordmark.

\`\`\`html
<td align="center" bgcolor="#040404" style="padding:25px 0;">
  <table align="center" width="100%" border="0" cellspacing="0" cellpadding="0" dir="rtl">
    <tr>
      <th align="right" dir="ltr" class="em_clear"><!-- WORDMARK on right --></th>
      <th width="49" class="em_hide">&nbsp;</th>
      <th align="center" dir="ltr" class="em_clear em_ptop">
        <!-- Email row with mail icon -->
        <table align="left" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <td align="center" valign="middle" width="12">
              <a href="mailto:[EMAIL]"><img src="MAIL_ICON_URL" width="12" height="18" alt="mail" border="0" style="display:block; max-width:13px;"/></a>
            </td>
            <td width="6">&nbsp;</td>
            <td style="font-family:'FONT_STACK'; font-size:14px; color:#878787;"><a href="mailto:[EMAIL]" style="color:#878787; text-decoration:none;">[EMAIL]</a></td>
          </tr>
        </table>
        <!-- Web row with web icon (same pattern) -->
      </th>
    </tr>
  </table>
</td>
\`\`\`
If mail/web icon URLs aren't in the spec, fallback to Unicode (✉ for mail, 🌐 for web) wrapped in a colored span, or use simple text "Email:" / "Web:" prefixes. Avoid emoji.

## PATTERN-MATCHING GUIDANCE

When generating an email:
1. First, scan the visual reference image (if available) for these patterns
2. For each section in the spec, determine which pattern (if any) it matches
3. Use the matching pattern's HTML template, substituting spec values for placeholders
4. If no pattern matches, fall back to the GOLD STANDARD section templates above
5. NEVER add visual elements (red borders, capsule rounding, color treatments) that aren't visible in the design reference
6. NEVER stack vertically when the reference shows horizontal arrangement
7. NEVER use bullet dots (•) or pipes (|) as ticker separators — always 1-2px bgcolor cells

The patterns above are the BASELINE for Mavlers-grade output. Match them precisely when the spec exhibits the trigger characteristics.

## FINAL CHECKLIST
Before outputting, verify:
- Output begins with <!DOCTYPE
- sections.length in HTML === sections.length in spec (count both)
- Every section from spec has a corresponding <tr> block in HTML
- Each section is its own em_wrapper table inside a <tr>
- CTAs match spec values for bgcolor, height, border-radius, font-size
- Text colors match the exact spec hex (no generic defaults substituted)
- All colors used are from the spec's _palette array (no invented hex values)
- EVERY text element's align attribute and text-align style matches the spec's "align" value (never default to left)
- Every img src is the exact Dropbox URL from spec.content[].src (or "" if spec had empty src)
- NO img tag has a relative path like "images/filename.png" — this is always wrong
- Every "spans" array renders as ONE td with multiple inline <span> elements (never two stacked rows)
- Font loaded via <link> tag, not @import
- All text from spec used verbatim
- Section order matches spec exactly (top-to-bottom)
- Thin elements (colored stripes, alert bars, standalone contact rows) are preserved
- Dark/light variant pairs both present when spec shows both
- Bullet lists rendered as <ul>/<li>
- Footer + copyright bar on separate rows
- No sections invented that aren't in the spec

Generate the most accurate, production-ready, Mavlers-grade HTML email code possible from the provided JSON design specification and developer overrides.`;


// =====================================================================
// EXPRESS APP SETUP

// =====================================================================
// v9.0.0 — CLAUDE CODE BRIDGE (parallel to Anthropic API for Stage 2)
// =====================================================================
//
// Toggle: header X-AI-Engine OR body.aiEngine = "claude-code" | "console" (default)
// Or env: AI_ENGINE_DEFAULT=claude-code
//
// When "claude-code" is selected, Stage 2 hits the Mac bridge instead of Anthropic API.
// Mac bridge URL: MAC_BRIDGE_URL env var (e.g. https://xxx.ngrok.io)
// Auth: MAC_BRIDGE_SECRET shared between Railway and Mac bridge

const MAC_BRIDGE_URL = process.env.MAC_BRIDGE_URL || null;
const MAC_BRIDGE_SECRET = process.env.MAC_BRIDGE_SECRET || "change-me-in-env";
const AI_ENGINE_DEFAULT = process.env.AI_ENGINE_DEFAULT || "console"; // "console" | "claude-code"

function getRequestedEngine(req) {
  // Per-request override via header or body
  const headerEngine = req.headers["x-ai-engine"];
  const bodyEngine = req.body?.aiEngine;
  return headerEngine || bodyEngine || AI_ENGINE_DEFAULT;
}

async function loadReferenceForFigmaFile(figmaFileKey) {
  // Use the existing REFERENCE_CACHE populated at boot from /references/
  if (!figmaFileKey) return null;
  return REFERENCE_CACHE.get(figmaFileKey) || null;
}

async function callClaudeCodeBridge({ designSpec, referenceHtml, designImageBase64, model, requestId, log }) {
  if (!MAC_BRIDGE_URL) {
    throw new Error("MAC_BRIDGE_URL not configured — set it to the ngrok URL of your Mac bridge");
  }

  const payload = {
    spec: designSpec,
    referenceHtml: referenceHtml || null,
    imageBase64: designImageBase64 || null,
    model: model || "sonnet",
    requestId,
  };

  log("info", "Claude Code: dispatching to Mac bridge", {
    requestId,
    bridgeUrl: MAC_BRIDGE_URL,
    specSections: designSpec?.sections?.length || 0,
    hasReference: !!referenceHtml,
    hasImage: !!designImageBase64,
  });

  const startTime = Date.now();

  // v9.1.2: long-timeout dispatcher is set globally at top of file (setGlobalDispatcher).
  // Plain fetch() will use it automatically. No per-call dispatcher tear-down needed.
  const response = await fetch(`${MAC_BRIDGE_URL}/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Secret": MAC_BRIDGE_SECRET,
      // v9.0.1: bypass ngrok free-tier interstitial. Without this header,
      // ngrok returns an HTML warning page instead of forwarding to the
      // bridge, causing JSON parse failures on the Railway side.
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify(payload),
  });

  const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Mac bridge returned ${response.status}: ${errBody.substring(0, 500)}`);
  }

  const result = await response.json();
  if (!result.html) {
    throw new Error(`Mac bridge returned no HTML: ${JSON.stringify(result).substring(0, 500)}`);
  }

  log("info", "Claude Code: bridge returned HTML", {
    requestId,
    jobId: result.jobId,
    bytesGenerated: result.bytesGenerated,
    elapsedSeconds: parseFloat(elapsedSeconds),
  });

  return result.html;
}

// =====================================================================
// END CLAUDE CODE BRIDGE
// =====================================================================


// =====================================================================
const app = express();

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST"],
  credentials: false,
}));

// Increased from 8mb to 35mb to accommodate PDF (5MB) + ZIP (25MB) after base64 inflation
app.use(express.json({ limit: "35mb" }));

app.use((req, res, next) => {
  req.id = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader("X-Request-ID", req.id);
  next();
});

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }));

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests",
    details: "Please wait a moment before generating again.",
  },
});

const rasterizeWithTimeout = (buffer) => Promise.race([
  pdfToPng(buffer, {
    viewportScale: RASTERIZE_SCALE,
    disableFontFace: false,
    useSystemFonts: false,
  }),
  new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`PDF rasterization timed out after ${RASTERIZE_TIMEOUT_MS / 1000}s`)),
      RASTERIZE_TIMEOUT_MS
    )
  ),
]);

// =====================================================================
// ROUTES
// =====================================================================

app.get("/health", (req, res) => {
  // v5.5.0: do not leak the configured model name to unauthenticated callers.
  res.json({
    status: "ok",
    uptime: process.uptime(),
    apiKeyConfigured: Boolean(process.env.CLAUDE_API_KEY),
    dropboxConfigured,
    figmaConfigured,
    supabaseConfigured,
    authConfigured: Boolean(SUPABASE_JWT_SECRET),
    framework: "master-v2",
    version: "9.1.0-async-preview",
    // v9.0.0: Claude Code engine status
    aiEngine: {
      default: AI_ENGINE_DEFAULT,
      claudeCodeBridgeConfigured: Boolean(MAC_BRIDGE_URL),
      bridgeUrl: MAC_BRIDGE_URL ? `${MAC_BRIDGE_URL.substring(0, 30)}...` : null,
    },
  });
});

// -----------------------------------------------------------------
// POST /generate — Main pipeline
// Accepts: { pdfBase64, pdfFilename, assetsZipBase64? }
// Returns: { html, orderId, pageCount, pageImages, imageUrlMap, requestId }
// -----------------------------------------------------------------
app.post("/generate", generateLimiter, optionalAuth, async (req, res) => {
  const startTime = Date.now();
  try {
    const { 
      pdfBase64, 
      pdfFilename, 
      assetsZipBase64, 
      // Developer input fields — only values Claude CANNOT detect from PDF
      emailWidth,        // e.g., 600, 640, 650, 680, 700
      primaryFont,       // e.g., "Poppins", "Montserrat", "Lato", "Arial"
      secondaryFont,     // e.g., "Arial", optional
      espPlatform,       // e.g., "none", "mailchimp", "sfmc", "hubspot", "klaviyo"
      darkMode,          // true/false
    } = req.body;

    // --- Validate PDF ---
    if (!pdfBase64) {
      return res.status(400).json({
        error: "Missing pdfBase64",
        details: "Request body must include a pdfBase64 field.",
        requestId: req.id,
      });
    }

    if (!pdfFilename) {
      return res.status(400).json({
        error: "Missing pdfFilename",
        details: "Request body must include a pdfFilename field (e.g., 'OID9924641912.pdf').",
        requestId: req.id,
      });
    }

    // --- Extract Order ID from filename ---
    const orderId = extractOrderId(pdfFilename);
    if (!orderId) {
      return res.status(400).json({
        error: "Invalid filename",
        details: "Please rename your PDF with the Order ID (e.g., 'OID9924641912.pdf'). Generic filenames like 'design.pdf' are not accepted.",
        requestId: req.id,
      });
    }

    const cleanBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, "");
    const pdfBuffer = Buffer.from(cleanBase64, "base64");

    if (pdfBuffer.length > MAX_PDF_BYTES) {
      return res.status(413).json({
        error: "PDF too large",
        details: `PDF must be 5 MB or smaller. Received ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB.`,
        requestId: req.id,
      });
    }

    const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
    if (pdfBuffer.length < 5 || !pdfBuffer.subarray(0, 5).equals(PDF_MAGIC)) {
      return res.status(400).json({
        error: "Invalid file",
        details: "The uploaded file is not a valid PDF.",
        requestId: req.id,
      });
    }

    log("info", "Processing request", {
      requestId: req.id,
      orderId,
      pdfSizeKB: Math.round(pdfBuffer.length / 1024),
      hasAssetsZip: Boolean(assetsZipBase64),
      userId: req.user?.id ?? "anonymous",
      userEmail: req.user?.email ?? "anonymous",
    });

    // --- Step 1: Rasterize PDF for Claude Vision ---
    log("info", "Rasterizing PDF", { requestId: req.id, scale: RASTERIZE_SCALE });
    const pngPages = await rasterizeWithTimeout(pdfBuffer);

    if (pngPages.length > MAX_PAGES) {
      return res.status(413).json({
        error: "Too many pages",
        details: `PDF has ${pngPages.length} pages. Maveloper supports up to ${MAX_PAGES} pages per email design.`,
        requestId: req.id,
      });
    }

    // --- Step 2: Extract or receive images ---
    let images = [];
    let imageSource = "none";

    if (assetsZipBase64) {
      // User provided images via ZIP upload
      try {
        images = await extractImagesFromZip(assetsZipBase64);
        imageSource = "zip";
        log("info", "Extracted images from ZIP", {
          requestId: req.id,
          imageCount: images.length,
          filenames: images.map((i) => i.filename),
          dimensions: images.map((i) => ({
            file: i.filename,
            w: i.originalWidth,
            h: i.originalHeight,
          })),
        });
      } catch (zipErr) {
        return res.status(400).json({
          error: "ZIP extraction failed",
          details: zipErr.message,
          requestId: req.id,
        });
      }
    } else {
      // Attempt auto-extraction from PDF
      images = await extractImagesFromPdf(pdfBuffer);
      imageSource = images.length > 0 ? "pdf-auto" : "none";
      log("info", "PDF image extraction result", {
        requestId: req.id,
        imageCount: images.length,
        source: imageSource,
      });
    }

    // --- Step 3: Upload images to Dropbox (if we have images and Dropbox is configured) ---
    // CRITICAL: If images are present, upload MUST succeed. Otherwise the generated
    // HTML will have broken image paths. We fail the request rather than ship bad HTML.
    let imageUrlMap = {};
    if (images.length > 0 && dropboxConfigured) {
      const UPLOAD_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
        try {
          imageUrlMap = await uploadImagesToDropbox(orderId, images, log);
          log("info", "Images uploaded to Dropbox", {
            requestId: req.id,
            imageCount: Object.keys(imageUrlMap).length,
            totalImages: images.length,
            attempt,
          });
          // Success: break out of retry loop if we got at least some URLs
          if (Object.keys(imageUrlMap).length > 0) break;
          log("warn", `Upload attempt ${attempt} returned empty map`, { requestId: req.id });
        } catch (dbxErr) {
          log("error", `Dropbox upload attempt ${attempt} failed`, {
            requestId: req.id,
            error: dbxErr.message,
          });
          if (attempt < UPLOAD_ATTEMPTS) {
            await sleepMs(DROPBOX_BATCH_RETRY_DELAY_MS);
          }
        }
      }

      // HARD FAIL if upload produced zero URLs despite having images
      if (Object.keys(imageUrlMap).length === 0) {
        log("error", "Dropbox upload failed completely — aborting to avoid shipping broken HTML", {
          requestId: req.id,
          imageCount: images.length,
        });
        return res.status(502).json({
          error: "Image upload failed",
          details: "Could not upload images to Dropbox after multiple attempts. Please try again in a moment. If the problem persists, check Dropbox credentials in Railway environment variables.",
          requestId: req.id,
        });
      }

      // PARTIAL fail: log but continue (will have some broken images, not all)
      if (Object.keys(imageUrlMap).length < images.length) {
        log("warn", "Partial Dropbox upload — some images failed", {
          requestId: req.id,
          uploaded: Object.keys(imageUrlMap).length,
          total: images.length,
          missing: images.filter((i) => !imageUrlMap[i.filename]).map((i) => i.filename),
        });
      }
    }

    // =================================================================
    // STAGE 1 — Design Analysis (v5.0.0)
    // Full-design Claude call with pixel-sampled palette + OCR text.
    //
    // v4.x was per-band Claude calls. That fragmented sections and lost
    // visual context. v5 reverts to a single full-design pass, but hands
    // Claude authoritative pixel-sampled colors + OCR text + a band map,
    // so Claude never has to GUESS colors or miss thin elements.
    // =================================================================
    const stage1StartTime = Date.now();
    log("info", "Stage 1 starting (v5.0.0)", {
      requestId: req.id,
      pageCount: pngPages.length,
    });

    // --- Step 1a: Text extraction (pdf-parse, fallback to Tesseract OCR) ---
    const MIN_USEFUL_TEXT_LENGTH = 200;
    let extractedText = "";
    let textExtractionMethod = "none";

    try {
      const pdfData = await pdfParse(pdfBuffer);
      if (pdfData.text && pdfData.text.trim().length >= MIN_USEFUL_TEXT_LENGTH) {
        extractedText = pdfData.text;
        textExtractionMethod = "pdf-parse";
      }
    } catch (parseErr) {
      log("warn", "pdf-parse failed, will try OCR", {
        requestId: req.id,
        error: parseErr.message,
      });
    }

    if (!extractedText || extractedText.trim().length < MIN_USEFUL_TEXT_LENGTH) {
      try {
        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker("eng");
        const ocrResults = [];
        for (const page of pngPages) {
          const { data } = await worker.recognize(page.content);
          ocrResults.push(data.text);
        }
        await worker.terminate();
        extractedText = ocrResults.join("\n\n");
        textExtractionMethod = "tesseract-ocr";
      } catch (ocrErr) {
        log("error", "Tesseract OCR failed", {
          requestId: req.id,
          error: ocrErr.message,
        });
      }
    }

    // Always run post-processing regardless of extraction method.
    // The universal fixes (letter-spacing collapse, doubled spaces, etc.)
    // don't break clean pdf-parse output but do repair OCR artifacts.
    extractedText = postProcessOcr(extractedText);

    log("info", "Text extraction complete", {
      requestId: req.id,
      textExtractionMethod,
      textLength: extractedText.length,
    });

    // --- Step 1b: Band detection + palette building ---
    const allBands = [];
    const pageInfos = [];
    let cumulativeBandCount = 0;

    for (let pageIdx = 0; pageIdx < pngPages.length; pageIdx++) {
      const pageBuffer = pngPages[pageIdx].content;
      const detectStart = Date.now();
      const { width: pageW, height: pageH, bands: pageBands } =
        await detectBands(pageBuffer);

      log("info", `Page ${pageIdx + 1} band detection`, {
        requestId: req.id,
        pageWidth: pageW,
        pageHeight: pageH,
        bandsDetected: pageBands.length,
        detectMs: Date.now() - detectStart,
      });

      pageInfos.push({
        pageIdx,
        pageWidth: pageW,
        pageHeight: pageH,
        bandCount: pageBands.length,
      });

      for (const band of pageBands) {
        allBands.push({
          ...band,
          pageIdx,
          globalIndex: ++cumulativeBandCount,
        });
      }
    }

    // Build a palette of authoritative colors
    const palette = buildColorPalette(allBands);

    log("info", "Band detection + palette complete", {
      requestId: req.id,
      totalBands: allBands.length,
      paletteSize: palette.length,
      paletteColors: palette.slice(0, 10).map((p) => p.hex),
    });

    // --- Step 1c: Prepare Stage 1 Claude inputs ---
    // Anthropic Vision API has a HARD LIMIT of 8000px on any image dimension.
    // Email design rasters at 150dpi often exceed 12000px tall. A single
    // resized image either breaks the limit (crash) or compresses so much
    // that section layout becomes unreadable.
    //
    // Solution: tile the design into overlapping horizontal slices, each
    // under 6000px tall (safe margin under 8000 cap). Overlap helps Claude
    // see section continuity across tile boundaries.
    // Each tile is a full-width slice of the original raster.
    const TILE_MAX_HEIGHT = 6000;
    const TILE_OVERLAP = 300;
    const TILE_TARGET_MAX_BYTES = 2 * 1024 * 1024; // 2MB per tile

    const tiles = []; // Array of { buffer, pageIdx, y_offset, y_end, width, height }

    for (let i = 0; i < pngPages.length; i++) {
      const page = pngPages[i];
      const pageInfo = pageInfos[i];
      const pageH = pageInfo.pageHeight;
      const pageW = pageInfo.pageWidth;

      log("info", `Page ${i + 1} original`, {
        requestId: req.id,
        origWidth: pageW,
        origHeight: pageH,
        origSizeKB: Math.round(page.content.length / 1024),
      });

      // Compute tile y-ranges in the ORIGINAL raster's coordinate space
      const tileRanges = [];
      if (pageH <= TILE_MAX_HEIGHT) {
        tileRanges.push({ y_start: 0, y_end: pageH });
      } else {
        const step = TILE_MAX_HEIGHT - TILE_OVERLAP;
        let y = 0;
        while (y < pageH) {
          const y_end = Math.min(y + TILE_MAX_HEIGHT, pageH);
          tileRanges.push({ y_start: y, y_end });
          if (y_end >= pageH) break;
          y += step;
        }
      }

      log("info", `Page ${i + 1} tiling plan`, {
        requestId: req.id,
        tileCount: tileRanges.length,
        tileRanges: tileRanges.map((t) => `${t.y_start}-${t.y_end}`),
      });

      // For each tile: crop, then JPEG-compress under the byte cap
      for (let t = 0; t < tileRanges.length; t++) {
        const { y_start, y_end } = tileRanges[t];
        const tileHeight = y_end - y_start;

        // Step-down JPEG quality until under byte cap.
        // We do NOT resize width — native resolution is preserved so text
        // and section boundaries stay crisp.
        const qualityAttempts = [82, 75, 68, 60, 52, 45];
        let tileBuffer = null;
        let usedQuality = null;

        for (const q of qualityAttempts) {
          try {
            const buf = await sharp(page.content)
              .extract({
                left: 0,
                top: y_start,
                width: pageW,
                height: tileHeight,
              })
              .jpeg({ quality: q })
              .toBuffer();

            if (buf.length <= TILE_TARGET_MAX_BYTES) {
              tileBuffer = buf;
              usedQuality = q;
              break;
            }
            tileBuffer = buf;
            usedQuality = q;
          } catch (e) {
            log("warn", `Tile compress attempt failed`, {
              requestId: req.id,
              quality: q,
              error: e.message,
            });
            continue;
          }
        }

        // If still too large at quality 45, try resizing width (last resort)
        if (tileBuffer && tileBuffer.length > TILE_TARGET_MAX_BYTES) {
          for (const targetW of [900, 750, 600]) {
            try {
              const buf = await sharp(page.content)
                .extract({
                  left: 0,
                  top: y_start,
                  width: pageW,
                  height: tileHeight,
                })
                .resize(targetW, null, { fit: "inside" })
                .jpeg({ quality: 55 })
                .toBuffer();
              if (buf.length <= TILE_TARGET_MAX_BYTES) {
                tileBuffer = buf;
                usedQuality = `55 (resized to ${targetW}w)`;
                break;
              }
              tileBuffer = buf;
            } catch {
              continue;
            }
          }
        }

        if (!tileBuffer) {
          log("error", "Failed to produce tile buffer", {
            requestId: req.id,
            pageIdx: i,
            tileIdx: t,
          });
          continue;
        }

        tiles.push({
          buffer: tileBuffer,
          pageIdx: i,
          tileIdx: t,
          y_offset: y_start,
          y_end,
          quality: usedQuality,
          sizeKB: Math.round(tileBuffer.length / 1024),
        });

        log("info", `Tile ${t + 1}/${tileRanges.length} compressed`, {
          requestId: req.id,
          pageIdx: i,
          y_offset: y_start,
          y_end,
          heightPx: tileHeight,
          quality: usedQuality,
          sizeKB: Math.round(tileBuffer.length / 1024),
        });
      }
    }

    log("info", "All tiles prepared", {
      requestId: req.id,
      tileCount: tiles.length,
      totalSizeMB: (tiles.reduce((s, t) => s + t.buffer.length, 0) / 1024 / 1024).toFixed(2),
    });

    // --- Step 1d: Build the Stage 1 user message ---
    // This is the SINGLE call that does all design analysis. Claude sees:
    // - Full high-quality design image
    // - Pixel-sampled color palette (authoritative)
    // - OCR text (authoritative)
    // - Band map (reference for thin elements)
    // - Image asset list (with Dropbox URLs pre-matched)
    // - Developer overrides (width, fonts, ESP, dark mode)

    const paletteTable = palette
      .map((p) => {
        const tags = [];
        if (p.is_saturated) tags.push("brand/accent");
        if (p.is_grayscale) tags.push("grayscale");
        return `  ${p.hex}  (${p.total_height_px}px total, ${p.band_count} bands${tags.length ? ", " + tags.join(", ") : ""})`;
      })
      .join("\n");

    const bandMapTable = allBands
      .map(
        (b) =>
          `  #${b.globalIndex.toString().padStart(2, " ")} y=${b.y_start}-${b.y_end} h=${b.height}px bg=${b.bg_hex}${b.is_thin ? " THIN" : ""}${b.is_content ? " CONTENT" : ""}`
      )
      .join("\n");

    // Gather image asset list from the uploaded ZIP (already extracted and
    // uploaded to Dropbox in earlier steps).
    const imageDimensions = {};
    if (Object.keys(imageUrlMap).length > 0) {
      for (const img of images) {
        try {
          const meta = await sharp(img.buffer).metadata();
          imageDimensions[img.filename] = {
            width: meta.width,
            height: meta.height,
          };
        } catch {
          imageDimensions[img.filename] = { width: 0, height: 0 };
        }
      }
    }

    const imageAssetList = Object.entries(imageUrlMap)
      .map(([filename, url]) => {
        const dims = imageDimensions[filename] || {};
        return `  ${filename}  (${dims.width || "?"}x${dims.height || "?"}px)  →  ${url}`;
      })
      .join("\n");

    // Developer override block
    const devOverrides = [];
    if (emailWidth) devOverrides.push(`EMAIL WIDTH: ${emailWidth}px`);
    if (primaryFont) devOverrides.push(`PRIMARY FONT: ${primaryFont}`);
    if (secondaryFont) devOverrides.push(`SECONDARY FONT: ${secondaryFont}`);
    if (espPlatform && espPlatform !== "none") devOverrides.push(`ESP PLATFORM: ${espPlatform}`);
    if (typeof darkMode === "boolean")
      devOverrides.push(`DARK MODE SUPPORT: ${darkMode ? "required" : "not required"}`);
    const devOverridesText = devOverrides.length
      ? devOverrides.join("\n")
      : "(none — use your best judgment)";

    const stage1UserPrompt = `
=== DEVELOPER-SPECIFIED VALUES (authoritative overrides) ===
${devOverridesText}
=== END DEVELOPER VALUES ===

=== COLOR PALETTE (pixel-sampled from the design image) ===
These are the exact colors that appear in the design. Use these verbatim for every bg/color/cta_bg/cta_color field in your output. Do NOT invent or round.
${paletteTable}
=== END PALETTE ===

=== BAND MAP (pixel-exact horizontal regions) ===
This is a reference map of every color transition in the design, by vertical position. Use this to verify you don't miss thin stripes or narrow bars. Your sections should cover the full y-range from 0 to the last band's y_end. Merge adjacent bands into logical sections, but don't skip visible thin colored stripes.
${bandMapTable}
=== END BAND MAP ===

=== OCR TEXT (verbatim, authoritative) ===
Every "text" field in your JSON output must come from this text, copied verbatim. Never paraphrase.

${extractedText.slice(0, 12000)}
=== END OCR TEXT ===

=== IMAGE ASSETS (uploaded to Dropbox, use these EXACT URLs) ===
For every visible image in the design, match to one of these files by content inspection and use the exact Dropbox URL in your output's img src field.
${imageAssetList || "(no images uploaded)"}
=== END IMAGE ASSETS ===

Now analyze the attached design image and produce the JSON specification per the schema rules. Output ONLY the JSON object, no markdown fences, no explanation.`;

    // Build the image blocks. Each tile gets a text label immediately before
    // it describing its pixel position in the full design, so Claude can
    // correlate visual content with the band map's global coordinates.
    const stage1ImageBlocks = [];
    tiles.forEach((tile, idx) => {
      stage1ImageBlocks.push({
        type: "text",
        text: `--- TILE ${idx + 1} of ${tiles.length} — y_range=${tile.y_offset}-${tile.y_end} (height ${tile.y_end - tile.y_offset}px) ---`,
      });
      stage1ImageBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: tile.buffer.toString("base64"),
        },
      });
    });

    const stage1UserContent = [
      ...stage1ImageBlocks,
      { type: "text", text: stage1UserPrompt },
    ];

    // --- Step 1e: Call Claude with retry on transient errors ---
    // v5.5.0: prompt-caching on system message (large + stable) cuts cost and
    // latency significantly across retries within the 5-min cache window.
    // Retry covers 429 + 408/500/502/503/504 + network-class errors.
    let stage1Message = null;
    let stage1LastErr = null;

    for (let attempt = 0; attempt <= STAGE1_MAX_RETRIES; attempt++) {
      try {
        stage1Message = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 64000,
          system: [{ type: "text", text: STAGE1_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: stage1UserContent }],
        });
        break; // success
      } catch (err) {
        stage1LastErr = err;
        if (isRetriableAnthropicError(err) && attempt < STAGE1_MAX_RETRIES) {
          const backoffMs = STAGE1_RETRY_INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          log("info", `Stage 1 transient error, retrying after ${backoffMs}ms`, {
            requestId: req.id,
            attempt: attempt + 1,
            status: err?.status,
            code: err?.code || err?.cause?.code,
          });
          await sleepMs(backoffMs);
          continue;
        }
        break;
      }
    }

    if (!stage1Message) {
      log("error", "Stage 1 API call failed after retries", {
        requestId: req.id,
        error: stage1LastErr?.message || "unknown",
      });
      return res.status(502).json({
        error: "Design analysis failed",
        details: "Could not reach Claude for design analysis. Please try again in a moment.",
        requestId: req.id,
      });
    }

    log("info", "Stage 1 response received", {
      requestId: req.id,
      stopReason: stage1Message.stop_reason,
      outputTokens: stage1Message.usage?.output_tokens,
      inputTokens: stage1Message.usage?.input_tokens,
    });

    // --- Step 1f: Parse JSON response ---
    const stage1TextBlock = stage1Message.content.find((b) => b.type === "text");
    if (!stage1TextBlock) {
      log("error", "Stage 1 returned no text block", { requestId: req.id });
      return res.status(502).json({
        error: "Design analysis failed",
        details: "Claude returned an empty response. Please try again.",
        requestId: req.id,
      });
    }

    const rawJson = stage1TextBlock.text;
    const candidateJson = extractJsonFromMarkdown(rawJson);
    if (!candidateJson) {
      log("error", "Stage 1 returned non-JSON output", {
        requestId: req.id,
        preview: rawJson.slice(0, 300),
      });
      return res.status(502).json({
        error: "Design analysis failed",
        details: "Claude's response was not valid JSON.",
        requestId: req.id,
      });
    }

    // Try parse as-is first; if truncated (no closing brace OR parse error),
    // attempt structural auto-repair by closing unterminated strings/arrays/objects.
    function autoRepairJson(s) {
      // Start from the first '{'. Track context: inside string? escape? brace/bracket stack.
      let str = s;
      let out = "";
      let inString = false;
      let escape = false;
      const stack = []; // '{' or '['
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        out += c;
        if (escape) { escape = false; continue; }
        if (c === "\\" && inString) { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === "{" || c === "[") stack.push(c);
        else if (c === "}" && stack[stack.length - 1] === "{") stack.pop();
        else if (c === "]" && stack[stack.length - 1] === "[") stack.pop();
      }
      // Close any unterminated string
      if (inString) out += '"';
      // Trim trailing incomplete content after the last comma or colon (common truncation pattern)
      // Walk backwards to find a safe boundary
      // Strip trailing partial key or partial value that can't be closed cleanly:
      //   - If we end with "  some text without closing quote already closed above
      //   - If we have `"key":` with nothing after, drop the `,"key":`
      out = out.replace(/,\s*"[^"]*"\s*:\s*$/, "");
      out = out.replace(/,\s*"[^"]*"\s*:\s*"[^"]*"$/, (m) => m); // keep clean string value
      out = out.replace(/,\s*$/, "");
      // Close open arrays and objects in reverse order
      while (stack.length > 0) {
        const opener = stack.pop();
        out += opener === "{" ? "}" : "]";
      }
      return out;
    }

    let designSpec;

    try {
      designSpec = JSON.parse(candidateJson);
    } catch (firstErr) {
      // Try auto-repair for truncated output
      const repaired = autoRepairJson(candidateJson);
      try {
        designSpec = JSON.parse(repaired);
        log("warn", "Stage 1 JSON was truncated — auto-repaired", {
          requestId: req.id,
          stopReason: stage1Message.stop_reason,
          originalLength: rawJson.length,
          repairedLength: repaired.length,
          outputTokens: stage1Message.usage?.output_tokens,
        });
      } catch (secondErr) {
        // v5.4.1: Last-resort retry — ask Claude to regenerate cleanly with the
        // parse error as context. This catches mid-string syntax errors that
        // truncation-repair cannot fix.
        // v5.5.0: prompt-cached system, temperature=0 for determinism, dedicated
        // AbortController timeout so a hung retry cannot block the request.
        log("warn", "Stage 1 JSON parse failed, attempting clean-regenerate retry", {
          requestId: req.id,
          firstErr: firstErr.message,
          repairErr: secondErr.message,
          stopReason: stage1Message.stop_reason,
          outputTokens: stage1Message.usage?.output_tokens,
        });

        const retryUserContent = [
          ...stage1ImageBlocks,
          { type: "text", text: stage1UserPrompt },
          {
            type: "text",
            text:
              "Your previous response was not valid JSON. The parser reported: " +
              firstErr.message +
              "\n\nCommon causes: missing closing quote on a string value, trailing comma before } or ], unescaped quote inside a string, partial object at the end. Please regenerate the COMPLETE JSON specification cleanly. Output ONLY the JSON object. Validate every quote, comma, bracket, and brace before outputting. Do not include the previous broken output. Do not include any explanation. Output ONLY a single valid JSON object starting with { and ending with }.",
          },
        ];

        let retryMessage = null;
        const retryAbort = new AbortController();
        const retryTimer = setTimeout(() => retryAbort.abort(), STAGE1_RETRY_API_TIMEOUT_MS);
        try {
          retryMessage = await anthropic.messages.create(
            {
              model: CLAUDE_MODEL,
              max_tokens: 64000,
              temperature: 0,
              system: [{ type: "text", text: STAGE1_PROMPT, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: retryUserContent }],
            },
            { signal: retryAbort.signal }
          );
        } catch (retryApiErr) {
          log("error", "Stage 1 clean-regenerate API call failed", {
            requestId: req.id,
            error: retryApiErr.message,
            aborted: retryAbort.signal.aborted,
          });
        } finally {
          clearTimeout(retryTimer);
        }

        const retryTextBlock = retryMessage?.content?.find((b) => b.type === "text");
        const retryCandidate = extractJsonFromMarkdown(retryTextBlock?.text || "");

        if (retryCandidate && retryCandidate.length > 10) {
          try {
            designSpec = JSON.parse(retryCandidate);
            log("warn", "Stage 1 clean-regenerate succeeded on retry", {
              requestId: req.id,
              retryOutputTokens: retryMessage.usage?.output_tokens,
            });
          } catch (retryParseErr) {
            try {
              const retryRepaired = autoRepairJson(retryCandidate);
              designSpec = JSON.parse(retryRepaired);
              log("warn", "Stage 1 clean-regenerate succeeded after auto-repair", {
                requestId: req.id,
                retryParseErr: retryParseErr.message,
              });
            } catch (lastErr) {
              log("error", "Stage 1 retry repair failed", {
                requestId: req.id,
                retryParseErr: retryParseErr.message,
                lastErr: lastErr.message,
              });
            }
          }
        }

        if (!designSpec) {
          log("error", "Stage 1 JSON parse error (all retries exhausted)", {
            requestId: req.id,
            error: firstErr.message,
            repairError: secondErr.message,
            stopReason: stage1Message.stop_reason,
            outputTokens: stage1Message.usage?.output_tokens,
            rawLength: rawJson.length,
            preview: rawJson.slice(0, 500),
            tail: rawJson.slice(-500),
          });
          return res.status(502).json({
            error: "Design analysis failed",
            details: "Claude's JSON output was malformed. Please try again.",
            requestId: req.id,
          });
        }
      }
    }

    // --- Step 1g: Post-analysis validation ---
    // Check that every meaningful band is accounted for in the sections.
    // A "meaningful band" is either saturated (brand color) OR >= 40px tall.
    // For each meaningful band, check that some section's y-range overlaps it.
    const meaningfulBands = allBands.filter((b) => {
      const [r, g, b2] = [
        parseInt(b.bg_hex.substring(1, 3), 16),
        parseInt(b.bg_hex.substring(3, 5), 16),
        parseInt(b.bg_hex.substring(5, 7), 16),
      ];
      const sat = Math.max(r, g, b2) - Math.min(r, g, b2);
      return sat > 40 || b.height >= 40;
    });

    const sections = Array.isArray(designSpec.sections) ? designSpec.sections : [];
    const coveredBands = meaningfulBands.filter((band) => {
      return sections.some((s) => {
        const ys = s.y_start ?? 0;
        const ye = s.y_end ?? ys;
        // Overlap check
        return ye > band.y_start && ys < band.y_end;
      });
    });

    const uncoveredBands = meaningfulBands.filter((b) => !coveredBands.includes(b));
    if (uncoveredBands.length > 0) {
      log("warn", "Some meaningful bands not covered by Stage 1 sections", {
        requestId: req.id,
        uncoveredCount: uncoveredBands.length,
        examples: uncoveredBands.slice(0, 5).map((b) => ({
          y: `${b.y_start}-${b.y_end}`,
          hex: b.bg_hex,
          height: b.height,
        })),
      });
    }

    // Expose band data + palette to Stage 2 (read-only reference)
    designSpec._band_map = allBands.map((b) => ({
      idx: b.globalIndex,
      y: [b.y_start, b.y_end],
      h: b.height,
      bg: b.bg_hex,
    }));
    designSpec._palette = palette.map((p) => p.hex);
    designSpec._uncovered_band_count = uncoveredBands.length;

    log("info", "Stage 1 complete (v5.0.0)", {
      requestId: req.id,
      stage1DurationMs: Date.now() - stage1StartTime,
      sectionCount: sections.length,
      bandCount: allBands.length,
      paletteSize: palette.length,
      meaningfulBands: meaningfulBands.length,
      coveredBands: coveredBands.length,
      uncoveredBands: uncoveredBands.length,
      textExtractionMethod,
    });


    // =================================================================
    // STAGE 2 — Code Generation (JSON spec + URLs → HTML)
    // Send the design spec + image URL map + developer overrides
    // to Claude with STAGE2_PROMPT. No PDF images sent.
    // =================================================================

    // --- Build developer specs (same logic as before, but now for Stage 2) ---
    const specs = [];

    // Width — developer override wins, then fall back to Stage 1 detection
    const finalWidth = emailWidth || designSpec?.width || 600;
    const breakpoint = finalWidth - 1;
    specs.push(`EMAIL WIDTH: Use exactly ${finalWidth}px for em_main_table and em_wrapper. Set table-layout:fixed. The primary responsive breakpoint is max-width: ${breakpoint}px.`);

    // Fonts — developer override wins, then fall back to Stage 1 detection
    const finalFont = primaryFont || designSpec?.font_body || "Arial";
    const finalSecondaryFont = secondaryFont || designSpec?.font_heading;
    const fontStack = (finalSecondaryFont && finalSecondaryFont !== finalFont)
      ? `'${finalFont}', '${finalSecondaryFont}', Arial, sans-serif`
      : `'${finalFont}', Arial, sans-serif`;

    const systemFonts = ["arial", "helvetica", "times new roman", "georgia", "verdana", "courier new", "tahoma", "trebuchet ms", "calibri"];
    const needsGoogleFont = !systemFonts.includes(finalFont.toLowerCase());

    if (needsGoogleFont) {
      specs.push(`FONT: Load '${finalFont}' via Google Fonts inside <!--[if !mso]><!--><style>@import url('https://fonts.googleapis.com/css2?family=${encodeURIComponent(finalFont)}:wght@100..900&display=swap');</style><!--<![endif]-->. Use font-family: ${fontStack} for ALL text elements throughout the email. NEVER fall back to just 'Arial, sans-serif' — the loaded font MUST be the primary in every font-family declaration.`);
    } else {
      specs.push(`FONT: Use font-family: ${fontStack} for all text elements. No Google Font loading needed.`);
    }

    // ESP Platform
    if (espPlatform && espPlatform !== "none") {
      const espInstructions = {
        mailchimp: `ESP: This is a Mailchimp template. Use these merge tags:
- Title: *|MC:SUBJECT|*
- Preview text: *|MC_PREVIEW_TEXT|* inside a hidden span
- View online link: *|ARCHIVE|*
- Unsubscribe: *|UNSUB|*
- Add mc:edit attributes to all editable content cells (e.g., mc:edit="text_01", mc:edit="img_01")
- Wrap each major section in a <table mc:repeatable mc:variant="Section Name"> for modularity`,
        sfmc: `ESP: This is a Salesforce Marketing Cloud template. Use these merge tags:
- Title: %%=v(@subject)=%%
- View online link: %%view_email_url%%
- Unsubscribe: %%unsub_center_url%%
- Add <custom name="opencounter" type="tracking" /> before </body>`,
        hubspot: `ESP: This is a HubSpot template. Use these merge tags:
- Unsubscribe: {{ unsubscribe_link }}
- View online: {{ view_as_page_url }}
- Company name: {{ site_settings.company_name }}`,
        klaviyo: `ESP: This is a Klaviyo template. Use these merge tags:
- Unsubscribe: {% unsubscribe %}
- View online: {{ message.ViewInBrowserUrl }}
- Preview text: {{ message.PreviewText }}`,
      };
      if (espInstructions[espPlatform]) {
        specs.push(espInstructions[espPlatform]);
      }
    }

    // Dark Mode — developer override wins, then fall back to Stage 1 detection
    if (darkMode === true || darkMode === "true") {
      specs.push(`DARK MODE: Include dark mode support. Add @media (prefers-color-scheme: dark) rules with design-specific dark colors. Use em_dark, em_dark1, em_dark2, em_dark3 classes on sections that need dark background overrides. Use em_dm_txt_white / em_color1 on text that should be white in dark mode. Invert CTA colors in dark mode using .em_cta class.`);
    } else if (darkMode === false || darkMode === "false") {
      specs.push(`DARK MODE: Do NOT include any dark mode CSS. No prefers-color-scheme media query. No em_dark classes. The email does not need dark mode support.`);
    }

    // --- Build image URL reference for Stage 2 (v5.0.0) ---
    // In v5, image URLs are embedded in each section's content[].src by Stage 1.
    // This block is a BACKUP reference in case Stage 1 left any src empty.
    let imageSection = "";
    if (Object.keys(imageUrlMap).length > 0) {
      const imageDimensions = {};
      for (const img of images) {
        try {
          const meta = await sharp(img.buffer).metadata();
          imageDimensions[img.filename] = { width: meta.width, height: meta.height };
        } catch {
          imageDimensions[img.filename] = { width: 0, height: 0 };
        }
      }

      const imageListStr = Object.entries(imageUrlMap)
        .map(([filename, url]) => {
          const dims = imageDimensions[filename];
          return `${filename} (${dims?.width || "?"}x${dims?.height || "?"}px) -> ${url}`;
        })
        .join("\n");

      imageSection = `\n\n=== IMAGE ASSETS REFERENCE (backup — primary URLs are embedded in spec.content[].src) ===
${imageListStr}

NOTE: In v5.0.0 the Stage 1 analysis has already matched images and embedded the correct Dropbox URL in each section's content.src field. Use those embedded URLs directly. This list is only a reference — do NOT use it to substitute URLs that Stage 1 already matched.
=== END IMAGE ASSETS REFERENCE ===`;
    }

    // --- Assemble the Stage 2 user message ---
    const stage2UserPrompt = `Generate production-ready Mavlers-grade HTML email code from the following design specification. Output ONLY the HTML starting with <!DOCTYPE. No markdown. No explanation.

=== DESIGN SPECIFICATION (from Stage 1 analysis) ===
${JSON.stringify(designSpec, null, 2)}
=== END DESIGN SPECIFICATION ===

=== DEVELOPER-SPECIFIED VALUES (MANDATORY — these override the spec where they differ) ===
${specs.join("\n\n")}
=== END DEVELOPER SPECIFICATIONS ===${imageSection}`;

    // Stage 2: text-only content (no images sent)
    const stage2Content = [{ type: "text", text: stage2UserPrompt }];

    log("info", "Stage 2: Sending spec to Claude for HTML generation", {
      requestId: req.id,
      specSections: designSpec?.sections?.length || 0,
      imageUrls: Object.keys(imageUrlMap).length,
      devSpecs: specs.length,
      finalWidth,
      finalFont,
      espPlatform: espPlatform || "none",
      darkMode: darkMode ?? "auto",
      stage1DurationMs: Date.now() - stage1StartTime,
    });

    const stage2StartTime = Date.now();

    // v9.0.0: Engine routing — Claude Code bridge OR existing Anthropic API
    const requestedEngine = getRequestedEngine(req);
    log("info", "Stage 2: engine selection", { requestId: req.id, engine: requestedEngine });

    let html_raw;
    if (requestedEngine === "claude-code") {
      // ─── Claude Code path (uses Mac bridge, Max 20× subscription, $0/gen) ───
      try {
        // Best-effort: load reference HTML if available for this Figma file
        let referenceHtmlForCC = null;
        try {
          referenceHtmlForCC = await loadReferenceForFigmaFile(figmaFileKey);
        } catch { /* ignore */ }

        html_raw = await callClaudeCodeBridge({
          designSpec,
          referenceHtml: referenceHtmlForCC,
          designImageBase64: null, // TODO: pass Phase B render image
          model: req.body?.model || "sonnet",
          requestId: req.id,
          log,
        });
      } catch (err) {
        log("error", "Claude Code bridge failed; falling back to Anthropic API", {
          requestId: req.id,
          error: err.message,
        });
        // Automatic fallback to Anthropic API so the user still gets output
        const stage2Response = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 64000,
          system: [{ type: "text", text: STAGE2_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: stage2Content }],
        });
        const stage2TextBlock = stage2Response.content?.find((block) => block.type === "text");
        if (!stage2TextBlock?.text) {
          return res.status(502).json({
            error: "HTML generation failed (Claude Code AND Anthropic API both failed)",
            details: err.message,
            requestId: req.id,
          });
        }
        html_raw = stage2TextBlock.text;
      }
    } else {
      // ─── Original Anthropic API path (UNCHANGED from v8.1.1) ───
      const stage2Response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 64000,
        system: [{ type: "text", text: STAGE2_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: stage2Content }],
      });

      const stage2TextBlock = stage2Response.content?.find((block) => block.type === "text");
      if (!stage2TextBlock || !stage2TextBlock.text) {
        log("error", "Stage 2: Claude returned no text", {
          requestId: req.id,
          contentBlocks: stage2Response.content?.length || 0,
        });
        return res.status(502).json({
          error: "HTML generation failed",
          details: "Claude could not generate HTML from the design spec. Please try again.",
          requestId: req.id,
        });
      }

      html_raw = stage2TextBlock.text;
    }

    // --- Post-processing (v5.2.0): deterministic fix-ups ---
    // Log imageUrlMap state BEFORE post-process so we can see what's actually available
    log("info", "Pre-post-process state check", {
      requestId: req.id,
      imageUrlMapSize: Object.keys(imageUrlMap).length,
      imageUrlMapFilenames: Object.keys(imageUrlMap),
      paletteSize: (designSpec?._palette || []).length,
      htmlRawLength: html_raw.length,
      rawRelativePaths: (html_raw.match(/src="images\/[^"]+"/g) || []).length,
      rawDropboxUrls: (html_raw.match(/dl\.dropboxusercontent\.com/g) || []).length,
    });

    // Build a filename -> {w, h} map from the extracted images metadata.
    // Used by fixImageDimensions post-processor to clamp img widths to
    // min(PDF placeholder width, ZIP original width).
    const imageDimensionsMap = {};
    for (const img of images || []) {
      if (img.originalWidth && img.originalHeight) {
        imageDimensionsMap[img.filename] = {
          w: img.originalWidth,
          h: img.originalHeight,
        };
      }
    }

    const postProcessResult = postProcessHtml(html_raw, {
      imageUrlMap,
      palette: designSpec?._palette || [],
      bandMap: designSpec?._band_map || [],
      imageDimensionsMap,
      zipWasUploaded: !!assetsZipBase64,
      secondaryFont: secondaryFont || designSpec?.font_heading,
    });
    const html = postProcessResult.html;

    log("info", "Post-processing complete (v5.5.0)", {
      requestId: req.id,
      imageUrlsReplaced: postProcessResult.report.imageUrls.replaced,
      imageUrlsSequentialFallbacks: postProcessResult.report.imageUrls.sequentialFallbacks,
      imageUrlsUnmatched: postProcessResult.report.imageUrls.unmatched,
      googleFontLinkConvertFixes: postProcessResult.report.googleFontLinkConvert?.fixes,
      malformedImgFixes: postProcessResult.report.malformedImgFix?.fixes,
      secondaryFontStripFixes: postProcessResult.report.secondaryFontStrip?.fixes,
      stackedHeadingMergeFixes: postProcessResult.report.stackedHeadingMerge?.fixes,
      sectionColorsRebound: postProcessResult.report.rebindSectionColors?.rebound,
      sectionColorsChecked: postProcessResult.report.rebindSectionColors?.checked,
      nearWhiteNormalizedCount: postProcessResult.report.nearWhite.count,
      nearWhiteColors: postProcessResult.report.nearWhite.normalizedColors,
      alertBarWarmBgFixes: postProcessResult.report.alertBarWarmBg?.fixes,
      alertBarContrastFixes: postProcessResult.report.alertBar.fixes,
      accentBgTextFixes: postProcessResult.report.accentBgText?.fixes,
      universalContrastFixes: postProcessResult.report.universalContrast?.fixes,
      ctaContrastFixes: postProcessResult.report.ctaContrast?.fixes,
      fontStackQuoteFixes: postProcessResult.report.fontStackQuotes?.fixes,
      ocrCapitalIFixes: postProcessResult.report.ocrCapitalI?.fixes,
      inlineSvgDataUrlFixes: postProcessResult.report.inlineSvgDataUrl?.fixes,
      inlineSvgUlFixes: postProcessResult.report.inlineSvgDataUrl?.ulFixes,
      imageDimensionsFixed: postProcessResult.report.imageDimensions?.fixes,
      mergedSections: postProcessResult.report.mergedSections?.merges,
      activityFeedFixes: postProcessResult.report.activityFeed.fixes,
      thinBandsRemoved: postProcessResult.report.thinBands.removed,
      finalRelativePaths: (html.match(/src="images\/[^"]+"/g) || []).length,
      finalDropboxUrls: (html.match(/dl\.dropboxusercontent\.com/g) || []).length,
    });

    // Post-generation validation: count sections in HTML output vs spec
    // Gold-standard HTML uses <!-- Section_Name --> comments for each section
    const htmlSectionMatches = html.match(/<!-- [A-Za-z_0-9]+ -->/g) || [];
    // Filter out closing comments (<!-- // Section_Name -->)
    const htmlOpeningSections = htmlSectionMatches.filter(m => !m.includes("//"));
    const specSectionCount = designSpec?.sections?.length || 0;
    const bandCount = designSpec?.band_count || specSectionCount;

    const sectionCountMatch = htmlOpeningSections.length >= specSectionCount;
    const bandCountMatch = htmlOpeningSections.length >= bandCount;

    log("info", "Stage 2 complete: HTML generated", {
      requestId: req.id,
      stage2DurationMs: Date.now() - stage2StartTime,
      totalPipelineDurationMs: Date.now() - startTime,
      htmlLength: html.length,
      htmlSectionCount: htmlOpeningSections.length,
      specSectionCount,
      bandCount,
      sectionCountMatch,
      bandCountMatch,
    });

    if (!sectionCountMatch || !bandCountMatch) {
      log("warn", "SECTION COUNT MISMATCH — HTML has fewer sections than spec", {
        requestId: req.id,
        htmlSections: htmlOpeningSections.length,
        specSections: specSectionCount,
        bandCount,
        missingCount: Math.max(specSectionCount, bandCount) - htmlOpeningSections.length,
      });
    }

    // --- Step 6: Generate preview images ---
    const previewImages = await Promise.all(
      pngPages.map(async (page) => {
        const jpeg = await sharp(page.content)
          .jpeg({ quality: 75, mozjpeg: true })
          .toBuffer();
        return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      })
    );

    log("info", "Generation complete (two-stage pipeline)", {
      requestId: req.id,
      orderId,
      pageCount: pngPages.length,
      imageSource,
      imageCount: images.length,
      dropboxUrls: Object.keys(imageUrlMap).length,
      totalDurationMs: Date.now() - startTime,
      htmlLength: html.length,
      specSections: designSpec?.sections?.length || 0,
    });

    // --- Step 7: Ensure imageUrlMap is populated ---
    // Fallback: if imageUrlMap is empty but the HTML contains Dropbox URLs, extract them
    if (Object.keys(imageUrlMap).length === 0 && (html.includes("dl.dropboxusercontent.com") || html.includes("www.dropbox.com/scl"))) {
      log("warn", "imageUrlMap was empty but HTML contains Dropbox URLs — extracting from HTML", { requestId: req.id });
      
      // Match both dl.dropboxusercontent.com and www.dropbox.com URLs
      const urlRegex = /https:\/\/(?:dl\.dropboxusercontent\.com|www\.dropbox\.com)\/scl\/fi\/[^\s"'<>]+/g;
      const foundUrls = html.match(urlRegex) || [];
      
      for (const url of foundUrls) {
        try {
          // Extract filename from the URL path
          const urlObj = new URL(url);
          const filename = path.basename(urlObj.pathname);
          if (filename && !imageUrlMap[filename]) {
            // Ensure we store the dl.dropboxusercontent.com version
            let directUrl = url;
            if (directUrl.includes("www.dropbox.com")) {
              directUrl = directUrl.replace("www.dropbox.com", "dl.dropboxusercontent.com");
            }
            if (!directUrl.includes("raw=1") && !directUrl.includes("dl=1")) {
              directUrl = directUrl.replace("dl=0", "raw=1");
            }
            imageUrlMap[filename] = directUrl;
          }
        } catch {
          // Skip invalid URLs
        }
      }
      
      log("info", "Extracted imageUrlMap from HTML", {
        requestId: req.id,
        recoveredCount: Object.keys(imageUrlMap).length,
        filenames: Object.keys(imageUrlMap),
      });
      
      // Also fix the HTML to use dl.dropboxusercontent.com URLs
      if (html.includes("www.dropbox.com")) {
        log("info", "Fixing HTML to use dl.dropboxusercontent.com URLs", { requestId: req.id });
      }
    }

    log("info", "Sending response to frontend", {
      requestId: req.id,
      imageUrlMapKeys: Object.keys(imageUrlMap),
      imageUrlMapSize: Object.keys(imageUrlMap).length,
    });

    // --- Return response for preview ---
    res.json({
      html,
      orderId,
      pageCount: pngPages.length,
      pageImages: previewImages,
      imageUrlMap,
      imageSource,
      imageCount: images.length,
      designSpec,
      requestId: req.id,
    });

  } catch (err) {
    log("error", "Generation error", {
      requestId: req.id,
      error: err.message,
      errorBody: err.error ? JSON.stringify(err.error).substring(0, 2000) : "no error body",
      status: err.status,
      durationMs: Date.now() - startTime,
    });

    let userMessage = "An unexpected error occurred. Please try again.";
    let statusCode = 500;

    if (err.message?.includes("rasterization timed out")) {
      userMessage = "The PDF took too long to process. Try a smaller or simpler PDF.";
      statusCode = 504;
    } else if (err.message?.includes("Request timed out") || err.message?.includes("timed out")) {
      userMessage = "Claude took too long to generate the HTML. Try a PDF with fewer pages or simpler design.";
      statusCode = 504;
    } else if (err.status === 429) {
      userMessage = "Maveloper is currently overloaded. Please wait a minute and try again.";
      statusCode = 429;
    } else if (err.status === 401) {
      userMessage = "Backend configuration error. Please contact the Maveloper admin.";
      statusCode = 500;
    } else if (err.message?.includes("Invalid PDF") || err.message?.includes("PDF parsing")) {
      userMessage = "The uploaded file is not a valid PDF or is corrupted.";
      statusCode = 400;
    } else if (err.message?.includes("Not allowed by CORS")) {
      userMessage = "Request blocked by CORS policy.";
      statusCode = 403;
    } else if (err.message?.includes("ZIP")) {
      userMessage = err.message;
      statusCode = 400;
    }

    res.status(statusCode).json({
      error: "Generation failed",
      details: userMessage,
      requestId: req.id,
    });
  }
});

// =====================================================================
// POST /generate-from-figma — v6.1.0 (Phase B: auto image export)
// Accepts: { figmaUrl, emailWidth?, primaryFont?, secondaryFont?, espPlatform?, darkMode? }
// Returns: { html, orderId, pageImages, imageUrlMap, designSpec, figmaSource, requestId }
//
// Pipeline:
//   1. Parse Figma URL → fetch node tree from Figma REST API
//   2. Convert node tree to designSpec JSON (skips Stage 1 vision entirely)
//   3. Render every image node + the email frame via Figma /v1/images
//   4. Upload images to Dropbox; patch designSpec src fields with real URLs
//   5. Send populated designSpec to Stage 2 (existing prompt, unchanged)
//   6. Run post-processors (HTML hygiene; band-related rules are no-ops)
//   7. Return HTML + pageImages[0]=preview URL + imageUrlMap
//
// Phase B (v6.1.0) — image export is automatic:
//   - Every <img> in the generated HTML has a real Dropbox URL.
//   - The /approve endpoint's ZIP packaging picks up the images via
//     imageUrlMap (same path the PDF flow uses).
//   - Image export failures are NON-FATAL: if Figma /v1/images or
//     Dropbox upload fails, we degrade to empty src (Phase A behavior)
//     and surface the failure in imageExportReport.
// =====================================================================

// =====================================================================
// v9.1.0 — ASYNC JOB PATTERN
//
// PROBLEM:
//   Railway's HTTP request handler has a ~30s timeout. Claude Code
//   generations take 10-30 min. Lovable always sees "Generation failed"
//   even on success.
//
// SOLUTION:
//   /generate-from-figma-async — returns a jobId in <1s, runs generation
//     in background, writes result to Supabase maveloper_jobs table.
//   /job-status/:jobId — polls Supabase for status/result/error.
//
// IMPLEMENTATION:
//   The async endpoint reuses the existing synchronous /generate-from-figma
//   handler by passing it a "fake response object" that captures the
//   response body instead of writing it to a socket. The captured body is
//   then persisted to Supabase. This keeps the existing endpoint 100%
//   unchanged and reduces risk of regressions.
// =====================================================================

/**
 * Creates a fake Express response object that captures status code and JSON
 * body in memory instead of writing to a socket. Used internally to invoke
 * a synchronous Express handler from an async background worker.
 *
 * Returns an object with the same shape Express handlers expect:
 *   res.status(code).json(body)
 *   res.json(body)
 * After the handler completes, read result.statusCode and result.body.
 */
function createFakeResponse() {
  const result = { statusCode: 200, body: null, headersSent: false };
  const fakeRes = {
    status(code) {
      result.statusCode = code;
      return fakeRes;
    },
    json(body) {
      if (result.headersSent) return fakeRes;
      result.body = body;
      result.headersSent = true;
      return fakeRes;
    },
    send(body) {
      if (result.headersSent) return fakeRes;
      result.body = body;
      result.headersSent = true;
      return fakeRes;
    },
    set() { return fakeRes; },
    setHeader() { return fakeRes; },
    get headersSent() { return result.headersSent; },
  };
  return { res: fakeRes, result };
}

/**
 * Updates a maveloper_jobs row. Non-fatal: errors are logged but don't throw.
 * Reason: we never want a Supabase blip to crash the in-flight generation.
 */
async function updateJobStatus(jobId, fields, requestId) {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin
      .from("maveloper_jobs")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (e) {
    log("warn", "Failed to update job status (non-fatal)", {
      requestId,
      jobId,
      error: e.message,
    });
  }
}

app.post("/generate-from-figma", generateLimiter, optionalAuth, async (req, res) => {
  const startTime = Date.now();
  try {
    const { figmaUrl, emailWidth, primaryFont, secondaryFont, espPlatform, darkMode } = req.body;

    // --- Validate input ---
    if (!figmaUrl || typeof figmaUrl !== "string") {
      return res.status(400).json({
        error: "Missing figmaUrl",
        details: "Request body must include a figmaUrl field with a Figma share link.",
        requestId: req.id,
      });
    }

    if (!figmaConfigured) {
      return res.status(503).json({
        error: "Figma not configured",
        details: "FIGMA_API_TOKEN env var is not set on the backend. Contact the Maveloper admin.",
        requestId: req.id,
      });
    }

    log("info", "Figma generation starting", {
      requestId: req.id,
      figmaUrl: figmaUrl.split("?")[0], // strip query params for cleaner logs
      userId: req.user?.id ?? "anonymous",
      userEmail: req.user?.email ?? "anonymous",
    });

    // --- Stage 1 (Figma): parse URL → fetch → produce designSpec ---
    let figmaResult;
    try {
      figmaResult = await figmaToDesignSpec({
        figmaUrl,
        token: FIGMA_API_TOKEN,
        devOverrides: { emailWidth, primaryFont, secondaryFont },
      });
    } catch (figmaErr) {
      // Surface user-facing errors (bad URL, multi-frame ambiguity) as 400.
      // Network / token / API errors are 502.
      const msg = figmaErr.message || "";
      const isUserError =
        figmaErr.code === "MULTIPLE_EMAIL_FRAMES" ||
        /Figma URL|Figma frame|Figma node|email-shaped|email design frame|Right-click|Copy link/i.test(msg);
      log("warn", "Figma parse failed", {
        requestId: req.id,
        error: msg,
        code: figmaErr.code,
        userError: isUserError,
      });
      return res.status(isUserError ? 400 : 502).json({
        error:
          figmaErr.code === "MULTIPLE_EMAIL_FRAMES"
            ? "Multiple email frames in URL"
            : isUserError
            ? "Invalid Figma URL"
            : "Figma fetch failed",
        details: msg,
        candidates: figmaErr.candidates ?? undefined, // structured list for picker UI
        requestId: req.id,
      });
    }

    const { designSpec, imageRefs, fileName, sourceFrame, warnings, fileKey, nodeId, layoutMode } = figmaResult;

    // --- Extract Order ID from frame name (Mavlers convention: OF/OID + digits) ---
    const orderIdMatch = sourceFrame.name?.match(/(?:OID|OF)\d{8,}/i);
    const orderId = orderIdMatch ? orderIdMatch[0].toUpperCase() : `FIGMA-${Date.now()}`;

    log("info", "Figma parse complete", {
      requestId: req.id,
      orderId,
      fileName,
      frameName: sourceFrame.name,
      frameWidth: sourceFrame.width,
      sections: designSpec.sections.length,
      imageRefs: imageRefs.length,
      layoutMode,
      warnings,
    });

    // --- Build developer specs (mirrors PDF flow) ---
    const finalWidth = emailWidth || designSpec.width;
    const finalFont = primaryFont || designSpec.font_body;

    const specs = [];
    specs.push(`EMAIL_WIDTH: ${finalWidth}px`);
    specs.push(`PRIMARY_FONT: ${finalFont}`);
    if (secondaryFont) specs.push(`SECONDARY_FONT: ${secondaryFont}`);
    if (espPlatform && espPlatform !== "none") specs.push(`ESP_PLATFORM: ${espPlatform}`);
    if (darkMode === true) specs.push(`DARK_MODE: true (force dark mode CSS)`);
    if (darkMode === false) specs.push(`DARK_MODE: false (skip dark mode CSS)`);

    // --- v6.2.0 Phase B: render & export images from Figma to Dropbox ---
    // For every image node the parser found (inline images, section bg_images,
    // and atomic visual units like icons/logos/decorative graphics), render
    // via Figma /v1/images, download the PNG, upload to Dropbox, and patch
    // the designSpec's src fields so Stage 2 sees real URLs. Also render
    // the parent email frame for the side-by-side preview pane.
    let imageUrlMap = {};
    let previewImageUrl = null;
    let previewBufferForStage2 = null;  // v6.6.0: held for Stage 2 visual input
    let imageExportReport = { rendered: 0, uploaded: 0, patched: 0, missing: 0, durationMs: 0, bgImageCount: 0 };
    const imageExportStartTime = Date.now();

    try {
      // Collect ALL nodeIds to render:
      // 1. Inline images from imageRefs (parser-emitted image elements)
      // 2. Section bg_images (v6.2.0 hero-with-overlay pattern)
      // 3. The email frame itself (for the preview pane)
      const inlineImageNodeIds = imageRefs.map((r) => r.nodeId);
      // v6.5.0: bg_image collection now also captures imageRef so we can
      // fetch the RAW (uncomposited) image instead of a frame render.
      // Without this fix, frames with image fill + text children render
      // as PNGs containing the text — which then duplicates when the HTML
      // overlay text is rendered on top of the bg ("double print" bug).
      const bgImageNodes = [];
      for (const s of designSpec.sections || []) {
        if (s.bg_image && s.bg_image._figmaNodeId) {
          bgImageNodes.push({
            nodeId: s.bg_image._figmaNodeId,
            imageRef: s.bg_image._imageRef,   // v6.5.0
            name: s.bg_image.alt || `section-${s.n}-bg`,
            width: s.bg_image.width,
            height: s.bg_image.height,
          });
        }
      }
      imageExportReport.bgImageCount = bgImageNodes.length;

      // v6.4.0: dedup imageRefs by renderKey before calling Figma.
      // Multiple INSTANCEs sharing a component master at the same size
      // render to identical PNGs — render once, reuse URL across all
      // instances. Cuts ~20% off Arsenal Pulse render count and avoids
      // duplicate Dropbox uploads.
      const renderKeyToNodeId = new Map();  // renderKey → first nodeId seen
      const nodeIdToRenderKey = new Map();  // nodeId → renderKey (for patching)
      for (const ref of imageRefs) {
        nodeIdToRenderKey.set(ref.nodeId, ref.renderKey);
        if (!renderKeyToNodeId.has(ref.renderKey)) {
          renderKeyToNodeId.set(ref.renderKey, ref.nodeId);
        }
      }
      const dedupedInlineIds = Array.from(renderKeyToNodeId.values());

      // Collect ALL nodeIds to render via /v1/images (inline + preview).
      // v6.5.0: bg_images NO LONGER go through /v1/images — they use raw
      // image-ref URLs via /v1/files/.../images to avoid double-print.
      const previewNodeId = sourceFrame.id;
      const allNodeIds = [
        ...dedupedInlineIds,
        ...(previewNodeId ? [previewNodeId] : []),
      ];

      if (allNodeIds.length > 0 || bgImageNodes.length > 0) {
        log("info", "Phase B: requesting Figma render", {
          requestId: req.id,
          inlineImagesTotal: imageRefs.length,
          inlineImagesUnique: dedupedInlineIds.length,
          dedupSavings: imageRefs.length - dedupedInlineIds.length,
          bgImages: bgImageNodes.length,
          includesPreview: Boolean(previewNodeId),
        });

        // Inline images + preview: composited renders via /v1/images
        const bufferMap = allNodeIds.length > 0
          ? await renderFigmaNodes({
              fileKey,
              nodeIds: allNodeIds,
              token: FIGMA_API_TOKEN,
              logFn: (level, msg, meta) => log(level, msg, { requestId: req.id, ...meta }),
            })
          : new Map();
        imageExportReport.rendered = bufferMap.size;

        // v6.5.0: Background images use RAW image-ref URLs (no compositing).
        // This prevents the "double print" bug where /v1/images bakes child
        // text into the bg PNG, then the HTML also renders the text on top.
        if (bgImageNodes.length > 0) {
          try {
            const refsNeeded = bgImageNodes.filter((b) => b.imageRef).map((b) => b.imageRef);
            if (refsNeeded.length > 0) {
              const rawUrlMap = await fetchRawImageRefUrls({ fileKey, token: FIGMA_API_TOKEN });
              for (const bg of bgImageNodes) {
                if (!bg.imageRef) continue;
                const signedUrl = rawUrlMap.get(bg.imageRef);
                if (!signedUrl) {
                  log("warn", "Phase B: no raw URL for imageRef", { requestId: req.id, imageRef: bg.imageRef });
                  continue;
                }
                try {
                  const r = await fetch(signedUrl);
                  if (!r.ok) throw new Error(`HTTP ${r.status}`);
                  const buf = Buffer.from(await r.arrayBuffer());
                  bufferMap.set(bg.nodeId, buf);
                  imageExportReport.rendered++;
                } catch (downloadErr) {
                  log("warn", "Phase B: raw bg image download failed", {
                    requestId: req.id, imageRef: bg.imageRef, error: downloadErr.message,
                  });
                }
              }
            }
          } catch (rawErr) {
            log("warn", "Phase B: raw image-ref fetch failed, bg_images will be empty", {
              requestId: req.id, error: rawErr.message,
            });
          }
        }

        // Pull out the email frame preview separately
        const previewBuffer = previewNodeId ? bufferMap.get(previewNodeId) : null;
        if (previewNodeId) bufferMap.delete(previewNodeId);
        previewBufferForStage2 = previewBuffer; // v6.6.0: pass to Stage 2 as visual reference

        if (dropboxConfigured) {
          const takenFilenames = new Set();
          const nodeIdToFilename = new Map();
          const renderKeyToFilename = new Map(); // v6.4.0: share filename across renderKey
          const dropboxImages = [];

          // Inline images: one upload per unique renderKey, all sharing instances point to it
          for (const ref of imageRefs) {
            // Use existing filename if another instance with same renderKey was processed
            const existingFilename = renderKeyToFilename.get(ref.renderKey);
            if (existingFilename) {
              nodeIdToFilename.set(ref.nodeId, existingFilename);
              continue;
            }
            // First time seeing this renderKey — render & upload
            const buf = bufferMap.get(ref.nodeId);
            if (!buf) continue;
            const filename = makeFilename(ref.name, ref.width, ref.height, takenFilenames);
            renderKeyToFilename.set(ref.renderKey, filename);
            nodeIdToFilename.set(ref.nodeId, filename);
            dropboxImages.push({ filename, buffer: buf });
          }
          // Background images (no dedup — heroes are typically unique)
          for (const bg of bgImageNodes) {
            if (nodeIdToFilename.has(bg.nodeId)) continue;
            const buf = bufferMap.get(bg.nodeId);
            if (!buf) continue;
            const filename = makeFilename(`bg-${bg.name}`, bg.width, bg.height, takenFilenames);
            nodeIdToFilename.set(bg.nodeId, filename);
            dropboxImages.push({ filename, buffer: buf });
          }

          if (dropboxImages.length > 0) {
            imageUrlMap = await uploadImagesToDropbox(orderId, dropboxImages, log);
            imageExportReport.uploaded = Object.keys(imageUrlMap).length;
          }

          // Patch designSpec — covers both content[].src and section.bg_image.src
          const patchReport = patchSpecImageSrcs(designSpec, nodeIdToFilename, imageUrlMap);
          imageExportReport.patched = patchReport.patched;
          imageExportReport.missing = patchReport.missing;

          // Upload the preview frame
          if (previewBuffer) {
            try {
              const previewPath = `${getDropboxFolderPath(orderId)}/preview.png`;
              const { directUrl } = await uploadToDropbox(previewPath, previewBuffer);
              previewImageUrl = directUrl;
            } catch (previewErr) {
              log("warn", "Phase B: preview upload failed (non-fatal)", {
                requestId: req.id,
                error: previewErr.message,
              });
            }
          }
        } else {
          log("warn", "Phase B: Dropbox not configured; image src will be empty", { requestId: req.id });
          for (const s of designSpec.sections) {
            for (const c of s.content) delete c._figmaNodeId;
            if (s.bg_image) delete s.bg_image._figmaNodeId;
          }
        }
      } else {
        for (const s of designSpec.sections) {
          for (const c of s.content) delete c._figmaNodeId;
          if (s.bg_image) delete s.bg_image._figmaNodeId;
        }
      }

      imageExportReport.durationMs = Date.now() - imageExportStartTime;
      log("info", "Phase B: image export complete", { requestId: req.id, ...imageExportReport });
    } catch (imgErr) {
      log("error", "Phase B: image export failed, degrading to empty src", {
        requestId: req.id,
        error: imgErr.message,
      });
      imageUrlMap = {};
      for (const s of designSpec.sections) {
        for (const c of s.content) delete c._figmaNodeId;
        if (s.bg_image) delete s.bg_image._figmaNodeId;
      }
    }

    // Build the image section for the Stage 2 prompt
    const imageUrlList = Object.entries(imageUrlMap)
      .map(([fn, url]) => `- ${fn} → ${url}`)
      .join("\n");
    const imageSection = imageUrlList
      ? `

=== IMAGE ASSETS REFERENCE ===
The following images have been uploaded to Dropbox. Each image element in the spec already has a populated src field; sections with image backgrounds have a populated bg_image.src field. Use those URLs verbatim — do NOT alter or invent image paths.

When a section has a "bg_image" object, render it as the section's background using table[background="URL"] + VML <v:image> for Outlook compatibility. Place the section's text/CTA content on top of the background. Do NOT emit an inline <img> for bg_image — it IS the section background.

${imageUrlList}
=== END IMAGE ASSETS REFERENCE ===`
      : `

=== IMAGE ASSETS REFERENCE ===
No images were exported for this email. Leave src="" on each <img> tag.
=== END IMAGE ASSETS REFERENCE ===`;

    // --- Stage 2 invocation ---
    // v6.6.0: Stage 2 now receives the rendered Figma frame as a visual
    // reference IMAGE input alongside the JSON spec. Claude sees what the
    // email should look like while writing the HTML — like a human dev
    // referencing the design while coding. This is intended to help with
    // layout decisions (grids vs stacks, side-by-side vs vertical) that
    // the JSON spec alone can't fully convey.
    const hasVisualReference = Boolean(previewBufferForStage2);
    const visualReferenceInstructions = hasVisualReference
      ? `

=== VISUAL REFERENCE (FIGMA RENDER) ===
An image of the source Figma design is attached. Use it to understand LAYOUT and STRUCTURE:
- Multi-column layouts (e.g., 2-column profile sections, 3×2 candidate card grids)
- Horizontal vs vertical arrangement of related elements
- Side-by-side CTA banners vs stacked CTA blocks
- Capsule/pill styling on tags, labels, status badges
- Card grouping and spacing rhythm
- Section dividers and visual separators

CRITICAL RULES:
1. The JSON spec is the AUTHORITATIVE source for ALL TEXT CONTENT. Use spec text verbatim — never transcribe text from the image.
2. The JSON spec is the AUTHORITATIVE source for COLORS, IMAGE URLs, FONT SIZES, and explicit dimensions.
3. The IMAGE is the AUTHORITATIVE source for LAYOUT STRUCTURE — column counts, element grouping, horizontal vs vertical arrangement.
4. When the spec is ambiguous about layout (e.g., 6 cards in a row — grid or list?), the image resolves it.
5. Match the image's layout structure precisely. If the image shows 3×2 grid, output a 3×2 grid. If side-by-side CTA, output side-by-side. Do NOT default to vertical stacking.
=== END VISUAL REFERENCE ===`
      : "";

    // v8.0.0: Reference HTML injection — when a human-coded reference exists
    // for this Figma file, embed it as a few-shot example so Stage 2 learns
    // the exact Mavlers visual patterns (capsule borders, vertical-line ticker
    // dividers, bordered card containers, red status indicators, two-column
    // profile blocks, side-by-side CTA layouts).
    const referenceHtml = REFERENCE_CACHE.get(fileKey);
    const referenceSection = referenceHtml
      ? `

=== HUMAN-CODED REFERENCE EXAMPLE ===
A senior Mavlers email developer has hand-coded the FINAL VERSION of this exact email design. Their HTML output is provided below as a GOLD-STANDARD REFERENCE for the QUALITY LEVEL and STYLISTIC PATTERNS you must match.

YOUR HTML OUTPUT MUST MATCH THIS REFERENCE in the following dimensions:

1. CARD STYLING
   - Bordered card containers (border: 1px solid + background-color)
   - Capsule pills with border-radius:50px+ and visible 1px border
   - Card padding, internal spacing, corner radii — MATCH PRECISELY
   - NEVER add visible borders/outlines to elements that don't have them in the reference (e.g., candidate cards in the reference have NO red border outlines)

2. SECTION SEPARATORS & LABELS
   - Section labels like "01 THIS WEEK'S OUTLIERS" use a horizontal-row layout: number left, divider line middle, label right (NOT collapsed together)
   - Ticker bars use THIN VERTICAL LINE dividers between items (1px wide), NOT bullet dots (•)
   - Stats rows sit inside a bordered horizontal strip with vertical line dividers between each stat

3. COLOR USAGE
   - "CANDIDATE STATUS" labels are RED (#FF2323 or similar bright red), not grey
   - Status indicator dots (small red circles) appear inside pills like "ACTIVELY EXPLORING"
   - Red CTAs use the exact red from the reference

4. LAYOUT PATTERNS
   - "Interested in exploring further?" sits side-by-side with a RED SQUARE CARD containing the REQUEST INTRO button + arrow — NOT a standalone button
   - Profile Overview + Operating Impact sit inside ONE bordered card container with two columns inside it — NOT two separate floating columns
   - Footer mail/web icons are rendered as small images (or icon-font), not Unicode characters

5. TYPOGRAPHY
   - Hero text mixes font WEIGHTS within a heading: e.g., "The" thin + "Outliers" thick
   - Eyebrow labels (CANDIDATE INTELLIGENCE REPORT, PROFILE OVERVIEW) use uniform letter-spacing

6. CONTENT COMPLETENESS
   - If the reference has 6 ticker items, your output has 6 ticker items — do not drop "Precision Over Volume" or any other item

CRITICAL RULES FOR USING THE REFERENCE:
- The reference's TEXT CONTENT may differ from your spec — IGNORE the reference's text. Your text comes from the JSON SPEC ONLY.
- The reference's IMAGE URLs are NOT yours — use the image URLs from the spec ONLY.
- COPY the reference's CSS PATTERNS (border styles, padding values, color usage, layout structure) but APPLY THEM to YOUR SPEC's content.
- This is a stylistic reference for HOW to lay out Mavlers emails, not WHAT content to include.

=== REFERENCE HTML (copy patterns, NOT content) ===
${referenceHtml}
=== END HUMAN-CODED REFERENCE EXAMPLE ===`
      : "";

    const stage2UserPrompt = `Generate production-ready Mavlers-grade HTML email code from the following design specification and visual reference. Output ONLY the HTML starting with <!DOCTYPE. No markdown. No explanation.

=== DESIGN SPECIFICATION (from Figma parser) ===
${JSON.stringify(designSpec, null, 2)}
=== END DESIGN SPECIFICATION ===

=== DEVELOPER-SPECIFIED VALUES (MANDATORY — these override the spec where they differ) ===
${specs.join("\n\n")}
=== END DEVELOPER SPECIFICATIONS ===${imageSection}${visualReferenceInstructions}${referenceSection}`;

    const stage2StartTime = Date.now();

    // v6.6.0: build the user content array — image first (Anthropic best
    // practice for multimodal attention), then text. If no preview buffer
    // is available (Figma image render failed), fall back to text-only.
    const userContent = [];
    if (hasVisualReference) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: previewBufferForStage2.toString("base64"),
        },
      });
    }
    userContent.push({ type: "text", text: stage2UserPrompt });

    // v9.0.2: Engine routing — Claude Code bridge OR existing Anthropic API.
    // This branch was previously only wired into the PDF /generate endpoint;
    // the Figma path always hit Anthropic directly. Now both endpoints honor
    // X-AI-Engine header / aiEngine body field / AI_ENGINE_DEFAULT env var.
    const requestedEngine = getRequestedEngine(req);

    log("info", "Stage 2: Sending Figma spec to Claude", {
      requestId: req.id,
      engine: requestedEngine,
      specSections: designSpec.sections.length,
      imageRefs: imageRefs.length,
      devSpecs: specs.length,
      finalWidth,
      finalFont,
      espPlatform: espPlatform || "none",
      darkMode: darkMode ?? "auto",
      hasVisualReference,                            // v6.6.0
      previewBytesKB: previewBufferForStage2 ? Math.round(previewBufferForStage2.length / 1024) : 0,
      hasReferenceHtml: Boolean(referenceHtml),      // v8.0.0
      referenceHtmlKB: referenceHtml ? Math.round(referenceHtml.length / 1024) : 0,
    });

    let html_raw;
    let engineUsed = requestedEngine;

    if (requestedEngine === "claude-code") {
      // ─── Claude Code path (Mac bridge, Max 20× subscription) ───
      try {
        const designImageBase64ForCC = previewBufferForStage2
          ? previewBufferForStage2.toString("base64")
          : null;

        html_raw = await callClaudeCodeBridge({
          designSpec,
          referenceHtml: referenceHtml || null,
          designImageBase64: designImageBase64ForCC,
          model: req.body?.model || "sonnet",
          requestId: req.id,
          log,
        });
      } catch (err) {
        // v9.0.3: AI_ENGINE_NO_FALLBACK protects against silent Anthropic billing
        // when the bridge is misconfigured or under repair. Set this env var to
        // "true" on Railway during Claude Code testing so failures surface to the
        // client as 502s instead of triggering an expensive Anthropic fallback
        // (a single Stage 2 Sonnet 4-6 call costs ~$2 in tokens).
        const noFallback = process.env.AI_ENGINE_NO_FALLBACK === "true";

        if (noFallback) {
          log("error", "Claude Code bridge failed; fallback DISABLED (AI_ENGINE_NO_FALLBACK=true)", {
            requestId: req.id,
            error: err.message,
          });
          return res.status(502).json({
            error: "Claude Code bridge failed and automatic fallback is disabled.",
            details: err.message,
            requestId: req.id,
            engineUsed: "claude-code-failed-no-fallback",
            hint: "Either fix the bridge (check ngrok + cc-runner.mjs) or unset AI_ENGINE_NO_FALLBACK on Railway to re-enable Anthropic fallback.",
          });
        }

        log("error", "Claude Code bridge failed; falling back to Anthropic API", {
          requestId: req.id,
          error: err.message,
        });
        engineUsed = "console-fallback";
        // Automatic fallback to Anthropic API so the user still gets output.
        const stage2Response = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 64000,
          system: [{ type: "text", text: STAGE2_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: userContent }],
        });
        const stage2TextBlock = stage2Response.content?.find((b) => b.type === "text");
        if (!stage2TextBlock?.text) {
          return res.status(502).json({
            error: "HTML generation failed (Claude Code AND Anthropic API both failed)",
            details: err.message,
            requestId: req.id,
          });
        }
        html_raw = stage2TextBlock.text;
      }
    } else {
      // ─── Original Anthropic API path (UNCHANGED from v8.1.1) ───
      const stage2Response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 64000,
        system: [{ type: "text", text: STAGE2_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent }],
      });

      const stage2TextBlock = stage2Response.content?.find((b) => b.type === "text");
      if (!stage2TextBlock || !stage2TextBlock.text) {
        log("error", "Stage 2 (Figma): Claude returned no text", {
          requestId: req.id,
          contentBlocks: stage2Response.content?.length || 0,
        });
        return res.status(502).json({
          error: "HTML generation failed",
          details: "Claude could not generate HTML from the Figma spec. Please try again.",
          requestId: req.id,
        });
      }

      html_raw = stage2TextBlock.text;
    }

    // --- Post-processing: most rules are no-ops on Figma path, but HTML
    //     hygiene rules (font stacks, malformed self-closing img, Google
    //     Fonts link conversion) still apply.
    const postProcessResult = postProcessHtml(html_raw, {
      imageUrlMap,
      palette: designSpec._palette || [],
      bandMap: [], // Figma path has no band map
      imageDimensionsMap: {}, // Phase A: no dimension data without exporting
      zipWasUploaded: false,
      secondaryFont: secondaryFont || designSpec.font_heading,
    });
    const html = postProcessResult.html;

    log("info", "Figma generation complete", {
      requestId: req.id,
      orderId,
      engineUsed,                                              // v9.0.2: definitive engine record
      stage2DurationMs: Date.now() - stage2StartTime,
      totalPipelineDurationMs: Date.now() - startTime,
      htmlLength: html.length,
      specSections: designSpec.sections.length,
      googleFontLinkConvertFixes: postProcessResult.report.googleFontLinkConvert?.fixes,
      malformedImgFixes: postProcessResult.report.malformedImgFix?.fixes,
      fontStackQuoteFixes: postProcessResult.report.fontStackQuotes?.fixes,
      secondaryFontStripFixes: postProcessResult.report.secondaryFontStrip?.fixes,
    });

    // --- Return response ---
    res.json({
      html,
      orderId,
      pageCount: 1, // Figma has no pages concept — single frame in, single HTML out
      pageImages: previewImageUrl ? [previewImageUrl] : [], // v6.1.0: side-by-side preview
      imageUrlMap,
      imageSource: "figma",
      imageCount: Object.keys(imageUrlMap).length,
      imageExportReport,                                    // v6.1.0: visibility into export status
      model: CLAUDE_MODEL,                                  // v7.0.0: diagnostic — which Claude model produced this
      engineUsed,                                           // v9.0.2: "claude-code" | "console" | "console-fallback"
      referenceHtmlUsed: Boolean(REFERENCE_CACHE.get(fileKey)), // v8.0.0: was a human-coded reference injected
      figmaSource: {
        fileKey,
        nodeId,
        fileName,
        frameName: sourceFrame.name,
        frameWidth: sourceFrame.width,
        layoutMode,
      },
      designSpec,
      warnings,
      requestId: req.id,
    });
  } catch (err) {
    log("error", "Figma generation error", {
      requestId: req.id,
      error: err.message,
      errorBody: err.error ? JSON.stringify(err.error).substring(0, 2000) : "no error body",
      status: err.status,
      durationMs: Date.now() - startTime,
    });

    let userMessage = "An unexpected error occurred. Please try again.";
    let statusCode = 500;

    if (err.message?.includes("timed out") || err.message?.includes("timeout")) {
      userMessage = "Figma API or Claude took too long. Try again.";
      statusCode = 504;
    } else if (err.status === 429) {
      userMessage = "Maveloper is currently overloaded. Please wait a minute and try again.";
      statusCode = 429;
    } else if (err.status === 401) {
      userMessage = "Backend configuration error. Please contact the Maveloper admin.";
      statusCode = 500;
    } else if (err.message?.includes("Not allowed by CORS")) {
      userMessage = "Request blocked by CORS policy.";
      statusCode = 403;
    }

    res.status(statusCode).json({
      error: "Figma generation failed",
      details: userMessage,
      requestId: req.id,
    });
  }
});

// =====================================================================
// v9.1.0 — POST /generate-from-figma-async
//
// Async wrapper around /generate-from-figma. Returns a jobId immediately
// (<1s). Generation runs in background; result is stored in Supabase
// maveloper_jobs table for Lovable to poll via /job-status/:jobId.
//
// Request body: same shape as /generate-from-figma plus optional fields.
//   { figmaUrl, emailWidth?, primaryFont?, secondaryFont?, espPlatform?, darkMode? }
//
// Response (immediate, ~1s):
//   { jobId, status: "pending", requestId }
//
// Background worker writes one of these final states to Supabase:
//   status="completed", result_html=<string>, engine_used=<string>
//   status="failed", error_message=<string>
// =====================================================================
app.post("/generate-from-figma-async", generateLimiter, optionalAuth, async (req, res) => {
  try {
    const { figmaUrl } = req.body;

    if (!figmaUrl || typeof figmaUrl !== "string") {
      return res.status(400).json({
        error: "Missing figmaUrl",
        details: "Request body must include a figmaUrl field with a Figma share link.",
        requestId: req.id,
      });
    }

    if (!supabaseAdmin) {
      return res.status(503).json({
        error: "Async generation unavailable",
        details: "Supabase is not configured on the backend. The async job table is required.",
        requestId: req.id,
      });
    }

    // Create the job row immediately. We need the jobId before returning to Lovable.
    const { data: job, error: insertErr } = await supabaseAdmin
      .from("maveloper_jobs")
      .insert({
        status: "pending",
        figma_url: figmaUrl,
        progress_message: "Job created; waiting to start",
      })
      .select("id")
      .single();

    if (insertErr || !job) {
      log("error", "Failed to create maveloper_jobs row", {
        requestId: req.id,
        error: insertErr?.message,
      });
      return res.status(500).json({
        error: "Failed to create job",
        details: "Could not initialize the async generation job in Supabase.",
        requestId: req.id,
      });
    }

    const jobId = job.id;

    log("info", "Async Figma generation started", {
      requestId: req.id,
      jobId,
      figmaUrl: figmaUrl.split("?")[0],
      userId: req.user?.id ?? "anonymous",
    });

    // Return jobId immediately. Lovable starts polling /job-status/:jobId.
    res.status(202).json({
      jobId,
      status: "pending",
      requestId: req.id,
    });

    // ──────────────────────────────────────────────────────────────
    // Background work — runs after res.json() returns to the client.
    // setImmediate ensures Node finishes flushing the response before
    // we start the long-running task.
    // ──────────────────────────────────────────────────────────────
    setImmediate(async () => {
      const bgStartTime = Date.now();
      try {
        await updateJobStatus(jobId, {
          status: "running",
          progress_message: "Generation started; calling /generate-from-figma handler internally",
        }, req.id);

        // Build a fake request mirroring the real one. The existing
        // /generate-from-figma handler will read req.body and req.id from it.
        const fakeReq = {
          body: req.body,
          id: req.id,
          user: req.user,
          headers: req.headers || {},
          get: (h) => (req.headers ? req.headers[h.toLowerCase()] : undefined),
        };

        // Build a fake response object that captures status + body in memory.
        const { res: fakeRes, result } = createFakeResponse();

        // Invoke the synchronous handler. It will populate `result.body`
        // when it finishes (success or error). This call can take 10-30 min.
        // We DELIBERATELY do not await any Railway HTTP timeout here — the
        // outer endpoint has already returned to the client.
        const handlerEntry = app._router?.stack?.find((layer) =>
          layer.route?.path === "/generate-from-figma" && layer.route?.methods?.post
        );

        if (!handlerEntry || !handlerEntry.route) {
          throw new Error("/generate-from-figma route not found in Express router");
        }

        // The route's handler stack includes generateLimiter and optionalAuth
        // before the actual handler. For the internal call we skip those —
        // the user has already passed them on the async endpoint. Find the
        // last handler in the route's stack (the actual generation handler).
        const handlerStack = handlerEntry.route.stack;
        const actualHandler = handlerStack[handlerStack.length - 1].handle;

        await actualHandler(fakeReq, fakeRes, (err) => {
          // Express "next" — only called on error inside the handler.
          if (err) throw err;
        });

        // Handler completed. Inspect result.
        const durationSec = Math.round((Date.now() - bgStartTime) / 1000);

        if (result.statusCode >= 200 && result.statusCode < 300 && result.body?.html) {
          // SUCCESS
          await updateJobStatus(jobId, {
            status: "completed",
            result_html: result.body.html,
            engine_used: result.body.engineUsed ?? null,
            progress_message: `Generation complete in ${durationSec}s`,
            completed_at: new Date().toISOString(),
          }, req.id);
          log("info", "Async job completed", { requestId: req.id, jobId, durationSec });
        } else {
          // FAILURE — handler set non-2xx status or no html
          const errMsg = result.body?.error
            ? `${result.body.error}: ${result.body.details ?? ""}`.trim()
            : `Handler returned status ${result.statusCode} with no html`;
          await updateJobStatus(jobId, {
            status: "failed",
            error_message: errMsg.substring(0, 2000),
            completed_at: new Date().toISOString(),
          }, req.id);
          log("warn", "Async job failed", {
            requestId: req.id,
            jobId,
            statusCode: result.statusCode,
            error: errMsg,
            durationSec,
          });
        }
      } catch (bgErr) {
        const durationSec = Math.round((Date.now() - bgStartTime) / 1000);
        log("error", "Async job crashed", {
          requestId: req.id,
          jobId,
          error: bgErr.message,
          stack: bgErr.stack?.substring(0, 1000),
          durationSec,
        });
        await updateJobStatus(jobId, {
          status: "failed",
          error_message: `Internal error: ${bgErr.message}`.substring(0, 2000),
          completed_at: new Date().toISOString(),
        }, req.id);
      }
    });
  } catch (err) {
    log("error", "Async endpoint setup error", {
      requestId: req.id,
      error: err.message,
    });
    res.status(500).json({
      error: "Failed to start async generation",
      details: err.message,
      requestId: req.id,
    });
  }
});

// =====================================================================
// v9.1.0 — GET /job-status/:jobId
//
// Returns the current status of an async generation job.
//
// Response shapes by status:
//   pending:   { status: "pending", progress_message }
//   running:   { status: "running", progress_message }
//   completed: { status: "completed", html, engineUsed, completedAt }
//   failed:    { status: "failed", error, completedAt }
// =====================================================================
app.get("/job-status/:jobId", optionalAuth, async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
      return res.status(400).json({
        error: "Invalid jobId format",
        details: "jobId must be a UUID.",
        requestId: req.id,
      });
    }

    if (!supabaseAdmin) {
      return res.status(503).json({
        error: "Async generation unavailable",
        details: "Supabase is not configured on the backend.",
        requestId: req.id,
      });
    }

    const { data: job, error } = await supabaseAdmin
      .from("maveloper_jobs")
      .select("id, status, progress_message, result_html, error_message, engine_used, created_at, updated_at, completed_at")
      .eq("id", jobId)
      .single();

    if (error || !job) {
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with id ${jobId}.`,
        requestId: req.id,
      });
    }

    const baseResponse = {
      jobId: job.id,
      status: job.status,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      requestId: req.id,
    };

    if (job.status === "completed") {
      return res.json({
        ...baseResponse,
        html: job.result_html,
        engineUsed: job.engine_used,
        completedAt: job.completed_at,
      });
    }

    if (job.status === "failed") {
      return res.json({
        ...baseResponse,
        error: job.error_message,
        completedAt: job.completed_at,
      });
    }

    // pending or running
    return res.json({
      ...baseResponse,
      progressMessage: job.progress_message,
    });
  } catch (err) {
    log("error", "Job-status endpoint error", {
      requestId: req.id,
      error: err.message,
    });
    res.status(500).json({
      error: "Failed to fetch job status",
      details: err.message,
      requestId: req.id,
    });
  }
});

// -----------------------------------------------------------------
// POST /approve — Package ZIP and upload to Dropbox
// Called after dev reviews preview and clicks "Approve & Upload"
// Accepts: { orderId, html, imageUrlMap, images? }
// Returns: { dropboxUrl, orderId, requestId }
// -----------------------------------------------------------------
app.post("/approve", generateLimiter, optionalAuth, async (req, res) => {
  const startTime = Date.now();
  try {
    const { orderId, html, imageUrlMap } = req.body;

    if (!orderId || !html) {
      return res.status(400).json({
        error: "Missing required fields",
        details: "Request must include orderId and html.",
        requestId: req.id,
      });
    }

    if (!dropboxConfigured) {
      return res.status(503).json({
        error: "Dropbox not configured",
        details: "Dropbox credentials are not set. Contact the Maveloper admin.",
        requestId: req.id,
      });
    }

    if (!imageUrlMap || Object.keys(imageUrlMap).length === 0) {
      log("warn", "No imageUrlMap provided to /approve — building ZIP with HTML only", { requestId: req.id, orderId });
    }

    log("info", "Building delivery ZIP", { requestId: req.id, orderId });

    // v5.5.0: parallel image downloads with bounded concurrency + per-fetch
    // AbortController timeout. Sequential awaits previously caused the ZIP step
    // to drag past Anthropic timeout on emails with 20+ images.
    const images = [];
    if (imageUrlMap && Object.keys(imageUrlMap).length > 0) {
      const entries = Object.entries(imageUrlMap);
      const downloaded = await mapWithConcurrency(entries, IMAGE_DOWNLOAD_CONCURRENCY, async ([filename, url]) => {
        try {
          const response = await fetchWithTimeout(url, IMAGE_DOWNLOAD_TIMEOUT_MS);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            return { filename, buffer: Buffer.from(arrayBuffer) };
          }
          log("warn", `Failed to download image: ${filename}`, {
            requestId: req.id,
            status: response.status,
            url: redactUrl(url),
          });
        } catch (dlErr) {
          log("warn", `Failed to download image: ${filename}`, {
            requestId: req.id,
            error: dlErr.message,
            aborted: dlErr.name === "AbortError",
            url: redactUrl(url),
          });
        }
        return null;
      });
      for (const item of downloaded) {
        if (item) images.push(item);
      }
    }

    // Build ZIP
    const zipBuffer = buildDeliveryZip(orderId, html, imageUrlMap, images);

    log("info", "ZIP built", {
      requestId: req.id,
      orderId,
      zipSizeKB: Math.round(zipBuffer.length / 1024),
      imageCount: images.length,
    });

    // Upload ZIP to Dropbox
    const dropboxUrl = await uploadZipToDropbox(orderId, zipBuffer, log);

    log("info", "ZIP uploaded to Dropbox", {
      requestId: req.id,
      orderId,
      durationMs: Date.now() - startTime,
    });

    res.json({
      dropboxUrl,
      orderId,
      zipSizeKB: Math.round(zipBuffer.length / 1024),
      requestId: req.id,
    });

  } catch (err) {
    log("error", "Approve/upload error", {
      requestId: req.id,
      error: err.message,
      durationMs: Date.now() - startTime,
    });

    res.status(500).json({
      error: "Upload failed",
      details: "Failed to package and upload to Dropbox. Please try again.",
      requestId: req.id,
    });
  }
});

// =====================================================================
// SERVER START + PROCESS HANDLERS
// =====================================================================
const server = app.listen(PORT, () => {
  log("info", `Maveloper backend running on port ${PORT}`, {
    model: CLAUDE_MODEL,
    framework: "master-v2",
    version: "9.1.0-async-preview",
    dropboxConfigured,
    figmaConfigured,
    rasterizeScale: RASTERIZE_SCALE,
  });
});

server.timeout = SERVER_TIMEOUT_MS;
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled rejection", { reason: String(reason) });
});

process.on("uncaughtException", (err) => {
  log("error", "Uncaught exception", { error: err.message, stack: err.stack });
  // v5.5.0: route through graceful shutdown instead of immediate exit so
  // in-flight requests (which may be holding large PDF/PNG buffers) get a
  // chance to finish before the pod is killed.
  shutdown("uncaughtException");
});

const shutdown = (signal) => {
  log("info", `${signal} received, shutting down gracefully`);
  server.close(() => {
    log("info", "HTTP server closed");
    process.exit(0);
  });
  // v5.5.0: 30s was too aggressive — Stage 2 alone can run for several minutes
  // with 32K max_tokens. Drain window must comfortably exceed
  // ANTHROPIC_TIMEOUT_MS for an in-flight Stage 2 to complete.
  setTimeout(() => {
    log("error", `Forced shutdown after ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s timeout`);
    process.exit(1);
  }, SHUTDOWN_DRAIN_TIMEOUT_MS).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
