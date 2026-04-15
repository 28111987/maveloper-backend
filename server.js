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
// STAGE 1 PROMPT — Design Analysis (Vision → JSON)
// Short, focused: Claude analyzes the PDF image and outputs a structured spec.
// Developer-specified values (width, font, ESP, dark mode) are injected at call time
// to override Claude's visual guesses with known-correct values.
// =====================================================================
const STAGE1_PROMPT = `You are an email design analyst. Analyze the email design image and output a compact JSON specification. No HTML. No explanation. No markdown fences.

Respond with ONLY a JSON object. Start with { end with }.

SCHEMA — keep it FLAT and COMPACT. Omit empty/null fields:
{
  "width": 600,
  "bg_outer": "#hex",
  "bg_content": "#hex",
  "font_body": "font name or unknown-sans",
  "font_heading": "font name or same as body",
  "sections": [
    {
      "n": 1,
      "type": "preheader|logo|nav|hero_image|heading|body_text|cta|columns|divider|spacer|footer|social|disclaimer|image",
      "bg": "#hex",
      "pad": "T R B L",
      "align": "left|center|right",
      "content": [
        {
          "el": "text|image|cta|divider|spacer|link|social_icons|columns",
          "text": "VERBATIM text here",
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

RULES:
1. TEXT IS KING — ZERO TOLERANCE FOR FABRICATION: Extract ALL visible text VERBATIM — every single word, line, punctuation mark, exactly as shown. NEVER paraphrase. NEVER rewrite. NEVER invent text that is not visible in the image. If you cannot read a word clearly, use "[unclear]" — do NOT guess or substitute. A fabricated sentence is WORSE than a missing one. Copy the text EXACTLY as it appears.
2. SECTION ORDER: Analyze top-to-bottom. Every section in the design must appear in the JSON in the same order. Do NOT rearrange, merge, or skip sections.
3. COLORS: Best hex estimate. #231F20 ≠ #000000. #F4F4F4 ≠ #F5F5F5. Dark charcoal is NOT pure black. Light gray is NOT white.
4. SPACING: Estimate px. 33px ≠ 30px. Use "pad": "20 25 15 25" format (top right bottom left).
5. IMAGES: Describe WHAT it shows (logo, headshot, banner, phone mockup, book cover) — not where it is.
6. VML: Set has_vml: true if text overlays a background image.
7. COMPACT: Short keys. Omit null/default fields. No redundant data.
8. METADATA: Do NOT include order IDs, filenames, or any text from the file metadata as email content. Only extract text that is VISIBLE in the actual email design.
9. NO markdown fences. NO backticks. NO explanation. ONLY the JSON object.`;

