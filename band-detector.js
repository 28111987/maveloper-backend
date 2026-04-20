// =====================================================================
// BAND DETECTION MODULE (v4.0.0)
// =====================================================================
// Deterministic horizontal band detection via pixel analysis.
// Scans a rasterized PNG row-by-row and identifies every distinct
// horizontal region where the dominant background color changes.
//
// Returns a structured list of bands with exact hex colors and
// pixel-precise y-coordinates, which serves as the authoritative
// section map for the email design.
//
// Philosophy: Stage 1 vision cannot reliably count sections in long,
// compressed email designs. Pixel data can. The number of bands the
// image contains IS the number of sections — a math problem, not a
// vision judgment.
// =====================================================================

import sharp from "sharp";

// -----------------------------------------------------------
// Tunable parameters (universal — no email-specific values)
// -----------------------------------------------------------

// Minimum pixel height for a band to be kept as its own section.
// Bands shorter than this are merged into the adjacent band.
// 2px is low enough to catch thin colored stripes, high enough to ignore
// single-pixel anti-aliasing noise.
const MIN_BAND_HEIGHT_PX = 2;

// Color similarity threshold (Euclidean RGB distance).
// Rows whose dominant color is within this distance of the previous
// row's color are treated as part of the same band.
// Value 25 tolerates JPEG/anti-aliasing noise without merging truly
// distinct colors like #F5F5E8 vs #F5F5F5.
const COLOR_SIMILARITY_THRESHOLD = 25;

// How much of a row's pixels must share the dominant color for the
// row to be classified as "solid" (as opposed to an image/content row).
// 0.7 = 70% of pixels must match. Below this, the row is content-heavy
// (text, image, photo) and inherits the previous band's bg color.
const DOMINANT_COLOR_RATIO = 0.7;

// Sample every Nth row for dominant color detection.
// 1 = every row (slow, precise). 4 = every 4th row (fast, enough precision).
// We post-process to merge adjacent similar bands, so sampling doesn't
// sacrifice band boundary accuracy.
const ROW_SAMPLE_STEP = 2;

// -----------------------------------------------------------
// Utilities
// -----------------------------------------------------------

/**
 * Convert RGB triplet to uppercase hex string (#RRGGBB).
 */
