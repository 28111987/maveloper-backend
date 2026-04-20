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
import { detectBands, buildColorPalette, samplePixelColor, cropBand, postProcessOcr } from "./band-detector.js";

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
// STAGE 1 PROMPT (v5.0.0) — Full-design analysis with pixel palette
// Replaces v4.0.1's per-band classification. Claude now sees the full design
// once, with pixel-exact colors and OCR text provided as authoritative data.
// =====================================================================
const STAGE1_PROMPT = `You are analyzing an email design PDF to produce a structured JSON specification. You will receive:

1. A HIGH-QUALITY IMAGE of the complete email design
2. A pixel-sampled COLOR PALETTE — these are the exact hex values that appear in the design's pixels. Use these VERBATIM for any color field in your JSON output. Do NOT round, approximate, or substitute colors. A dark-charcoal hex like #2A2623 is different from pure black #000000. A specific brand green like #1FC23D is different from neon green #00FF00. A cream off-white like #F7F3E4 is different from generic #F5F5F5. Match the exact palette hex, never a common default.
3. OCR-EXTRACTED TEXT — every piece of text visible in the design. Use this text VERBATIM for every "text" field. NEVER paraphrase, rewrite, or invent text. If you cannot match a piece of OCR text to a visible section, include it where it logically belongs.
4. A BAND MAP — pixel-exact positions (y_start, y_end, height, bg_hex) of every horizontal band detected in the design. This is a structural reference showing where color transitions occur. Use it to verify you don't miss thin elements (colored stripes, narrow alert bars, divider lines).
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

========================================
SCHEMA
========================================
{
  "width": <developer-specified width>,
  "font_body": "<developer-specified primary font>",
  "font_heading": "<developer-specified secondary font, if any, else same as body>",
  "band_count": <total bands from BAND MAP>,
  "sections": [
    {
      "n": 1,
      "type": "thin_colored_band|preheader|nav|logo|hero_image|alert_bar|heading|body_text|cta|columns|divider|spacer|testimonial|image|phone_bar|closing_cta|bullet_list|footer|disclaimer|social",
      "bg": "#<exact hex from palette>",
      "pad": "T R B L",
      "align": "left|center|right",
      "dark_variant": false,
      "y_start": <pixel y from band map — approximate if merging bands>,
      "y_end": <pixel y>,
      "content": [
        {
          "el": "text|image|cta|divider|spacer|link|social_icons|columns|bullet_list",
          "text": "<verbatim from OCR>",
          "spans": [{ "text": "...", "color": "#hex" }],
          "size": 16, "weight": 400, "lh": 24,
          "color": "#hex", "align": "left|center|right", "transform": "uppercase",
          "src": "<Dropbox URL>", "alt": "<description>", "width": <number>, "height": <number>,
          "cta_bg": "#hex", "cta_color": "#hex", "cta_radius": 30,
          "cta_h": 50, "cta_size": 16, "cta_weight": 700, "cta_pad": 30,
          "cta_text": "<button label>",
          "bullets": ["item 1", "item 2"],
          "cols": [ { "w": "50%", "content": [] } ]
        }
      ]
    }
  ],
  "palette_used": ["#hex1", "#hex2", "..."]
}

========================================
FINAL CHECKLIST (run before outputting)
========================================
- Do your sections cover the full vertical range from y=0 to the last band's y_end?
- Every "bg" and "color" is from the supplied palette?
- Every "text" is verbatim from OCR?
- Every image has a src that is a Dropbox URL from the assets list (or empty if no match)?
- Every text element has an "align" field matching the visible alignment?
- Multi-color inline headings use "spans" (not duplicated rows)?
- Colored stripes >= 2px in the band map have a thin_colored_band section?
- No fake hallucinated sections not visible in the design image?
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
    version: "5.0.0",
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
    // Compress each page for Claude vision. Use higher quality than v4 (2x
    // larger file budget) because this is a single full-design call, not 30
    // per-band calls, so we can afford better resolution.
    const TARGET_MAX_BYTES = 3 * 1024 * 1024; // 3MB — single call allows larger images

    const compressedPdfPages = [];
    for (let i = 0; i < pngPages.length; i++) {
      const page = pngPages[i];
      const pageInfo = pageInfos[i];

      log("info", `Page ${i + 1} original`, {
        requestId: req.id,
        origWidth: pageInfo.pageWidth,
        origHeight: pageInfo.pageHeight,
        origSizeKB: Math.round(page.content.length / 1024),
      });

      // Step-down quality until we fit under the byte cap.
      // Higher resolution than v4 for better section recognition.
      const attempts = [
        { width: 1400, quality: 80 },
        { width: 1200, quality: 75 },
        { width: 1000, quality: 70 },
        { width: 850, quality: 65 },
        { width: 700, quality: 55 },
      ];

      let compressed = page.content;
      const MAX_HEIGHT = 12000;

      for (const attempt of attempts) {
        try {
          const buf = await sharp(page.content)
            .resize(attempt.width, MAX_HEIGHT, {
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: attempt.quality })
            .toBuffer();

          if (buf.length <= TARGET_MAX_BYTES) {
            compressed = buf;
            log("info", `Page ${i + 1} compressed`, {
              requestId: req.id,
              width: attempt.width,
              quality: attempt.quality,
              sizeKB: Math.round(buf.length / 1024),
            });
            break;
          } else {
            compressed = buf;
          }
        } catch {
          continue;
        }
      }

      compressedPdfPages.push(compressed);
    }

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

    const stage1ImageBlocks = compressedPdfPages.map((buf) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: buf.toString("base64"),
      },
    }));

    const stage1UserContent = [
      ...stage1ImageBlocks,
      { type: "text", text: stage1UserPrompt },
    ];

    // --- Step 1e: Call Claude with retry on 429 ---
    const MAX_STAGE1_RETRIES = 3;
    let stage1Message = null;
    let stage1LastErr = null;
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let attempt = 0; attempt <= MAX_STAGE1_RETRIES; attempt++) {
      try {
        stage1Message = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 16000,
          system: STAGE1_PROMPT,
          messages: [{ role: "user", content: stage1UserContent }],
        });
        break; // success
      } catch (err) {
        stage1LastErr = err;
        const is429 =
          err?.status === 429 || (err?.message && err.message.includes("429"));
        if (is429 && attempt < MAX_STAGE1_RETRIES) {
          const backoffMs = 3000 * Math.pow(2, attempt);
          log("info", `Stage 1 hit rate limit, retrying after ${backoffMs}ms`, {
            requestId: req.id,
            attempt: attempt + 1,
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

    let rawJson = stage1TextBlock.text.trim();
    rawJson = rawJson
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
    const firstBrace = rawJson.indexOf("{");
    const lastBrace = rawJson.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) {
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

    let designSpec;
    try {
      designSpec = JSON.parse(rawJson.substring(firstBrace, lastBrace + 1));
    } catch (jsonErr) {
      log("error", "Stage 1 JSON parse error", {
        requestId: req.id,
        error: jsonErr.message,
        preview: rawJson.slice(0, 500),
      });
      return res.status(502).json({
        error: "Design analysis failed",
        details: "Claude's JSON output was malformed. Please try again.",
        requestId: req.id,
      });
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
    version: "5.0.0",
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