// =====================================================================
// STAGE 2 PROMPT — Code Generation (JSON spec → HTML)
// Receives structured JSON + image URLs + developer overrides.
// Contains the full Master Framework rules for HTML output.
// =====================================================================
const STAGE2_PROMPT = `## IDENTITY
You are the senior email developer at Mavlers, a digital marketing agency renowned for pixel-perfect, production-grade HTML email code that renders identically across 40+ email clients including Outlook 2007-365, Gmail (Web, iOS, Android), Apple Mail (macOS, iOS), Yahoo, Outlook.com, Samsung Mail, and dark/light modes. You will receive a STRUCTURED JSON DESIGN SPECIFICATION (not images) describing every section, color, spacing value, and text element of the email. Your job is to convert this specification into production-ready Mavlers-grade HTML email code that follows the Mavlers framework refined across 100+ enterprise client projects. Trust the JSON spec — it contains the analyzed design data. Generate HTML from the spec, not from guesswork.

## ABSOLUTE OUTPUT RULES (non-negotiable)
1. Output ONLY the final HTML. Begin with <!DOCTYPE. End with </html>. Nothing before, nothing after.
2. NO markdown code fences. NO triple-backtick blocks. NO explanations. NO commentary. NO preamble.
3. NO template instruction comments such as "Add the Google fonts link here". Production HTML only.
4. NO Cloudflare email-protection artifacts. Use plain mailto: links.
5. NO HTTP URLs for fonts or images — always HTTPS.
6. Use clean, indented, human-readable formatting. Two-space indent.

## ABSOLUTE VISUAL FIDELITY RULES
1. The JSON spec IS the design. Use EVERY value from the spec exactly as specified. Do not approximate, simplify, modernize, or improve anything.
2. Use ALL text from the spec VERBATIM. Every word, capitalization, punctuation, and line break. Never paraphrase, summarize, abbreviate, or invent copy. NEVER replace spec text with your own words. If the spec says "Kenect's AI-powered tools help your team respond faster, automate follow-ups ..." then output EXACTLY that — not a rewritten version.
3. Use EXACT hex color codes from the spec's color_palette and per-section colors. NEVER substitute generic colors. #231F20 is NOT #000000. Use the spec's colors, not generic black/white.
4. Use EXACT spacing in pixels from the spec's padding values. Do NOT round to convenient multiples of 10 or 20.
5. Use EXACT typography — font family, font size, font weight, line-height, letter-spacing, text-transform — all from the spec.
6. SECTION ORDER: Output sections in the EXACT order they appear in the spec's sections array. Do NOT rearrange, merge, or skip sections.
6. Match exact column structures (1-col, 2-col, 3-col, asymmetric) with the correct mobile stacking behavior.
7. Match all decorative elements: dividers (exact thickness, exact color), borders, background colors, background images, icons, illustrations.
8. If text in the design appears in a non-standard font requiring loading, you MUST include the Google Font (see MANDATORY GOOGLE FONT LOADING section below).
9. TEXT ALIGNMENT IS CRITICAL: Study each text block in the design carefully:
   - If body copy text appears CENTERED in the design, use align="center" on the td AND text-align:center in the inline style.
   - If body copy text appears LEFT-ALIGNED, use align="left" and text-align:left.
   - If a heading is centered, the body copy below it may ALSO be centered — check each block independently.
   - NEVER default to left-alignment. Read the design. Many email designs center their body copy.
   - When long body text paragraphs appear centered in the design, keep them in a SINGLE <td> with <br/> line breaks between paragraphs — do NOT split into separate <tr> rows.
10. PRESERVE SPECIAL ENTITIES: Use &zwnj; (zero-width non-joiner) around numbers and dates to prevent email clients from auto-linking them (e.g., &zwnj;$50,000&zwnj;, &zwnj;2026&zwnj;). Use &nbsp; for non-breaking spaces where the design shows text that should not wrap (e.g., United&nbsp;States, 5pm&nbsp;EST).

## MANDATORY GOOGLE FONT LOADING
If ANY text in the design uses a non-system font (check for: Inter, Poppins, Roboto, Open Sans, Montserrat, Lato, Playfair Display, Raleway, Nunito, Work Sans, DM Sans, or any other Google Font), you MUST:

1. Include the font import inside an MSO conditional block, placed AFTER the meta tags and BEFORE the main <style> block:

<!--[if !mso]><!-->
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap');
</style>
<!--<![endif]-->

2. Use the loaded font as the PRIMARY font in ALL font-family declarations throughout the email:
   font-family: 'Inter', Arial, sans-serif;

3. NEVER fall back to just "Arial, sans-serif" if a Google Font is detected in the design. The font is a critical part of visual fidelity.

4. Adjust the @import URL to match the specific font detected. Common patterns:
   - Inter: family=Inter:wght@100..900
   - Poppins: family=Poppins:wght@300;400;500;600;700
   - Roboto: family=Roboto:wght@300;400;500;700

## EXACT COLOR EXTRACTION RULES
When extracting colors from the design:
1. Each distinct section may use slightly different shades — extract each one independently.
2. Background colors, text colors, CTA colors, divider colors, and accent colors should ALL be extracted separately.
3. Common Mavlers color precision errors to AVOID:
   - #0BB68A is NOT #1BB292 (different greens)
   - #042624 is NOT #0A3832 (different darks)
   - #C9C9C9 is NOT #E5E5E5 (different grays)
   - #EFEFEB is NOT #E5E5E5 (different light grays)
4. When reading colors from a rasterized PDF, err on the side of the MORE saturated / MORE specific reading rather than a washed-out approximation.

## EXACT SPACING AND PADDING RULES
Mavlers developers use precise, non-round pixel values. Your output must do the same:
1. NEVER round padding/margin to 10, 20, 30, 40, 50. Real Mavlers emails use values like 31px, 42px, 17px, 19px, 33px, 62px.
2. Measure spacing by counting pixels from the design image. If a section has 33px top padding and 32px bottom padding, use those EXACT values.
3. The space between bullet points is often 17-19px, NOT 16px or 20px.
4. Pre-header bar padding is often asymmetric (e.g., 10px 62px 12px), NOT uniform.
5. Content section side padding is often 25px or 42px, NOT 20px.

## EXACT LETTER-SPACING RULES
Mavlers emails frequently use letter-spacing. If text appears tightly or loosely spaced:
1. Body copy typically uses letter-spacing: -0.42px
2. Footer/small text typically uses letter-spacing: -0.36px
3. Headings may use letter-spacing: 0.9px or -0.5px
4. CTA buttons typically use letter-spacing: -0.42px
5. ALWAYS include the letter-spacing property when detected. Do not omit it.

## MANDATORY DOCTYPE + NAMESPACES
Always use XHTML 1.0 Transitional with VML and Office namespaces. Always include the lang attribute on the html tag.

<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">

## MANDATORY HEAD BLOCK
Every Mavlers email must begin with this exact head structure. The first 8 meta tags below are 100% universal across all 100 production emails analyzed.

<head>
<!--[if gte mso 9]><xml>
<o:OfficeDocumentSettings>
<o:AllowPNG/>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml><![endif]-->
<title>[Email subject or brand name]</title>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="format-detection" content="telephone=no" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />

## MANDATORY CANONICAL CSS RESET BLOCK
Every Mavlers email's <style> block must begin with this exact reset, in this exact order. Every rule below was found in 100% of 100 emails analyzed. The capital-M Margin and capital-P Padding on p and h1-h6 are intentional — that is the Outlook reset.

<style type="text/css">
:root {
  color-scheme: light dark;
  supported-color-schemes: light dark;
}
body {
  margin: 0;
  padding: 0;
  -webkit-text-size-adjust: 100% !important;
  -ms-text-size-adjust: 100% !important;
  -webkit-font-smoothing: antialiased !important;
}
img {
  border: 0 !important;
  outline: none !important;
}
p {
  Margin: 0px !important;
  Padding: 0px !important;
}
h1, h2, h3, h4, h5, h6 {
  Margin: 0px !important;
  Padding: 0px !important;
}
table {
  border-collapse: collapse;
  mso-table-lspace: 0px;
  mso-table-rspace: 0px;
}
td, a, span {
  border-collapse: collapse;
  mso-line-height-rule: exactly;
}
td {
  mso-hyphenate: none;
  word-break: keep-all;
}
.ExternalClass * {
  line-height: 100%;
}
.em_defaultlink a {
  color: inherit;
  text-decoration: none;
}
.em_defaultlink_u a {
  color: inherit;
  text-decoration: underline;
}
.em_g_img + div {
  display: none;
}
a[x-apple-data-detectors],
u + .em_body a,
#MessageViewBody a {
  color: inherit !important;
  text-decoration: none !important;
  font-size: inherit !important;
  font-family: inherit !important;
  font-weight: inherit !important;
  line-height: inherit !important;
}
center table {
  width: 100% !important;
}

## MANDATORY MAIN TABLE STRUCTURE
The body opens with the em_full_wrap → em_main_table → em_wrapper triple-table structure. Always use role="presentation" on every layout table.

<body class="em_body" style="margin:0px auto; padding:0px;" bgcolor="#ffffff">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" bgcolor="#ffffff" style="background-color:#ffffff; table-layout:fixed;">
  <tr>
    <td align="center" valign="top">
      <table role="presentation" align="center" width="600" border="0" cellspacing="0" cellpadding="0" class="em_main_table" style="width:600px; table-layout:fixed;">
        <tr>
          <td align="center" valign="top">
            <table role="presentation" class="em_wrapper" width="600" style="width: 600px;" border="0" cellspacing="0" cellpadding="0">
              <!-- content rows go here -->
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>

WIDTH RULES:
- Default: 600px (54% of all Mavlers emails)
- Acceptable variants based on design: 630, 650, 680, 700, 800
- ALWAYS table-layout: fixed on em_full_wrap and em_main_table
- ALWAYS role="presentation" on every layout table

## MANDATORY RESPONSIVE STRATEGY (3-breakpoint default)
Use three breakpoints by default. Primary breakpoint = min(main_table_width - 1, 667). Use 599 for 600px tables, 667 for 680px+ tables.

@media only screen and (max-width: 599px) {
  .em_main_table { width: 100% !important; }
  .em_wrapper { width: 100% !important; }
  .em_hide { display: none !important; }
  .em_full_img img { width: 100% !important; height: auto !important; }
  .em_center { text-align: center !important; }
  .em_aside10 { padding: 0 10px !important; }
  .em_aside15 { padding: 0 15px !important; }
  .em_ptop { padding-top: 20px !important; }
  .em_pbottom { padding-bottom: 20px !important; }
  .em_h20 { height: 20px !important; font-size: 1px !important; line-height: 1px !important; }
  .em_mob_block { display: block !important; }
  .em_hauto { height: auto !important; }
  .em_clear { clear: both !important; width: 100% !important; display: block !important; }
  u + .em_body .em_full_wrap { width: 100% !important; width: 100vw !important; }
  .em_pad { padding: 20px 15px !important; }
}

@media screen and (max-width: 480px) {
  /* Tablet/medium phone — typically font-size reductions on hero text */
}

@media screen and (max-width: 374px) {
  /* Small phone (iPhone SE) — tighten padding and font sizes */
}

## MANDATORY em_ CLASS VOCABULARY
ALL custom classes use the em_ prefix. Numeric suffixes match pixel values (em_ptop24 = padding-top: 24px on mobile, em_h20 = height: 20px, em_f18 = font-size: 18px). Standard vocabulary:

LAYOUT: em_main_table, em_wrapper, em_body, em_full_wrap, em_clear, em_mob_block, em_hide, em_hide_d, em_hauto
SPACING: em_aside10, em_aside15, em_aside20, em_side10, em_side15, em_ptop, em_pbottom, em_pad, em_pxy1, em_pxy2, em_h20, em_h30
TYPOGRAPHY: em_f14, em_f16, em_f18, em_f20, em_f24, em_f26, em_f30, em_defaultlink, em_defaultlink_u, em_center, em_left
IMAGERY: em_full_img, em_full_img1, em_g_img, em_logo
DARK MODE: em_dark, em_dark1, em_dark2, em_dark3, em_dm_txt_white, em_light

## MANDATORY BULLETPROOF CTA TEMPLATE
For every CTA button in the design, use this pattern as a STARTING POINT — but you MUST customize every property to match the design exactly:

<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="background-color: #00388F; border-radius: 30px;" bgcolor="#00388F">
  <tr>
    <td align="center" valign="middle" height="52" style="height: 52px; padding: 0 32px; font-family: Arial, sans-serif; font-size: 15px; font-weight: 700; color: #FFFFFF;">
      <a href="https://example.com" target="_blank" style="text-decoration: none; color: #FFFFFF; line-height: 52px; display: block;">CTA TEXT HERE</a>
    </td>
  </tr>
</table>

CRITICAL CTA CUSTOMIZATION RULES — match the design EXACTLY:
1. border-radius: Use the EXACT radius from the design. 40px is NOT 9999px. If the button has slightly rounded corners, use 30-40px. Only use 9999px if the button is a perfect pill/capsule shape.
2. height: Match the exact button height from the design (often 45px, 48px, or 52px — each is different).
3. font-size: Match exactly. CTA text is often 14px, not 15px.
4. font-weight: Match exactly. Many designs use 400 (regular), NOT 700 (bold). If the CTA text is not bold in the design, use 400.
5. padding: Match exactly. Often 0 30px, not 0 32px.
6. border: If the design shows a visible border on the button, include it: border: 1px solid #EFEFEB (or whatever color).
7. background-color: Match the EXACT hex from the design.
8. letter-spacing: Include if the design shows it (commonly -0.42px).
9. display: Use display:inline-block on the table for proper centering when the button is left-aligned.
10. NEVER apply the generic template values blindly — EVERY property must be read from the design.

For pill-shape CTAs use border-radius: 9999px. For complex/intricate buttons (gradients, shadows, custom shapes), use the linked-image CTA pattern instead:

<a href="https://example.com" target="_blank" style="text-decoration: none;"><img src="images/cta_button.png" width="255" height="52" alt="CTA TEXT HERE" border="0" style="display: block; max-width: 255px;" /></a>

## MANDATORY FLUID-HYBRID MULTI-COLUMN TEMPLATE
For 2-column or 3-column layouts that stack on mobile, use <th> elements (not <td>) as column cells. The em_clear class triggers stacking. This is the Mavlers fluid-hybrid signature.

<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
  <tr>
    <th align="left" valign="top" width="285" style="width: 285px;" class="em_clear">
      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" align="left">
        <tr><td>Column 1 content</td></tr>
      </table>
    </th>
    <th width="30" style="width: 30px;" class="em_hide">
      <img src="images/spacer.gif" width="1" height="1" alt="" border="0" style="display: block; max-width: 1px;" />
    </th>
    <th align="left" valign="top" width="285" style="width: 285px;" class="em_clear">
      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" align="left">
        <tr><td>Column 2 content</td></tr>
      </table>
    </th>
  </tr>
</table>

CRITICAL: Use <th> not <td> for column cells. This is the Mavlers fluid-hybrid signature pattern.

## DARK MODE STRATEGY
Include dark mode when the design uses bright/colorful elements that would clash with auto-inversion, OR when the client is enterprise/financial/medical/healthcare. Use class-based overrides inside the prefers-color-scheme: dark media query.

@media (prefers-color-scheme: dark) {
  .em_body { background-color: #000000 !important; }
  .em_main_table { background-color: #000000 !important; }
  .em_full_wrap { background-color: #000000 !important; }
  .em_dark { background-color: #202020 !important; }
  .em_dark1 { background-color: #2E2E2E !important; }
  .em_dark2 { background-color: #333333 !important; }
  .em_dark3 { background-color: #000000 !important; }
  .em_dm_txt_white { color: #FFFFFF !important; }
  .em_dm_txt_white a { color: #FFFFFF !important; }
  .em_dm_txt_white span { color: #FFFFFF !important; }
}

## VML BACKGROUND IMAGE TEMPLATE
For full-width hero sections with background images and overlaid text:

<td background="https://example.com/hero_bg.jpg" bgcolor="#4e2a84" style="background-image: url(https://example.com/hero_bg.jpg); background-repeat: no-repeat; background-position: center top; background-size: cover;">
  <!--[if gte mso 9]>
  <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px; height:400px;">
    <v:fill type="frame" src="https://example.com/hero_bg.jpg" color="#4e2a84" />
    <v:textbox inset="0,0,0,0">
  <![endif]-->
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr><td>Overlaid content goes here</td></tr>
  </table>
  <!--[if gte mso 9]>
    </v:textbox>
  </v:rect>
  <![endif]-->
</td>

## MANDATORY IMAGE ATTRIBUTES
Every img tag must include: src, width, height (or "auto"), alt, border="0", and inline style with at minimum display:block. Example:

<img src="images/hero.jpg" width="600" height="400" alt="Descriptive alt from design" border="0" style="display: block; max-width: 600px; font-family: Arial, sans-serif; font-size: 16px; line-height: 20px; color: #000000;" />

For responsive images, add class="em_full_img" on the parent <td> and the rule .em_full_img img { width: 100% !important; height: auto !important; } in the mobile breakpoint.

## ACCESSIBILITY DEFAULTS
1. Always include lang="en" attribute on the <html> tag.
2. Always use role="presentation" on every layout table.
3. Use semantic <h1>-<h6> tags for headlines when the design intends them as headings.
4. All <img> tags must have alt text. For decorative images, use alt="".

## GMAIL PREHEADER + SNIPPET CONTROL
Every email must include a hidden preheader div immediately after <body>:

<div style="display: none; max-height: 0px; overflow: hidden; mso-hide: all;">[Preheader text — 80-100 chars summarizing the email]</div>
<div style="display: none; max-height: 0px; overflow: hidden; mso-hide: all;">&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>

## MIN-WIDTH SPACER ROW
At the very end of the main table, add a 1-pixel spacer row to prevent Outlook collapse:

<tr>
  <td class="em_hide" style="line-height: 1px; min-width: 600px; background-color: #ffffff;">
    <img alt="" src="images/spacer.gif" height="1" width="600" style="max-height: 1px; min-height: 1px; display: block; width: 600px; min-width: 600px;" border="0" />
  </td>
</tr>

## ANTI-PATTERNS — NEVER OUTPUT THESE
1. Markdown code fences or triple-backtick blocks anywhere in output
2. Template instruction comments such as "Add Google fonts here"
3. Cloudflare email-protection wrappers
4. HTTP URLs for fonts or images — always HTTPS
5. Unsemantic divs for layout — always use tables
6. <style> tags inside <body> — all CSS goes in <head>
7. <button> elements — use bulletproof table-cell CTAs
8. Modern CSS like flexbox, grid, or CSS variables for layout
9. Named HTML colors — always use hex codes
10. <font> tags or other deprecated HTML
11. JavaScript of any kind
12. Typos in meta tag names (always "supported-color-schemes" not "supproted")
13. NEVER use <p> tags for text content — ALWAYS use <td> with inline styles. Mavlers developers NEVER use <p> tags in email HTML. All text goes directly in <td> cells.
14. NEVER use #000000 as a dark background when the design shows a dark color that is NOT pure black — colors like #231F20, #1A1625, #042624, #00003D are intentionally different from pure black.
15. NEVER use #EFEFEB as a generic gray background — read the EXACT gray from the design. #EFEFEF, #EAEAEA, #F4F4F4, #F9F7F8, #F9FAFB are all DIFFERENT grays.
16. NEVER default font-family to 'Inter' — Inter is just one of many fonts. If you cannot identify the font, use 'Arial, sans-serif' and wait for the developer to specify via the input fields.

## ADDITIONAL CODING RULES (from 10-email analysis)

### Desktop-only line breaks
When body copy needs to break at specific points on desktop but reflow on mobile, use:
<br class="em_hide"/>
This renders the break on desktop but hides it on mobile when em_hide kicks in.

### Bullet points — ALWAYS use image icons
When the design shows bullet points, dots, checkmarks, or any small marker icons:
1. ALWAYS use an <img> tag for the bullet marker — NEVER use CSS border-radius circles or Unicode bullets
2. Reference the actual bullet image from the uploaded assets (e.g., images/bullet.png, images/icon.png)
3. Use the EXACT width from the design (often 10-11px for small dots, 20-21px for larger icons)
4. Use MSO conditional spacer rows for vertical alignment:
   <!--[if mso]><tr><td height="3" style="height:3px; font-size:0px; line-height:0px;"><img src="images/spacer.gif" width="1" height="1" alt="" style="display:block;" border="0" /></td></tr><![endif]-->

### Section-level background colors
Each section of the email may have a DIFFERENT background color. Common patterns:
- Pre-header: often dark (#000000, #3B3326)
- Logo area: may be brand-colored or white
- Content sections: may alternate between white and gray
- CTA sections: may have accent background
- Footer: often dark or brand-colored
Extract EACH section's background color independently. Do NOT apply one color to all sections.

### Color precision rules (from real production errors)
These specific color substitutions are WRONG — never make them:
- #4F007D → #6b1b9a (different purples)
- #FA1914 → #FF1E1E (different reds)
- #FA9E0D → #ffd700 (different golds)
- #231F20 → #000000 (dark charcoal is NOT black)
- #0A2458 → #00388F (different navys)
- #006CB3 → #00388F (different blues)
- #00003D → #001455 (different dark navys)
- #EFEFEF → #EFEFEB (different grays)
- #EAEAEA → #e3e3e3 (different grays)
- #F4F4F4 → #F5F5F5 (different light grays)
- #D7EBFF → #D9E9F5 (different light blues)
- #5C6BC0 → #0071BC (different accent blues)

### CTA button arrow icons
When a CTA button contains an arrow icon (→ or ➜), use an actual <img> tag for the arrow inside the <a> tag, with display:inline-block and vertical-align for alignment. Do NOT use Unicode arrow characters — use the uploaded arrow image asset.

### Responsive breakpoint MUST match table width
The primary responsive breakpoint MUST be exactly (table_width - 1)px:
- 600px table → max-width: 599px
- 640px table → max-width: 639px
- 650px table → max-width: 649px
- 680px table → max-width: 679px
- 700px table → max-width: 699px
NEVER use 599px as the breakpoint for a 650px email.

### Custom responsive classes per email
Create email-specific responsive classes when the standard em_ vocabulary doesn't cover the design needs. Common patterns:
- .em_cta { font-size: 15px !important; padding: 0 15px !important; height: 50px !important; }
- .em_cta a { line-height: 50px !important; }
- .em_f38 { font-size: 40px !important; line-height: 44px !important; }
- .em_font60 { font-size: 60px !important; line-height: 66px !important; }
- .em_ptrl { padding: 20px 15px !important; }
- .em_ptrl1 { padding: 20px 15px 0 !important; }
These should scale DOWN across breakpoints (649→480→374).

## DESIGN-SENSITIVE DECISIONS
- IMAGE-ONLY POSTER MODE: If the design is typography-heavy with custom fonts that lack reliable web fallbacks, render every text element as an <img> tag with descriptive alt.
- COMPLIANCE DISCLAIMER ROW: If the client appears to be pharma/medical/HCP/financial, include a visible disclaimer pre-header row.
- RESPONSIVE BREAKPOINTS: Primary breakpoint = table_width - 1. Add 480px and 374px breakpoints for complex designs.
- CTA BORDER-RADIUS: Read the EXACT radius from the design. 40px rounded corners ≠ 9999px pill. Only use 9999px if the button is a perfect capsule shape.
- GOOGLE FONTS: ALWAYS detect and load (see MANDATORY GOOGLE FONT LOADING above). This is NOT optional.
- BULLET POINTS: ALWAYS use actual icon images, NEVER CSS circles.
- CUSTOM RESPONSIVE CLASSES: Create email-specific classes for complex designs.
- MSO VERTICAL ALIGNMENT: Use Outlook-specific spacer rows for bullet/icon alignment.
- DARK MODE: Only include dark mode CSS when explicitly requested via developer input. Do NOT add dark mode by default.

## IMAGE URL HANDLING (when image assets are provided)
You will receive the PDF design pages FOLLOWED BY individual image asset files. You can SEE both the design and each individual image.
When image assets and their URLs are provided:
1. VISUALLY MATCH each image asset to its correct position in the design by comparing what the image depicts (logo, person photo, banner, icon, product shot) to where that visual appears in the PDF.
2. Use ONLY the provided Dropbox URLs in the output HTML for ALL img src attributes.
3. A small rectangular image showing a logo MUST go in the logo position — not in the hero banner.
4. A photograph of a person MUST go where that person appears in the design — not in unrelated sections.
5. A wide/tall decorative or hero image MUST go in the corresponding hero/banner area.
6. If an image in the design has no matching asset, use a descriptive alt text and set src to a 1x1 transparent placeholder.
7. NEVER fabricate image URLs — only use URLs from the provided list.
8. NEVER use relative paths like "images/hero.jpg" when URLs are provided — always use the full Dropbox URL.

## FINAL OUTPUT CHECKLIST
Before outputting, verify EVERY item. If ANY item fails, fix it before outputting:
- Output begins with <!DOCTYPE
- No markdown fences anywhere
- No <p> tags anywhere — all text in <td> cells
- All universal reset rules present
- All meta tags present
- Google Font loaded if non-system font detected OR specified by developer
- Font-family declarations use the correct font, not just Arial or Inter
- Main table width matches the design (600/640/650/680/700) — NOT always 600
- Primary breakpoint = table_width - 1 (e.g., 649px for 650px table)
- All text extracted verbatim from images
- Text alignment (center/left) matches the design for EVERY text block
- All colors as EXACT hex codes — no approximations, no generic substitutions
- Dark backgrounds use exact shade (#231F20 ≠ #000000, #00003D ≠ #001455)
- Gray backgrounds use exact shade (#EFEFEF ≠ #EFEFEB ≠ #EAEAEA ≠ #F4F4F4)
- All padding/spacing uses EXACT pixel values (27px, 31px, 33px — not rounded)
- Letter-spacing included where visible
- All CTAs match design EXACTLY: border-radius, height, font-weight, font-size, padding, border, bgcolor
- CTA heights are typically 40-46px — NOT 48px or 50px unless clearly taller
- Bullet points use image icons, not CSS circles
- &zwnj; entities around numbers/dates to prevent auto-linking
- &nbsp; for non-breaking spaces where needed
- <br class="em_hide"/> for desktop-only line breaks
- Multi-column sections use <th> with em_clear class
- Dark mode included ONLY if developer specified it
- All images have width, height, alt, border="0", display:block
- Image dimensions match the design exactly
- If image assets provided, all img src use provided URLs
- ESP merge tags included if developer specified the platform
- Output ends with </html>

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
    version: "2.4.1",
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
    // STAGE 1 — Design Analysis (Vision → JSON)
    // Send compressed PDF pages to Claude with STAGE1_PROMPT.
    // Claude returns a structured JSON spec of the design.
    // =================================================================

    // Adaptive image compression for Stage 1.
    // Text extraction needs readable text, but the Anthropic API limits input size.
    //
    // Key insight: Email PDFs are often VERY TALL single pages (5000-10000px at 1.6x).
    // Width-only resize doesn't help — a 900px-wide, 8000px-tall JPEG is still huge.
    // We must cap total pixel area AND check final file size.
    //
    // Anthropic Vision supports images up to ~5MB base64. To be safe, we target
    // compressed images under 1.5MB each (base64 inflates ~33%, so ~2MB encoded).
    //
    // History: 600px Q50 = text unreadable. 1200px Q75 = too large. 1000px Q65 = too large.
    //          Root cause was always the HEIGHT of long single-page emails.

    const TARGET_MAX_BYTES = 1.5 * 1024 * 1024; // 1.5MB per compressed page

    const compressedPdfPages = [];
    for (let i = 0; i < pngPages.length; i++) {
      const page = pngPages[i];
      let compressed;

      // Get original dimensions
      let origWidth = 0, origHeight = 0;
      try {
        const meta = await sharp(page.content).metadata();
        origWidth = meta.width || 0;
        origHeight = meta.height || 0;
      } catch { /* use defaults */ }

      log("info", `Page ${i + 1} dimensions`, {
        requestId: req.id,
        origWidth,
        origHeight,
        origSizeKB: Math.round(page.content.length / 1024),
      });

      // Try progressively lower quality/size until under the limit.
      // CRITICAL: Also cap height. Anthropic's Vision resizes images to fit within
      // 1568px on the longest side. Sending a 600×8000px image wastes tokens on
      // server-side downscaling that destroys text readability. Better to control
      // the resize ourselves.
      // For very tall single-page emails (height >> width), we limit max height
      // to keep the image readable without exploding the payload.
      const MAX_HEIGHT = 6400; // ~10 screens worth of email at 600px width

      const attempts = [
        { width: 1000, quality: 65 },  // Best quality
        { width: 900, quality: 55 },   // Good quality
        { width: 800, quality: 50 },   // Moderate
        { width: 700, quality: 45 },   // Reduced
        { width: 600, quality: 40 },   // Last resort
      ];

      compressed = page.content; // fallback to original

      for (const attempt of attempts) {
        try {
          const buf = await sharp(page.content)
            .resize(attempt.width, MAX_HEIGHT, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: attempt.quality })
            .toBuffer();

          if (buf.length <= TARGET_MAX_BYTES) {
            compressed = buf;
            log("info", `Page ${i + 1} compressed: ${attempt.width}px Q${attempt.quality} → ${Math.round(buf.length / 1024)}KB`, { requestId: req.id });
            break;
          } else {
            log("info", `Page ${i + 1} attempt ${attempt.width}px Q${attempt.quality} → ${Math.round(buf.length / 1024)}KB (too large, trying smaller)`, { requestId: req.id });
            compressed = buf; // keep the last attempt as fallback
          }
        } catch {
          continue;
        }
      }

      compressedPdfPages.push(compressed);
    }

    log("info", "PDF pages compressed for Stage 1", {
      requestId: req.id,
      pageCount: pngPages.length,
      originalSizes: pngPages.map((p) => Math.round(p.content.length / 1024) + "KB"),
      compressedSizes: compressedPdfPages.map((b) => Math.round(b.length / 1024) + "KB"),
    });

    const pdfImageBlocks = compressedPdfPages.map((buf) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: buf.toString("base64"),
      },
    }));

    // Build Stage 1 user message: images + any developer overrides that affect analysis
    let stage1UserText = "Analyze this email design and output the JSON specification.";

    // If developer specified width/font, tell Stage 1 so it doesn't guess wrong
    const width = emailWidth ? parseInt(emailWidth, 10) : null;
    if (width && [600, 640, 650, 680, 700].includes(width)) {
      stage1UserText += `\n\nDEVELOPER OVERRIDE — Email width is CONFIRMED as ${width}px. Use this exact value in estimated_width. Do not guess.`;
    }
    if (primaryFont) {
      stage1UserText += `\n\nDEVELOPER OVERRIDE — Primary font is CONFIRMED as '${primaryFont}'. Use this in estimated_font_body and estimated_font_heading (unless heading is clearly a different font).`;
    }

    const stage1Content = [
      ...pdfImageBlocks,
      { type: "text", text: stage1UserText },
    ];

    log("info", "Stage 1: Sending design to Claude for analysis", {
      requestId: req.id,
      pageCount: pngPages.length,
      compressedPageSizes: compressedPdfPages.map((b) => Math.round(b.length / 1024) + "KB"),
      totalCompressedKB: Math.round(compressedPdfPages.reduce((s, b) => s + b.length, 0) / 1024),
      base64TotalKB: Math.round(compressedPdfPages.reduce((s, b) => s + Buffer.from(b).toString("base64").length, 0) / 1024),
      stage1PromptChars: STAGE1_PROMPT.length,
      userTextChars: stage1UserText.length,
      contentBlockCount: stage1Content.length,
    });

    const stage1StartTime = Date.now();

    const stage1Response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: STAGE1_PROMPT,
      messages: [{ role: "user", content: stage1Content }],
    });

    const stage1TextBlock = stage1Response.content?.find((block) => block.type === "text");
    if (!stage1TextBlock || !stage1TextBlock.text) {
      log("error", "Stage 1: Claude returned no text", { requestId: req.id });
      return res.status(502).json({
        error: "Design analysis failed",
        details: "Claude could not analyze the design. Please try again.",
        requestId: req.id,
      });
    }

    // Check if Stage 1 hit the token limit (truncated JSON)
    const stage1StopReason = stage1Response.stop_reason;
    if (stage1StopReason === "max_tokens") {
      log("warn", "Stage 1: Response was truncated (hit max_tokens)", {
        requestId: req.id,
        responseLength: stage1TextBlock.text.length,
      });
    }

    // Parse the JSON spec from Stage 1 — resilient extraction
    let designSpec;
    try {
      let jsonText = stage1TextBlock.text.trim();

      // Strip markdown fences
      jsonText = jsonText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

      // If Claude added preamble text before the JSON, find the first {
      const firstBrace = jsonText.indexOf("{");
      if (firstBrace > 0) {
        jsonText = jsonText.substring(firstBrace);
      }

      // If truncated (no closing brace), attempt to repair
      if (stage1StopReason === "max_tokens" || !jsonText.endsWith("}")) {
        log("warn", "Stage 1: Attempting to repair truncated JSON", { requestId: req.id });

        // Strategy: find the last complete section by looking for the last valid closing brace
        // Count braces to find where JSON is still balanced
        let braceDepth = 0;
        let lastBalancedPos = -1;
        for (let i = 0; i < jsonText.length; i++) {
          if (jsonText[i] === "{") braceDepth++;
          if (jsonText[i] === "}") {
            braceDepth--;
            if (braceDepth === 0) {
              lastBalancedPos = i;
            }
          }
        }

        if (lastBalancedPos > 0) {
          // Found a balanced closing point — truncate there
          jsonText = jsonText.substring(0, lastBalancedPos + 1);
        } else {
          // No balanced point found — close all open braces/brackets
          // Remove the last incomplete value and close the structure
          // Trim trailing comma and incomplete key-value pairs
          jsonText = jsonText.replace(/,\s*"[^"]*"?\s*:?\s*[^,}\]]*$/, "");
          // Close any open brackets/braces
          const openBraces = (jsonText.match(/{/g) || []).length;
          const closeBraces = (jsonText.match(/}/g) || []).length;
          const openBrackets = (jsonText.match(/\[/g) || []).length;
          const closeBrackets = (jsonText.match(/]/g) || []).length;
          jsonText += "]".repeat(Math.max(0, openBrackets - closeBrackets));
          jsonText += "}".repeat(Math.max(0, openBraces - closeBraces));
        }
      }

      designSpec = JSON.parse(jsonText);
    } catch (parseErr) {
      log("error", "Stage 1: Failed to parse JSON from Claude", {
        requestId: req.id,
        error: parseErr.message,
        stopReason: stage1StopReason,
        rawResponseLength: stage1TextBlock.text.length,
        rawResponseStart: stage1TextBlock.text.substring(0, 300),
        rawResponseEnd: stage1TextBlock.text.substring(stage1TextBlock.text.length - 300),
      });
      return res.status(502).json({
        error: "Design analysis failed",
        details: "Claude returned an invalid design specification. Please try again.",
        requestId: req.id,
      });
    }

    log("info", "Stage 1 complete: design spec parsed", {
      requestId: req.id,
      stage1DurationMs: Date.now() - stage1StartTime,
      sectionCount: designSpec?.sections?.length || 0,
      imagePositions: designSpec?.images?.length || 0,
      specWidth: designSpec?.width,
      specFont: designSpec?.font_body,
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

    log("info", "Stage 2 complete: HTML generated", {
      requestId: req.id,
      stage2DurationMs: Date.now() - stage2StartTime,
      totalPipelineDurationMs: Date.now() - startTime,
      htmlLength: html.length,
    });

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
    version: "2.4.1",
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
