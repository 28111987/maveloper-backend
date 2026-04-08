import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pdfToPng } from "pdf-to-png-converter";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";

// =====================================================================
// STARTUP VALIDATION
// =====================================================================
if (!process.env.CLAUDE_API_KEY) {
  console.error("FATAL: CLAUDE_API_KEY environment variable is not set.");
  console.error("Set it in Railway -> maveloper-backend -> Variables.");
  process.exit(1);
}

// =====================================================================
// CONFIGURATION
// =====================================================================
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";
const MAX_PDF_BYTES = 5 * 1024 * 1024;        // 5 MB
const MAX_PAGES = 10;
const RASTERIZE_TIMEOUT_MS = 30 * 1000;       // 30 seconds
const ANTHROPIC_TIMEOUT_MS = 90 * 1000;       // 90 seconds
const SERVER_TIMEOUT_MS = 120 * 1000;         // 2 minutes

const ALLOWED_ORIGINS = [
  "https://maveloper.vercel.app",       // TODO: replace with your real Vercel URL
  "https://maveloper.lovable.app",      // Lovable preview, if used
  "http://localhost:3000",
  "http://localhost:5173",
];

// =====================================================================
// ANTHROPIC CLIENT
// =====================================================================
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
  timeout: ANTHROPIC_TIMEOUT_MS,
  maxRetries: 2,
});

// =====================================================================
// SYSTEM PROMPT (placeholder — will be replaced by Master Framework)
// =====================================================================
const SYSTEM_PROMPT = `You are an expert email developer at Mavlers, a digital marketing agency known for pixel-perfect, production-grade HTML email code. You will receive one or more images showing pages of an email design PDF. Generate production-ready HTML email code that visually matches the design EXACTLY.

ABSOLUTE VISUAL FIDELITY RULES:
1. Match exact visual hierarchy, spacing, padding, margins, colors, font sizes, and proportions shown in the images. Do not approximate, simplify, or improve the design in any way.
2. Extract ALL visible text VERBATIM from the images. Preserve every word, capitalization, punctuation, and line break. Never paraphrase, summarize, or invent copy.
3. Identify every section in the design and replicate it: hero banners, headlines, body copy blocks, image sections, multi-column layouts, CTAs, dividers, footers, social icons, unsubscribe links.
4. Identify the column structure of each section (1-col, 2-col, 3-col, hybrid) and use th-based fluid-hybrid responsive stacking.
5. Match button colors, padding, corner radius, and typography from the design exactly. Use bulletproof table-cell CTAs with VML fallback for Outlook.
6. Match all background colors, image placements, and decorative elements. If an image is shown in the design, include an img tag with appropriate alt text and dimensions.
7. Output ONLY the final HTML — no markdown code fences, no explanations, no commentary. Begin output with <!DOCTYPE.

MAVLERS TECHNICAL FRAMEWORK (mandatory):
- DOCTYPE: XHTML 1.0 Transitional with xmlns:v="urn:schemas-microsoft-com:vml" and xmlns:o="urn:schemas-microsoft-com:office:office"
- Head: meta charset utf-8, meta viewport width=device-width initial-scale=1, meta name="x-apple-disable-message-reformatting", meta name="color-scheme" content="light dark", meta name="supported-color-schemes" content="light dark"
- Outlook MSO conditional with PixelsPerInch 96
- Class naming convention: ALL custom classes use em_ prefix (em_main_table, em_wrapper, em_body, em_clear, em_hide, em_defaultlink, em_full_img, em_dark, em_dm_txt_white, em_full_wrap, em_mob_block, em_hauto, em_aside, em_side)
- Outlook reset in head style: table { border-collapse: collapse; } and capital-M Margin: 0; capital-P Padding: 0; on body
- Main table: width 600px or 700px max, table-layout: fixed, role="presentation", align="center"
- All layout tables: role="presentation", cellpadding="0", cellspacing="0", border="0"
- Responsive: media query at max-width 599px or 667px, use th elements with display: block !important for column stacking
- Dark mode: @media (prefers-color-scheme: dark) with em_dark and em_dm_txt_white class overrides
- Bulletproof CTAs: table-cell with bgcolor attribute AND background-color inline style, border-radius, padding 12-16px vertical and 24-32px horizontal, VML roundrect fallback inside MSO conditional comment
- Inline ALL CSS on every element for maximum email client compatibility
- Image tags: include width, height, alt, border="0", style="display:block;"
- Links: include style with color and text-decoration explicitly

Generate the most accurate, production-ready Mavlers-grade HTML email code possible from the provided design images.`;

// =====================================================================
// EXPRESS APP SETUP
// =====================================================================
const app = express();

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: false,
}));

// CORS — restricted to known origins
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST"],
  credentials: false,
}));

// JSON body parser — sized for 5MB PDFs after base64 inflation
app.use(express.json({ limit: "8mb" }));

// Request ID middleware for tracing
app.use((req, res, next) => {
  req.id = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader("X-Request-ID", req.id);
  next();
});

// Structured logger
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }));

// Rate limiter for the generate endpoint
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

// =====================================================================
// HELPER: Rasterize PDF with timeout
// =====================================================================
const rasterizeWithTimeout = (buffer) => Promise.race([
  pdfToPng(buffer, {
    viewportScale: 2.5,
    disableFontFace: false,
    useSystemFonts: false,
  }),
  new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("PDF rasterization timed out after 30s")),
      RASTERIZE_TIMEOUT_MS
    )
  ),
]);

// =====================================================================
// ROUTES
// =====================================================================

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    apiKeyConfigured: Boolean(process.env.CLAUDE_API_KEY),
    model: CLAUDE_MODEL,
    version: "1.0.0",
  });
});

// Generate endpoint
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

    // Decode base64
    const cleanBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, "");
    const pdfBuffer = Buffer.from(cleanBase64, "base64");

    // Size check
    if (pdfBuffer.length > MAX_PDF_BYTES) {
      return res.status(413).json({
        error: "PDF too large",
        details: `PDF must be 5 MB or smaller. Received ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB.`,
        requestId: req.id,
      });
    }

    // PDF magic-byte validation
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
    });

    // Rasterize with timeout
    const pngPages = await rasterizeWithTimeout(pdfBuffer);

    // Page count guard
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
    });

    // Build image blocks for Claude (high-quality PNG)
    const imageBlocks = pngPages.map((page) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: page.content.toString("base64"),
      },
    }));

    // Call Claude
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

    // Defensive response parsing
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

    // Compress preview images to JPEG for the frontend
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

// =====================================================================
// SERVER START + PROCESS HANDLERS
// =====================================================================
const server = app.listen(PORT, () => {
  log("info", `Maveloper backend running on port ${PORT}`, { model: CLAUDE_MODEL });
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
