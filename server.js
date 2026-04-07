import express from "express";
import cors from "cors";
import { pdfToPng } from "pdf-to-png-converter";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

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

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/generate", async (req, res) => {
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) {
      return res.status(400).json({ error: "Missing pdfBase64 in request body" });
    }

    const cleanBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, "");
    const pdfBuffer = Buffer.from(cleanBase64, "base64");

    console.log("Rasterizing PDF...");
    const pngPages = await pdfToPng(pdfBuffer, {
      viewportScale: 2.5,
      disableFontFace: false,
      useSystemFonts: false,
    });

    console.log(`Rasterized ${pngPages.length} pages. Sending to Claude...`);

    const pageBase64Array = pngPages.map((page) => page.content.toString("base64"));

    const imageBlocks = pageBase64Array.map((b64) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: b64,
      },
    }));

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
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

    const html = message.content[0].text;
    console.log("Generation complete.");

    const pageImages = pageBase64Array.map((b64) => `data:image/png;base64,${b64}`);

    res.json({
      html,
      pageCount: pngPages.length,
      pageImages,
    });
  } catch (err) {
    console.error("Generation error:", err);
    res.status(500).json({
      error: "Generation failed",
      details: err.message,
    });
  }
});

app.listen(PORT, () => console.log(`Maveloper backend running on port ${PORT}`));
