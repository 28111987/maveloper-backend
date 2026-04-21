// =====================================================================
// BAND DETECTION + PALETTE MODULE (v5.0.0)
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

// Palette building tunables
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

function findDominantColor(rowPixels, channels) {
  const bins = new Map();
  const totalPixels = rowPixels.length / channels;

  for (let i = 0; i < rowPixels.length; i += channels) {
    const r = rowPixels[i];
    const g = rowPixels[i + 1];
    const b = rowPixels[i + 2];

    if (channels === 4) {
      const a = rowPixels[i + 3];
      if (a < 128) continue;
    }

    const binR = Math.floor(r / BIN_STEP) * BIN_STEP;
    const binG = Math.floor(g / BIN_STEP) * BIN_STEP;
    const binB = Math.floor(b / BIN_STEP) * BIN_STEP;
    const key = `${binR},${binG},${binB}`;

    const existing = bins.get(key);
    if (existing) {
      existing.count++;
      existing.rSum += r;
      existing.gSum += g;
      existing.bSum += b;
    } else {
      bins.set(key, { count: 1, rSum: r, gSum: g, bSum: b });
    }
  }

  if (bins.size === 0) {
    return { hex: "#FFFFFF", count: 0, total: totalPixels, ratio: 0, rgb: [255, 255, 255] };
  }

  let topBin = null;
  let topCount = 0;
  for (const [, bin] of bins) {
    if (bin.count > topCount) {
      topCount = bin.count;
      topBin = bin;
    }
  }

  const avgR = topBin.rSum / topBin.count;
  const avgG = topBin.gSum / topBin.count;
  const avgB = topBin.bSum / topBin.count;

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
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const rowBytes = width * channels;

  const rowInfo = [];
  for (let y = 0; y < height; y += ROW_SAMPLE_STEP) {
    const rowStart = y * rowBytes;
    const rowEnd = rowStart + rowBytes;
    const rowPixels = data.subarray(rowStart, rowEnd);
    const dom = findDominantColor(rowPixels, channels);
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
    return {
      index: i + 1,
      y_start: b.y_start,
      y_end: b.y_end,
      height: h,
      bg_hex: rgbToHex(b.rgb[0], b.rgb[1], b.rgb[2]),
      is_thin: h <= 10,
      is_content: b.solidRowCount / Math.max(b.totalRowCount, 1) < 0.5,
      row_coverage_ratio: b.solidRowCount / Math.max(b.totalRowCount, 1),
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
    // Palette-group bin (32-step) to collapse near-identical shades
    const binR = Math.floor(rgb[0] / 32) * 32;
    const binG = Math.floor(rgb[1] / 32) * 32;
    const binB = Math.floor(rgb[2] / 32) * 32;
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

export function postProcessOcr(rawText) {
  if (!rawText) return "";

  let text = rawText;

  // 1. Collapse letter-spaced ALL-CAPS runs.
  //    Pattern: 3+ consecutive uppercase tokens of length 1-2 separated by single spaces.
  //    "E X P E R T" or "EXPE RT M E NTO RS" → consolidated
  text = text.replace(
    /(?:\b[A-Z]{1,2}\s){2,}[A-Z]{1,2}\b/g,
    (match) => match.replace(/\s+/g, "")
  );

  // 2. Doubled spaces → single space (preserves newlines)
  text = text.replace(/ {2,}/g, " ");

  // 3. Stray space before punctuation
  text = text.replace(/\s+([,.!?;:])/g, "$1");

  // 4. Missing space after sentence punctuation followed by uppercase
  //    "dolor.Lorem" → "dolor. Lorem"
  text = text.replace(/([.!?])([A-Z])/g, "$1 $2");

  // 5. Strip stray single-letter tokens that OCR occasionally inserts.
  //    " f " mid-sentence (where f is a spurious char). Preserve 'a' and 'i'
  //    as they are valid English single-letter words.
  text = text.replace(/\s([b-hj-z])\s/g, " ");

  return text;
}
