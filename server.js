import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pdfToPng } from "pdf-to-png-converter";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";

if (!process.env.CLAUDE_API_KEY) {
  console.error("FATAL: CLAUDE_API_KEY environment variable is not set.");
  console.error("Set it in Railway -> maveloper-backend -> Variables.");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 10;
const RASTERIZE_TIMEOUT_MS = 60 * 1000;
const ANTHROPIC_TIMEOUT_MS = 180 * 1000;      // raised to 180s, no retries
const SERVER_TIMEOUT_MS = 240 * 1000;         // raised to 240s
const RASTERIZE_SCALE = 2.0;

const ALLOWED_ORIGINS = [
  "https://maveloper.vercel.app",
  "https://maveloper.lovable.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
  timeout: ANTHROPIC_TIMEOUT_MS,
  maxRetries: 0,                              // CRITICAL: no retries — fail fast
});

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
3. Match exact colors using hex codes derived from the design. Never use named colors.
4. Match exact spacing — padding, margins, gaps — in pixels as shown.
5. Match exact typography — font family, size, weight, line-height, letter-spacing, text-transform.
6. Match exact column structures (1-col, 2-col, 3-col, asymmetric) with the correct mobile stacking behavior.
7. Match all decorative elements: dividers, borders, background colors, background images, icons, illustrations.
8. If text in the design appears in a non-standard font requiring loading, include the appropriate Google Font link OR fall back to image-only rendering for that text block.

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
For every CTA button in the design, use this exact pattern. The line-height = height trick vertically centers without flexbox. The display:block on the anchor makes the entire cell clickable.

<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="background-color: #00388F; border-radius: 30px;" bgcolor="#00388F">
  <tr>
    <td align="center" valign="middle" height="52" style="height: 52px; padding: 0 32px; font-family: Arial, sans-serif; font-size: 15px; font-weight: 700; color: #FFFFFF;">
      <a href="https://example.com" target="_blank" style="text-decoration: none; color: #FFFFFF; line-height: 52px; display: block;">CTA TEXT HERE</a>
    </td>
  </tr>
</table>

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
- 3-BREAKPOINT MOBILE: For complex hero typography, use 3 breakpoints (599/480/374).
- PILL CTAs: Use border-radius: 9999px for safe pill shape.
- GOOGLE FONTS: Load via <link> with rel="preconnect" inside <!--[if !mso]><!--> conditional.

## FINAL OUTPUT CHECKLIST
- Output begins with <!DOCTYPE
- No markdown fences anywhere
- All universal reset rules present
- All meta tags present
- Main table uses role="presentation" and width matches design
- All text extracted verbatim from images
- All colors as hex codes
- All CTAs use bulletproof or linked-image pattern
- Multi-column sections use <th> with em_clear class
- Dark mode block included if appropriate
- All images have width, height, alt, border="0", display:block
- Output ends with </html>

Generate the most accurate, production-ready, Mavlers-grade HTML email code possible from the provided design images.`;

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));

// CORS — also send headers on errors so timeouts don't show as CORS bugs
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST"],
  credentials: false,
}));

app.use(express.json({ limit: "8mb" }));

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

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    apiKeyConfigured: Boolean(process.env.CLAUDE_API_KEY),
    model: CLAUDE_MODEL,
    framework: "master-v1",
    version: "1.1.2",
  });
});

app.post("/generate", generateLimiter, async (req, res) => {
  const startTime = Date.now();
  try {
    const { pdfBase64 } = req.body;

    if (!pdfBase64) {
      return res.status(400).json({
        error: "Missing pdfBase64",
        details: "Request body must include a pdfBase64 field.",
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

    log("info", "Rasterizing PDF", {
      requestId: req.id,
      sizeKB: Math.round(pdfBuffer.length / 1024),
      scale: RASTERIZE_SCALE,
    });

    const pngPages = await rasterizeWithTimeout(pdfBuffer);

    if (pngPages.length > MAX_PAGES) {
      return res.status(413).json({
        error: "Too many pages",
        details: `PDF has ${pngPages.length} pages. Maveloper supports up to ${MAX_PAGES} pages per email design.`,
        requestId: req.id,
      });
    }

    log("info", "Sending to Claude", {
      requestId: req.id,
      pageCount: pngPages.length,
      rasterizeMs: Date.now() - startTime,
    });

    const imageBlocks = pngPages.map((page) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: page.content.toString("base64"),
      },
    }));

    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: "Generate production-ready Mavlers-grade HTML email code that visually matches the design shown in the images above EXACTLY. Extract all text verbatim. Output only the HTML starting with <!DOCTYPE.",
            },
          ],
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
      pageCount: pngPages.length,
      durationMs: Date.now() - startTime,
      htmlLength: html.length,
    });

    res.json({
      html,
      pageCount: pngPages.length,
      pageImages: previewImages,
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
    }

    res.status(statusCode).json({
      error: "Generation failed",
      details: userMessage,
      requestId: req.id,
    });
  }
});

const server = app.listen(PORT, () => {
  log("info", `Maveloper backend running on port ${PORT}`, {
    model: CLAUDE_MODEL,
    framework: "master-v1",
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
