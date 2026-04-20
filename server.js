import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pdfToPng } from "pdf-to-png-converter";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import AdmZip from "adm-zip";
import { Dropbox } from "dropbox";
import path from "path";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { detectBands, cropBand, extractAccentColors, postProcessOcr } from "./band-detector.js";

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

// =====================================================================
// CONFIGURATION
// =====================================================================
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
const MAX_PDF_BYTES = 5 * 1024 * 1024;        // 5 MB
const MAX_ZIP_BYTES = 25 * 1024 * 1024;        // 25 MB for image assets ZIP
const MAX_PAGES = 10;
const RASTERIZE_TIMEOUT_MS = 60 * 1000;
const ANTHROPIC_TIMEOUT_MS = 480 * 1000;   // 8 min — complex emails with 32K max_tokens need more time
const SERVER_TIMEOUT_MS = 600 * 1000;      // 10 min — must exceed Anthropic timeout + Dropbox upload time
const RASTERIZE_SCALE = 1.6;
const ALLOWED_IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

const ALLOWED_ORIGINS = [
  "https://maveloper.vercel.app",
  "https://maveloper.lovable.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

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
  const BATCH_SIZE = 3;

  logFn("info", `Uploading ${images.length} images to Dropbox (parallel, batch size ${BATCH_SIZE})`, { orderId });

  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const batch = images.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (img) => {
        const dropboxFilePath = `${folderPath}/images/${img.filename}`;
        const { directUrl, sharedUrl } = await uploadToDropbox(dropboxFilePath, img.buffer);
        logFn("info", `Dropbox URL for ${img.filename}`, { sharedUrl: sharedUrl?.substring(0, 80), directUrl: directUrl?.substring(0, 80) });
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
    logFn("info", `Retrying ${failedImages.length} failed uploads after 2s delay`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    for (const img of failedImages) {
      try {
        const dropboxFilePath = `${folderPath}/images/${img.filename}`;
        const { directUrl } = await uploadToDropbox(dropboxFilePath, img.buffer);
        imageUrlMap[img.filename] = directUrl;
        logFn("info", `Retry succeeded for ${img.filename}`);
      } catch (retryErr) {
        logFn("error", `Retry also failed for ${img.filename}`, { error: retryErr.message });
      }
      // Small delay between retries
      await new Promise((resolve) => setTimeout(resolve, 500));
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
function extractImagesFromZip(zipBase64) {
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
    if (buffer.length > 0) {
      images.push({ filename, buffer });
    }
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
// BAND ANALYSIS PROMPT (v4.0.0) — Per-band content classification
// Receives a single cropped horizontal band image + its exact bg color
// + accent colors sampled from pixels + nearby OCR text.
// Returns classification of WHAT the band contains.
//
// This replaces Stage 1's old approach of asking Claude to discover ALL
// sections in a full compressed PDF (which missed thin bands and guessed
// colors). Now band discovery is done by pixel analysis in Node.js, and
// Claude only classifies what's inside each already-detected band.
// =====================================================================
const BAND_PROMPT = `You are analyzing ONE horizontal band (one section) of an email design.

You will receive:
- A cropped image showing just this band
- The EXACT bg color (hex) sampled from pixels — use this, don't guess
- Accent colors (hex) detected in this band's pixels — use these for any non-bg elements
- OCR text that falls within this band's vertical range
- Band dimensions (width × height in px)

Respond with ONLY a compact JSON object. No markdown fences. No commentary. Start with { end with }.

SCHEMA:
{
  "type": "thin_colored_band|preheader|logo|nav|hero_image|heading|body_text|cta|columns|divider|spacer|footer|social|disclaimer|image|testimonial|alert_bar|phone_bar|bullet_list|job_listings|closing_cta|empty",
  "dark_variant": false,
  "pad": "T R B L",
  "align": "left|center|right",
  "content": [
    {
      "el": "text|image|cta|divider|spacer|link|social_icons|columns|bullet_list",
      "text": "EXACT TEXT from OCR in this band",
      "size": 16,
      "weight": 400,
      "lh": 24,
      "color": "#hex (pick from accent_colors or band bg)",
      "align": "center",
      "transform": "uppercase",
      "img_desc": "what the image shows (for image elements)",
      "img_w": 600,
      "cta_bg": "#hex (pick from accent_colors)",
      "cta_color": "#hex",
      "cta_radius": 6,
      "cta_h": 45,
      "cta_text": "CTA button text from OCR",
      "bullets": ["item 1", "item 2"],
      "cols": [
        { "w": "50%", "content": [] }
      ]
    }
  ]
}

RULES:
1. USE ACCENT COLORS VERBATIM: the accent_colors array contains exact hex values sampled from this band's pixels. Pick from this list for all color fields. DO NOT invent or round colors.
2. USE BG VERBATIM: the band's bg color is provided as an exact hex. DO NOT change it.
3. TEXT FROM OCR: every "text" field MUST be verbatim from the provided OCR text for this band. Never paraphrase or invent.
4. CLASSIFY CORRECTLY:
   - Band height ≤10px with single solid color → "thin_colored_band"
   - Narrow band (10-50px) with a notification/uppercase text on bright bg → "alert_bar"
   - Phone number as the only content → "phone_bar"
   - A prominent closing section with large heading + CTA on a branded bg color → "closing_cta"
   - 4+ short stacked lines each starting a sentence → "bullet_list"
   - List of name + timestamp + action repeated → "job_listings"
   - Only a logo image → "logo"
   - Uppercase tagline + browser link combo → "preheader"
   - Background is primarily dark (bg matches dark_variant=true means bg is near-black) → set dark_variant: true
5. COLUMNS: if the image shows 2 or 3 visually distinct vertical columns, use el:"columns" with cols array. Each column's content is its own array of elements.
6. EMPTY / DIVIDER: if the band is purely decorative (a spacer, or a thin line), use type "divider" or "spacer" and empty content array.
7. ALIGN: read the visual alignment of text in the image. "center" when text is horizontally centered; "left" when left-aligned; "right" when right-aligned. Never guess — look at the image.
8. COMPACT: omit null/default fields.
9. NO markdown. NO backticks. NO explanation.`;

// =====================================================================
// STAGE 1 PROMPT — Design Analysis (Vision → JSON)
// NOTE: As of v4.0.0, this full-PDF analysis is used as a FALLBACK only,
// when per-band analysis produces an incomplete spec. The primary Stage 1
// uses band detection + per-band BAND_PROMPT classification.
// =====================================================================
const STAGE1_PROMPT = `You are an email design analyst. You will receive:
1. One or more IMAGES showing an email design
2. RAW TEXT extracted directly from the PDF file (OCR output)

Your job: Combine the visual layout from the images with the exact text from the PDF extraction to produce a JSON design specification.

CRITICAL: The RAW TEXT section contains the EXACT text from the PDF. You MUST use this text verbatim in your JSON output. NEVER rewrite, paraphrase, or invent text. The images help you understand WHERE each piece of text goes and the visual layout — but the TEXT CONTENT itself comes from the RAW TEXT extraction.

Respond with ONLY a JSON object. No markdown fences. No backticks. No explanation. Start with { end with }.

========================================
MANDATORY PRE-ANALYSIS PROCESS (do this BEFORE building JSON)
========================================

STEP 1 — HORIZONTAL BAND COUNT (required)
Scan the image top-to-bottom. Count EVERY distinct horizontal band of content, no matter how thin or how similar to another band. Examples of bands that MUST be counted:
- A 2-5px colored stripe at the top or bottom of the design
- A narrow preheader bar with text like "View in Browser"
- A logo band (even if only 30-50px tall)
- An alert/notification bar in a bright color (orange, red, yellow)
- A hero image
- A heading band
- A body text band
- A CTA band
- A divider/spacer band
- A column row (2-col, 3-col)
- A repeated variant of an earlier band (count it AGAIN even if it looks similar)
- A footer band
- A copyright band

Put this band count in "band_count" at the top level of your JSON. Your "sections" array MUST have AT LEAST this many entries. If band_count is 28, sections array must have 28+ entries.

STEP 2 — ABSOLUTELY NO DEDUPLICATION
Many email designs intentionally show the SAME content in MULTIPLE layout variants (e.g., a testimonial shown in one style, then shown again in a different style below). The designer put it there twice on purpose. You MUST include BOTH occurrences as separate entries in the sections array. NEVER skip a section because "it looks similar to an earlier one". If you see two testimonials with the same quote text, output TWO testimonial sections.

STEP 3 — THIN/SMALL ELEMENTS ARE SECTIONS
Do NOT skip these just because they are small:
- Colored divider stripes (even 2-5px tall)
- Preheader/utility bars (10-20px tall) 
- Alert message bars
- Dark-mode and light-mode duplicate versions of the same section (many designs show the dark version followed by the light version as a preview)
- Separator bars between major sections
- Phone number or contact info bars above the footer
Each of these is a separate entry in the sections array.

STEP 4 — REPEATED LAYOUT VARIANTS
If you see the same short piece of text (e.g., a name + timestamp) appear twice within a single row (two columns side-by-side), that is ONE section with columns. But if you see the ENTIRE block (heading + body + CTA) twice at different vertical positions, those are TWO separate sections.

========================================
SCHEMA
========================================
{
  "width": 600,
  "bg_outer": "#hex",
  "bg_content": "#hex",
  "font_body": "font name or unknown-sans",
  "font_heading": "font name or same as body",
  "band_count": 28,
  "sections": [
    {
      "n": 1,
      "type": "thin_colored_band|preheader|logo|nav|hero_image|heading|body_text|cta|columns|divider|spacer|footer|social|disclaimer|image|testimonial|stats|alert_bar|phone_bar|bullet_list|job_listings|closing_cta",
      "bg": "#hex",
      "pad": "T R B L",
      "align": "left|center|right",
      "height_hint": "2px|thin|normal|tall",
      "content": [
        {
          "el": "text|image|cta|divider|spacer|link|social_icons|columns|bullet_list",
          "text": "EXACT TEXT FROM PDF EXTRACTION — copy verbatim",
          "size": 16,
          "weight": 400,
          "lh": 24,
          "color": "#hex",
          "align": "center",
          "transform": "uppercase",
          "img_desc": "what the image shows",
          "img_w": 600,
          "img_h": 400,
          "cta_bg": "#hex",
          "cta_color": "#hex",
          "cta_radius": 6,
          "cta_h": 45,
          "cta_size": 16,
          "cta_weight": 600,
          "cta_pad": 30,
          "cta_border": "1px solid #hex",
          "bullets": ["item 1", "item 2"],
          "cols": [
            { "w": "50%", "content": [] }
          ]
        }
      ]
    }
  ],
  "images": [
    { "n": 1, "section": 3, "desc": "company logo top center", "w": 184, "h": 60, "full_width": false, "is_bg": false }
  ],
  "colors": {
    "brand1": "#hex",
    "brand2": "#hex",
    "text": "#hex",
    "heading": "#hex",
    "cta_bg": "#hex",
    "cta_text": "#hex"
  },
  "has_vml": false,
  "has_multicol": false,
  "cta_count": 2,
  "img_count": 8
}

========================================
RULES
========================================
1. TEXT FROM PDF EXTRACTION ONLY: Every "text" field MUST contain text copied verbatim from the RAW TEXT section. NEVER generate, paraphrase, or approximate. If you cannot match a text snippet to a visual section, include it in the nearest logical section.
2. TEXT ALIGNMENT — STUDY EVERY BLOCK INDIVIDUALLY: For every text element, look at the image and determine whether the text is left-aligned, centered, or right-aligned within its container. Set the "align" field explicitly for each element. NEVER default to "left" just because it's the common default — if the visual shows centered text, set align="center". Headings, body copy, testimonial quotes, CTAs, and footer text often use center alignment; sidebar content and list items often use left alignment. A section can contain text elements with different alignments. Get this right for every element.
3. SECTION ORDER: Top-to-bottom in visual order. Every section visible in the image must appear in the JSON.
4. NO DEDUPLICATION: If the same content/layout appears multiple times in the design, output it multiple times. This is intentional design — preserve it.
5. CATALOG EVERY BAND: Even 2-5px colored stripes, narrow alert bars, dark/light duplicate sections — each gets its own entry.
6. COLORS: Be specific. Match the exact hex visible in the design. Dark charcoal is NOT pure #000000. Neon/saturated colors are NOT the same as brand colors (a brand green is NOT pure #00FF00; a brand red is NOT pure #FF0000; a brand blue is NOT pure #0000FF). Light neutrals (cream, off-white, warm beige, cool gray) are NOT #FFFFFF. When in doubt, pick a hex that matches the actual pixel color, not a common default. Report the exact hex you see — do not round to convenient values.
7. SPACING: Estimate px from the image. 33px ≠ 30px.
8. IMAGES: Describe WHAT each image shows (logo, headshot, phone mockup, banner).
9. VML: Set has_vml: true if text overlays a background image.
10. COMPACT: Short keys. Omit null/default fields.
11. METADATA: Order IDs, filenames, "OID" lines from file metadata are NOT email content. Do not include them as text in sections.
12. BULLET LISTS: If the design shows a bulleted list (4+ short items stacked with bullet markers), use el: "bullet_list" with a "bullets" array.
13. BAND_COUNT CHECK: Before outputting, count your sections array length. If it's less than band_count, GO BACK and find the missing bands. Common missed bands: thin colored stripes at edges of the design, dark/light duplicate versions of preheader or logo, narrow alert/notification bars, standalone contact info rows, prominent closing CTA blocks, separate copyright/legal footer strips.
14. NO markdown fences. NO backticks. NO explanation. ONLY the JSON object.

========================================
SELF-CHECK CHECKLIST (verify before outputting)
========================================
- Did you count every horizontal band top-to-bottom?
- Did you include any thin accent-colored stripes at the top or bottom (if present)?
- Did you include BOTH dark and light versions of preheader/logo (if the design shows both)?
- Did you include any narrow alert/notification bars (if present — any bright accent color)?
- Did you include every repeated layout variant as a separate section?
- Did you include standalone contact info bands like phone number rows (if separate from footer)?
- Did you include the closing CTA block (if the design has a prominent final call-to-action section before the footer)?
- Did you include the copyright/legal footer band?
- Does sections.length >= band_count?
- Are colors specific hex values matching the actual design (not generic defaults)?
- Is every "text" field from the RAW TEXT extraction, verbatim?
- Is the "align" field set correctly for EVERY text element based on the visual alignment in the design?`;

// =====================================================================
// STAGE 2 PROMPT — Code Generation (JSON spec → HTML)
// Contains the full Master Framework + GOLD STANDARD CODE EXAMPLES
// extracted from real developer-coded Mavlers emails.
// =====================================================================
const STAGE2_PROMPT = `## IDENTITY
You are the senior email developer at Mavlers. You receive a JSON design specification and produce production-ready HTML email code. The JSON spec contains analyzed design data — section structure, verbatim text, colors, spacing, image descriptions. Your job: convert this spec into Mavlers-grade HTML. Trust the spec. Generate HTML from it, not from guesswork.

## IMPORTANT — PIXEL-EXACT COLORS IN SPEC (v4.0.0)
The spec's section "bg" fields, and any hex values in "colors.unique_bg_colors" and "colors.accent_colors" arrays, are sampled DIRECTLY from the design image's pixels — NOT guessed from a compressed preview. Use these hex values VERBATIM. Do NOT round #231F20 to #000000, do NOT substitute #F5F5F5 for #F5F5E8, do NOT change #00DA00 to #00FF00. Whatever hex the spec contains IS the correct color.

Each section also carries a "_band" field with y_start, y_end, height, row_coverage, and page — this is structural metadata. You can ignore _band but must honor the section order it implies.

## ABSOLUTE OUTPUT RULES
1. Output ONLY the final HTML. Begin with <!DOCTYPE. End with </html>. Nothing else.
2. NO markdown code fences. NO explanations. NO commentary.
3. NO template comments. Production HTML only.
4. Clean, indented, human-readable formatting. Two-space indent.

## ABSOLUTE FIDELITY RULES
1. Use ALL text from the spec VERBATIM. Copy every word exactly. NEVER rewrite or paraphrase.
2. Use EXACT hex colors from the spec. Match every hex value as-is. Do not substitute pure black for a dark charcoal, do not substitute a neon color for a brand color, do not substitute #FFFFFF for a light neutral.
3. Use EXACT spacing from the spec. 33px ≠ 30px. NEVER round.
4. Output sections in the EXACT order from the spec. Do NOT rearrange, merge, or skip sections.
5. Every element goes in a <td> with inline styles. NEVER use <p>, <h1>-<h6>, or <div> (except the hidden preheader div and <ul>/<li> inside bullet_list sections).
6. TEXT ALIGNMENT — RESPECT THE SPEC'S "align" FIELD FOR EVERY ELEMENT: For every text element, set the <td>'s align attribute AND the inline style's text-align to match the spec's "align" value. If spec says align="center", the <td> must be align="center" with text-align:center in the style. If spec says align="left", use align="left". NEVER default to "left" when the spec says otherwise. This applies to headings, body text, testimonial quotes, footer text, and every other text block. Also apply the correct alignment to the parent <td> that wraps the content table (align="center" parent td vs align="left" parent td).

## GOLD STANDARD: SECTION WRAPPER PATTERN
Every section MUST follow this exact wrapper pattern — each section is an independent table block:

<!-- Section_Name -->
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
<!-- // Section_Name -->

RULES: Each section gets its OWN em_wrapper table. Sections are NOT nested inside one shared wrapper. Use HTML comments to label each section. Adjust padding, bgcolor, and dark-mode class per section.

## GOLD STANDARD: CTA BUTTON
Every CTA button MUST follow this exact pattern (substitute values from spec):

<table align="left" bgcolor="#CTA_BG_HEX" border="0" cellspacing="0" cellpadding="0" style="background-color:#CTA_BG_HEX; border-radius: [SPEC_RADIUS]px;" class="em_border">
  <tr>
    <td class="em_defaultlink" align="center" valign="middle" height="[SPEC_HEIGHT]" style="font-size: [SPEC_SIZE]px; font-family: 'FONT_STACK'; font-weight:[SPEC_WEIGHT]; color: #CTA_TEXT_HEX; height:[SPEC_HEIGHT]px; padding:0px [SPEC_PAD]px;" ><a href="#" target="_blank" style="text-decoration:none; color:#CTA_TEXT_HEX; line-height:[SPEC_HEIGHT]px; display:block;">CTA TEXT</a></td>
  </tr>
</table>

MANDATORY CTA PROPERTIES — ALL values come from the spec, never from defaults:
- bgcolor + background-color: EXACT value from spec.cta_bg — NEVER substitute #000000 or a guess
- color (text): EXACT value from spec.cta_color — usually #FFFFFF but not always
- border-radius: spec value — commonly 4px, 6px, 8px, 25px, 30px (pill-shape). NEVER assume one default.
- height: spec value — commonly 38px, 40px, 44px, 45px, 50px
- font-size: spec value — commonly 13px, 14px, 15px, 16px, 18px
- font-weight: spec value — commonly 400, 600, or 700
- padding: spec value — horizontal padding varies widely
- class="em_border" on the table (for dark mode border)
- class="em_defaultlink" on the td
- align="left" on the table for left-aligned CTAs, align="center" for centered
- For centered CTA: wrap in a <td align="center"> parent

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

## GOLD STANDARD: COLORED CARD (e.g., case study, feature callout)
Cards with a solid bg color and contrasting text. Use spec values for bg + text color:

<td align="center" valign="top" bgcolor="#CARD_BG_HEX" style="padding: [SPEC_PAD]; border-radius: [SPEC_RADIUS]px;"><table align="center" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tbody>
      <tr>
        <td align="left" valign="top" class="em_defaultlink em_dm_txt_white" style="font-family: 'FONT_STACK'; font-size:[SPEC_SIZE]px; line-height:[SPEC_LH]px; color: #TEXT_ON_CARD_HEX; font-weight: 400; padding-bottom: [SPEC_PB]px;"><span style="font-weight: 600;">[ATTRIBUTION]</span> <br />[HEADLINE FROM SPEC]</td>
      </tr>
      <tr>
        <td align="left" valign="top" class="em_defaultlink em_dm_txt_white" style="font-family: 'FONT_STACK'; font-size:[SPEC_SIZE]px; line-height:[SPEC_LH]px; color: #TEXT_ON_CARD_HEX; font-weight: 400;">[BODY TEXT FROM SPEC]</td>
      </tr>
    </tbody>
  </table></td>

## GOLD STANDARD: FOOTER
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

## IMAGE URL HANDLING
When image URLs are provided, use the EXACT Dropbox URLs for ALL img src attributes. NEVER use relative paths like "images/hero.jpg" when URLs are provided.

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
<td align="center" valign="top" style="padding: 20px 40px;" bgcolor="#000000">
  <td align="center" class="em_defaultlink em_dm_txt_white" style="font-family: 'FONT_STACK'; font-size: 14px; line-height: 16px; color: #FFFFFF; font-weight: 400;">(+61) 1300 818 777</td>
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
    <li style="font-family: 'FONT_STACK'; font-size: 14px; line-height: 22px; color: #231F20; padding-bottom: 8px;">Bullet item 1</li>
    <li style="font-family: 'FONT_STACK'; font-size: 14px; line-height: 22px; color: #231F20; padding-bottom: 8px;">Bullet item 2</li>
  </ul>
</td>
Note: <ul>/<li> ARE acceptable for bullet lists (exception to the no-non-table-elements rule).

### job_listings (name + timestamp + action pattern)
Used for activity feeds, booking lists, etc. Each entry has name (bold), timestamp (light), action (gray):
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
  <tr>
    <td align="left" style="font-family: 'FONT_STACK'; font-size: 12px; font-weight: 600; color: #231F20; padding-bottom: 4px;">Name Wed DD Mon H.MMpm</td>
  </tr>
  <tr>
    <td align="left" style="font-family: 'FONT_STACK'; font-size: 12px; font-weight: 400; color: #666666; padding-bottom: 12px;">Action description</td>
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
8. Neon/pure/saturated colors (like #00FF00, #FF0000, #0000FF) when spec shows a brand variant (like #00DA00, #E41525, #022C87). Match the exact hex from spec.
9. border-radius: 4px on CTAs (should be 6px or 30px based on spec)
10. @import for fonts (use <link> tag)
11. One giant em_wrapper nesting all sections (each section gets its own)
12. SKIPPING any section from the spec — if spec has 28 sections, output 28 sections
13. DEDUPLICATING sections — if spec shows the same content twice (dark+light, two variants), output both
14. Collapsing similar adjacent sections into one — preserve every section from the spec

## FINAL CHECKLIST
Before outputting, verify:
- Output begins with <!DOCTYPE
- sections.length in HTML === sections.length in spec (count both)
- Every section from spec has a corresponding <tr> block in HTML
- Each section is its own em_wrapper table inside a <tr>
- CTAs match spec values for bgcolor, height, border-radius, font-size
- Text colors match the exact spec hex (no generic defaults substituted)
- EVERY text element's align attribute and text-align style matches the spec's "align" value (never default to left)
- Font loaded via <link> tag, not @import
- All text from spec used verbatim
- Section order matches spec exactly (top-to-bottom)
- Thin elements (colored stripes, alert bars, standalone contact rows) are preserved
- Dark/light variant pairs both present when spec shows both
- Bullet lists rendered as <ul>/<li>
- Footer + copyright bar on separate rows

Generate the most accurate, production-ready, Mavlers-grade HTML email code possible from the provided JSON design specification and developer overrides.`;


// =====================================================================
// EXPRESS APP SETUP
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
  res.json({
    status: "ok",
    uptime: process.uptime(),
    apiKeyConfigured: Boolean(process.env.CLAUDE_API_KEY),
    dropboxConfigured,
    model: CLAUDE_MODEL,
    framework: "master-v2",
    version: "4.0.0",
  });
});

// -----------------------------------------------------------------
// POST /generate — Main pipeline
// Accepts: { pdfBase64, pdfFilename, assetsZipBase64? }
// Returns: { html, orderId, pageCount, pageImages, imageUrlMap, requestId }
// -----------------------------------------------------------------
app.post("/generate", generateLimiter, async (req, res) => {
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
        images = extractImagesFromZip(assetsZipBase64);
        imageSource = "zip";
        log("info", "Extracted images from ZIP", {
          requestId: req.id,
          imageCount: images.length,
          filenames: images.map((i) => i.filename),
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
    let imageUrlMap = {};
    if (images.length > 0 && dropboxConfigured) {
      try {
        imageUrlMap = await uploadImagesToDropbox(orderId, images, log);
        log("info", "Images uploaded to Dropbox", {
          requestId: req.id,
          imageCount: Object.keys(imageUrlMap).length,
        });
      } catch (dbxErr) {
        log("error", "Dropbox upload failed", {
          requestId: req.id,
          error: dbxErr.message,
        });
        // Non-fatal: continue without Dropbox URLs, Claude will use placeholder paths
      }
    }

    // =================================================================
    // STAGE 1 — Design Analysis (Band Detection → Per-band Claude → Spec)
    // v4.0.0 — Deterministic band discovery + pixel-sampled colors.
    //
    // OLD (v3.x): Send compressed PDF to Claude, ask "find all sections".
    //              Missed thin bands, guessed colors from compressed JPEG.
    // NEW (v4.0.0): Detect bands in Node.js by scanning pixel rows.
    //                Sample exact hex colors from pixels.
    //                Crop each band and send to Claude individually for
    //                content classification. Claude's job shrinks from
    //                "analyze entire design" to "describe this one strip".
    // =================================================================
    const stage1StartTime = Date.now();
    log("info", "Stage 1 starting: band detection (v4.0.0)", {
      requestId: req.id,
      pageCount: pngPages.length,
    });

    // --- Extract raw text from PDF (unchanged from v3.x) ---
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
      // Fall back to Tesseract OCR on the full-res rasterized PNG
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

    // Post-process OCR output to fix letter-spacing, doubled spaces, etc.
    // This is Fix #2 from the v4.0.0 plan.
    if (textExtractionMethod === "tesseract-ocr") {
      extractedText = postProcessOcr(extractedText);
    }

    log("info", "Text extraction complete", {
      requestId: req.id,
      textExtractionMethod,
      textLength: extractedText.length,
    });

    // --- Detect bands in each page ---
    // For multi-page PDFs, we process each page independently and concatenate
    // band lists with y-offsets to preserve global section ordering.
    const allBands = [];
    const pageBandOffsets = []; // { pageIdx, yOffset, bandCount }
    let cumulativeBandCount = 0;

    for (let pageIdx = 0; pageIdx < pngPages.length; pageIdx++) {
      const pageBuffer = pngPages[pageIdx].content;
      const detectStart = Date.now();
      const { width: pageW, height: pageH, bands: pageBands } = await detectBands(pageBuffer);

      log("info", `Page ${pageIdx + 1} band detection`, {
        requestId: req.id,
        pageWidth: pageW,
        pageHeight: pageH,
        bandsDetected: pageBands.length,
        detectMs: Date.now() - detectStart,
      });

      pageBandOffsets.push({
        pageIdx,
        yOffset: cumulativeBandCount,
        bandCount: pageBands.length,
        pageWidth: pageW,
        pageHeight: pageH,
      });

      for (const band of pageBands) {
        allBands.push({
          ...band,
          pageIdx,
          globalIndex: ++cumulativeBandCount,
        });
      }
    }

    log("info", "Band detection complete", {
      requestId: req.id,
      totalBands: allBands.length,
    });

    // --- For each band: crop, extract accent colors, classify with Claude ---
    // We process bands in parallel (batch of 5 at a time) to keep latency low.
    const BAND_ANALYSIS_CONCURRENCY = 5;
    const bandAnalyses = new Array(allBands.length);

    // Slice OCR text into chunks proportional to band vertical positions.
    // For each band, we provide OCR text from roughly its vertical region.
    // This is a heuristic — exact slicing would need positional OCR which
    // tesseract doesn't provide here. We pass the full OCR text to each band
    // and let Claude match relevant lines.
    const totalOcrText = extractedText;

    const analyzeBand = async (band, idx) => {
      // Skip empty/pure-spacer bands to save API calls
      if (band.height < 3 && band.bg_hex === "#FFFFFF") {
        return {
          type: "spacer",
          pad: "0 0 0 0",
          align: "center",
          content: [],
          _meta: { skipped: true, reason: "empty_spacer" },
        };
      }

      const pageBuffer = pngPages[band.pageIdx].content;
      // Crop the band from its source page PNG
      const cropped = await cropBand(pageBuffer, band.y_start, band.y_end);
      // Compress the crop for Claude API (small JPEG keeps latency low)
      const croppedJpeg = await sharp(cropped)
        .jpeg({ quality: 75 })
        .toBuffer();

      // Sample accent colors from the band's pixel region
      const accentColors = await extractAccentColors(pageBuffer, band, 6);

      // Build the per-band user prompt
      const bandInfoText = [
        `BAND DIMENSIONS: ${band.height}px tall`,
        `BAND BG COLOR (exact from pixels): ${band.bg_hex}`,
        `ACCENT COLORS (exact from pixels): ${accentColors.length > 0 ? accentColors.join(", ") : "none detected"}`,
        `IS THIN BAND: ${band.is_thin}`,
        `IS CONTENT-HEAVY (text/image): ${band.is_content}`,
        "",
        "FULL OCR TEXT FROM THE EMAIL (use only lines visually within this band):",
        totalOcrText.substring(0, 8000),
      ].join("\n");

      const userContent = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: croppedJpeg.toString("base64"),
          },
        },
        { type: "text", text: bandInfoText },
      ];

      try {
        const message = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 4000,
          system: BAND_PROMPT,
          messages: [{ role: "user", content: userContent }],
        });

        const textBlock = message.content.find((b) => b.type === "text");
        if (!textBlock) {
          throw new Error("No text block in response");
        }

        let raw = textBlock.text.trim();
        // Strip any accidental markdown fences
        raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();

        // Find first { and matching final }
        const firstBrace = raw.indexOf("{");
        const lastBrace = raw.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) {
          throw new Error("No JSON object in response");
        }
        const jsonStr = raw.substring(firstBrace, lastBrace + 1);
        return JSON.parse(jsonStr);
      } catch (err) {
        log("warn", `Band ${idx + 1} analysis failed, using fallback`, {
          requestId: req.id,
          error: err.message,
          bandHex: band.bg_hex,
          bandHeight: band.height,
        });
        // Fallback: classify by pixel heuristics alone
        return {
          type: band.is_thin ? "thin_colored_band" : band.is_content ? "body_text" : "spacer",
          pad: "0 0 0 0",
          align: "center",
          content: [],
          _meta: { fallback: true },
        };
      }
    };

    // Run band analyses in parallel batches
    for (let i = 0; i < allBands.length; i += BAND_ANALYSIS_CONCURRENCY) {
      const batch = allBands.slice(i, i + BAND_ANALYSIS_CONCURRENCY);
      const results = await Promise.all(
        batch.map((band, j) => analyzeBand(band, i + j))
      );
      for (let j = 0; j < results.length; j++) {
        bandAnalyses[i + j] = results[j];
      }
    }

    log("info", "Per-band Claude analysis complete", {
      requestId: req.id,
      bandsAnalyzed: bandAnalyses.length,
      fallbackCount: bandAnalyses.filter((b) => b._meta?.fallback).length,
      skippedCount: bandAnalyses.filter((b) => b._meta?.skipped).length,
    });

    // --- Assemble the final design spec ---
    // Each band becomes one section with its pixel-exact bg_hex and the
    // Claude-classified content.
    const sections = allBands.map((band, idx) => {
      const analysis = bandAnalyses[idx] || {};
      return {
        n: idx + 1,
        type: analysis.type || "unknown",
        bg: band.bg_hex,              // PIXEL-EXACT, never guessed
        pad: analysis.pad || "0 0 0 0",
        align: analysis.align || "center",
        height_hint: band.is_thin ? "thin" : band.height < 100 ? "normal" : "tall",
        dark_variant: analysis.dark_variant || false,
        content: analysis.content || [],
        _band: {
          y_start: band.y_start,
          y_end: band.y_end,
          height: band.height,
          row_coverage: band.row_coverage_ratio,
          page: band.pageIdx,
        },
      };
    });

    // Build the aggregate color palette from all pixel-sampled bg colors.
    const uniqueBgColors = [...new Set(allBands.map((b) => b.bg_hex))];
    const allAccentColors = new Set();
    for (let i = 0; i < Math.min(allBands.length, 20); i++) {
      const band = allBands[i];
      const pageBuffer = pngPages[band.pageIdx].content;
      try {
        const accents = await extractAccentColors(pageBuffer, band, 3);
        accents.forEach((c) => allAccentColors.add(c));
      } catch {
        // non-fatal
      }
    }

    // Width is taken from developer input or from page width / RASTERIZE_SCALE
    const detectedWidth = Math.round((pageBandOffsets[0]?.pageWidth || 960) / RASTERIZE_SCALE);

    const designSpec = {
      width: detectedWidth,
      bg_outer: uniqueBgColors[0] || "#FFFFFF",
      bg_content: uniqueBgColors.find((c) => c === "#FFFFFF") || uniqueBgColors[0] || "#FFFFFF",
      font_body: "unknown-sans", // Developer input overrides this in Stage 2
      font_heading: "unknown-sans",
      band_count: allBands.length,
      sections,
      colors: {
        unique_bg_colors: uniqueBgColors,
        accent_colors: [...allAccentColors],
      },
      cta_count: sections.filter((s) => s.type === "cta" || s.type === "closing_cta").length,
      img_count: sections.filter((s) => s.type === "image" || s.type === "hero_image" || s.type === "logo").length,
    };

    log("info", "Stage 1 complete: design spec parsed (v4.0.0)", {
      requestId: req.id,
      stage1DurationMs: Date.now() - stage1StartTime,
      sectionCount: sections.length,
      bandCount: allBands.length,
      uniqueBgColors: uniqueBgColors.length,
      accentColorCount: allAccentColors.size,
      detectedWidth,
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
    const finalWidth = width || designSpec?.width || 600;
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

    // --- Build image URL mapping for Stage 2 ---
    let imageSection = "";
    if (Object.keys(imageUrlMap).length > 0) {
      // Get image dimensions from Sharp for each uploaded image
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
          return `${filename} (${dims?.width || "?"}×${dims?.height || "?"}px) → ${url}`;
        })
        .join("\n");

      imageSection = `\n\n=== IMAGE ASSETS (USE THESE EXACT URLs for img src) ===
Match each image to its correct position in the design using the image_positions array from the JSON spec above. The spec describes what each image shows (logo, hero, photo, icon, etc.) — match by description.

Available images:
${imageListStr}

RULES:
1. Use the full Dropbox URL for every img src — NEVER use relative paths like "images/hero.jpg".
2. Match images by their description in the spec's image_positions array.
3. Use the actual image dimensions from the list above for width/height attributes.
4. If an image in the spec has no matching uploaded asset, use a descriptive alt text and a transparent placeholder.
5. NEVER fabricate image URLs.
=== END IMAGE ASSETS ===`;
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

    const stage2Response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 32000,
      system: STAGE2_PROMPT,
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

    const html = stage2TextBlock.text;

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

// -----------------------------------------------------------------
// POST /approve — Package ZIP and upload to Dropbox
// Called after dev reviews preview and clicks "Approve & Upload"
// Accepts: { orderId, html, imageUrlMap, images? }
// Returns: { dropboxUrl, orderId, requestId }
// -----------------------------------------------------------------
app.post("/approve", generateLimiter, async (req, res) => {
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

    // Download images from Dropbox URLs to include in ZIP
    const images = [];
    if (imageUrlMap && Object.keys(imageUrlMap).length > 0) {
      for (const [filename, url] of Object.entries(imageUrlMap)) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            images.push({ filename, buffer: Buffer.from(arrayBuffer) });
          } else {
            log("warn", `Failed to download image: ${filename}`, { requestId: req.id, status: response.status });
          }
        } catch (dlErr) {
          log("warn", `Failed to download image: ${filename}`, { requestId: req.id, error: dlErr.message });
        }
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
    version: "4.0.0",
    dropboxConfigured,
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
  process.exit(1);
});

const shutdown = (signal) => {
  log("info", `${signal} received, shutting down gracefully`);
  server.close(() => {
    log("info", "HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => {
    log("error", "Forced shutdown after 30s timeout");
    process.exit(1);
  }, 30000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
