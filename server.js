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
const ANTHROPIC_TIMEOUT_MS = 300 * 1000;   // 5 min — image-heavy emails with 15+ visual blocks need more time
const SERVER_TIMEOUT_MS = 360 * 1000;      // 6 min — must exceed Anthropic timeout + Dropbox upload time
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
 * Uploads in parallel batches of 5 for speed without hitting rate limits.
 * Returns a map: { "hero.jpg": "https://dl.dropboxusercontent.com/..." }
 */
async function uploadImagesToDropbox(orderId, images, logFn) {
  const folderPath = getDropboxFolderPath(orderId);
  const imageUrlMap = {};
  const BATCH_SIZE = 5;

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
    for (const result of results) {
      if (result.status === "fulfilled") {
        imageUrlMap[result.value.filename] = result.value.directUrl;
      } else {
        logFn("error", "Individual image upload failed", { error: result.reason?.message || String(result.reason) });
      }
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
// MAVELOPER MASTER FRAMEWORK SYSTEM PROMPT
// Distilled from 100 production Mavlers emails — 140 documented patterns.
// =====================================================================
const SYSTEM_PROMPT = `## IDENTITY
You are the senior email developer at Mavlers, a digital marketing agency renowned for pixel-perfect, production-grade HTML email code that renders identically across 40+ email clients including Outlook 2007-365, Gmail (Web, iOS, Android), Apple Mail (macOS, iOS), Yahoo, Outlook.com, Samsung Mail, and dark/light modes. You will receive one or more images showing pages of an email design PDF. Your job is to output production-ready Mavlers-grade HTML email code that visually matches the design EXACTLY and follows the Mavlers framework refined across 100+ enterprise client projects.

## ABSOLUTE OUTPUT RULES (non-negotiable)
1. Output ONLY the final HTML. Begin with <!DOCTYPE. End with </html>. Nothing before, nothing after.
2. NO markdown code fences. NO triple-backtick blocks. NO explanations. NO commentary. NO preamble.
3. NO template instruction comments such as "Add the Google fonts link here". Production HTML only.
4. NO Cloudflare email-protection artifacts. Use plain mailto: links.
5. NO HTTP URLs for fonts or images — always HTTPS.
6. Use clean, indented, human-readable formatting. Two-space indent.

## ABSOLUTE VISUAL FIDELITY RULES
1. Match the design EXACTLY. Do not approximate, simplify, modernize, or improve anything. The design is the law.
2. Extract ALL visible text VERBATIM from the images. Every word, capitalization, punctuation, and line break. Never paraphrase, summarize, abbreviate, or invent copy.
3. Match EXACT hex color codes from the design. NEVER approximate. If a green looks like #0BB68A, do NOT output #1BB292. If a dark looks like #042624, do NOT output #0A3832. Pay extreme attention to subtle color differences — two similar greens are likely two different hex values. When in doubt, favor the darker/more saturated reading.
4. Match EXACT spacing in pixels as shown. Do NOT round to convenient multiples of 10 or 20. If the design shows 31px padding, use 31. If 42px, use 42. If 17px between items, use 17. Mavlers emails use precise, non-round pixel values — that precision is what makes them pixel-perfect.
5. Match EXACT typography — font family (including Google Fonts), font size, font weight, line-height, letter-spacing, text-transform. NEVER inflate font sizes. If body copy in the design is 14px, use 14px — not 16px. If a CTA button text is font-weight:400, use 400 — not 700.
6. Match exact column structures (1-col, 2-col, 3-col, asymmetric) with the correct mobile stacking behavior.
7. Match all decorative elements: dividers (exact thickness, exact color), borders, background colors, background images, icons, illustrations.
8. If text in the design appears in a non-standard font requiring loading, you MUST include the Google Font (see MANDATORY GOOGLE FONT LOADING section below).

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

## DESIGN-SENSITIVE DECISIONS
- IMAGE-ONLY POSTER MODE: If the design is typography-heavy with custom fonts that lack reliable web fallbacks, render every text element as an <img> tag with descriptive alt.
- COMPLIANCE DISCLAIMER ROW: If the client appears to be pharma/medical/HCP/financial, include a visible disclaimer pre-header row.
- RESPONSIVE BREAKPOINTS: Use 1 breakpoint (599px) for simple emails. Use 3 breakpoints (599/480/374) only for complex hero typography or intricate mobile layouts. Do not over-engineer simple emails.
- CTA BORDER-RADIUS: Read the EXACT radius from the design. 40px rounded corners ≠ 9999px pill. Only use 9999px if the button is a perfect capsule shape.
- GOOGLE FONTS: ALWAYS detect and load (see MANDATORY GOOGLE FONT LOADING above). This is NOT optional.
- BULLET POINTS: If the design uses small icons/dots as bullet markers, prefer using actual small icon images (img tags) over CSS border-radius circles. Image bullets are more reliable across email clients including Outlook.
- CUSTOM RESPONSIVE CLASSES: For emails with complex section-specific mobile behavior, create custom em_ classes (e.g., em_pad_ET, em_pad_EB, em_f01) in addition to the standard vocabulary. This achieves precise mobile rendering per section.
- MSO VERTICAL ALIGNMENT: For bullet lists and icon+text layouts, use Outlook-specific spacer rows inside MSO conditionals to achieve precise vertical alignment:
  <!--[if (gte mso 9)|(IE)]><tr><td height="3" style="height:3px; font-size:0px; line-height:0px;"><img src="spacer.gif" width="1" height="1" alt="" style="display:block;" border="0" /></td></tr><![endif]-->
- DARK MODE: Only include dark mode CSS when the design specifically requires it or uses bright elements that would clash with auto-inversion. Do NOT include dark mode by default for every email.

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
Before outputting, verify EVERY item:
- Output begins with <!DOCTYPE
- No markdown fences anywhere
- All universal reset rules present
- All meta tags present
- Google Font loaded if non-system font detected in design (<!--[if !mso]><!--> @import block)
- Font-family declarations use the loaded Google Font, not just Arial
- Main table uses role="presentation" and width matches design
- All text extracted verbatim from images
- All colors as EXACT hex codes from the design (not approximations)
- All padding/spacing uses EXACT pixel values from design (not rounded to 10/20)
- Letter-spacing included where visible in the design
- All CTAs match design EXACTLY: border-radius, height, font-weight, font-size, padding, border, bgcolor
- Multi-column sections use <th> with em_clear class
- Dark mode block included ONLY if appropriate for this design
- All images have width, height, alt, border="0", display:block
- If image assets were provided, all img src use the provided URLs matched by VISUAL CONTENT
- Output ends with </html>

Generate the most accurate, production-ready, Mavlers-grade HTML email code possible from the provided design images.`;

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
    framework: "master-v1",
    version: "1.3.5",
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
    const { pdfBase64, pdfFilename, assetsZipBase64, darkMode } = req.body;

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

    // --- Step 4: Build prompt with image map + visual image blocks ---
    const pdfImageBlocks = pngPages.map((page) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: page.content.toString("base64"),
      },
    }));

    // Build content array: PDF pages first, then extracted images with labels, then text prompt
    const contentBlocks = [
      ...pdfImageBlocks,
      { type: "text", text: "--- The above images show the email design PDF pages. Below are the individual image assets extracted/uploaded for this email. Study each one carefully to understand what it depicts (logo, photo, icon, banner, etc.) before matching them to the design. ---" },
    ];

    // Add each extracted image as a visual block so Claude can SEE them and match accurately
    // Only send SIGNIFICANT images as visual blocks — skip tiny icons, spacers, and GIFs
    // Cap at 10 visual blocks to avoid overloading Claude's context
    const MAX_VISUAL_BLOCKS = 10;
    const MIN_VISUAL_SIZE = 3 * 1024; // Skip images under 3KB (spacers, tiny icons)

    if (images.length > 0 && Object.keys(imageUrlMap).length > 0) {
      // Get dimensions for each image using Sharp
      const imageMeta = await Promise.all(
        images.map(async (img) => {
          try {
            const metadata = await sharp(img.buffer).metadata();
            return { filename: img.filename, width: metadata.width, height: metadata.height, size: img.buffer.length };
          } catch {
            return { filename: img.filename, width: 0, height: 0, size: img.buffer.length };
          }
        })
      );

      // Sort images by file size descending — largest (most important) first
      const sortedIndices = imageMeta
        .map((meta, idx) => ({ idx, size: meta.size }))
        .sort((a, b) => b.size - a.size)
        .map((item) => item.idx);

      let visualBlockCount = 0;

      for (const i of sortedIndices) {
        const img = images[i];
        const meta = imageMeta[i];
        const url = imageUrlMap[img.filename];

        // Always list ALL images in the text map (for URL reference)
        // But only send significant ones as visual blocks

        if (img.buffer.length < MIN_VISUAL_SIZE) continue; // Skip tiny files
        if (visualBlockCount >= MAX_VISUAL_BLOCKS) continue; // Cap visual blocks

        // Determine media type from extension
        const ext = path.extname(img.filename).toLowerCase();
        const mediaTypeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
        const mediaType = mediaTypeMap[ext] || "image/jpeg";

        // Add a label before each image
        contentBlocks.push({
          type: "text",
          text: `Image asset: "${img.filename}" (${meta.width}×${meta.height}px) → URL: ${url}`,
        });

        // Add the actual image so Claude can see it
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: img.buffer.toString("base64"),
          },
        });

        visualBlockCount++;
      }

      log("info", "Visual blocks prepared for Claude", {
        requestId: req.id,
        totalImages: images.length,
        visualBlocksSent: visualBlockCount,
        skippedSmall: images.filter((img) => img.buffer.length < MIN_VISUAL_SIZE).length,
      });
    }

    // Build the final text prompt
    let userPrompt = "Generate production-ready Mavlers-grade HTML email code that visually matches the design shown in the PDF page images above EXACTLY. Extract all text verbatim. Output only the HTML starting with <!DOCTYPE.";

    if (Object.keys(imageUrlMap).length > 0) {
      const imageListStr = Object.entries(imageUrlMap)
        .map(([filename, url]) => `${filename} → ${url}`)
        .join("\n");

      userPrompt += `\n\nIMAGE MATCHING INSTRUCTIONS:\nYou have been shown the PDF design AND each individual image asset above. You can SEE what each image looks like. Match each image to the correct position in the email design by comparing what the image shows (photo of a person, logo, icon, banner, etc.) to where that visual appears in the PDF design.\n\nAvailable image URLs (USE THESE EXACT URLs for img src):\n${imageListStr}\n\nCRITICAL RULES:\n1. Match images by their VISUAL CONTENT — look at what each image depicts and place it where that visual appears in the PDF design.\n2. A small image with a logo should go in the logo position, not the hero banner.\n3. A photo of a person should go in the section where that person's photo appears in the design.\n4. A wide banner/hero image should go at the top hero section.\n5. Use the full Dropbox URL for every img src — NEVER use relative paths.\n6. If an image cannot be matched to any design element, do not use it.`;
    }

    contentBlocks.push({ type: "text", text: userPrompt });

    // --- Step 5: Send to Claude ---
    log("info", "Sending to Claude", {
      requestId: req.id,
      pageCount: pngPages.length,
      extractedImageCount: images.length,
      imageUrlCount: Object.keys(imageUrlMap).length,
      rasterizeMs: Date.now() - startTime,
    });

    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: contentBlocks,
        },
      ],
    });

    const textBlock = message.content?.find((block) => block.type === "text");
    if (!textBlock || !textBlock.text) {
      log("error", "Claude returned no text block", {
        requestId: req.id,
        contentBlocks: message.content?.length || 0,
      });
      return res.status(502).json({
        error: "Generation failed",
        details: "Claude returned an empty or unexpected response. Please try again.",
        requestId: req.id,
      });
    }

    const html = textBlock.text;

    // --- Step 6: Generate preview images ---
    const previewImages = await Promise.all(
      pngPages.map(async (page) => {
        const jpeg = await sharp(page.content)
          .jpeg({ quality: 75, mozjpeg: true })
          .toBuffer();
        return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      })
    );

    log("info", "Generation complete", {
      requestId: req.id,
      orderId,
      pageCount: pngPages.length,
      imageSource,
      imageCount: images.length,
      dropboxUrls: Object.keys(imageUrlMap).length,
      durationMs: Date.now() - startTime,
      htmlLength: html.length,
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
      requestId: req.id,
    });

  } catch (err) {
    log("error", "Generation error", {
      requestId: req.id,
      error: err.message,
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
    framework: "master-v1",
    version: "1.3.5",
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
