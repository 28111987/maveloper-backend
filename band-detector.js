// =====================================================================
// BAND DETECTION + PALETTE MODULE (v5.5.0)
// =====================================================================
// Purpose: produce pixel-exact colors and positional data about the email
// design so Claude's Stage 1 vision pass never has to GUESS colors.
//
// Responsibilities (deterministic, Node.js only):
// 1. Scan raster rows for horizontal bands of similar color
// 2. Build a palette of dominant colors sampled from pixels
// 3. Sample exact colors at specific coordinates
// 4. Post-process OCR text (fix letter-spacing, double-spaces, common errors)
//
// NOT responsibilities (delegated to Claude):
// - Deciding what a band "means" (section vs decoration vs noise)
// - Grouping bands into logical sections
// - Classifying section types
//
// This module is universal — no email-specific, brand-specific, or
// design-specific logic. Works on any PDF raster regardless of layout.
// =====================================================================

import sharp from "sharp";

// -----------------------------------------------------------
// Tunable parameters (all universal)
// -----------------------------------------------------------
const MIN_BAND_HEIGHT_PX = 2;
const COLOR_SIMILARITY_THRESHOLD = 25;
const DOMINANT_COLOR_RATIO = 0.7;
const ROW_SAMPLE_STEP = 2;
const BIN_STEP = 16;
const BIN_SHIFT = 4;                         // log2(BIN_STEP) — pre-computed for hot loop
const BIN_BUCKETS_PER_CHANNEL = 256 / BIN_STEP; // 16
const BIN_TOTAL_BUCKETS = BIN_BUCKETS_PER_CHANNEL * BIN_BUCKETS_PER_CHANNEL * BIN_BUCKETS_PER_CHANNEL; // 4096

// Palette building tunables
const PALETTE_BIN_STEP = 32;                 // Coarser bin (32) collapses near-identical shades into one palette entry
const PALETTE_MIN_PREVALENCE_PX = 30;        // Min total pixel-height a color must cover to enter the palette (lowered from 50 so thinner bands survive)
const PALETTE_MAX_COLORS = 24;               // Cap palette size — more than this is noise (raised from 20)
const PALETTE_GRAYSCALE_TOLERANCE = 12;      // R/G/B max-diff to consider a color "grayscale"
const TINTED_OFFWHITE_SATURATION_THRESHOLD = 6;  // Off-white shades with R-G-B spread >= this are PRESERVED (cream, ivory, etc.) instead of collapsed to white

// -----------------------------------------------------------
// Color utilities
// -----------------------------------------------------------

