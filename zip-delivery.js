// =====================================================================
// ZIP DELIVERY — the /approve deliverable packager (extracted verbatim from
// server.js so it can be unit-tested without booting the Express app).
//
// This is THE ZIP path, relocated — NOT a parallel one. server.js imports
// buildDeliveryZip from here and calls it exactly as before. Behaviour is
// byte-identical to the in-server definition it replaced.
// =====================================================================
import AdmZip from "adm-zip";

/**
 * Build the final deliverable ZIP containing:
 * - ORDER_ID.html (with relative image paths)
 * - images/ folder with all image files
 *
 * For every [filename, dropboxUrl] in imageUrlMap the HTML's absolute Dropbox
 * URL is swapped back to a local `images/<filename>` reference and the matching
 * image buffer is bundled under images/. Any imageUrlMap entry flows through
 * this same localisation — including compiler slice images once their map has
 * been merged in (see mergeCompilerSlices).
 */
export function buildDeliveryZip(orderId, htmlWithDropboxUrls, imageUrlMap, images) {
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

/**
 * Fold the compiler's slice-image map into the Figma-flow imageUrlMap so the
 * /approve ZIP localises the slice PNGs the SAME way it localises node exports.
 *
 * INERT on the LLM path: when compilerImageUrlMap is absent/empty the ORIGINAL
 * imageUrlMap object is returned by reference (no copy, no new keys), so a
 * downstream ZIP build is byte-identical to today. On the compiler path the
 * slice entries win on key collision (they are what the delivered HTML actually
 * references), which is correct.
 */
export function mergeCompilerSlices(imageUrlMap, compilerImageUrlMap) {
  const base = imageUrlMap || {};
  if (!compilerImageUrlMap || typeof compilerImageUrlMap !== "object") return base;
  if (Object.keys(compilerImageUrlMap).length === 0) return base;
  return { ...base, ...compilerImageUrlMap };
}
