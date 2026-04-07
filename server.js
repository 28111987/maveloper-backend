import express from "express";
import cors from "cors";
import { pdfToPng } from "pdf-to-png-converter";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const SYSTEM_PROMPT = `You will receive one or more images showing pages of an email design PDF. Your task is to generate production-ready HTML email code that visually matches the design exactly.

CRITICAL VISUAL FIDELITY RULES:
1. Match the exact visual hierarchy, spacing, padding, and proportions shown in the images. Do not approximate or improve the design.
2. Extract ALL visible text verbatim from the images. Do not paraphrase, summarize, or invent copy. Preserve capitalization, punctuation, and line breaks.
3. Identify the column structure of each section (1-column, 2-column, 3-column) and use the em_ th-based stacking pattern from the framework.
4. Identify all CTAs as bulletproof table-cell buttons per the framework, matching colors, padding, and corner radius from the design.
5. Output only the final HTML — no markdown fences, no explanations, no commentary.

---const express = require("express");
const cors = require("cors");
require("dotenv").config();
const axios = require("axios");

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  next();
});
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.post("/generate", async (req, res) => {
  try {
    const { pdfBase64, brandName } = req.body;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: `Convert this PDF into email HTML. Brand: ${brandName}. PDF: ${pdfBase64}`
          }
        ]
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );

    res.json({
      html: response.data.content[0].text
    });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
  error: "Failed",
  details: err.response?.data || err.message
});
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});`;

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