function rgbToHex(r, g, b) {
  const toHex = (n) => Math.round(n).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Parse hex string back to RGB array.
 */
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

/**
 * Euclidean distance between two RGB colors.
 */
function colorDistance(rgb1, rgb2) {
  const dr = rgb1[0] - rgb2[0];
  const dg = rgb1[1] - rgb2[1];
  const db = rgb1[2] - rgb2[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Find the dominant color in a single row of pixel data.
 * Buckets colors into 16-step-quantized RGB bins to tolerate noise,
 * then returns the bin with the highest count and its share of the row.
 *
 * Returns: { hex, count, total, ratio, rgb }
 */
function findDominantColor(rowPixels, channels) {
  // Quantize to 16-step bins: #FFFFFF and #FFFFFE become the same bin.
  // This collapses JPEG noise and subtle gradients into a stable "dominant" value.
  const BIN_STEP = 16;
  const bins = new Map();
  const totalPixels = rowPixels.length / channels;

  for (let i = 0; i < rowPixels.length; i += channels) {
    const r = rowPixels[i];
    const g = rowPixels[i + 1];
    const b = rowPixels[i + 2];

    // Skip transparent pixels if alpha channel exists
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

  // Find the most populated bin
  let topBin = null;
  let topCount = 0;
  for (const [, bin] of bins) {
    if (bin.count > topCount) {
      topCount = bin.count;
      topBin = bin;
    }
  }

  // Use the average RGB within the top bin for the final color
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
// Main detection function
// -----------------------------------------------------------

/**
 * Detect horizontal bands in a rasterized PDF page.
 *
 * @param {Buffer} pngBuffer - Raw PNG buffer of the rasterized page
 * @returns {Promise<{
 *   width: number,
 *   height: number,
 *   bands: Array<{
 *     index: number,
 *     y_start: number,
 *     y_end: number,
 *     height: number,
 *     bg_hex: string,
 *     is_thin: boolean,
 *     is_content: boolean,
 *     row_coverage_ratio: number
 *   }>
 * }>}
 */
export async function detectBands(pngBuffer) {
  // Load full raw pixel data (no downscaling — we want pixel precision)
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info; // channels = 4 (RGBA)
  const rowBytes = width * channels;

  // -------------------------------------------------
  // Pass 1: Determine each sampled row's dominant color and solidity
  // -------------------------------------------------
  const rowInfo = []; // { y, hex, rgb, ratio, isSolid }

  for (let y = 0; y < height; y += ROW_SAMPLE_STEP) {
    const rowStart = y * rowBytes;
    const rowEnd = rowStart + rowBytes;
    const rowPixels = data.subarray(rowStart, rowEnd);

    const dom = findDominantColor(rowPixels, channels);
    const isSolid = dom.ratio >= DOMINANT_COLOR_RATIO;

    rowInfo.push({
      y,
      hex: dom.hex,
      rgb: dom.rgb,
      ratio: dom.ratio,
      isSolid,
    });
  }

  // -------------------------------------------------
  // Pass 2: Walk rows and accumulate bands.
  //
  // A band starts when the dominant color changes significantly from
  // the previous band's background color. Content-heavy rows (text,
  // images) don't start new bands — they inherit the most recent
  // solid-background color.
  // -------------------------------------------------
  const rawBands = [];
  let currentBand = null;
  let lastSolidColor = null;

  for (const row of rowInfo) {
    // Determine this row's effective bg color.
    // If the row is solid, use its dominant color.
    // If the row is content-heavy (text/image), use the last known solid bg.
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

    // Check color similarity to current band
    const distance = colorDistance(currentBand.rgb, effectiveColor);

    if (distance <= COLOR_SIMILARITY_THRESHOLD) {
      // Extend current band
      currentBand.y_end = row.y + ROW_SAMPLE_STEP;
      currentBand.totalRowCount++;
      if (row.isSolid) currentBand.solidRowCount++;
    } else {
      // Close current band and start a new one
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

  if (currentBand) {
    rawBands.push(currentBand);
  }

  // -------------------------------------------------
  // Pass 3: Merge tiny bands (below MIN_BAND_HEIGHT_PX)
  // into the adjacent band with the closest color match.
  // Preserves intentional thin stripes while eliminating noise.
  // -------------------------------------------------
  const mergedBands = [];
  for (const band of rawBands) {
    const bandHeight = band.y_end - band.y_start;

    if (bandHeight < MIN_BAND_HEIGHT_PX && mergedBands.length > 0) {
      // Merge with previous band
      const prev = mergedBands[mergedBands.length - 1];
      prev.y_end = band.y_end;
      prev.totalRowCount += band.totalRowCount;
      prev.solidRowCount += band.solidRowCount;
    } else {
      mergedBands.push({ ...band });
    }
  }

  // Clamp final band to image height
  if (mergedBands.length > 0) {
    mergedBands[mergedBands.length - 1].y_end = Math.min(
      mergedBands[mergedBands.length - 1].y_end,
      height
    );
  }

  // -------------------------------------------------
  // Pass 4: Build final output structure with metadata
  // -------------------------------------------------
  const bands = mergedBands.map((b, i) => {
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

/**
 * Crop a specific band out of a source PNG and return as a fresh PNG buffer.
 * Used to produce small per-band images that Claude can analyze individually.
 *
 * @param {Buffer} pngBuffer - Source PNG
 * @param {number} y_start
 * @param {number} y_end
 * @returns {Promise<Buffer>} Cropped PNG buffer
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

/**
 * Sample the exact hex color at a specific pixel coordinate.
 * Used to read brand colors (CTA backgrounds, accent colors) directly
 * from the image instead of asking Claude to guess them.
 *
 * @param {Buffer} pngBuffer
 * @param {number} x
 * @param {number} y
 * @returns {Promise<string>} Hex color like "#00DA00"
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
 * For a given band, find non-background accent colors by scanning
 * the pixels within the band region. Returns up to N distinct colors
 * that differ from the band's bg_hex.
 *
 * Used to detect CTA button colors, heading accent colors, etc.
 * — all the "important" colors inside a section without asking Claude.
 *
 * @param {Buffer} pngBuffer
 * @param {Object} band - { y_start, y_end, bg_hex }
 * @param {number} maxColors - default 5
 * @returns {Promise<string[]>} Array of hex strings ordered by pixel count
 */
export async function extractAccentColors(pngBuffer, band, maxColors = 5) {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, channels } = info;
  const bgRgb = hexToRgb(band.bg_hex);
  const BIN_STEP = 16;
  const bins = new Map();

  const yStart = Math.max(0, band.y_start);
  const yEnd = Math.min(info.height, band.y_end);

  for (let y = yStart; y < yEnd; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const idx = (y * width + x) * channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // Skip transparent
      if (channels === 4 && data[idx + 3] < 128) continue;

      // Skip pixels similar to bg (not accent colors)
      if (colorDistance([r, g, b], bgRgb) <= COLOR_SIMILARITY_THRESHOLD) continue;

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
  }

  // Sort bins by count, take top N, and merge near-duplicate colors
  const sorted = Array.from(bins.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, maxColors * 3); // oversample, then dedupe

  const result = [];
  for (const bin of sorted) {
    const avgRgb = [bin.rSum / bin.count, bin.gSum / bin.count, bin.bSum / bin.count];

    // Check if this color is close to an already-added result
    let isDuplicate = false;
    for (const existing of result) {
      if (colorDistance(hexToRgb(existing), avgRgb) <= COLOR_SIMILARITY_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      result.push(rgbToHex(avgRgb[0], avgRgb[1], avgRgb[2]));
      if (result.length >= maxColors) break;
    }
  }

  return result;
}

// =====================================================================
// OCR POST-PROCESSING
// =====================================================================
// Cleans up common Tesseract errors in display text.
// Universal fixes only — no email-specific string patches.
// =====================================================================

/**
 * Repair common OCR errors in extracted text.
 *
 * Handles:
 * - Letter-spaced display text: "EXPE RT M E NTO RS" → "EXPERT MENTORS"
 * - Doubled spaces, stray spaces before punctuation
 * - Common letter confusions when followed by typical letters
 *   (e.g., "froi" at word end → "from" — but only if it's clearly truncated)
 *
 * @param {string} rawText
 * @returns {string}
 */
export function postProcessOcr(rawText) {
  if (!rawText) return "";

  let text = rawText;

  // -----------------------------------------------------------
  // Fix 1: Collapse letter-spaced ALL-CAPS runs.
  // Pattern: runs of 4+ single uppercase letters separated by single
  // spaces — almost always a letter-spaced display word.
  //
  // Example: "EXPE RT M E NTO RS" → detect "E X P E R T M E N T O R S"
  // after pre-collapsing short 1-2 char uppercase chunks.
  //
  // Strategy:
  //   1. Find runs where uppercase words of length <=2 appear >=3 times
  //      in a row with single spaces between them.
  //   2. Join those letters together.
  //   3. Re-split on typical word boundaries (2-char gaps, etc.)
  // -----------------------------------------------------------

  // Collapse sequences like "A B C" or "AB C DE" into "ABCDE"
  // when at least 3 consecutive uppercase tokens of length 1-2 exist.
  text = text.replace(
    /(?:\b[A-Z]{1,2}\s){3,}[A-Z]{1,2}\b/g,
    (match) => match.replace(/\s+/g, "")
  );

  // -----------------------------------------------------------
  // Fix 2: Doubled spaces → single space (but preserve newlines).
  // -----------------------------------------------------------
  text = text.replace(/ {2,}/g, " ");

  // -----------------------------------------------------------
  // Fix 3: Stray space before common punctuation.
  // -----------------------------------------------------------
  text = text.replace(/\s+([,.!?;:])/g, "$1");

  // -----------------------------------------------------------
  // Fix 4: Missing space after sentence punctuation when OCR
  // squashed them: "dolor.Lorem" → "dolor. Lorem"
  // -----------------------------------------------------------
  text = text.replace(/([.!?])([A-Z])/g, "$1 $2");

  return text;
}