function rgbToHex(r, g, b) {
  const toHex = (n) => Math.round(n).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function colorDistance(rgb1, rgb2) {
  const dr = rgb1[0] - rgb2[0];
  const dg = rgb1[1] - rgb2[1];
  const db = rgb1[2] - rgb2[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function isGrayscale(rgb, tolerance = PALETTE_GRAYSCALE_TOLERANCE) {
  const [r, g, b] = rgb;
  return Math.abs(r - g) <= tolerance && Math.abs(g - b) <= tolerance && Math.abs(r - b) <= tolerance;
}

function saturation(rgb) {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min;
}

// -----------------------------------------------------------
// Row-dominant-color analysis
// -----------------------------------------------------------

/**
 * v5.5.0: typed-array bins replace the per-row string-keyed Map. For a 600x12000
 * design that's millions of fewer string allocations. Caller passes reusable
 * bin buffers so allocation happens once per detectBands() not once per row.
 */
function findDominantColor(rowPixels, channels, binCounts, binR, binG, binB) {
  binCounts.fill(0);
  binR.fill(0);
  binG.fill(0);
  binB.fill(0);

  const totalPixels = rowPixels.length / channels;
  let nonTransparent = 0;

  for (let i = 0; i < rowPixels.length; i += channels) {
    if (channels === 4 && rowPixels[i + 3] < 128) continue;
    const r = rowPixels[i];
    const g = rowPixels[i + 1];
    const b = rowPixels[i + 2];
    const idx = ((r >>> BIN_SHIFT) * BIN_BUCKETS_PER_CHANNEL + (g >>> BIN_SHIFT)) * BIN_BUCKETS_PER_CHANNEL + (b >>> BIN_SHIFT);
    binCounts[idx]++;
    binR[idx] += r;
    binG[idx] += g;
    binB[idx] += b;
    nonTransparent++;
  }

  if (nonTransparent === 0) {
    return { hex: "#FFFFFF", count: 0, total: totalPixels, ratio: 0, rgb: [255, 255, 255] };
  }

  let topIdx = 0;
  let topCount = binCounts[0];
  for (let i = 1; i < BIN_TOTAL_BUCKETS; i++) {
    if (binCounts[i] > topCount) {
      topCount = binCounts[i];
      topIdx = i;
    }
  }

  const avgR = binR[topIdx] / topCount;
  const avgG = binG[topIdx] / topCount;
  const avgB = binB[topIdx] / topCount;

  return {
    hex: rgbToHex(avgR, avgG, avgB),
    count: topCount,
    total: totalPixels,
    ratio: topCount / totalPixels,
    rgb: [avgR, avgG, avgB],
  };
}

// -----------------------------------------------------------
// Band detection (main)
// -----------------------------------------------------------

export async function detectBands(pngBuffer) {
  if (!pngBuffer || !pngBuffer.length) {
    throw new Error("detectBands: empty or missing pngBuffer");
  }
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const rowBytes = width * channels;

  // Reusable bin buffers (allocated once for all rows in this image).
  const binCounts = new Int32Array(BIN_TOTAL_BUCKETS);
  const binR = new Int32Array(BIN_TOTAL_BUCKETS);
  const binG = new Int32Array(BIN_TOTAL_BUCKETS);
  const binB = new Int32Array(BIN_TOTAL_BUCKETS);

  const rowInfo = [];
  for (let y = 0; y < height; y += ROW_SAMPLE_STEP) {
    const rowStart = y * rowBytes;
    const rowEnd = rowStart + rowBytes;
    const rowPixels = data.subarray(rowStart, rowEnd);
    const dom = findDominantColor(rowPixels, channels, binCounts, binR, binG, binB);
    rowInfo.push({
      y,
      hex: dom.hex,
      rgb: dom.rgb,
      ratio: dom.ratio,
      isSolid: dom.ratio >= DOMINANT_COLOR_RATIO,
    });
  }

  const rawBands = [];
  let currentBand = null;
  let lastSolidColor = null;

  for (const row of rowInfo) {
    let effectiveColor;
    if (row.isSolid) {
      effectiveColor = row.rgb;
      lastSolidColor = row.rgb;
    } else {
      effectiveColor = lastSolidColor || row.rgb;
    }

    if (!currentBand) {
      currentBand = {
        y_start: row.y,
        y_end: row.y + ROW_SAMPLE_STEP,
        rgb: effectiveColor,
        solidRowCount: row.isSolid ? 1 : 0,
        totalRowCount: 1,
      };
      continue;
    }

    const distance = colorDistance(currentBand.rgb, effectiveColor);
    if (distance <= COLOR_SIMILARITY_THRESHOLD) {
      currentBand.y_end = row.y + ROW_SAMPLE_STEP;
      currentBand.totalRowCount++;
      if (row.isSolid) currentBand.solidRowCount++;
    } else {
      rawBands.push(currentBand);
      currentBand = {
        y_start: row.y,
        y_end: row.y + ROW_SAMPLE_STEP,
        rgb: effectiveColor,
        solidRowCount: row.isSolid ? 1 : 0,
        totalRowCount: 1,
      };
    }
  }
  if (currentBand) rawBands.push(currentBand);

  const merged = [];
  for (const band of rawBands) {
    const bandHeight = band.y_end - band.y_start;
    if (bandHeight < MIN_BAND_HEIGHT_PX && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.y_end = band.y_end;
      prev.totalRowCount += band.totalRowCount;
      prev.solidRowCount += band.solidRowCount;
    } else {
      merged.push({ ...band });
    }
  }

  if (merged.length > 0) {
    merged[merged.length - 1].y_end = Math.min(merged[merged.length - 1].y_end, height);
  }

  const bands = merged.map((b, i) => {
    const h = b.y_end - b.y_start;
    const rowCoverageRatio = b.solidRowCount / Math.max(b.totalRowCount, 1);
    // v5.4.0: An "is_likely_artifact" flag identifies thin bands that are likely
    // JPEG compression noise at section boundaries rather than intentional design
    // elements. Used downstream in fixThinBands() to drop hallucinated thin bands
    // even when their color happens to overlap with a real palette color.
    //
    // Heuristic: a band is likely an artifact if ALL of:
    //   - height < 5px (very thin)
    //   - low solid-row coverage (<= 0.5; mixed/transition rows dominate)
    //   - color saturation is low (gray-leaning, not vivid brand color)
    const rgb = b.rgb;
    const sat = saturation(rgb);
    const isLikelyArtifact = h < 5 && rowCoverageRatio <= 0.5 && sat < 50;

    return {
      index: i + 1,
      y_start: b.y_start,
      y_end: b.y_end,
      height: h,
      bg_hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
      is_thin: h <= 10,
      is_content: rowCoverageRatio < 0.5,
      row_coverage_ratio: rowCoverageRatio,
      is_likely_artifact: isLikelyArtifact,
    };
  });

  return { width, height, bands };
}

// -----------------------------------------------------------
// Palette builder
// -----------------------------------------------------------
// Produces a deduplicated list of the most prominent colors in the design.
// Filters out JPEG compression noise. Universal — no design assumptions.
//
// This is the "authoritative color list" that gets handed to Claude so it
// never has to GUESS a color value from the compressed PDF image.
// -----------------------------------------------------------

/**
 * Build a prominent-color palette from detected bands.
 *
 * @param {Array} bands - Output of detectBands()
 * @returns {Array<{hex, rgb, total_height_px, band_count, is_saturated, is_grayscale}>}
 */
export function buildColorPalette(bands) {
  const buckets = new Map();

  for (const band of bands) {
    const rgb = hexToRgb(band.bg_hex);
    // Palette-group bin (PALETTE_BIN_STEP) collapses near-identical shades
    const binR = Math.floor(rgb[0] / PALETTE_BIN_STEP) * PALETTE_BIN_STEP;
    const binG = Math.floor(rgb[1] / PALETTE_BIN_STEP) * PALETTE_BIN_STEP;
    const binB = Math.floor(rgb[2] / PALETTE_BIN_STEP) * PALETTE_BIN_STEP;
    const key = `${binR},${binG},${binB}`;

    const existing = buckets.get(key);
    if (existing) {
      const newTotal = existing.total_height_px + band.height;
      existing.avg_r = (existing.avg_r * existing.total_height_px + rgb[0] * band.height) / newTotal;
      existing.avg_g = (existing.avg_g * existing.total_height_px + rgb[1] * band.height) / newTotal;
      existing.avg_b = (existing.avg_b * existing.total_height_px + rgb[2] * band.height) / newTotal;
      existing.total_height_px = newTotal;
      existing.band_count++;
    } else {
      buckets.set(key, {
        avg_r: rgb[0],
        avg_g: rgb[1],
        avg_b: rgb[2],
        total_height_px: band.height,
        band_count: 1,
      });
    }
  }

  const palette = Array.from(buckets.values()).map((b) => {
    const rgb = [b.avg_r, b.avg_g, b.avg_b];
    const sat = saturation(rgb);
    const avg = (rgb[0] + rgb[1] + rgb[2]) / 3;
    // A "tinted off-white" is a light shade that is NOT pure white and has a subtle color tint.
    // Example: a cream off-white shade (R=245,G=245,B=232 — avg 240, tint spread 13)
    // We preserve these separately from pure white because they carry design meaning.
    const is_tinted_offwhite = avg >= 225 && sat >= TINTED_OFFWHITE_SATURATION_THRESHOLD;
    // A "pure-white-ish" shade has negligible tint and is very bright.
    const is_pure_whiteish = avg >= 245 && sat < TINTED_OFFWHITE_SATURATION_THRESHOLD;
    return {
      hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
      rgb,
      total_height_px: Math.round(b.total_height_px),
      band_count: b.band_count,
      saturation: sat,
      is_saturated: sat > 40,
      is_grayscale: isGrayscale(rgb),
      is_tinted_offwhite,
      is_pure_whiteish,
    };
  });

  // Filter: keep if saturated OR tinted-offwhite OR sufficiently prevalent
  // This ensures cream / ivory / off-white brand tints survive
  const filtered = palette.filter(
    (p) => p.is_saturated || p.is_tinted_offwhite || p.total_height_px >= PALETTE_MIN_PREVALENCE_PX
  );

  // Sort by prevalence, cap size
  filtered.sort((a, b) => b.total_height_px - a.total_height_px);
  return filtered.slice(0, PALETTE_MAX_COLORS);
}

/**
 * Sample the exact color at a specific pixel coordinate.
 */
export async function samplePixelColor(pngBuffer, x, y) {
  if (!pngBuffer || !pngBuffer.length) {
    throw new Error("samplePixelColor: empty or missing pngBuffer");
  }
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const cx = Math.max(0, Math.min(width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(height - 1, Math.round(y)));
  const idx = (cy * width + cx) * channels;
  return rgbToHex(data[idx], data[idx + 1], data[idx + 2]);
}

/**
 * Crop a specific band out of a source PNG and return as a fresh PNG buffer.
 * Kept for any future per-region analysis. Not used in v5.0.0 Stage 1 flow.
 */
export async function cropBand(pngBuffer, y_start, y_end) {
  if (!pngBuffer || !pngBuffer.length) {
    throw new Error("cropBand: empty or missing pngBuffer");
  }
  const meta = await sharp(pngBuffer).metadata();
  const width = meta.width || 0;
  const height = Math.max(1, y_end - y_start);

  return await sharp(pngBuffer)
    .extract({
      left: 0,
      top: Math.max(0, y_start),
      width,
      height: Math.min(height, (meta.height || y_end) - y_start),
    })
    .png()
    .toBuffer();
}

// -----------------------------------------------------------
// OCR post-processing
// -----------------------------------------------------------
// Universal fixes for Tesseract OCR output.
// No design-specific, email-specific, or brand-specific patterns.
// -----------------------------------------------------------

// v5.5.0: regex literals hoisted to module scope so they're not recompiled
// on every postProcessOcr call.
const OCR_LETTER_SPACED_CAPS = /(?:\b[A-Z]{1,2}\s){2,}[A-Z]{1,2}\b/g;
const OCR_INNER_WHITESPACE = /\s+/g;
const OCR_DOUBLE_SPACE = / {2,}/g;
const OCR_SPACE_BEFORE_PUNCT = /\s+([,.!?;:])/g;
const OCR_MISSING_SPACE_AFTER_PUNCT = /([.!?])([A-Z])/g;
const OCR_STRAY_SINGLE_LETTER = /\s([b-hj-z])\s/g;
const OCR_AL_BEFORE_CAPITAL = /\bAl(?=[\s\-'][A-Z])/g;
const OCR_AL_BEFORE_LOWER = /\bAl(?=\s[a-z])/g;

export function postProcessOcr(rawText) {
  if (!rawText) return "";

  let text = rawText;

  // 1. Collapse letter-spaced ALL-CAPS runs (3+ consecutive 1-2 char uppercase tokens).
  text = text.replace(OCR_LETTER_SPACED_CAPS, (match) => match.replace(OCR_INNER_WHITESPACE, ""));
  // 2. Doubled spaces → single space (preserves newlines)
  text = text.replace(OCR_DOUBLE_SPACE, " ");
  // 3. Stray space before punctuation
  text = text.replace(OCR_SPACE_BEFORE_PUNCT, "$1");
  // 4. Missing space after sentence punctuation followed by uppercase
  text = text.replace(OCR_MISSING_SPACE_AFTER_PUNCT, "$1 $2");
  // 5. Strip stray single-letter tokens (preserve valid 'a' and 'i')
  text = text.replace(OCR_STRAY_SINGLE_LETTER, " ");
  // 6. Capital-I → lowercase-l misreads: "Al" as standalone acronym → "AI"
  text = text.replace(OCR_AL_BEFORE_CAPITAL, "AI");
  text = text.replace(OCR_AL_BEFORE_LOWER, "AI");

  return text;
}
