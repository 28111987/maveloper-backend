import express from "express";
import cors from "cors";
import { pdfToPng } from "pdf-to-png-converter";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const SYSTEM_PROMPT = `You are an expert email developer at Mavlers. You will receive one or more images showing pages of an email design PDF. Your task is to generate production-ready HTML email code that visually matches the design exactly.

CRITICAL VISUAL FIDELITY RULES:
1. Match the exact visual hierarchy, spacing, padding, and proportions shown in the images. Do not approximate or improve the design.
2. Extract ALL visible text verbatim from the images. Do not paraphrase, summarize, or invent copy. Preserve capitalization, punctuation, and line breaks.
3. Identify the column structure of each section (1-column, 2-column, 3-column) and use th-based stacking for responsive behavior.
4. Identify all CTAs as bulletproof table-cell buttons, matching colors, padding, and corner radius from the design.
5. Output only the final HTML — no markdown fences, no explanations, no commentary.

TECHNICAL FRAMEWORK (Mavlers standard):
- DOCTYPE: XHTML 1.0 Transitional with VML/Office namespaces
- Class naming: use em_ prefix (em_main_table, em_wrapper, em_body, em_hide, em_full_img, em_dark, em_mob_block, em_hauto)
- Table widths: 600-700px max, table-layout: fixed
- Responsive: th-based fluid-hybrid stacking, breakpoints at 599px and 667px
- Outlook reset: capital-M Margin and capital-P Padding
- Dark mode: prefers-color-scheme meta tag plus class overrides (em_dark, em_dm_txt_white)
- CTAs: bulletproof table-cell with bgcolor and border-radius, VML fallback for Outlook
- Use role="presentation" on all layout tables
- Inline all CSS for maximum client compatibility`;

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
      viewportScale: 2.0,
      disableFontFace: false,
      useSystemFonts: false,
    });

    console.log(`Rasterized ${pngPages.length} pages. Sending to Claude...`);

    const imageBlocks = pngPages.map((page) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: page.content.toString("base64"),
      },
    }));

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: "Generate production-ready HTML email code for the design shown in the images above. Follow the Mavlers Email Coding Framework exactly. Output only the HTML — no explanations, no markdown code fences.",
            },
          ],
        },
      ],
    });

    const html = message.content[0].text;
    console.log("Generation complete.");

    res.json({ html, pageCount: pngPages.length });
  } catch (err) {
    console.error("Generation error:", err);
    res.status(500).json({
      error: "Generation failed",
      details: err.message,
    });
  }
});

app.listen(PORT, () => console.log(`Maveloper backend running on port ${PORT}`));
