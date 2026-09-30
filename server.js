import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Dropbox } from "dropbox";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { figmaToDesignSpec } from "./figma-parser.js";
import { renderFigmaNodes, makeFilename, patchSpecImageSrcs, fetchRawImageRefUrls } from "./figma-image-export.js";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";
import { Agent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { createQueueRunner } from "./queue-runner.js";
import { createSpacesRoutes, platformOwners } from "./spaces.js";
import { createRouteDoors } from "./route-doors.js";
import { buildDeliveryZip, mergeCompilerSlices } from "./zip-delivery.js";
import { persistSliceMapToDrafts } from "./drafts-persist.js";
import { pruneImages } from "./dropbox-prune.js";
import { uploadImagesWithConcurrency, readConcurrency } from "./dropbox-upload.js";
// ★★ RUN 3 - PER-SPACE FIGMA CREDENTIALS. Built dark in runs 1 and 2; MOUNTED here.
// Everything this module does fails OPEN to the global Mavlers token, so a space
// with nothing stored behaves exactly as it does today.
import { resolveFigmaToken, describeResolution } from "./figma-credential.js";
import { createFigmaCredentialRoutes } from "./figma-credential-routes.js";
// ★★ FIGMA OAUTH RUN 1 - resolveFigmaCredential tries this space's OAuth
// connection first and falls through to resolveFigmaToken UNCHANGED when
// there is none. Fails OPEN exactly like the resolver it wraps: a space with
// no OAuth connection and no pasted token behaves exactly as it does today.
import { resolveFigmaOAuth, shapeOAuthResolution, figmaCredentialProvenanceLine } from "./figma-oauth.js";
import { createFigmaOAuthRoutes } from "./figma-oauth-routes.js";
import {
  sanitizeOrderId,
  collectReferencedUrls,
  basenameFromUrl,
  assignLocalFilenames,
  localizeHtml,
  planDeliveredImagesFolder,
  collectDeadLocalRefs,
  gateDeliveredFolderStatic,
  detectDarkMode,
  looksCompilerAuthored,
  collectFonts,
  deriveWordFatalLedger,
  buildDeliveryNotes,
  buildCertificateText,
} from "./delivery-folder.js";
import { extractAssetRefs, isRemoteRef, assetBasename, rewriteRefsByBasename } from "./asset-refs.js";
// ★ ORDER-CONFIRMATION EMAIL. Two new modules, imported together and committed
// together — a backend file importing a module the deploy does not have is a
// crash on boot. Neither adds an npm dependency: the transports are built on
// global fetch (undici, already a dependency) and node:tls/node:net.
// Inert unless ORDER_CONFIRMATION_ENABLED === "true" (default OFF).
import { buildOrderConfirmation } from "./order-confirmation.js";
import {
  isConfirmationEnabled,
  sendOrderConfirmation,
  confirmationMetaFor,
} from "./order-confirmation-transport.js";
// ★★ APPROVE IDEMPOTENCY + IMAGE-MAP RECONCILIATION. Two more pure modules,
// imported and committed together with this file for the same reason as the pair
// above. Neither adds an npm dependency (node:crypto is built in) and neither
// performs I/O: approve-idempotency.js decides, image-map-reconcile.js counts,
// and this file does the reading and writing.
import {
  approveFingerprint,
  readApproveRecord,
  decideApprove,
  buildApproveRecord,
  replayApproveResponse,
  beginApprove,
  APPROVE_RECORD_KEY,
} from "./approve-idempotency.js";
import { reconcileImageMap, summariseReconciliation } from "./image-map-reconcile.js";

// v9.1.2: set a process-wide long-timeout dispatcher for the bridge fetch.
// Previous v9.1.1 used per-call `dispatcher` option with .close() in finally,
// but Node's fetch reads the response body lazily â€” closing the Agent before
// .json() reads the body kills the in-flight read. Global dispatcher avoids
// this entirely; the agent stays alive for the process lifetime.
const BRIDGE_LONG_TIMEOUT_MS = 45 * 60 * 1000;
const _bridgeAgent = new Agent({
  headersTimeout: BRIDGE_LONG_TIMEOUT_MS,
  bodyTimeout: BRIDGE_LONG_TIMEOUT_MS,
  connectTimeout: 30 * 1000,
  keepAliveTimeout: 60 * 1000,
  keepAliveMaxTimeout: BRIDGE_LONG_TIMEOUT_MS,
});
setGlobalDispatcher(_bridgeAgent);

// =====================================================================
// STARTUP VALIDATION
// =====================================================================
const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY;
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET;
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;

const dropboxConfigured = Boolean(DROPBOX_APP_KEY && DROPBOX_APP_SECRET && DROPBOX_REFRESH_TOKEN);

if (!dropboxConfigured) {
  console.warn("WARNING: Dropbox credentials not fully configured. Image upload and ZIP delivery will be disabled.");
  console.warn("Set DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN in Railway Variables.");
}

// v6.0.0: Figma API token for the /generate-from-figma endpoint.
// Optional â€” if not set, only the PDF /generate endpoint is available.
const FIGMA_API_TOKEN = process.env.FIGMA_API_TOKEN;
const figmaConfigured = Boolean(FIGMA_API_TOKEN);
if (!figmaConfigured) {
  console.warn("WARNING: FIGMA_API_TOKEN not set. /generate-from-figma will return 503 until configured.");
}

// =====================================================================
// CONFIGURATION
// =====================================================================
const PORT = process.env.PORT || 3000;
// Charter Â§1.1 â€” bridge path defaults to Opus. Env override allows Sonnet
// experimentation without redeploy. Short-token form ("opus"/"sonnet"/"haiku")
// to match the bridge resolver's allowlist (bridge-server.mjs ALLOWED_MODELS).
const BRIDGE_DEFAULT_MODEL = process.env.BRIDGE_DEFAULT_MODEL || "opus";

// v9.6.0 â€” server-side queue runner master switch. SHIPPED DARK: with this
// unset or "false", the runner never starts and no runner-driven writes occur,
// so backend behaviour is unchanged. Flip to "true" only AFTER the /os client
// runner is disabled (never run both â€” they would double-dispatch). This flag
// also gates the /approve dropbox_url write-back (spec Â§9) so the dark build is
// byte-for-byte unchanged; see the note there.
const RUNNER_ENABLED = process.env.RUNNER_ENABLED === "true";

// =====================================================================
// v8.0.0 â€” REFERENCE HTML LIBRARY
//
// Map Figma fileKey â†’ human-coded HTML reference path. When a request
// arrives for one of these files, Stage 2 receives the human-coded
// HTML as a few-shot example, instructed to MATCH ITS STYLISTIC
// PATTERNS (bordered cards, capsule pills, vertical-line dividers,
// red status colors, side-by-side layouts) while adapting structure
// and content to the new spec.
//
// To add a new reference:
//   1. Drop the human-coded HTML into ./references/<name>.html
//   2. Map the Figma fileKey to that path in REFERENCE_LIBRARY below
//   3. Restart the server (references load at boot)
// =====================================================================
const __dirname_v8 = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_LIBRARY = {
  // Arsenal Pulse â€” Candidate Intelligence Report
  "GPBtdVIKA5RMOHK3TITYvZ": path.join(__dirname_v8, "references", "arsenal-pulse.html"),
  // Add more entries as human-coded references become available
};

const REFERENCE_CACHE = new Map();
for (const [fileKey, refPath] of Object.entries(REFERENCE_LIBRARY)) {
  try {
    if (existsSync(refPath)) {
      const content = readFileSync(refPath, "utf-8");
      REFERENCE_CACHE.set(fileKey, content);
      console.log(`[v8.0.0] Loaded reference HTML for ${fileKey}: ${refPath} (${Math.round(content.length / 1024)}KB)`);
    } else {
      console.warn(`[v8.0.0] Reference path missing: ${refPath}`);
    }
  } catch (err) {
    console.warn(`[v8.0.0] Failed to load reference ${refPath}:`, err.message);
  }
}

const SERVER_TIMEOUT_MS = 600 * 1000;      // 10 min — must exceed engine dispatch wait + Dropbox upload time

// ── ★ DROPBOX UPLOAD CONCURRENCY — A RAILWAY SETTING, NOT A COMMIT ──────────
// Was a hardcoded 3. THE RECORDED REASON, and it is a belief rather than an
// incident: commit 4cc586e "fix: reduce Dropbox batch size + retry failed
// uploads (v1.3.6)", 14 Apr 2026, moved it 5 → 3 in the same diff that added the
// failedImages retry queue, and rewrote the doc comment from "batches of 5 for
// speed without hitting rate limits" to "batches of 3 with retry logic for
// rate-limited requests". No 429 is quoted, no error text, no order id, no
// measurement — and the value has not moved since. It is reported here rather
// than deleted, because the person who wrote it may have been looking at
// something the commit does not record.
//
// WHAT DROPBOX ACTUALLY DOCUMENTS for the endpoints this code names — filesUpload
// (/2/files/upload) and sharingCreateSharedLinkWithSettings — is NOT a published
// requests-per-second figure. It is: 429 `too_many_requests` with a Retry-After
// header, and 429 `too_many_write_operations` when concurrent writes contend for
// a lock on the SAME namespace, which is exactly what N parallel uploads into one
// order folder do. There is no documented number to be 3 or 12 units of, so the
// old value could not have been derived from the docs either.
//
// The default is 12. Reverting is `DROPBOX_UPLOAD_CONCURRENCY=3` in Railway and a
// restart — deliberately not a commit, because the width is the thing under test
// and the owner must be able to put it back at 02:00 without a deploy.
const DROPBOX_BATCH_SIZE = readConcurrency(process.env.DROPBOX_UPLOAD_CONCURRENCY, 12, 1, 32);
const DROPBOX_BATCH_RETRY_DELAY_MS = 2000;
const DROPBOX_RETRY_INTERVAL_MS = 500;
// images/ prune (dropbox-prune.js): how hard to retry a rate-limited delete, and
// how long to poll a filesDeleteBatch async job before giving up (best-effort).
const DROPBOX_DELETE_MAX_ATTEMPTS = 5;
const DROPBOX_DELETE_POLL_INTERVAL_MS = 1000;
const DROPBOX_DELETE_POLL_TIMEOUT_MS = 60 * 1000;
// small pacing gap so the delete phase does not start while the API is still hot
// from the ~25 shared-link metadata calls the materialisation loop just fired.
const DROPBOX_PRUNE_PACING_MS = 750;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const IMAGE_DOWNLOAD_CONCURRENCY = 5;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 180 * 1000;       // 3 min â€” must allow in-flight Stage 2 to finish

const ALLOWED_ORIGINS = [
  "https://mavloper.dev",
  "https://www.mavloper.dev",
  "https://maveloper.vercel.app",
  "https://maveloper.lovable.app",
  "http://localhost:3000",
  "http://localhost:5173",
  // ★ THE CONSOLE'S ACTUAL DEV PORT, and its absence has been costing reviews.
  //   vite.config.ts pins `port: 8080`, so a developer running `npm run dev`
  //   serves from an origin this list did not carry - while carrying 3000 and
  //   5173, which nothing serves on. Every backend-backed panel therefore read
  //   "Failed to fetch" locally, so the Admin screen could not be looked at
  //   before it shipped. Four console deploys went out unreviewed for this
  //   reason alone.
  //
  //   ★ AND A LOCALHOST ORIGIN IN A PRODUCTION ALLOW-LIST IS SAFE, which is
  //   worth stating because it looks wrong at a glance. An Origin header is
  //   set by the browser and cannot be forged by a page: a site at evil.com
  //   sends Origin: https://evil.com and is refused. The only way a request
  //   arrives claiming http://localhost:8080 is if it came from a page served
  //   on that port on the reader's OWN machine - which means somebody is
  //   already running code there, and CORS is no longer the boundary that
  //   matters. It also carries no credentials: `credentials: false` below, so
  //   no cookie or session rides along with it.
  "http://localhost:8080",
];

// =====================================================================
// MODULE-LEVEL UTILITIES (v5.5.0)
// =====================================================================

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() wrapped with AbortController so a hung server cannot
 * stall the request past the configured timeout.
 */
async function fetchWithTimeout(url, timeoutMs = IMAGE_DOWNLOAD_TIMEOUT_MS, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded-concurrency parallel map. Preserves input order in the output array.
 * Used to parallelize image downloads without overwhelming the network.
 */
async function mapWithConcurrency(items, concurrency, asyncFn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await asyncFn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Strip tokens / signed-URL query params for safer logging. Dropbox shared
 * links carry rlkey + st tokens that grant read access.
 */
function redactUrl(url) {
  if (!url || typeof url !== "string") return url;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

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
// SUPABASE CONFIG (Phase 1: Auth + Cloud Drafts)
// =====================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const supabaseConfigured = Boolean(
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_JWT_SECRET
);

if (!supabaseConfigured) {
  console.warn(
    "WARNING: Supabase env vars missing â€” auth middleware will reject all protected requests. " +
    "Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_JWT_SECRET in Railway Variables."
  );
}

// Admin Supabase client â€” used server-side for writes that bypass RLS.
// Only reach for this when necessary (audit logs, orchestrated multi-table writes).
// Prefer user-scoped queries from the frontend whenever possible.
const supabaseAdmin = supabaseConfigured
  ? createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// =====================================================================
// AUTH MIDDLEWARE (Phase 1)
// =====================================================================

/**
 * VERIFIED BY SUPABASE, NOT BY A SHARED SECRET.
 *
 * This read jwt.verify(token, SUPABASE_JWT_SECRET, { algorithms: ['HS256'] }).
 * Supabase has since moved the project to asymmetric signing keys and now issues
 * ES256 tokens, so every valid token was rejected with 'invalid algorithm' and
 * EVERY authenticated route answered 401: run-next, provenance and spaces alike.
 * Generation kept working only because /generate uses optionalAuth, which never
 * rejects - so the failure was invisible on the one path anybody was watching.
 *
 * Asking Supabase is the fix rather than adding ES256 to the list: the algorithm
 * is Supabase's to choose and it has changed once already. getUser verifies the
 * signature against the project's own keys, so the next rotation costs nothing.
 * It also checks revocation, which a local signature check cannot.
 */
async function requireAuth(req, res, next) {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: "Auth not configured",
      details: "Backend has no Supabase client. Contact admin.",
    });
  }

  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) {
    return res.status(401).json({ error: "Missing Authorization: Bearer <token> header" });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(match[1]);
    if (error || !data?.user) {
      return res.status(401).json({
        error: "Invalid or expired token",
        details: error?.message || "Supabase did not recognise this token",
      });
    }
    req.user = {
      id: data.user.id,
      email: data.user.email,
      role: data.user.role,
    };
    return next();
  } catch (err) {
    return res.status(401).json({
      error: "Invalid or expired token",
      details: err.message,
    });
  }
}

// =====================================================================
// DROPBOX HELPERS
// =====================================================================

/**
 * Get the Dropbox folder path for an order.
 * Format: /maveloper/<YYYY>/<MM-YYYY>/<ORDER ID>   (Mavlers human-coded layout)
 *
 * The NEW <YYYY> level sits above the existing month folder so the year rolls
 * over (a 2027 order lands under /maveloper/2027/01-2027/â€¦) and the month keeps
 * auto-rolling (08-2026 when August arrives) â€” both derived from `new Date()`.
 * ALL Dropbox writes (generation images, preview, and the /approve delivery
 * folder) go through this one function, so image/preview/html always share a
 * folder keyed by the same order id.
 */
function getDropboxFolderPath(orderId) {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  return `/${yyyy}/${mm}-${yyyy}/${orderId}`;
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
 * Bounded-concurrency worker pool at DROPBOX_BATCH_SIZE (env
 * DROPBOX_UPLOAD_CONCURRENCY, default 12) with one serial retry sweep.
 * Returns a map: { "hero.jpg": "https://dl.dropboxusercontent.com/..." }
 *
 * ★ THE SCHEDULER LIVES IN dropbox-upload.js so the failure path can be exercised
 * without a live order — see that file's header. This wrapper injects the real
 * uploadToDropbox, so the bytes, the Dropbox paths and the returned URLs are
 * produced by the same call as before; imageUrlMap keys are inserted in INPUT
 * order, which is what Stage 2's === IMAGE ASSETS REFERENCE === block renders.
 *
 * ALL THREE CALL SITES SHARE THIS ONE FUNCTION: the PDF path, Figma Phase B
 * (before Stage 2), and /bridge-callback's compiler slice upload (after the
 * callback). One width setting moves all three.
 */
async function uploadImagesToDropbox(orderId, images, logFn) {
  const folderPath = getDropboxFolderPath(orderId);
  return uploadImagesWithConcurrency({
    images,
    folderPath,
    uploadOne: (dropboxFilePath, buffer) => uploadToDropbox(dropboxFilePath, buffer),
    logFn,
    concurrency: DROPBOX_BATCH_SIZE,
    retryDelayMs: DROPBOX_BATCH_RETRY_DELAY_MS,
    interRetryMs: DROPBOX_RETRY_INTERVAL_MS,
    sleep: sleepMs,
    orderId,
    redact: redactUrl,
  });
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

/**
 * Upload one file into a delivery FOLDER (no per-file shared link). Folder-
 * internal files (the html, images/, preview.png, the two .txt files) are
 * referenced by the html as LOCAL relative paths, so they never need their own
 * public link â€” only the folder gets one (createFolderShareLink). Overwrite mode
 * so a re-approve replaces cleanly. Returns nothing; throws on hard failure.
 */
async function uploadFileToDropboxRaw(filePath, fileBuffer) {
  await dbx.filesUpload({
    path: filePath,
    contents: fileBuffer,
    mode: { ".tag": "overwrite" },
    mute: true,
  });
}

/**
 * Does a Dropbox path already exist? Used to avoid clobbering a preview.png /
 * certificate.txt that generation (or /bridge-callback) already co-located.
 * Any error (incl. not_found) â†’ false.
 */
async function dropboxPathExists(filePath) {
  try {
    await dbx.filesGetMetadata({ path: filePath });
    return true;
  } catch {
    return false;
  }
}

/**
 * List the FILE names (not subfolders) directly inside a Dropbox folder. Used by
 * /approve to trim images/ to exactly the delivered-html reference set. Paginates
 * so a large folder is fully enumerated. Throws on a hard failure (e.g. the folder
 * does not exist) so the caller can decide to skip the trim (never fatal to
 * delivery). Returns an array of bare filenames.
 */
async function dropboxListFolderNames(folderPath) {
  const names = [];
  let resp = await dbx.filesListFolder({ path: folderPath });
  for (;;) {
    for (const e of resp.result.entries) {
      if (e[".tag"] === "file") names.push(e.name);
    }
    if (!resp.result.has_more) break;
    resp = await dbx.filesListFolderContinue({ cursor: resp.result.cursor });
  }
  return names;
}

/**
 * SERVER-SIDE copy of one Dropbox file to another path IN THE SAME ACCOUNT, with
 * overwrite semantics. The bytes never leave Dropbox (no Railway download/upload).
 * filesCopyV2 refuses to overwrite (throws to/conflict/file), so on a dest conflict
 * (a re-approve) we delete the stale destination and re-copy â€” idempotent, and the
 * delivered bytes always match the source. Throws if the copy cannot be done
 * server-side (e.g. the source path is not in this account); callers decide the
 * fallback. Returns "copied" | "overwritten" on success.
 */
async function dbxServerCopyOverwrite(fromPath, toPath) {
  try {
    await dbx.filesCopyV2({ from_path: fromPath, to_path: toPath, autorename: false });
    return "copied";
  } catch (e) {
    const summary = e?.error?.error_summary || e?.error_summary || "";
    if (/to\/conflict/.test(summary)) {
      try { await dbx.filesDeleteV2({ path: toPath }); } catch {}
      await dbx.filesCopyV2({ from_path: fromPath, to_path: toPath, autorename: false });
      return "overwritten";
    }
    throw e;
  }
}

/**
 * Resolve a Dropbox SHARE URL (as embedded in delivered html:
 *   https://dl.dropboxusercontent.com/scl/fi/HASH/name?rlkey=KEY&raw=1)
 * back to its PATH in THIS Dropbox account, so it can be server-side-copied
 * instead of downloaded+re-uploaded. Uses sharingGetSharedLinkMetadata, whose
 * `path_lower` is populated ONLY when the linked file lives in the authenticated
 * account â€” which is exactly the "is this our file?" test we need. Returns the
 * path string, or null for any non-Dropbox URL, a link we do NOT own, or any
 * error (caller then falls back to download+upload â€” no image is ever dropped).
 */
async function resolveDropboxPathFromShareUrl(url) {
  if (typeof url !== "string" || !/dropbox(usercontent)?\.com/i.test(url)) return null;
  // Normalise the direct-download variant back to the canonical share form the
  // metadata API expects: dl.dropboxusercontent.com -> www.dropbox.com, raw/dl=1 -> dl=0.
  let shareUrl = url.replace("dl.dropboxusercontent.com", "www.dropbox.com");
  if (shareUrl.includes("raw=1")) shareUrl = shareUrl.replace("raw=1", "dl=0");
  else if (shareUrl.includes("dl=1")) shareUrl = shareUrl.replace("dl=1", "dl=0");
  try {
    const md = await dbx.sharingGetSharedLinkMetadata({ url: shareUrl });
    const res = md?.result;
    if (res && res[".tag"] === "file") return res.path_lower || res.path_display || null;
    return null;
  } catch {
    return null;
  }
}

/**
 * Copy a Dropbox file from one path to another (overwrite dest). Best-effort:
 * returns true on success, false on any failure. Prefers a SERVER-SIDE copy (no
 * Railway bandwidth); only if that is impossible does it fall back to the original
 * download + re-upload. Used to pull a generation-time preview.png into the
 * owner-named delivery folder when the two ended up keyed differently.
 */
async function dropboxCopyFile(fromPath, toPath) {
  try {
    await dbxServerCopyOverwrite(fromPath, toPath);
    return true;
  } catch (copyErr) {
    log("warn", "dropboxCopyFile: server-side copy failed, falling back to download+upload", {
      fromPath, toPath, error: copyErr?.message,
    });
  }
  try {
    // filesDownload then re-upload â€” the pre-existing fallback path.
    const dl = await dbx.filesDownload({ path: fromPath });
    const buf = dl?.result?.fileBinary
      ? Buffer.from(dl.result.fileBinary)
      : (dl?.result?.fileBlob ? Buffer.from(await dl.result.fileBlob.arrayBuffer()) : null);
    if (!buf) return false;
    await uploadFileToDropboxRaw(toPath, buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create (or retrieve) a public shared link for a delivery FOLDER and return the
 * regular Dropbox share URL (nicer UX than a direct-download link; Dropbox zips
 * the folder for the recipient on download â€” exactly the "loose folder" the owner
 * wants). Mirrors the ZIP link logic in uploadZipToDropbox.
 */
async function createFolderShareLink(folderPath) {
  try {
    const linkResult = await dbx.sharingCreateSharedLinkWithSettings({
      path: folderPath,
      settings: { requested_visibility: { ".tag": "public" }, audience: { ".tag": "public" } },
    });
    return linkResult.result.url;
  } catch (linkErr) {
    if (linkErr?.error?.error?.[".tag"] === "shared_link_already_exists") {
      const existing = await dbx.sharingListSharedLinks({ path: folderPath, direct_only: true });
      if (existing.result.links.length > 0) return existing.result.links[0].url;
    }
    throw linkErr;
  }
}

// =====================================================================
// IMAGE EXTRACTION FROM PDF
// =====================================================================


// =====================================================================
// POST-PROCESSING PIPELINE (v5.1.0) â€” Deterministic fix-ups after Stage 2
// =====================================================================
// These fix failures that prompt rules alone cannot reliably solve:
//  1. Image URL replacement (local paths -> Dropbox URLs)
//  2. Near-white normalization (JPEG-shifted near-white -> pure white)
//  3. Alert-bar text contrast (force readable text color)
//  4. Activity-feed detection (strip bullet-list wrapping of day/time patterns)
//  5. Hallucinated thin band removal (drop non-palette thin bands)
//  6. Cream/accent preservation (already handled by palette lock, no-op here)
//
// Universal. No brand-specific strings or hex values.
// =====================================================================

function hexToRgbTriplet(hex) {
  if (!hex || !/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.substring(1, 3), 16),
    parseInt(hex.substring(3, 5), 16),
    parseInt(hex.substring(5, 7), 16),
  ];
}

function isNearWhite(hex) {
  const rgb = hexToRgbTriplet(hex);
  if (!rgb) return false;
  return rgb[0] >= 248 && rgb[1] >= 248 && rgb[2] >= 248 && hex.toUpperCase() !== "#FFFFFF";
}

function isBrightWarm(hex) {
  // Orange / yellow / warm red bgs typically have R > B, G > B, and R+G > 300
  const rgb = hexToRgbTriplet(hex);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return r > b + 30 && r + g > 300 && (r + g + b) > 400;
}

function isDarkColor(hex) {
  const rgb = hexToRgbTriplet(hex);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  // Luminance approx
  return (r * 0.299 + g * 0.587 + b * 0.114) < 90;
}

function saturationOfHex(hex) {
  const rgb = hexToRgbTriplet(hex);
  if (!rgb) return 0;
  return Math.max(...rgb) - Math.min(...rgb);
}

/**
 * Fix 1: Replace relative image paths with Dropbox URLs.
 * Scans for src="...filename" where filename matches a key in imageUrlMap.
 * Reliable string replace, zero Claude guessing.
 */
function fixImageUrls(html, imageUrlMap, imageDimensionsMap, options = {}) {
  if (!imageUrlMap || Object.keys(imageUrlMap).length === 0) {
    return { html, replaced: 0, unmatched: [], sequentialFallbacks: 0, fallbackUsed: [] };
  }

  let replaced = 0;
  let sequentialFallbacks = 0;
  const unmatched = [];
  const fallbackUsed = []; // {invented, actual, url} for each sequential fallback
  let output = html;

  // Build a case-insensitive lookup by filename
  const byName = {};
  for (const [filename, url] of Object.entries(imageUrlMap)) {
    byName[filename.toLowerCase()] = url;
  }

  // v5.4.2: Build an ORDERED list of available image filenames + URLs.
  // Used as a positional fallback when filename match fails.
  // Sort by filename (case-insensitive) so order is stable and predictable.
  const orderedImages = Object.entries(imageUrlMap)
    .map(([filename, url]) => ({
      filename,
      url,
      width: imageDimensionsMap?.[filename]?.width || null,
      height: imageDimensionsMap?.[filename]?.height || null,
    }))
    .sort((a, b) => a.filename.toLowerCase().localeCompare(b.filename.toLowerCase()));

  // First pass: exact filename matches
  output = output.replace(/\bsrc\s*=\s*["']([^"']+)["']/gi, (match, src) => {
    // Skip already-good URLs (http/https/data/cid)
    if (/^(https?:|data:|cid:)/i.test(src)) return match;

    // Extract filename (last segment of path)
    const filename = src.split("/").pop();
    if (!filename) return match;

    const lookupKey = filename.toLowerCase();
    const dropboxUrl = byName[lookupKey];

    if (dropboxUrl) {
      replaced++;
      return `src="${dropboxUrl}"`;
    }

    // No exact match â€” leave for second pass to handle
    return match;
  });

  // â”€â”€ FOLDER-FIX: the SAME exact-basename rewrite for NON-src mechanisms â”€â”€â”€â”€â”€
  // Pass 1 above is `src=`-only, and that is the second reason TEST27-1800
  // shipped 7 files short: even once the bridge forwards a background image, a
  // src-only rewrite leaves `background-image:url(assets/fill_<sha>.png)`
  // RELATIVE, so /approve's `^https?://` collector drops it and the folder is
  // short again. Mechanisms handled: CSS url(), the HTML `background=`
  // attribute, srcset candidates and poster â€” enumerated by asset-refs.js, the
  // one extractor the collector and the delivered-folder gate both use.
  //
  // Deliberately EXACT-MATCH ONLY, never positional: an unmatched background is
  // reported, never guessed at. Idempotent (remote refs are skipped), so the LLM
  // path â€” where every asset is already an absolute Dropbox URL before this runs
  // â€” is a no-op and its bytes are unchanged.
  {
    const bg = rewriteRefsByBasename(output, byName, { skipMechs: ["src"] });
    output = bg.html;
    replaced += bg.replaced;
  }

  // v9.7.0 (Figma gate Â§3): on the Figma/bridge path the spec already carries
  // absolute Dropbox URLs, so any relative src left after pass 1 is an ANOMALY,
  // not something to guess at. The positional fallback below can silently bind
  // the WRONG image, so we skip it here and instead RETURN the leftover names
  // (the caller logs a WARN). PDF path passes no options â†’ fallback runs as before.
  if (options.skipPositionalFallback) {
    // FOLDER-FIX: scan EVERY mechanism, not just src=. A leftover relative
    // background is precisely the anomaly this branch exists to surface, and the
    // src-only scan reported `unmatched: []` on TEST27-1800 while 7 backgrounds
    // sat un-rewritten â€” a clean log line over a broken delivery.
    const leftover = [];
    for (const ref of extractAssetRefs(output)) {
      if (isRemoteRef(ref.url)) continue;
      const fn = assetBasename(ref.url);
      if (!fn || /^spacer\.gif$/i.test(fn)) continue;
      leftover.push(ref.mech === "src" ? fn : `${fn} (${ref.mech})`);
    }
    return { html: output, replaced, sequentialFallbacks: 0, fallbackUsed: [], unmatched: leftover };
  }

  // v5.4.2: Second pass â€” sequential positional fallback.
  // For any remaining relative-path images, replace with images from the
  // ORDERED list in order of appearance in the HTML. This guarantees real
  // working URLs even when Stage 2 invented filenames that don't match the ZIP.
  // Logic:
  //   - Walk through remaining src="images/..." attrs in document order.
  //   - For each, assign the next available image from orderedImages.
  //   - Skip spacer.gif (intentionally local).
  //   - If we run out of images, mark as unmatched.
  let imageCursor = 0;
  output = output.replace(/\bsrc\s*=\s*["']([^"']+)["']/gi, (match, src) => {
    if (/^(https?:|data:|cid:)/i.test(src)) return match;

    const filename = src.split("/").pop();
    if (!filename) return match;

    // Skip spacer.gif intentionally (these are framework-internal placeholders)
    if (/^spacer\.gif$/i.test(filename)) return match;

    if (imageCursor < orderedImages.length) {
      const fallback = orderedImages[imageCursor];
      imageCursor++;
      sequentialFallbacks++;
      fallbackUsed.push({
        invented: filename,
        actual: fallback.filename,
        url: fallback.url,
      });
      return `src="${fallback.url}"`;
    }

    unmatched.push(filename);
    return match;
  });

  return {
    html: output,
    replaced,
    sequentialFallbacks,
    fallbackUsed,
    unmatched,
  };
}

/**
 * Fix 2: Normalize near-white colors to pure white.
 * If a hex is R,G,B all >= 248 but not exactly #FFFFFF, it's a JPEG-shifted
 * near-white artifact. Replace with #FFFFFF throughout.
 */
function fixNearWhite(html, palette) {
  // Find near-white hex values that appear in the html
  const hexRegex = /#([0-9A-Fa-f]{6})\b/g;
  const seen = new Set();
  const matches = [...html.matchAll(hexRegex)];
  for (const m of matches) {
    const hex = "#" + m[1].toUpperCase();
    if (isNearWhite(hex)) seen.add(hex);
  }

  let output = html;
  let replaced = 0;
  for (const hex of seen) {
    // Replace in all case forms
    const upper = hex.toUpperCase();
    const lower = hex.toLowerCase();
    // Count occurrences before replacement
    const upperRe = new RegExp(upper.replace("#", "#"), "g");
    const lowerRe = new RegExp(lower.replace("#", "#"), "g");
    const upperCount = (output.match(upperRe) || []).length;
    const lowerCount = (output.match(lowerRe) || []).length;
    output = output.split(upper).join("#FFFFFF");
    output = output.split(lower).join("#FFFFFF");
    replaced += upperCount + lowerCount;
  }

  return { html: output, normalizedColors: [...seen], count: replaced };
}

/**
 * Fix 3: Alert bar text contrast.
 * Scan for sections annotated with alert_bar. If bg is bright-warm, force text to
 * black. If bg is dark, force text to white.
 */
function fixAlertBarContrast(html) {
  let output = html;
  let fixes = 0;

  // Match <!-- Section_N: alert_bar --> ... <!-- // Section_N -->
  const alertBarRegex = /<!--\s*Section[^>]*alert[_ ]bar[^>]*-->[\s\S]*?<!--\s*\/\/[^>]*-->/gi;

  output = output.replace(alertBarRegex, (block) => {
    // Extract bgcolor from the content (first bgcolor we find in the block)
    const bgMatch = block.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/i);
    if (!bgMatch) return block;
    const bg = bgMatch[1].toUpperCase();

    // Determine correct text color based on bg
    let textColor;
    if (isDarkColor(bg)) {
      textColor = "#FFFFFF";
    } else {
      // For bright/warm or light bgs, text should be black for contrast
      textColor = "#000000";
    }

    // Replace any color: #XXXXXX in inline styles with textColor
    // Parse style attributes and replace color values within them.
    // Use lookbehind-safe pattern to avoid matching background-color.
    const fixed = block.replace(
      /style\s*=\s*"([^"]*)"/gi,
      (attrMatch, styleVal) => {
        const updated = styleVal.replace(
          /(^|[^\-])\bcolor\s*:\s*#[0-9A-Fa-f]{6}/g,
          (m, prefix) => `${prefix}color: ${textColor}`
        );
        return `style="${updated}"`;
      }
    );
    if (fixed !== block) fixes++;
    return fixed;
  });

  return { html: output, fixes };
}

/**
 * Fix 4: Strip bullet-list wrapping from activity-feed patterns.
 * If a <ul>...</ul> block contains <li> items matching day+time patterns
 * (e.g., "Mon/Tue/Wed ... 2.45pm" or "Jan 15 4pm"), unwrap to plain <td> rows.
 */
function fixActivityFeed(html) {
  let output = html;
  let fixes = 0;

  // Detect <ul>...</ul> blocks
  const ulRegex = /<ul\b[^>]*>([\s\S]*?)<\/ul>/gi;
  output = output.replace(ulRegex, (ulBlock, inner) => {
    // Extract li items
    const liMatches = [...inner.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)];
    if (liMatches.length < 2) return ulBlock;

    // Check if items match activity-feed pattern:
    // day-of-week (Mon|Tue|Wed|...) OR time pattern (e.g. "2.45pm", "4pm", "10:30am")
    const dayRegex = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(day)?\b/i;
    const timeRegex = /\b\d{1,2}[.:]?\d{0,2}\s*(am|pm)\b/i;

    let matches = 0;
    for (const li of liMatches) {
      const text = li[2].replace(/<[^>]+>/g, "").trim();
      if (dayRegex.test(text) || timeRegex.test(text)) matches++;
    }

    // If majority of items match, treat as activity feed â€” unwrap
    if (matches / liMatches.length < 0.5) return ulBlock;

    fixes++;
    // Convert each <li> to a <tr><td>...</td></tr> as plain text row
    const rows = liMatches
      .map((m) => {
        const liAttrs = m[1] || "";
        // Extract style from li attrs to preserve font styling
        const styleMatch = liAttrs.match(/style\s*=\s*["']([^"']*)["']/i);
        const style = styleMatch ? styleMatch[1] : "";
        const content = m[2].trim();
        return `<tr><td align="left" valign="top" style="${style}">${content}</td></tr>`;
      })
      .join("\n");
    return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%">\n${rows}\n</table>`;
  });

  return { html: output, fixes };
}

/**
 * Fix 5: Remove hallucinated thin bands.
 * Hallucinated thin bands are <tr> blocks whose only purpose is a tiny colored
 * stripe with a bgcolor that doesn't appear as a REAL section bg anywhere else
 * in the design.
 *
 * Trust rule: a thin-band color is REAL if it either:
 *  (a) is #FFFFFF, #000000, or a very-dark color (true footer/header dividers)
 *  (b) appears as the bgcolor on a NON-thin section elsewhere in the HTML
 *      (i.e., it's a color the design actually uses for content backgrounds)
 *
 * A thin_colored_band whose color satisfies neither is dropped as noise.
 */
function fixThinBands(html, palette, bandMap) {
  // Step 1: collect bgcolors used on REAL content sections (not thin-band-only sections).
  // Strategy: iterate over thin_colored_band SECTION comment blocks and capture
  // their bgcolors as "thin-only colors". Any color that appears as bgcolor
  // ONLY inside thin_colored_band sections is hallucinated noise; any color
  // that also appears elsewhere is a real design color.
  //
  // v5.4.0: Also reject bands flagged as "is_likely_artifact" by the band
  // detector (thin + low coverage + low saturation). These are JPEG compression
  // artifacts at section boundaries, not real design elements â€” even if their
  // color happens to overlap with a real palette color.
  //
  // This avoids the nested <tr> regex problem entirely.

  // Build a y-range -> artifact lookup from the band map
  const artifactColors = new Set();
  if (Array.isArray(bandMap)) {
    for (const b of bandMap) {
      if (b.is_likely_artifact) {
        artifactColors.add((b.bg_hex || "").toUpperCase());
      }
    }
  }

  const thinBandSectionRegex = /<!--\s*Section[^>]*thin[_ ]colored[_ ]band[^>]*-->[\s\S]*?<!--\s*\/\/[^>]*-->/gi;
  const thinBandColors = new Set();
  const thinBandBlockList = [];
  for (const match of html.matchAll(thinBandSectionRegex)) {
    const block = match[0];
    thinBandBlockList.push(block);
    const bgs = [...block.matchAll(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/gi)];
    for (const m of bgs) thinBandColors.add(m[1].toUpperCase());
  }

  // Remove all thin-band blocks from a temporary copy to find "other" bgcolors
  let htmlWithoutThinBands = html;
  for (const block of thinBandBlockList) {
    htmlWithoutThinBands = htmlWithoutThinBands.replace(block, "");
  }

  // Collect bgcolors that appear OUTSIDE thin-band sections (real design colors)
  const realBgColors = new Set();
  const bgRegex = /bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/gi;
  for (const m of htmlWithoutThinBands.matchAll(bgRegex)) {
    realBgColors.add(m[1].toUpperCase());
  }
  // Always trust pure white and pure black
  realBgColors.add("#FFFFFF");
  realBgColors.add("#000000");

  let output = html;
  let removed = 0;

  // Re-scan and remove thin bands whose bgcolor is NOT a real design color
  // OR which are flagged as likely artifacts by the band detector
  const thinBandRemoveRegex = /<!--\s*Section[^>]*thin[_ ]colored[_ ]band[^>]*-->[\s\S]*?<!--\s*\/\/[^>]*-->\s*/gi;

  output = output.replace(thinBandRemoveRegex, (block) => {
    const bgMatch = block.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/i);
    if (!bgMatch) return block;
    const bg = bgMatch[1].toUpperCase();

    // v5.4.0: Drop if band detector flagged this color as a likely artifact
    if (artifactColors.has(bg)) {
      removed++;
      return "";
    }

    // Trust if this color appears elsewhere as a real section bg
    if (realBgColors.has(bg)) return block;

    // Trust if color is very dark (legit footer dividers)
    if (isDarkColor(bg)) return block;

    // Trust if color is within distance 20 of any real color
    const bgRgb = hexToRgbTriplet(bg);
    for (const t of realBgColors) {
      const tRgb = hexToRgbTriplet(t);
      if (!tRgb) continue;
      const dist = Math.sqrt(
        (bgRgb[0] - tRgb[0]) ** 2 +
        (bgRgb[1] - tRgb[1]) ** 2 +
        (bgRgb[2] - tRgb[2]) ** 2
      );
      if (dist < 20) return block;
    }

    // Drop it â€” hallucinated thin band
    removed++;
    return "";
  });

  return { html: output, removed };
}

/**
 * Fix 6 (NEW in v5.2.0): Rebind section bgcolors using band_map + y-range in comments.
 *
 * Every section comment emitted by Stage 2 contains y=Y1-Y2 (e.g. "Section_8_alert_bar y=345-380").
 * We parse that y-range, look up the DOMINANT band color covering that range, and override
 * the section's bgcolor attribute. This is fully deterministic â€” no Claude guessing.
 *
 * Why this exists: Stage 1 Claude sometimes collapses distinct design colors into a
 * single palette color (e.g. cream off-white shades rendered as pure white). Stage 2 then uses
 * that wrong color. This function restores the correct color from pixel-sampled data.
 */
function rebindSectionColors(html, bandMap, palette) {
  if (!Array.isArray(bandMap) || bandMap.length === 0) {
    return { html, rebound: 0, checked: 0, skipped: "no band map" };
  }

  let rebound = 0;
  let checked = 0;

  // Normalize band_map to a sorted array of { y_start, y_end, hex }
  const bands = bandMap
    .map((b) => {
      const y = b.y || [0, 0];
      const y_start = Array.isArray(y) ? y[0] : b.y_start || 0;
      const y_end = Array.isArray(y) ? y[1] : b.y_end || 0;
      return {
        y_start: Number(y_start) || 0,
        y_end: Number(y_end) || 0,
        hex: (b.bg || b.bg_hex || "").toUpperCase(),
      };
    })
    .filter((b) => b.y_end > b.y_start && /^#[0-9A-F]{6}$/.test(b.hex))
    .sort((a, b) => a.y_start - b.y_start);

  if (bands.length === 0) {
    return { html, rebound: 0, checked: 0, skipped: "band map empty after normalize" };
  }

  // Build palette hex set for validation
  const paletteSet = new Set(
    (palette || [])
      .map((p) => (typeof p === "string" ? p : p?.hex || "").toUpperCase())
      .filter((h) => /^#[0-9A-F]{6}$/.test(h))
  );

  // Section block regex matches: <!-- Section_N_type y=Y1-Y2 --> ... <!-- // Section_N_type -->
  const sectionRegex =
    /(<!--\s*Section_(\d+)_([a-zA-Z_]+)\s+y=(\d+)-(\d+)\s*-->)([\s\S]*?)(<!--\s*\/\/\s*Section_\2(?:_\3)?\s*-->)/g;

  const output = html.replace(sectionRegex, (match, openTag, n, stype, y1, y2, body, closeTag) => {
    checked++;
    const y_start = parseInt(y1, 10);
    const y_end = parseInt(y2, 10);
    if (!(y_end > y_start)) return match;

    // Find dominant band color in this y-range (weighted by pixel coverage)
    const coverage = new Map();
    for (const band of bands) {
      const overlap = Math.max(0, Math.min(band.y_end, y_end) - Math.max(band.y_start, y_start));
      if (overlap <= 0) continue;
      coverage.set(band.hex, (coverage.get(band.hex) || 0) + overlap);
    }
    if (coverage.size === 0) return match;

    // Skip the content color if the section is a CONTENT-heavy band pattern â€” thin-colored-bands
    // already have their bg correctly set by type semantics; don't rebind them.
    if (stype === "thin_colored_band") return match;

    // Find the MOST-COVERED non-grayscale-muddy color first; fall back to overall dominant
    let domHex = null;
    let domCov = 0;
    for (const [hex, cov] of coverage) {
      if (cov > domCov) {
        domCov = cov;
        domHex = hex;
      }
    }
    if (!domHex) return match;

    // Only rebind if dominant color is actually in the palette (prevents binding to
    // JPEG shift artifacts the palette already filtered out)
    if (paletteSet.size > 0 && !paletteSet.has(domHex)) {
      // Try to find closest palette color by RGB distance
      const domRgb = hexToRgbTriplet(domHex);
      let best = null;
      let bestD = Infinity;
      for (const p of paletteSet) {
        const pRgb = hexToRgbTriplet(p);
        if (!pRgb) continue;
        const d = Math.sqrt(
          (domRgb[0] - pRgb[0]) ** 2 +
            (domRgb[1] - pRgb[1]) ** 2 +
            (domRgb[2] - pRgb[2]) ** 2
        );
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best && bestD < 30) {
        domHex = best;
      } else {
        return match; // dominant color not meaningfully in palette; leave Stage 2's choice
      }
    }

    // Extract current bgcolor in the section's outer wrapper (first bgcolor inside body)
    const bgMatch = body.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/);
    if (!bgMatch) return match;
    const currentBg = bgMatch[1].toUpperCase();

    // Don't rebind if Stage 2's choice is already correct
    if (currentBg === domHex) return match;

    // Don't rebind when dominant is pure white and current is pure white â€” no-op
    if (currentBg === "#FFFFFF" && domHex === "#FFFFFF") return match;

    // Replace the FIRST bgcolor and background-color occurrence in the section body
    let newBody = body;
    let replaced = false;
    newBody = newBody.replace(
      /bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/,
      (bgM) => {
        if (replaced) return bgM;
        if (bgM.toUpperCase().includes(currentBg)) {
          replaced = true;
          return `bgcolor="${domHex}"`;
        }
        return bgM;
      }
    );
    // Replace the matching background-color in the first inline style that contains currentBg
    newBody = newBody.replace(
      new RegExp(`background-color\\s*:\\s*${currentBg}`, "i"),
      `background-color: ${domHex}`
    );

    if (newBody !== body) rebound++;
    return openTag + newBody + closeTag;
  });

  return { html: output, rebound, checked };
}

/**
 * Fix 7 (NEW in v5.2.0): Force alert_bar sections to use a warm palette color if available.
 * Many designs use orange/yellow alert bars. If Stage 2 rendered an alert_bar on white,
 * check the palette for a bright-warm color and force it.
 */
function forceAlertBarWarmBg(html, palette) {
  let fixes = 0;
  if (!palette || palette.length === 0) return { html, fixes };

  // Find warmest color in palette (high saturation, R > B)
  const warm = (palette || [])
    .map((p) => (typeof p === "string" ? p : p?.hex || "").toUpperCase())
    .filter((h) => /^#[0-9A-F]{6}$/.test(h))
    .filter((h) => {
      const rgb = hexToRgbTriplet(h);
      if (!rgb) return false;
      const [r, g, b] = rgb;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      return sat > 100 && r > b + 40 && r + g > 300; // bright warm (orange/yellow/red)
    });

  if (warm.length === 0) return { html, fixes };
  const warmColor = warm[0];

  const alertBarRegex =
    /(<!--\s*Section_(\d+)_alert_bar(?:\s+y=\d+-\d+)?\s*-->)([\s\S]*?)(<!--\s*\/\/\s*Section_\2(?:_alert_bar)?\s*-->)/g;

  const output = html.replace(alertBarRegex, (match, openTag, n, body, closeTag) => {
    const bgMatch = body.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/);
    if (!bgMatch) return match;
    const currentBg = bgMatch[1].toUpperCase();
    if (currentBg === warmColor) return match;
    // Only override if current bg is white/near-white (likely wrong default)
    const rgb = hexToRgbTriplet(currentBg);
    if (!rgb) return match;
    const avg = (rgb[0] + rgb[1] + rgb[2]) / 3;
    if (avg < 220) return match; // current bg is not light â€” don't touch

    let newBody = body.replace(
      /bgcolor\s*=\s*["']?#[0-9A-Fa-f]{6}["']?/,
      `bgcolor="${warmColor}"`
    );
    newBody = newBody.replace(
      new RegExp(`background-color\\s*:\\s*${currentBg}`, "i"),
      `background-color: ${warmColor}`
    );
    if (newBody !== body) fixes++;
    return openTag + newBody + closeTag;
  });

  return { html: output, fixes };
}

/**
 * Fix 8 (NEW in v5.2.0): Universal luminance-based text contrast.
 *
 * For every section, compute bg luminance. If bg is DARK, force every inline
 * `color: #XYZ` inside that section to #FFFFFF. If bg is LIGHT, force every
 * text color currently set to near-white to #000000.
 *
 * This eliminates the recurring "white text on bright bg" readability failure.
 */
function universalTextContrast(html) {
  let fixes = 0;

  const sectionRegex =
    /(<!--\s*Section_(\d+)_([a-zA-Z_]+)(?:\s+y=\d+-\d+)?\s*-->)([\s\S]*?)(<!--\s*\/\/\s*Section_\2(?:_\3)?\s*-->)/g;

  const output = html.replace(sectionRegex, (match, openTag, n, stype, body, closeTag) => {
    // Skip thin bands and spacers â€” no text
    if (stype === "thin_colored_band" || stype === "spacer" || stype === "divider") {
      return match;
    }

    // Determine section bg from FIRST bgcolor in the body (outer wrapper)
    const bgMatch = body.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/);
    if (!bgMatch) return match;
    const bg = bgMatch[1].toUpperCase();
    const bgRgb = hexToRgbTriplet(bg);
    if (!bgRgb) return match;

    // Luminance (perceived brightness). < 128 = dark bg, >= 128 = light bg
    const lum = 0.299 * bgRgb[0] + 0.587 * bgRgb[1] + 0.114 * bgRgb[2];
    const isDarkBg = lum < 128;

    let newBody = body;

    // Rewrite any `color: #XXX` inside style="..." to the correct contrast color.
    // Use (^|[^\-]) lookbehind to avoid matching background-color / border-color / outline-color.
    newBody = newBody.replace(/style\s*=\s*"([^"]*)"/gi, (attrMatch, styleVal) => {
      const updated = styleVal.replace(
        /(^|[^\-])\bcolor\s*:\s*(#[0-9A-Fa-f]{6})/g,
        (colorMatch, prefix, colorHex) => {
          const cRgb = hexToRgbTriplet(colorHex);
          if (!cRgb) return colorMatch;
          const cLum = 0.299 * cRgb[0] + 0.587 * cRgb[1] + 0.114 * cRgb[2];
          const isDarkColor = cLum < 128;
          // If text color is incompatible with bg (same luminance band), invert it
          if (isDarkBg && isDarkColor) {
            return `${prefix}color: #FFFFFF`;
          }
          if (!isDarkBg && !isDarkColor) {
            return `${prefix}color: #000000`;
          }
          // Acceptable contrast â€” keep as-is. This preserves spec colors like
          // brand-green accent text on white bg (green is mid-luminance but
          // intentional). Only fix when both are same-luminance-band.
          return colorMatch;
        }
      );
      return `style="${updated}"`;
    });

    // Also fix color attributes on <font> tags (rare, but some devs use them)
    // skipped â€” master framework forbids <font>

    if (newBody !== body) fixes++;
    return openTag + newBody + closeTag;
  });

  return { html: output, fixes };
}

/**
 * Fix 9 (NEW in v5.2.0): Add a warning HTML comment if no images were uploaded.
 * Helps devs spot when they forgot the ZIP and got local paths in output.
 */

/**
 * Fix 10 (NEW in v5.2.2): CTA auto-contrast.
 *
 * When Stage 2 emits CTAs without a valid cta_color, it often defaults to #000000
 * on a dark brand bgcolor â€” producing illegible black-on-dark buttons.
 * This deterministic post-processor finds every CTA table (em_cta or matching the
 * CTA pattern) and forces readable contrast based on luminance of the CTA bg.
 *
 * Universal. Works on any brand's dark/light CTA color.
 */
function fixCtaContrast(html) {
  let fixes = 0;

  // CTAs in Mavlers framework always have bgcolor AND border-radius on the SAME
  // opening <table> tag. We match only these â€” prevents matching outer wrapper
  // tables which also have bgcolor but no border-radius.
  //
  // Non-greedy regex means we match the INNERMOST such table, which is always
  // the CTA (since outer wrappers don't have border-radius).
  const ctaRegex =
    /<table\b([^>]*?)bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?([^>]*?border-radius[^>]*?)>([\s\S]*?)<\/table>/gi;

  const output = html.replace(ctaRegex, (match, pre, bgHex, post, body) => {
    const hasAnchor = /<a\s+[^>]*href\s*=/i.test(body);
    const hasButtonHeight = /\bheight\s*=\s*["']?\d{2,3}["']?/i.test(body);
    if (!hasAnchor || !hasButtonHeight) return match;

    const bg = bgHex.toUpperCase();
    const rgb = hexToRgbTriplet(bg);
    if (!rgb) return match;

    const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    const wantedTextColor = lum < 128 ? "#FFFFFF" : "#000000";

    // Rewrite text-color in the body. Match `color:` NOT preceded by `-`
    let newBody = body.replace(/style\s*=\s*"([^"]*)"/gi, (attrM, styleVal) => {
      let updated = styleVal.replace(
        /(^|[^\-])\bcolor\s*:\s*#[0-9A-Fa-f]{6}/g,
        (m, prefix) => `${prefix}color: ${wantedTextColor}`
      );
      return `style="${updated}"`;
    });

    if (newBody !== body) fixes++;
    return `<table${pre}bgcolor="${bg}"${post}>${newBody}</table>`;
  });

  return { html: output, fixes };
}

/**
 * Fix 11 (NEW in v5.2.2): Font stack quote sanitizer.
 *
 * When the developer-input secondary font field contains a comma-separated list
 * (e.g. "Arial, Helvetica, sans-serif"), Stage 2 sometimes wraps the WHOLE thing
 * in single quotes: 'Arial, Helvetica, sans-serif' â€” one malformed font name.
 * This function detects that pattern and splits into proper comma-separated stack.
 *
 * Universal. Handles any font fallback string.
 */
function fixFontStackQuotes(html) {
  let fixes = 0;

  // Only act inside font-family declarations found in element `style="..."` attributes.
  // This avoids over-touching CSS inside <style> blocks, MSO conditional styles,
  // or @import rules.
  const output = html.replace(
    /style\s*=\s*"([^"]*)"/g,
    (attrMatch, styleVal) => {
      if (!/font-family\s*:/i.test(styleVal)) return attrMatch;

      // Normalize font-family declarations inside this style attribute
      const updated = styleVal.replace(
        /font-family\s*:\s*([^;]+)/gi,
        (m, rawValue) => {
          const value = rawValue.trim();

          // Tokenize: match either 'quoted' or "quoted" or bareword-until-comma
          const tokenRegex = /'([^']*)'|"([^"]*)"|([^,]+)/g;
          const tokens = [];
          let tm;
          while ((tm = tokenRegex.exec(value)) !== null) {
            const raw = (tm[1] ?? tm[2] ?? tm[3] ?? "").trim();
            if (!raw) continue;
            // If token contains commas internally (from the 'Arial, Helvetica, sans-serif' case),
            // split it into its pieces
            if (raw.includes(",")) {
              for (const sub of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
                tokens.push(sub);
              }
            } else {
              tokens.push(raw);
            }
          }

          // Filter out tokens that are CSS !important markers or malformed entries
          const cleaned = tokens
            .map((t) => t.replace(/!important$/i, "").trim())
            .filter((t) => t.length > 0 && !/^!important$/i.test(t));

          // De-duplicate case-insensitively, preserving first-seen order
          const seen = new Set();
          const uniq = [];
          for (const t of cleaned) {
            const key = t.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            uniq.push(t);
          }

          if (uniq.length === 0) return m; // safety: don't produce empty font-family

          // Quote only names containing spaces; keep single-word/hyphenated names bare.
          const generic = new Set([
            "serif", "sans-serif", "monospace", "cursive", "fantasy",
            "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace",
          ]);
          const rebuilt = uniq
            .map((t) => {
              const lower = t.toLowerCase();
              if (generic.has(lower)) return lower;
              if (/\s/.test(t)) return `'${t}'`;
              return t;
            })
            .join(", ");

          // Preserve !important if present in original
          const importantSuffix = /!important/i.test(value) ? " !important" : "";

          if (rebuilt + importantSuffix !== value) fixes++;
          return `font-family: ${rebuilt}${importantSuffix}`;
        }
      );

      return `style="${updated}"`;
    }
  );

  return { html: output, fixes };
}

/**
 * Fix 12 (NEW in v5.2.2): OCR capital-I repair.
 *
 * Tesseract frequently misreads capital I as lowercase l in font glyphs where
 * they're visually similar (Inter, Helvetica, Arial at certain sizes).
 * Example: "AI Integration" â†’ "Al Integration".
 *
 * Strategy: scan visible text in HTML for tokens matching /\b[A-Z]l(?=[\s.,;:!?]|$)/ â€” a capital
 * letter followed by lowercase l ending the word. Replace with the capital-I
 * equivalent UNLESS the token is a valid English word on an exclusion list.
 *
 * Universal. Works on any content; does NOT modify attribute values or URLs.
 */
function fixOcrCapitalI(html) {
  // Exclusion list â€” real English words that legitimately start with capital + lowercase L
  const exclusions = new Set([
    "Al", // valid as name (e.g. "Al Pacino") â€” but in pharma/tech contexts usually wrong
    // We leave "Al" in because context-aware logic is hard. Instead, we only fix when
    // followed by another capitalized word (suggests acronym usage)
  ]);

  let fixes = 0;

  // Walk the HTML. Only rewrite text content, never inside tags or attributes.
  // Simple state machine: outside-tag vs inside-tag.
  let output = "";
  let i = 0;
  let inTag = false;
  let textBuffer = "";

  const flushTextBuffer = () => {
    if (textBuffer.length === 0) return;
    // Apply regex to this text chunk
    // Match: "Al" followed by space and capital letter (indicating acronym followed by word)
    //   e.g., "Al Integration" â†’ "AI Integration"
    //         "Al plugs"       â†’ "AI plugs"
    //         "Al can"         â†’ "AI can"
    //         "Al-driven"      â†’ "AI-driven"
    //         "Al boosts"      â†’ "AI boosts"
    // Criteria: "Al" standalone as acronym (start of sentence or after space) AND next non-space char is lowercase letter (word start) OR capital letter (proper noun / another acronym) OR a hyphen/apostrophe
    const fixed = textBuffer.replace(
      /\bAl(?=[\s\-'][A-Za-z])/g,
      (match) => {
        fixes++;
        return "AI";
      }
    );
    output += fixed;
    textBuffer = "";
  };

  while (i < html.length) {
    const c = html[i];
    if (!inTag) {
      if (c === "<") {
        flushTextBuffer();
        inTag = true;
        output += c;
      } else {
        textBuffer += c;
      }
    } else {
      output += c;
      if (c === ">") inTag = false;
    }
    i++;
  }
  flushTextBuffer();

  return { html: output, fixes };
}

/**
 * Fix 13 (NEW in v5.2.2): Accent-bg dark-text rule.
 *
 * When a section has a saturated brand accent bgcolor (not pure white, not pure
 * black, not near-white), and the text inside is white but the brand's darkest
 * palette color would provide better readability + match brand intent, swap text
 * to the darkest palette color.
 *
 * This fixes the pattern where alert bars or accent sections were rendered with
 * white text instead of brand-dark text (e.g. white text on a brand accent bg instead of
 * dark-green on green).
 *
 * Universal â€” uses palette to find darkest non-black brand color.
 */
function fixAccentBgText(html, palette) {
  let fixes = 0;
  if (!palette || palette.length === 0) return { html, fixes };

  // Find the DARKEST non-black, non-white color in the palette
  const paletteHex = (palette || [])
    .map((p) => (typeof p === "string" ? p : p?.hex || "").toUpperCase())
    .filter((h) => /^#[0-9A-F]{6}$/.test(h));

  const darkest = paletteHex
    .filter((h) => {
      const rgb = hexToRgbTriplet(h);
      if (!rgb) return false;
      const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      // Not pure black, not near-white
      return lum > 20 && lum < 100;
    })
    .sort((a, b) => {
      const la = (() => {
        const r = hexToRgbTriplet(a);
        return 0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2];
      })();
      const lb = (() => {
        const r = hexToRgbTriplet(b);
        return 0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2];
      })();
      return la - lb;
    })[0];

  if (!darkest) return { html, fixes };

  // Walk each section. For each, check if the section bg is a saturated accent color.
  const sectionRegex =
    /(<!--\s*Section_(\d+)_([a-zA-Z_]+)(?:\s+y=\d+-\d+)?\s*-->)([\s\S]*?)(<!--\s*\/\/\s*Section_\2(?:_\3)?\s*-->)/g;

  const output = html.replace(sectionRegex, (match, openTag, n, stype, body, closeTag) => {
    if (stype === "thin_colored_band" || stype === "spacer" || stype === "divider" || stype === "footer") {
      return match;
    }

    const bgMatch = body.match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/);
    if (!bgMatch) return match;
    const bg = bgMatch[1].toUpperCase();
    const rgb = hexToRgbTriplet(bg);
    if (!rgb) return match;

    const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    const sat = Math.max(...rgb) - Math.min(...rgb);

    // Is this a saturated accent bg (not white, not black, meaningfully saturated)?
    const isAccent = sat >= 60 && lum >= 80 && lum <= 200;
    if (!isAccent) return match;

    // Darkest-color-on-accent vs white-on-accent:
    // Developers usually pick the BRAND DARK color for text on a brand accent bg
    // (matches overall branding) even if white would have slightly higher raw contrast.
    // We prefer brand-dark as long as it stays readable (luminance distance > 70).
    const darkRgb = hexToRgbTriplet(darkest);
    const darkLum = 0.299 * darkRgb[0] + 0.587 * darkRgb[1] + 0.114 * darkRgb[2];
    const darkContrast = Math.abs(lum - darkLum);

    // Brand-dark wins if it's sufficiently readable (contrast >= 70 is comfortable)
    const READABLE_CONTRAST_THRESHOLD = 70;
    if (darkContrast < READABLE_CONTRAST_THRESHOLD) return match;

    // Replace all `color: #FFFFFF` and `color:#ffffff` inside this section's body with darkest.
    // Use (^|[^\-]) lookbehind to avoid matching background-color.
    let newBody = body.replace(/style\s*=\s*"([^"]*)"/gi, (attrM, styleVal) => {
      const updated = styleVal.replace(
        /(^|[^\-])\bcolor\s*:\s*#(?:FFFFFF|ffffff|FFF|fff)\b/g,
        (m, prefix) => `${prefix}color: ${darkest}`
      );
      return `style="${updated}"`;
    });

    if (newBody !== body) fixes++;
    return openTag + newBody + closeTag;
  });

  return { html: output, fixes };
}

function addMissingZipWarning(html, imageUrlMap, hadRelativePaths) {
  if (Object.keys(imageUrlMap || {}).length > 0) return html;
  if (!hadRelativePaths) return html;

  const warning = `\n<!-- âš  MAVELOPER WARNING: No image ZIP was uploaded. Image paths in this HTML are placeholders. Re-run generation with the image ZIP to get working Dropbox URLs. -->\n`;
  // Insert right after <body ...>
  return html.replace(/(<body[^>]*>)/i, `$1${warning}`);
}
/**
 * Main post-processing entry point (v5.2.2).
 * Runs all deterministic fixes in order and returns the fixed HTML + a report.
 *
 * Order matters:
 *  1. fixImageUrls â€” replace local image paths with Dropbox URLs
 *  2. rebindSectionColors â€” fix section bgcolors using band_map y-ranges (must run BEFORE fixNearWhite)
 *  3. fixNearWhite â€” normalize JPEG-shifted near-whites to pure #FFFFFF
 *  4. forceAlertBarWarmBg â€” ensure alert bars use warm palette color if available
 *  5. fixAlertBarContrast â€” alert bar text contrast (black on warm, white on dark)
 *  6. fixAccentBgText â€” use brand-dark text on saturated brand-accent bgs (v5.2.2)
 *  7. universalTextContrast â€” fix all text-on-bg contrast globally
 *  8. fixCtaContrast â€” auto-invert CTA text color based on CTA bg luminance (v5.2.2)
 *  9. fixFontStackQuotes â€” un-nest malformed single-quoted font stacks (v5.2.2)
 *  10. fixOcrCapitalI â€” repair "Al" OCR misread back to "AI" in content text (v5.2.2)
 *  11. fixActivityFeed â€” unwrap day+time bullet lists to plain rows
 *  12. fixThinBands â€” drop hallucinated thin stripes whose color isn't used elsewhere
 *  13. addMissingZipWarning â€” visible comment if no image ZIP was uploaded
 */
/**
 * Fix 14 (NEW in v5.2.2): Strip inline SVG/data-URL backgrounds from styles.
 *
 * When Stage 2 generates bullet icons using `background: url('data:image/svg+xml;utf8,<svg ...>')`,
 * the inner double-quote characters inside the SVG break the HTML style attribute
 * parsing â€” browsers show raw SVG code as visible text. This is a CRITICAL bug.
 *
 * Fix: detect `background: url('data:image/svg...` or similar inside style attributes,
 * strip the entire background declaration, and add a `list-style-type: disc` fallback.
 * This is safe universally â€” bullets just render with default disc markers.
 */
function fixInlineSvgDataUrl(html) {
  let fixes = 0;
  let ulFixes = 0;

  // Step 1: Directly strip any `background: url('data:...')` or `background-image: url('data:...')`
  // declaration and everything up to the next `;` or the end of the style attr's closing quote.
  // This works even when the inner double-quotes of the SVG have already broken the style
  // attribute parsing â€” we just remove the toxic substring by pattern match, not by attr parsing.
  //
  // The data URL ends at the first `)` after the `url(` â€” even though the SVG contains internal
  // quotes, it does NOT contain literal `)` characters (the closing `/>` is not a paren).
  //
  // After stripping the url(...) part, also consume any trailing "no-repeat left 8px" style
  // keywords and the terminating ";" if present.
  let output = html.replace(
    /background(?:-image)?\s*:\s*url\s*\(\s*['"]?data:[^)]*\)(?:\s*(?:no-repeat|repeat|repeat-x|repeat-y|left|right|center|top|bottom|\d+(?:px|%)?))*\s*;?/gi,
    () => {
      fixes++;
      return "";
    }
  );

  // Step 2: Clean up any leftover double-semicolons or whitespace artifacts in styles.
  output = output.replace(/;\s*;+/g, ";").replace(/"\s*;\s*"/g, '";"');

  // Step 3: Any <ul> with list-style-type:none should switch to disc for a visible bullet.
  output = output.replace(
    /<ul([^>]*style\s*=\s*"[^"]*list-style-type\s*:\s*none[^"]*"[^>]*)>/gi,
    (match, attrs) => {
      const newAttrs = attrs.replace(
        /list-style-type\s*:\s*none/gi,
        "list-style-type: disc"
      );
      ulFixes++;
      return `<ul${newAttrs}>`;
    }
  );

  return { html: output, fixes, ulFixes };
}

/**
 * Fix 15 (NEW in v5.2.2): Clamp image widths to min(placeholder, original).
 *
 * Every <img> has a `width="N"` attribute and `max-width: Npx` in its inline
 * style â€” that's the placeholder width Stage 2 emitted from the spec. The ZIP
 * contains the actual source image at its original pixel dimensions. If the
 * original is SMALLER than the placeholder, we downsize the placeholder to the
 * original (upscaling a small source looks bad). If original is LARGER, we
 * keep the placeholder (renders crisp on retina).
 *
 * Aspect ratio is always preserved from the ZIP original.
 *
 * Universal. Executes on real measured pixel data.
 */
function fixImageDimensions(html, imageDimensionsMap) {
  let fixes = 0;
  if (!imageDimensionsMap || Object.keys(imageDimensionsMap).length === 0) {
    return { html, fixes, skipped: "no dimensions map" };
  }

  // Match each <img> tag. Capture src, width, and inline style so we can rewrite them.
  const imgRegex = /<img\b([^>]*)>/gi;
  const output = html.replace(imgRegex, (match, attrs) => {
    const srcMatch = attrs.match(/src\s*=\s*"([^"]+)"/i);
    if (!srcMatch) return match;
    const src = srcMatch[1];

    // Extract filename from src (strip URL params and path)
    const rawName = src.split("?")[0].split("/").pop();
    if (!rawName) return match;

    // Try exact match first, then case-insensitive
    let dims = imageDimensionsMap[rawName];
    if (!dims) {
      const lowered = rawName.toLowerCase();
      for (const key of Object.keys(imageDimensionsMap)) {
        if (key.toLowerCase() === lowered) {
          dims = imageDimensionsMap[key];
          break;
        }
      }
    }
    if (!dims || !dims.w || !dims.h) return match;

    const origW = dims.w;
    const origH = dims.h;

    // Read current placeholder width from width attr (prefer) or style max-width
    const widthAttrMatch = attrs.match(/\bwidth\s*=\s*["']?(\d+)["']?/i);
    const styleMatch = attrs.match(/style\s*=\s*"([^"]*)"/i);
    const maxWidthMatch = styleMatch ? styleMatch[1].match(/max-width\s*:\s*(\d+)px/i) : null;

    const placeholderW =
      (widthAttrMatch ? parseInt(widthAttrMatch[1], 10) : null) ||
      (maxWidthMatch ? parseInt(maxWidthMatch[1], 10) : null) ||
      origW;

    // Final width = min(placeholder, original). Only downsizes, never upsizes.
    const finalW = Math.min(placeholderW, origW);
    const finalH = Math.round((origH / origW) * finalW);

    // Nothing to change
    if (finalW === placeholderW && (!widthAttrMatch || parseInt(widthAttrMatch[1], 10) === finalW)) {
      return match;
    }

    let newAttrs = attrs;

    // Update width="..." attribute (set or replace)
    if (widthAttrMatch) {
      newAttrs = newAttrs.replace(
        /\bwidth\s*=\s*["']?\d+["']?/i,
        `width="${finalW}"`
      );
    } else {
      newAttrs = newAttrs.replace(/(<img\b)?/i, "") + ` width="${finalW}"`;
    }

    // Update max-width inside style attribute
    if (styleMatch) {
      const newStyle = styleMatch[1].replace(
        /max-width\s*:\s*\d+px/gi,
        `max-width: ${finalW}px`
      );
      if (newStyle !== styleMatch[1]) {
        newAttrs = newAttrs.replace(
          /style\s*=\s*"[^"]*"/i,
          `style="${newStyle}"`
        );
      }
    }

    // Add explicit height to help Outlook rendering (optional, but matches gold-standard)
    const heightAttrMatch = newAttrs.match(/\bheight\s*=\s*["']?(\d+)["']?/i);
    if (!heightAttrMatch && finalH > 0) {
      newAttrs = newAttrs + ` height="${finalH}"`;
    }

    fixes++;
    return `<img${newAttrs}>`;
  });

  return { html: output, fixes };
}

/**
 * Fix 16 (NEW in v5.2.2): Merge adjacent same-bg body_text/heading sections.
 *
 * When Stage 1 over-fragments a continuous body copy block into multiple
 * body_text sections, each becomes its own em_wrapper with redundant padding.
 * This post-processor detects adjacent sections with the SAME bgcolor AND
 * similar padding, and collapses them into one wrapper â€” the content rows
 * flow into a single table, reducing cumulative padding and matching dev
 * patterns.
 */
function mergeAdjacentSameBgSections(html) {
  let merges = 0;

  // Find every section open/close pair with y-range + bg attribute
  const sectionBlockRegex =
    /(<!--\s*Section_(\d+)_([a-zA-Z_]+)(?:\s+y=\d+-\d+)?\s*-->)([\s\S]*?)(<!--\s*\/\/\s*Section_\2(?:_\3)?\s*-->)/g;

  const MERGEABLE = new Set(["body_text", "heading", "bullet_list"]);

  // Parse all sections first
  const sections = [];
  let m;
  while ((m = sectionBlockRegex.exec(html)) !== null) {
    const bgMatch = m[4].match(/bgcolor\s*=\s*["']?(#[0-9A-Fa-f]{6})["']?/);
    sections.push({
      full: m[0],
      open: m[1],
      n: parseInt(m[2], 10),
      type: m[3],
      body: m[4],
      close: m[5],
      bg: bgMatch ? bgMatch[1].toUpperCase() : null,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  if (sections.length < 2) return { html, merges };

  // Find merge groups: adjacent sections where type is MERGEABLE AND bg matches
  const groups = [];
  let cur = [sections[0]];
  for (let i = 1; i < sections.length; i++) {
    const prev = cur[cur.length - 1];
    const s = sections[i];
    if (
      MERGEABLE.has(prev.type) &&
      MERGEABLE.has(s.type) &&
      prev.bg &&
      s.bg &&
      prev.bg === s.bg
    ) {
      cur.push(s);
    } else {
      if (cur.length > 1) groups.push(cur);
      cur = [s];
    }
  }
  if (cur.length > 1) groups.push(cur);

  if (groups.length === 0) return { html, merges };

  // Build new HTML by replacing each group with a merged single-wrapper section.
  // Extract the content rows (everything inside the inner <td class="em_pad*">
  // <table>...<tbody>...</tbody></table></td>) from each section and concatenate.
  let output = html;
  // Replace from bottom to top to keep indices valid
  for (const group of groups.reverse()) {
    const firstOpen = group[0].open;
    const lastClose = group[group.length - 1].close;

    // Extract the inner content rows from each section's body.
    // Pattern: <table ... class="em_wrapper..." ...><tbody><tr><td ... class="em_pad..."><table...><tbody>INNER_ROWS</tbody></table></td></tr></tbody></table>
    const innerRows = [];
    for (const s of group) {
      const innerMatch = s.body.match(
        /<table[^>]*class="em_wrapper[^"]*"[^>]*>[\s\S]*?<tbody>\s*<tr>\s*<td[^>]*class="em_pad[^"]*"[^>]*>\s*<table[^>]*>\s*<tbody>([\s\S]*?)<\/tbody>\s*<\/table>\s*<\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/i
      );
      if (innerMatch) innerRows.push(innerMatch[1].trim());
    }

    if (innerRows.length !== group.length) continue; // couldn't parse all â€” skip this group safely

    // Use the FIRST section's wrapper as the canonical wrapper
    const firstSection = group[0];
    const mergedInnerRows = innerRows.join("\n");
    const mergedWrapper = firstSection.body.replace(
      /(<table[^>]*class="em_wrapper[^"]*"[^>]*>[\s\S]*?<tbody>\s*<tr>\s*<td[^>]*class="em_pad[^"]*"[^>]*>\s*<table[^>]*>\s*<tbody>)([\s\S]*?)(<\/tbody>\s*<\/table>\s*<\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>)/i,
      `$1\n${mergedInnerRows}\n$3`
    );
    const mergedBlock = firstOpen + mergedWrapper + lastClose;

    // Replace the full range from group[0].start to group[end].end with mergedBlock
    const rangeStart = group[0].start;
    const rangeEnd = group[group.length - 1].end;
    output = output.slice(0, rangeStart) + mergedBlock + output.slice(rangeEnd);
    merges++;
  }

  return { html: output, merges };
}

/**
 * Fix 17 (NEW in v5.2.2): Diagnostic warning if ZIP was uploaded but Dropbox
 * returned empty imageUrlMap. Adds a LARGE visible comment block + visible banner.
 */
function addDropboxFailureWarning(html, imageUrlMap, hadRelativePaths, zipWasUploaded) {
  if (!zipWasUploaded) return html;
  if (Object.keys(imageUrlMap || {}).length > 0) return html;
  if (!hadRelativePaths) return html;

  const warningComment = `\n<!-- ============================================================\nâš âš âš  MAVELOPER CRITICAL WARNING âš âš âš \nZIP file was uploaded but Dropbox image-URL map is EMPTY.\nThe Dropbox upload pipeline failed silently.\nAll image paths in this HTML are broken placeholders.\nACTION: Check Railway logs for \"uploadImagesToDropbox\" errors,\nverify DROPBOX_APP_KEY/SECRET/REFRESH_TOKEN in Railway env,\nand confirm the Dropbox app has files.content.write permission.\n============================================================ -->\n`;

  const warningBanner = `
<tr>
  <td align="center" valign="top" bgcolor="#FF0000" style="background-color: #FF0000; padding: 20px; font-family: Arial, sans-serif; font-size: 14px; color: #FFFFFF; text-align: center; font-weight: bold;">
    âš  MAVELOPER: Image upload pipeline failed. Image paths in this HTML are broken. Re-generate after checking Dropbox credentials and Railway logs.
  </td>
</tr>`;

  // Insert comment after <body>
  let output = html.replace(/(<body[^>]*>)/i, `$1${warningComment}`);
  // Insert banner inside em_main_table as first row
  output = output.replace(
    /(<table[^>]*class="em_main_table"[^>]*>\s*(?:<tbody>\s*)?)/i,
    `$1${warningBanner}`
  );

  return output;
}

// =====================================================================
// v5.4.2 â€” DETERMINISTIC POST-PROCESSORS (preserved into v5.5.0)
// =====================================================================
// These run on the generated HTML after Stage 2. They fix bugs that no
// amount of prompt rules can reliably eliminate, by acting on the actual
// generated HTML structure.

/**
 * v5.4.2 Fix: Strip the user-specified secondary font from body font-family
 * stacks. Stage 2 has been observed to incorrectly inline the secondary font
 * into every element's font-family, even though the user only intended
 * that font to be loaded but not used as body fallback.
 *
 * Universal: works for any quoted font name passed via `secondaryFont`.
 */
function fixSecondaryFontInBodyStack(html, secondaryFont) {
  if (!secondaryFont || typeof secondaryFont !== "string") {
    return { html, fixes: 0 };
  }
  const sf = secondaryFont.trim();
  if (sf.length === 0) return { html, fixes: 0 };

  let fixes = 0;
  // Match any quoted form: 'FontName', "FontName", or unquoted FontName surrounded by commas.
  const escapedSf = sf.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

  const output = html.replace(
    /font-family\s*:\s*([^;"]+)/gi,
    (match, value) => {
      if (!new RegExp(`\\b${escapedSf}\\b`, "i").test(value)) {
        return match;
      }
      // Tokenize the font-family value
      const tokens = value
        .split(",")
        .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
        .filter((t) => t.length > 0 && t.toLowerCase() !== sf.toLowerCase());

      if (tokens.length === 0) return match; // safety

      // Re-quote tokens with spaces; preserve generics
      const generic = new Set([
        "serif", "sans-serif", "monospace", "cursive", "fantasy",
        "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace",
      ]);
      const rebuilt = tokens
        .map((t) => {
          const lower = t.toLowerCase();
          if (generic.has(lower)) return lower;
          if (/\s/.test(t)) return `'${t}'`;
          return t;
        })
        .join(", ");

      fixes++;
      return `font-family: ${rebuilt}`;
    }
  );

  return { html: output, fixes };
}

/**
 * v5.4.2 Fix: Convert Google Fonts @import in <style> block to a proper <link>
 * tag in <head>. @import is slower and can be blocked by some email clients;
 * <link> is the recommended pattern.
 *
 * Universal: detects any @import url('https://fonts.googleapis.com/...') pattern.
 */
function convertGoogleFontImportToLink(html) {
  const importRegex = /@import\s+url\s*\(\s*['"]?(https:\/\/fonts\.googleapis\.com\/[^'")]+)['"]?\s*\)\s*;?/gi;
  const matches = [...html.matchAll(importRegex)];
  if (matches.length === 0) return { html, fixes: 0 };

  let output = html;
  const linkTags = [];
  for (const m of matches) {
    const fontUrl = m[1];
    linkTags.push(`<link href="${fontUrl}" rel="stylesheet" />`);
  }

  // Strip the @import lines
  output = output.replace(importRegex, "");

  // Strip empty <style>...</style> blocks left after stripping @import
  output = output.replace(/<style[^>]*>\s*<\/style>/gi, "");
  // Strip wrapping <!--[if !mso]><!--> ... <!--<![endif]--> if it now contains nothing meaningful
  output = output.replace(
    /<!--\[if !mso\]><!-->\s*<!--<!\[endif\]-->/gi,
    ""
  );

  // Insert link tags before the closing </head>
  const linkBlock = "  " + linkTags.join("\n  ") + "\n";
  output = output.replace(/(<\/head>)/i, `${linkBlock}$1`);

  return { html: output, fixes: matches.length };
}

/**
 * v5.4.2 Fix: Repair malformed self-closing img tags where Stage 2 emitted
 *   style="..."/ height="X">
 * The forward-slash got placed BEFORE the closing-tag bracket but other
 * attributes appear after it. Repair to:
 *   style="..." height="X"/>
 *
 * Universal: matches any <img> tag with /-misplaced.
 */
function fixMalformedSelfClosingImg(html) {
  let fixes = 0;
  const output = html.replace(
    /<img\s+([^>]*?)style\s*=\s*"([^"]*)"\s*\/\s+([^>]+?)\s*\/?\s*>/gi,
    (match, before, styleVal, afterAttrs) => {
      fixes++;
      return `<img ${before}style="${styleVal}" ${afterAttrs.trim()}/>`;
    }
  );
  return { html: output, fixes };
}

/**
 * v5.4.2 Fix: Merge stacked-color heading rows into a single cell with spans.
 *
 * Stage 2 frequently violates the spans rule, splitting a 2-color headline
 * (e.g., one phrase in dark color, another phrase in accent color, on adjacent
 * visual lines) into TWO adjacent <tr> rows with identical font but different
 * color. The developer reference always uses ONE cell with multiple <span>s.
 *
 * Heuristic: detect adjacent <tr><td...>TEXT</td></tr> pairs where:
 *   - Both <td>s have align="center"
 *   - Both have the same font-family + font-size + line-height + font-weight
 *   - Colors differ
 *   - Texts are short (<80 chars each)
 *   - No image or other complex content between them
 * Merge into one <td> with two <span>s.
 *
 * Universal: works for any 2-color split heading.
 */
function fixStackedHeadingRows(html) {
  let fixes = 0;
  const rowPairRegex =
    /<tr>\s*<td\s+align="center"\s+valign="top"\s+(class="[^"]*"\s+)?style="([^"]*)"\s*>([^<]{1,80})<\/td>\s*<\/tr>\s*<tr>\s*<td\s+align="center"\s+valign="top"\s+(class="[^"]*"\s+)?style="([^"]*)"\s*>([^<]{1,80})<\/td>\s*<\/tr>/gi;

  let output = html;
  let prev = null;
  // Loop because merging shrinks the HTML and may expose new pairs
  while (prev !== output) {
    prev = output;
    output = output.replace(
      rowPairRegex,
      (match, cls1, style1, text1, cls2, style2, text2) => {
        // Extract font + color from each style
        const extract = (s) => {
          const ff = (s.match(/font-family\s*:\s*([^;]+)/i) || [])[1]?.trim();
          const fs = (s.match(/font-size\s*:\s*([^;]+)/i) || [])[1]?.trim();
          const lh = (s.match(/line-height\s*:\s*([^;]+)/i) || [])[1]?.trim();
          const fw = (s.match(/font-weight\s*:\s*([^;]+)/i) || [])[1]?.trim();
          const col = (s.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i) || [])[1]?.trim();
          return { ff, fs, lh, fw, col };
        };
        const a = extract(style1);
        const b = extract(style2);

        // Must match font, size, line-height, weight; must differ on color
        if (!a.ff || a.ff !== b.ff) return match;
        if (a.fs !== b.fs) return match;
        if (a.lh !== b.lh) return match;
        if (a.fw !== b.fw) return match;
        if (!a.col || !b.col) return match;
        if (a.col.toLowerCase() === b.col.toLowerCase()) return match;

        // Text content sanity check: not empty
        if (!text1.trim() || !text2.trim()) return match;

        // Build the merged <td>: keep style1 (without color) on the td, use spans for colors
        const baseStyle = style1
          .replace(/(?:^|;)\s*color\s*:\s*[^;]+;?/i, "")
          .replace(/;;+/g, ";")
          .trim();
        const merged = `<tr>
                          <td align="center" valign="top" ${cls1 || ""}style="${baseStyle}"><span style="color: ${a.col};">${text1.trim()}</span><br /><span style="color: ${b.col};">${text2.trim()}</span></td>
                        </tr>`;
        fixes++;
        return merged;
      }
    );
  }

  return { html: output, fixes };
}

function postProcessHtml(html, { imageUrlMap, palette, bandMap, imageDimensionsMap, zipWasUploaded, secondaryFont, mode = "pdf", requestId }) {
  const report = {};
  const hadRelativePaths = /src="images\//i.test(html);

  // v9.7.0 â€” path mode gate. 'pdf' (default) runs the FULL deterministic pipeline
  // exactly as before (byte-for-byte). 'figma' runs ONLY the HTML-hygiene subset,
  // because the bridge output is already VALIDATED â€” the PDF/OCR/Stage-2-era
  // colour/text/structure correctors must never override a validated design
  // decision. See MAVELOPER_POSTPROCESS_GATE_SPEC.
  const FIGMA_SAFE = mode === "figma";

  // [RUN on both] Image URL fix â€” pass 1 (filename match). On Figma the positional
  // fallback (pass 2) is DISABLED (it can silently mis-bind images); any leftover
  // relative src is logged as a WARN instead of guessed at (Â§3).
  const r1 = fixImageUrls(html, imageUrlMap, imageDimensionsMap, FIGMA_SAFE ? { skipPositionalFallback: true } : {});
  html = r1.html;
  report.imageUrls = {
    replaced: r1.replaced,
    sequentialFallbacks: r1.sequentialFallbacks,
    fallbackUsed: r1.fallbackUsed,
    unmatched: r1.unmatched,
  };
  if (FIGMA_SAFE && r1.unmatched && r1.unmatched.length > 0) {
    log("warn", "postProcess(figma): relative/non-http image src(s) left after filename match â€” NOT guessing (positional fallback disabled)", {
      requestId,
      leftover: r1.unmatched,
    });
  }

  // [RUN on both] Convert Google Fonts @import to <link> in <head> â€” font-loading mechanics
  const rGFont = convertGoogleFontImportToLink(html);
  html = rGFont.html;
  report.googleFontLinkConvert = { fixes: rGFont.fixes };

  // [RUN on both] Repair malformed self-closing img tags â€” malformed syntax
  const rImgMal = fixMalformedSelfClosingImg(html);
  html = rImgMal.html;
  report.malformedImgFix = { fixes: rImgMal.fixes };

  if (!FIGMA_SAFE) {
    // â”€â”€ PDF/OCR/Stage-2-era transforms â€” SKIPPED on the Figma/bridge path (Â§2). â”€â”€
    // Each can silently override a validated design decision. They run ONLY for
    // the PDF pipeline (mode='pdf'), unchanged. Functions themselves are untouched.

    // v5.4.2: Strip user-specified secondary font from body font-family stacks
    const rSecFont = fixSecondaryFontInBodyStack(html, secondaryFont);
    html = rSecFont.html;
    report.secondaryFontStrip = { fixes: rSecFont.fixes };

    // v5.4.2: Merge stacked-color heading rows into single cell with spans
    const rStacked = fixStackedHeadingRows(html);
    html = rStacked.html;
    report.stackedHeadingMerge = { fixes: rStacked.fixes };

    const r2 = rebindSectionColors(html, bandMap, palette);
    html = r2.html;
    report.rebindSectionColors = { rebound: r2.rebound, checked: r2.checked, skipped: r2.skipped };

    const r3 = fixNearWhite(html, palette);
    html = r3.html;
    report.nearWhite = { normalizedColors: r3.normalizedColors, count: r3.count };

    const r4 = forceAlertBarWarmBg(html, palette);
    html = r4.html;
    report.alertBarWarmBg = { fixes: r4.fixes };

    const r5 = fixAlertBarContrast(html);
    html = r5.html;
    report.alertBar = { fixes: r5.fixes };

    const r6 = universalTextContrast(html);
    html = r6.html;
    report.universalContrast = { fixes: r6.fixes };

    // Run accent-bg text AFTER universalTextContrast so brand-dark text isn't
    // reverted by the generic luminance rule.
    const r5b = fixAccentBgText(html, palette);
    html = r5b.html;
    report.accentBgText = { fixes: r5b.fixes };

    const r6b = fixCtaContrast(html);
    html = r6b.html;
    report.ctaContrast = { fixes: r6b.fixes };
  }

  // [RUN on both] Font-stack quote sanitizer â€” de-nest/de-dupe, PRESERVES first-seen order
  const r6c = fixFontStackQuotes(html);
  html = r6c.html;
  report.fontStackQuotes = { fixes: r6c.fixes };

  if (!FIGMA_SAFE) {
    const r6d = fixOcrCapitalI(html);
    html = r6d.html;
    report.ocrCapitalI = { fixes: r6d.fixes };

    // v5.2.2: Strip inline SVG/data-URL backgrounds that break style attribute parsing
    const rSvg = fixInlineSvgDataUrl(html);
    html = rSvg.html;
    report.inlineSvgDataUrl = { fixes: rSvg.fixes, ulFixes: rSvg.ulFixes };

    // v5.2.2: Clamp image widths to min(placeholder, original)
    const rDims = fixImageDimensions(html, imageDimensionsMap);
    html = rDims.html;
    report.imageDimensions = { fixes: rDims.fixes, skipped: rDims.skipped };

    const r7 = fixActivityFeed(html);
    html = r7.html;
    report.activityFeed = { fixes: r7.fixes };

    const r8 = fixThinBands(html, palette, bandMap);
    html = r8.html;
    report.thinBands = { removed: r8.removed };

    // v5.2.2: Merge adjacent same-bg body_text / heading / bullet sections
    const rMerge = mergeAdjacentSameBgSections(html);
    html = rMerge.html;
    report.mergedSections = { merges: rMerge.merges };

    html = addMissingZipWarning(html, imageUrlMap, hadRelativePaths);
    // v5.2.2: Escalate to visible warning if ZIP was uploaded but upload failed
    html = addDropboxFailureWarning(html, imageUrlMap, hadRelativePaths, zipWasUploaded);
  }

  report.mode = mode;
  return { html, report };
}

// =====================================================================
// v9.7.0 â€” POST-POST-PROCESS ASSERTION (Figma path)
//
// The font bug survived because the validator is NOT the last gate â€” Railway
// mutated the HTML after it passed. This asserts that the hygiene pass did not
// break a validator guarantee. It NEVER hard-fails delivery â€” it logs an ERROR
// and returns the violations so the caller can surface them (make it observable).
//
//   brandFont : every font-family that led with designSpec.brand_font BEFORE must
//               still lead with it AFTER (count must not drop). Skipped when the
//               spec has no brand_font (Arial-fallback designs).
//   fontCount : number of font-family declarations unchanged.
//   size      : byte count not dropped by more than 2%.
//   imgCount  : number of <img unchanged.
//   anchorCount: number of <a  unchanged.
// =====================================================================
function assertFigmaPostProcess(before, after, designSpec, { requestId, source = "figma" } = {}) {
  const violations = [];
  const countOf = (s, re) => (s.match(re) || []).length;

  const ffRe = /font-family\s*:\s*([^;"}]+)/gi;
  const leadCountWith = (s, brand) => {
    if (!brand) return 0;
    const b = brand.trim().toLowerCase();
    let n = 0, m;
    const re = new RegExp(ffRe.source, "gi");
    while ((m = re.exec(s)) !== null) {
      const first = m[1].split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
      if (first === b) n++;
    }
    return n;
  };

  // brandFont â€” count must not drop
  const brand = designSpec && designSpec.brand_font;
  if (brand) {
    const leadBefore = leadCountWith(before, brand);
    const leadAfter = leadCountWith(after, brand);
    if (leadAfter < leadBefore) {
      violations.push(`brandFont: declarations leading with '${brand}' dropped ${leadBefore}â†’${leadAfter}`);
    }
  }

  // fontCount
  const ffBefore = countOf(before, /font-family\s*:/gi);
  const ffAfter = countOf(after, /font-family\s*:/gi);
  if (ffBefore !== ffAfter) {
    violations.push(`fontCount: font-family declarations changed ${ffBefore}â†’${ffAfter}`);
  }

  // size (>2% drop)
  if (before.length > 0) {
    const dropPct = ((before.length - after.length) / before.length) * 100;
    if (dropPct > 2) {
      violations.push(`size: byte count dropped ${dropPct.toFixed(1)}% (${before.length}â†’${after.length})`);
    }
  }

  // imgCount
  const imgBefore = countOf(before, /<img\b/gi);
  const imgAfter = countOf(after, /<img\b/gi);
  if (imgBefore !== imgAfter) {
    violations.push(`imgCount: <img> count changed ${imgBefore}â†’${imgAfter}`);
  }

  // anchorCount
  const aBefore = countOf(before, /<a\b/gi);
  const aAfter = countOf(after, /<a\b/gi);
  if (aBefore !== aAfter) {
    violations.push(`anchorCount: <a> count changed ${aBefore}â†’${aAfter}`);
  }

  if (violations.length > 0) {
    log("error", "POST-PROCESS ASSERTION FAILED â€” post-processing altered validated HTML", {
      requestId,
      source,
      violations,
    });
  }
  return violations;
}




// =====================================================================
// EXPRESS APP SETUP

// =====================================================================
// v9.0.0 / run 14 — CLAUDE CODE BRIDGE (the only Stage 2 engine)
// =====================================================================
//
// Mac bridge URL: MAC_BRIDGE_URL env var (e.g. https://xxx.ngrok.io)
// Auth: MAC_BRIDGE_SECRET shared between Railway and Mac bridge

const MAC_BRIDGE_URL = process.env.MAC_BRIDGE_URL || null;
const MAC_BRIDGE_SECRET = process.env.MAC_BRIDGE_SECRET || "change-me-in-env";
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// v9.2.0 â€” Bridge callback architecture
//
// Why this exists:
//   We tried streaming responses (v9.1.4 / bridge v1.0.4). ngrok free tier
//   buffers responses server-side and enforces a 5-minute response wall â€”
//   even with chunked heartbeats. The only architecture that works in all
//   environments is: bridge accepts the job, immediately returns 202, then
//   POSTs the result back to Railway when done. No long HTTP connections.
//
// In-memory pending map:
//   When callClaudeCodeBridge dispatches a job, it creates a unique
//   bridgeJobId and stashes {resolve, reject, timer} keyed by that id.
//   When /bridge-callback receives a POST with that bridgeJobId, it
//   resolves the promise. If the bridge never calls back (machine off,
//   crash, network), the timer rejects after 45 minutes.
//
// This map is process-local on Railway. If Railway restarts mid-job, that
// job is lost (caller times out). Acceptable for now; durable queue
// would need Supabase persistence and is out of scope for this fix.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PENDING_BRIDGE_JOBS = new Map();
const BRIDGE_JOB_MAX_WAIT_MS = 45 * 60 * 1000; // 45 min hard ceiling

function settleBridgeJob(bridgeJobId, payload) {
  const entry = PENDING_BRIDGE_JOBS.get(bridgeJobId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  PENDING_BRIDGE_JOBS.delete(bridgeJobId);
  if (payload.error) entry.reject(new Error(payload.error));
  else entry.resolve(payload);
  return true;
}

// ESP threading (v9.x): map the coarse Lovable/server `espPlatform` value onto
// the canonical `spec.esp_target` key that cc-runner consumes (PART I). Single
// source of truth: C:\maveloper-bridge\esp-registry.md. Unknown / absent â†’
// "plain_html" (safe default). The parser never sets esp_target â€” it is a
// delivery concern applied here, just before dispatch to the bridge.
function mapEspPlatformToTarget(espPlatform) {
  const ESP_PLATFORM_TO_TARGET = {
    none: "plain_html",
    mailchimp: "mailchimp",
    braze: "liquid_braze",        // canonical platform for the (now-ACTIVE) liquid_braze family; needs a "Braze" UI option to be selectable
    sfmc: "sfmc_content_builder", // CB default; sfmc_ampscript is a separate target
    hubspot: "hubspot_cdn",       // CDN default; hubspot_hubl (dual-output) is separate
    klaviyo: "klaviyo",           // kept as its own canonical family (not folded into liquid_braze â€” distinct tokens)
    pardot: "pardot",             // Pardot / Account Engagement (ACTIVE v2.6.4, substitution-only)
    dynamics: "ms_dynamics_365",  // âš ï¸ CONFIRM the exact espPlatform value the Lovable dropdown sends for Dynamics
    ms_dynamics_365: "ms_dynamics_365", // passthrough in case Lovable sends the canonical key
    sendgrid: "sendgrid",         // SendGrid Marketing Campaigns (ACTIVE v2.6.6, substitution-only)
    customer_io: "customer_io",   // Customer.io (ACTIVE v2.6.6, substitution-only)
    customerio: "customer_io",    // âš ï¸ in case the Lovable dropdown sends "customerio" (no underscore)
    sparkpost: "sparkpost",       // SparkPost (ACTIVE v2.6.6; data-msys-unsubscribe attribute mechanism)
    marketo: "marketo",           // Marketo (ACTIVE v2.7.3, substitution + Layer-2 mktoText/mktoModule) â€” closes the only routing gap
  };
  if (espPlatform == null) return "plain_html";
  const key = String(espPlatform).trim().toLowerCase();
  return ESP_PLATFORM_TO_TARGET[key] || "plain_html";
}

async function callClaudeCodeBridge({ designSpec, referenceHtml, designImageBase64, model, requestId, maveloperJobId, espPlatform, figmaFileKey, figmaNodeId, figmaDesignWidth, figmaToken, log, assetSink }) {
  if (!MAC_BRIDGE_URL) {
    throw new Error("MAC_BRIDGE_URL not configured â€” set it to the ngrok URL of your Mac bridge");
  }

  // Thread the selected ESP onto the spec so cc-runner (PART I) can emit
  // ESP-specific markup. Don't override an esp_target already present on the spec.
  if (designSpec && typeof designSpec === "object" && !designSpec.esp_target) {
    designSpec.esp_target = mapEspPlatformToTarget(espPlatform);
  }

  // Generate a unique id we'll use to correlate the callback with this call.
  const bridgeJobId = `bj_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

  // Compute the public callback URL. We need an absolute URL the bridge
  // can reach from outside Railway. PUBLIC_BACKEND_URL is the env var
  // pointing at the Railway service (set during deploy). Fallback to the
  // hardcoded production URL if not configured, since that's our known
  // deployment target.
  const publicBackendUrl =
    process.env.PUBLIC_BACKEND_URL ||
    "https://maveloper-backend-production.up.railway.app";
  const callbackUrl = `${publicBackendUrl}/bridge-callback`;

  // v9.3.0 Bug B fix: tag the Supabase maveloper_jobs row with bridgeJobId BEFORE
  // dispatching, so /bridge-callback can find the row even if this Railway worker
  // restarts. Without this, the in-memory PENDING_BRIDGE_JOBS map is lost on
  // restart and late callbacks get 404.
  if (maveloperJobId && supabaseAdmin) {
    await updateJobStatus(maveloperJobId, {
      progress_message: `Dispatched to bridge (bridgeJobId=${bridgeJobId})`,
      // Stash bridgeJobId in error_message column as a side-channel since the
      // table doesn't have a dedicated column. We clear it when the job succeeds.
      // The /bridge-callback endpoint searches by this stashed value.
      error_message: `__BRIDGE__:${bridgeJobId}`,
    }, requestId);
  }

  const payload = {
    spec: designSpec,
    referenceHtml: referenceHtml || null,
    imageBase64: designImageBase64 || null,
    model: model || BRIDGE_DEFAULT_MODEL,
    requestId,
    bridgeJobId,
    maveloperJobId: maveloperJobId || null,
    callbackUrl,
  };

  // COMPILER FLIP â€” STEP 4: thread the Figma coordinates the parser already
  // extracted from the placed design URL as an OPTIONAL nested object. The bridge
  // and cc-runner treat this as additive: only when BOTH fileKey and nodeId are
  // present is the deterministic compiler even eligible (and then only if the
  // bridge's COMPILER_ENABLED flag is on and the pair is allow-listed). A payload
  // without figma coordinates â€” e.g. the PDF /generate path â€” is byte-identical
  // to today. designWidth rides along for the compiler's render width.
  if (figmaFileKey && figmaNodeId) {
    payload.figma = {
      fileKey: figmaFileKey,
      nodeId: figmaNodeId,
      designWidth: (figmaDesignWidth === undefined || figmaDesignWidth === null || figmaDesignWidth === "")
        ? null
        : figmaDesignWidth,
    };
  }

  // ── ★★ RUN 3: THE CREDENTIAL'S ONE HOP TO THE ENGINE. ───────────────────
  // The engine (_autonomous_24H) makes its OWN Figma calls and reads
  // $FIGMA_TOKEN to do it. The bridge box has no Supabase client and no service
  // role, so it cannot resolve a credential itself - the backend, which just
  // did, hands it over here.
  //
  // ★ IT TRAVELS IN THE POST BODY, WHICH IS THE SAFE CHANNEL OF THE THREE.
  //   - argv is world-readable to any other process on the box (`ps`, Task
  //     Manager), AND bridge-server.mjs:270 prints every flag verbatim into
  //     retained logs. Two independent leaks. Never argv.
  //   - a file the child reads by a path printed in a log is the same leak with
  //     an extra step.
  //   - this body already carries the design spec over the same authenticated
  //     HTTPS hop, and the bridge does not log it. The bridge puts this value
  //     straight into the spawn `env` and nowhere else.
  //
  // ★ SEPARATE FROM payload.figma ON PURPOSE. That object is logged by name at
  // bridge-server.mjs:267 (`figma coords threaded: fileKey=... nodeId=...`).
  // Putting the token inside it would have printed it on the very next line.
  if (typeof figmaToken === "string" && figmaToken) {
    payload.figmaToken = figmaToken;
  }

  log("info", "Claude Code: dispatching to Mac bridge (callback mode)", {
    requestId,
    maveloperJobId,
    bridgeJobId,
    bridgeUrl: MAC_BRIDGE_URL,
    callbackUrl,
    specSections: designSpec?.sections?.length || 0,
    hasReference: !!referenceHtml,
    hasImage: !!designImageBase64,
    // A BOOLEAN, never the value. Enough to answer "did the engine get a token
    // for this order at all" from the logs without the logs holding one.
    figmaTokenThreaded: Boolean(payload.figmaToken),
  });

  // Set up the promise BEFORE dispatching, so a fast bridge can't race the
  // callback in before we've registered the resolver.
  const resultPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (PENDING_BRIDGE_JOBS.delete(bridgeJobId)) {
        log("error", "Bridge job timed out waiting for callback", {
          requestId,
          bridgeJobId,
          maxWaitMinutes: BRIDGE_JOB_MAX_WAIT_MS / 60000,
        });
        reject(new Error(`Bridge did not call back within ${BRIDGE_JOB_MAX_WAIT_MS / 60000} minutes`));
      }
    }, BRIDGE_JOB_MAX_WAIT_MS);
    PENDING_BRIDGE_JOBS.set(bridgeJobId, { resolve, reject, timer, requestId, startedAt: Date.now() });
  });

  // Fire the dispatch. Bridge should respond 202 in <1 second.
  let dispatchResp;
  try {
    dispatchResp = await fetch(`${MAC_BRIDGE_URL}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Secret": MAC_BRIDGE_SECRET,
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify(payload),
      // Short signal â€” dispatch should be near-instant. If it takes more
      // than 60 sec, something is wrong at the network layer.
      signal: AbortSignal.timeout(60 * 1000),
    });
  } catch (dispatchErr) {
    // Clean up the pending promise so it doesn't leak.
    const entry = PENDING_BRIDGE_JOBS.get(bridgeJobId);
    if (entry) {
      clearTimeout(entry.timer);
      PENDING_BRIDGE_JOBS.delete(bridgeJobId);
    }
    log("error", "Bridge dispatch failed", {
      requestId,
      bridgeJobId,
      error: dispatchErr.message,
      code: dispatchErr.code || dispatchErr.cause?.code,
    });
    throw new Error(`Bridge dispatch failed: ${dispatchErr.message}`);
  }

  if (!dispatchResp.ok && dispatchResp.status !== 202) {
    const entry = PENDING_BRIDGE_JOBS.get(bridgeJobId);
    if (entry) {
      clearTimeout(entry.timer);
      PENDING_BRIDGE_JOBS.delete(bridgeJobId);
    }
    const errText = await dispatchResp.text().catch(() => "(no body)");
    const errBody = errText.trimStart().startsWith("<")
      ? "BRIDGE UNREACHABLE - the tunnel returned an HTML error page, not the bridge. The laptop or ngrok was down."
      : errText.substring(0, 500);
    throw new Error(`Bridge rejected dispatch with status ${dispatchResp.status}: ${errBody}`);
  }

  log("info", "Bridge accepted job â€” waiting for callback", {
    requestId,
    bridgeJobId,
    dispatchStatus: dispatchResp.status,
  });

  // Wait for /bridge-callback to settle this promise.
  const result = await resultPromise;

  if (!result.html) {
    throw new Error(`Bridge callback delivered no HTML: ${JSON.stringify(result).substring(0, 500)}`);
  }

  log("info", "Claude Code: bridge callback delivered HTML", {
    requestId,
    bridgeJobId,
    bytesGenerated: result.bytesGenerated,
    elapsedSeconds: result.elapsedSeconds,
  });

  // COMPILER ZIP FIX: hand the caller the slice-image map the /bridge-callback
  // uploaded to Dropbox (compiler path only), via the optional out-param sink.
  // The figma handler folds it into its imageUrlMap so the /approve ZIP localises
  // the slice PNGs. Inert on the LLM path: result.compilerImageUrlMap is null
  // there, so the sink is never touched and the return value is unchanged.
  if (assetSink && result.compilerImageUrlMap && typeof result.compilerImageUrlMap === "object") {
    assetSink.compilerImageUrlMap = result.compilerImageUrlMap;
  }

  return result.html;
}

// =====================================================================
// END CLAUDE CODE BRIDGE
// =====================================================================


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
  // DELETE is here for /os/spaces/:slug. Without it the browser refuses the
  // preflight and the request never leaves, which reads on screen as a dialog
  // that closes and does nothing.
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: false,
}));

// ── ★ CALLBACK TRANSFER, MEASURED (instrument only — nothing is optimised) ───
// The bridge POSTs /bridge-callback with a base64 compilerAssets payload the
// owner has seen between 1.0 and 19.4 MB, over a free ngrok tunnel from India to
// Railway, against the 35mb limit below. NOTHING HAS EVER TIMED IT. It is inside
// the 205 seconds that TEST12-1413 spent outside the engine's own 74, and it is
// currently an inference.
//
// It must be measured HERE, around express.json, and not in the route handler:
// by the time the handler runs the body is already buffered and parsed, so the
// handler cannot see the transfer at all. The first middleware stamps arrival —
// which for a large body is roughly when the HEADERS land, since express.json
// then reads the stream to completion — and the second stamps the moment the
// parsed body exists. The difference is tunnel transfer + JSON parse together;
// they are not separated, and the log says so rather than implying a clean split.
//
// Scoped to /bridge-callback by path so no other route pays a clock read, and
// req.id does not exist yet (it is assigned by the middleware below this one),
// so the values are stashed on req and logged by the route.
app.use((req, _res, next) => {
  if (req.method === "POST" && req.path === "/bridge-callback") {
    req._bodyRecvStart = Date.now();
    const cl = Number(req.headers["content-length"]);
    req._bodyRecvBytes = Number.isFinite(cl) ? cl : null;
  }
  next();
});

// Increased from 8mb to 35mb to accommodate PDF (5MB) + ZIP (25MB) after base64 inflation
app.use(express.json({ limit: "35mb" }));

app.use((req, _res, next) => {
  if (req._bodyRecvStart) req._bodyRecvMs = Date.now() - req._bodyRecvStart;
  next();
});

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

// RUN 14: sign-in + a live seat on the routes that read a space's data. The
// space comes from the signed-in person's seats, never from the request.
const doors = createRouteDoors({
  supabaseAdmin,
  requireAuth,
  platformOwners: platformOwners(process.env),
  log,
});

// =====================================================================
// ROUTES
// =====================================================================

app.get("/health", (req, res) => {
  // v5.5.0: do not leak the configured model name to unauthenticated callers.
  res.json({
    status: "ok",
    uptime: process.uptime(),
    dropboxConfigured,
    figmaConfigured,
    supabaseConfigured,
    authConfigured: Boolean(SUPABASE_JWT_SECRET),
    framework: "master-v2",
    version: "9.1.0-async-preview",
    // v9.0.0: Claude Code engine status
    engine: {
      claudeCodeBridgeConfigured: Boolean(MAC_BRIDGE_URL),
      bridgeUrl: MAC_BRIDGE_URL ? `${MAC_BRIDGE_URL.substring(0, 30)}...` : null,
    },
  });
});

// =====================================================================
// POST /generate-from-figma â€” v6.1.0 (Phase B: auto image export)
// Accepts: { figmaUrl, emailWidth?, primaryFont?, secondaryFont?, espPlatform?, darkMode? }
// Returns: { html, orderId, pageImages, imageUrlMap, designSpec, figmaSource, requestId }
//
// Pipeline:
//   1. Parse Figma URL â†’ fetch node tree from Figma REST API
//   2. Convert node tree to designSpec JSON (skips Stage 1 vision entirely)
//   3. Render every image node + the email frame via Figma /v1/images
//   4. Upload images to Dropbox; patch designSpec src fields with real URLs
//   5. Send populated designSpec to Stage 2 (existing prompt, unchanged)
//   6. Run post-processors (HTML hygiene; band-related rules are no-ops)
//   7. Return HTML + pageImages[0]=preview URL + imageUrlMap
//
// Phase B (v6.1.0) â€” image export is automatic:
//   - Every <img> in the generated HTML has a real Dropbox URL.
//   - The /approve endpoint's ZIP packaging picks up the images via
//     imageUrlMap (same path the PDF flow uses).
//   - Image export failures are NON-FATAL: if Figma /v1/images or
//     Dropbox upload fails, we degrade to empty src (Phase A behavior)
//     and surface the failure in imageExportReport.
// =====================================================================

// =====================================================================
// v9.1.0 â€” ASYNC JOB PATTERN
//
// PROBLEM:
//   Railway's HTTP request handler has a ~30s timeout. Claude Code
//   generations take 10-30 min. Lovable always sees "Generation failed"
//   even on success.
//
// SOLUTION:
//   /generate-from-figma-async â€” returns a jobId in <1s, runs generation
//     in background, writes result to Supabase maveloper_jobs table.
//   /job-status/:jobId â€” polls Supabase for status/result/error.
//
// IMPLEMENTATION:
//   The async endpoint reuses the existing synchronous /generate-from-figma
//   handler by passing it a "fake response object" that captures the
//   response body instead of writing it to a socket. The captured body is
//   then persisted to Supabase. This keeps the existing endpoint 100%
//   unchanged and reduces risk of regressions.
// =====================================================================

/**
 * Creates a fake Express response object that captures status code and JSON
 * body in memory instead of writing to a socket. Used internally to invoke
 * a synchronous Express handler from an async background worker.
 *
 * Returns an object with the same shape Express handlers expect:
 *   res.status(code).json(body)
 *   res.json(body)
 * After the handler completes, read result.statusCode and result.body.
 */
function createFakeResponse() {
  const result = { statusCode: 200, body: null, headersSent: false };
  const fakeRes = {
    status(code) {
      result.statusCode = code;
      return fakeRes;
    },
    json(body) {
      if (result.headersSent) return fakeRes;
      result.body = body;
      result.headersSent = true;
      return fakeRes;
    },
    send(body) {
      if (result.headersSent) return fakeRes;
      result.body = body;
      result.headersSent = true;
      return fakeRes;
    },
    set() { return fakeRes; },
    setHeader() { return fakeRes; },
    get headersSent() { return result.headersSent; },
  };
  return { res: fakeRes, result };
}

/**
 * Updates a maveloper_jobs row. Non-fatal: errors are logged but don't throw.
 * Reason: we never want a Supabase blip to crash the in-flight generation.
 */
async function updateJobStatus(jobId, fields, requestId) {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin
      .from("maveloper_jobs")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (e) {
    log("warn", "Failed to update job status (non-fatal)", {
      requestId,
      jobId,
      error: e.message,
    });
  }
}

app.post("/generate-from-figma", generateLimiter, ...doors.generate, async (req, res) => {
  const startTime = Date.now();
  try {
    const { figmaUrl, emailWidth, primaryFont, secondaryFont, espPlatform, darkMode } = req.body;

    // --- Validate input ---
    if (!figmaUrl || typeof figmaUrl !== "string") {
      return res.status(400).json({
        error: "Missing figmaUrl",
        details: "Request body must include a figmaUrl field with a Figma share link.",
        requestId: req.id,
      });
    }

    // ── ★★ RUN 3: RESOLVE THIS ORDER'S FIGMA CREDENTIAL. ────────────────────
    // This is the point at which an order stops being "a Maveloper order" and
    // becomes "an order belonging to a space". `orgId` arrives on the body from
    // queue-runner.js, which joins it off os_queue.org_id.
    //
    // ★ IT CANNOT FAIL THE ORDER. Every error path inside resolveFigmaToken -
    // no org, no table, Supabase down, row absent, revoked, expired, wrong
    // sealing key, malformed - lands on `globalToken`, which is the same
    // FIGMA_API_TOKEN this handler used before this block existed. A space with
    // no credential is byte-identical to today.
    // ── ★★ FIGMA OAUTH RUN 1: OAUTH FIRST, PASTED-TOKEN RESOLVER UNCHANGED. ──
    // Tries this space's connected Figma OAuth account first. When there is
    // none, oauthCred is null and figmaCred becomes the result of THIS SAME
    // resolveFigmaToken(...) call the code made before this block existed -
    // not a re-shaped copy of it, the actual call, so a space with no OAuth
    // connection is byte-identical to today. shapeOAuthResolution (figma-
    // oauth.js) is the one place the OAuth-to-resolution mapping is written;
    // resolveFigmaCredential in that file performs this same composition for
    // its own test coverage, but this call site inlines it rather than
    // calling that wrapper, so this file keeps a real, direct call to
    // resolveFigmaToken in its own text.
    const oauthCred = await resolveFigmaOAuth(req.body?.orgId, { db: supabaseAdmin });
    const figmaCred = oauthCred
      ? shapeOAuthResolution(oauthCred, req.body?.orgId)
      : await resolveFigmaToken(req.body?.orgId, {
          db: supabaseAdmin,
          globalToken: FIGMA_API_TOKEN,
        });
    const figmaToken = figmaCred.token;

    // ★ THE ONLY SAFE SHAPE TO LOG. describeResolution replaces `token` with a
    // BOOLEAN, so there is no code path by which this line can print a
    // credential - the value is simply not present in the object being
    // serialised. log() at :4365 JSON-stringifies its extras with NO REDACTION,
    // which is exactly why what is handed to it must be incapable of carrying a
    // secret rather than merely trusted not to.
    log("info", "Figma credential resolved", {
      requestId: req.id,
      ...describeResolution(figmaCred),
    });

    // ★ THE GUARD NOW ASKS THE QUESTION IT MEANT TO ASK. It used to test the
    // module-scope FIGMA_API_TOKEN. That would 503 a space that HAS pasted its
    // own working credential merely because the Mavlers global was unset. When
    // no space credential exists the resolved token IS the global, so this is
    // identical to the old check in every case that exists today.
    if (!figmaToken) {
      return res.status(503).json({
        error: "Figma not configured",
        details:
          "No Figma credential is available for this order. Either set the FIGMA_API_TOKEN env var " +
          "on the backend, or add this space's own Figma token in the space settings.",
        requestId: req.id,
      });
    }

    log("info", "Figma generation starting", {
      requestId: req.id,
      figmaUrl: figmaUrl.split("?")[0], // strip query params for cleaner logs
      userId: req.user?.id ?? "anonymous",
      userEmail: req.user?.email ?? "anonymous",
    });

    // --- Stage 1 (Figma): parse URL â†’ fetch â†’ produce designSpec ---
    let figmaResult;
    try {
      figmaResult = await figmaToDesignSpec({
        figmaUrl,
        // ★ RUN 3 SITE 1 OF 3. Reads the client's design file. Was the Mavlers
        // global; is now this space's own credential when one is stored.
        token: figmaToken,
        devOverrides: { emailWidth, primaryFont, secondaryFont },
      });
    } catch (figmaErr) {
      // Surface user-facing errors (bad URL, multi-frame ambiguity) as 400.
      // Network / token / API errors are 502.
      const msg = figmaErr.message || "";
      const isUserError =
        figmaErr.code === "MULTIPLE_EMAIL_FRAMES" ||
        /Figma URL|Figma frame|Figma node|email-shaped|email design frame|Right-click|Copy link/i.test(msg);
      log("warn", "Figma parse failed", {
        requestId: req.id,
        error: msg,
        code: figmaErr.code,
        userError: isUserError,
      });
      return res.status(isUserError ? 400 : 502).json({
        error:
          figmaErr.code === "MULTIPLE_EMAIL_FRAMES"
            ? "Multiple email frames in URL"
            : isUserError
            ? "Invalid Figma URL"
            : "Figma fetch failed",
        details: msg,
        candidates: figmaErr.candidates ?? undefined, // structured list for picker UI
        requestId: req.id,
      });
    }

    const { designSpec, imageRefs, fileName, sourceFrame, warnings, fileKey, nodeId, layoutMode } = figmaResult;

    // --- Resolve the Order ID (id-space reconciliation) -------------------
    // PRIORITY 1: the OWNER-SUPPLIED order id from the request body. This is the
    // name the /os queue stores as os_queue.order_id (e.g. "TEST23-1930") and the
    // exact id /approve packages the delivery folder under. The queue runner
    // passes it as jobBody.orderId; a caller may pass it directly. Honouring it
    // HERE is the fix for the two-id-space split: generation-time images + preview
    // upload to /maveloper/<YYYY>/<MM-YYYY>/<OWNER ID>/ and maveloper_jobs.order_id
    // becomes the OWNER id, so the html and its images finally share ONE folder
    // keyed the same way /approve keys the html.
    // PRIORITY 2 (fallback, unchanged): derive from the frame name (OF/OID + 8+
    // digits). PRIORITY 3: a synthetic FIGMA-<ts> so a nameless order still runs.
    const bodyOrderId = sanitizeOrderId(req.body?.orderId);
    const orderIdMatch = sourceFrame.name?.match(/(?:OID|OF)\d{8,}/i);
    const orderId = bodyOrderId
      || (orderIdMatch ? orderIdMatch[0].toUpperCase() : `FIGMA-${Date.now()}`);

    log("info", "Figma parse complete", {
      requestId: req.id,
      orderId,
      fileName,
      frameName: sourceFrame.name,
      frameWidth: sourceFrame.width,
      sections: designSpec.sections.length,
      imageRefs: imageRefs.length,
      layoutMode,
      warnings,
    });

    // --- Build developer specs (mirrors PDF flow) ---
    const finalWidth = emailWidth || designSpec.width;
    const finalFont = primaryFont || designSpec.font_body;

    const specs = [];
    specs.push(`EMAIL_WIDTH: ${finalWidth}px`);
    specs.push(`PRIMARY_FONT: ${finalFont}`);
    if (secondaryFont) specs.push(`SECONDARY_FONT: ${secondaryFont}`);
    if (espPlatform && espPlatform !== "none") specs.push(`ESP_PLATFORM: ${espPlatform}`);
    // v2.7.10: dark mode is DEVELOPER-CONTROLLED, DEFAULT LIGHT-ONLY. Resolve once; thread to the
    // engine instruction (specs) AND the spec.json the validator reads (designSpec.darkMode).
    const resolvedDarkMode = (darkMode === true || darkMode === "true");   // default (absent/false) = light-only
    designSpec.darkMode = resolvedDarkMode;
    specs.push(resolvedDarkMode
      ? `DARK_MODE: true (emit dark-mode support: @media prefers-color-scheme:dark block + color-scheme metas + em_dark scaffold)`
      : `DARK_MODE: false (LIGHT-ONLY â€” OMIT the dark-mode @media block and color-scheme metas entirely)`);

    // --- v6.2.0 Phase B: render & export images from Figma to Dropbox ---
    // For every image node the parser found (inline images, section bg_images,
    // and atomic visual units like icons/logos/decorative graphics), render
    // via Figma /v1/images, download the PNG, upload to Dropbox, and patch
    // the designSpec's src fields so Stage 2 sees real URLs. Also render
    // the parent email frame for the side-by-side preview pane.
    let imageUrlMap = {};
    let previewImageUrl = null;
    let previewBufferForStage2 = null;  // v6.6.0: held for Stage 2 visual input
    // renderMs / uploadMs are new and additive: durationMs was the whole phase in
    // one number, so nobody could say which half cost what. All three now ship.
    let imageExportReport = { rendered: 0, uploaded: 0, patched: 0, missing: 0, durationMs: 0, renderMs: 0, uploadMs: 0, bgImageCount: 0 };
    const imageExportStartTime = Date.now();

    try {
      // Collect ALL nodeIds to render:
      // 1. Inline images from imageRefs (parser-emitted image elements)
      // 2. Section bg_images (v6.2.0 hero-with-overlay pattern)
      // 3. The email frame itself (for the preview pane)
      const inlineImageNodeIds = imageRefs.map((r) => r.nodeId);
      // v6.5.0: bg_image collection now also captures imageRef so we can
      // fetch the RAW (uncomposited) image instead of a frame render.
      // Without this fix, frames with image fill + text children render
      // as PNGs containing the text â€” which then duplicates when the HTML
      // overlay text is rendered on top of the bg ("double print" bug).
      const bgImageNodes = [];
      for (const s of designSpec.sections || []) {
        if (s.bg_image && s.bg_image._figmaNodeId) {
          bgImageNodes.push({
            nodeId: s.bg_image._figmaNodeId,
            imageRef: s.bg_image._imageRef,   // v6.5.0
            name: s.bg_image.alt || `section-${s.n}-bg`,
            width: s.bg_image.width,
            height: s.bg_image.height,
          });
        }
      }
      imageExportReport.bgImageCount = bgImageNodes.length;

      // v6.4.0: dedup imageRefs by renderKey before calling Figma.
      // Multiple INSTANCEs sharing a component master at the same size
      // render to identical PNGs â€” render once, reuse URL across all
      // instances. Cuts ~20% off Arsenal Pulse render count and avoids
      // duplicate Dropbox uploads.
      const renderKeyToNodeId = new Map();  // renderKey â†’ first nodeId seen
      const nodeIdToRenderKey = new Map();  // nodeId â†’ renderKey (for patching)
      for (const ref of imageRefs) {
        nodeIdToRenderKey.set(ref.nodeId, ref.renderKey);
        if (!renderKeyToNodeId.has(ref.renderKey)) {
          renderKeyToNodeId.set(ref.renderKey, ref.nodeId);
        }
      }
      const dedupedInlineIds = Array.from(renderKeyToNodeId.values());

      // Collect ALL nodeIds to render via /v1/images (inline + preview).
      // v6.5.0: bg_images NO LONGER go through /v1/images â€” they use raw
      // image-ref URLs via /v1/files/.../images to avoid double-print.
      const previewNodeId = sourceFrame.id;
      const allNodeIds = [
        ...dedupedInlineIds,
        ...(previewNodeId ? [previewNodeId] : []),
      ];

      if (allNodeIds.length > 0 || bgImageNodes.length > 0) {
        log("info", "Phase B: requesting Figma render", {
          requestId: req.id,
          inlineImagesTotal: imageRefs.length,
          inlineImagesUnique: dedupedInlineIds.length,
          dedupSavings: imageRefs.length - dedupedInlineIds.length,
          bgImages: bgImageNodes.length,
          includesPreview: Boolean(previewNodeId),
        });

        // Inline images + preview: composited renders via /v1/images
        // ── ★ THE FIGMA RENDER PHASE, SPLIT OUT (instrument only) ─────────────
        // WHAT THE LOGS ALREADY SHOWED: "Phase B: image export complete" carries
        // a durationMs, but it is the duration of the WHOLE phase — Figma render,
        // PNG download, raw bg-image fetch, the Dropbox upload, the spec patch and
        // the preview upload, in one number. Asking "how long does Figma take" of
        // that number is unanswerable, which is why it has never been answered.
        // renderMs is the /v1/images call plus the signed-URL PNG downloads
        // (PNG_DOWNLOAD_CONCURRENCY=5 in figma-image-export.js) and NOTHING else,
        // so it can be subtracted from the phase and from the upload.
        const tRenderStart = Date.now();
        const bufferMap = allNodeIds.length > 0
          ? await renderFigmaNodes({
              fileKey,
              nodeIds: allNodeIds,
              // ★ RUN 3 SITE 2 OF 3. Renders nodes out of the client's file.
              token: figmaToken,
              logFn: (level, msg, meta) => log(level, msg, { requestId: req.id, ...meta }),
            })
          : new Map();
        imageExportReport.renderMs = Date.now() - tRenderStart;
        imageExportReport.rendered = bufferMap.size;
        let renderedBytes = 0;
        for (const b of bufferMap.values()) renderedBytes += b?.length || 0;
        log("info", "Phase B: Figma render + PNG download complete", {
          requestId: req.id,
          requested: allNodeIds.length,
          returned: bufferMap.size,
          missing: allNodeIds.length - bufferMap.size,
          renderMs: imageExportReport.renderMs,
          bytes: renderedBytes,
          mb: Number((renderedBytes / 1048576).toFixed(2)),
        });

        // v6.5.0: Background images use RAW image-ref URLs (no compositing).
        // This prevents the "double print" bug where /v1/images bakes child
        // text into the bg PNG, then the HTML also renders the text on top.
        if (bgImageNodes.length > 0) {
          try {
            const refsNeeded = bgImageNodes.filter((b) => b.imageRef).map((b) => b.imageRef);
            if (refsNeeded.length > 0) {
              // ★ RUN 3 SITE 3 OF 3. Fetches raw image-ref URLs from the file.
              const rawUrlMap = await fetchRawImageRefUrls({ fileKey, token: figmaToken });
              for (const bg of bgImageNodes) {
                if (!bg.imageRef) continue;
                const signedUrl = rawUrlMap.get(bg.imageRef);
                if (!signedUrl) {
                  log("warn", "Phase B: no raw URL for imageRef", { requestId: req.id, imageRef: bg.imageRef });
                  continue;
                }
                try {
                  const r = await fetch(signedUrl);
                  if (!r.ok) throw new Error(`HTTP ${r.status}`);
                  const buf = Buffer.from(await r.arrayBuffer());
                  bufferMap.set(bg.nodeId, buf);
                  imageExportReport.rendered++;
                } catch (downloadErr) {
                  log("warn", "Phase B: raw bg image download failed", {
                    requestId: req.id, imageRef: bg.imageRef, error: downloadErr.message,
                  });
                }
              }
            }
          } catch (rawErr) {
            log("warn", "Phase B: raw image-ref fetch failed, bg_images will be empty", {
              requestId: req.id, error: rawErr.message,
            });
          }
        }

        // Pull out the email frame preview separately
        const previewBuffer = previewNodeId ? bufferMap.get(previewNodeId) : null;
        if (previewNodeId) bufferMap.delete(previewNodeId);
        previewBufferForStage2 = previewBuffer; // v6.6.0: pass to Stage 2 as visual reference

        if (dropboxConfigured) {
          const takenFilenames = new Set();
          const nodeIdToFilename = new Map();
          const renderKeyToFilename = new Map(); // v6.4.0: share filename across renderKey
          const dropboxImages = [];

          // Inline images: one upload per unique renderKey, all sharing instances point to it
          for (const ref of imageRefs) {
            // Use existing filename if another instance with same renderKey was processed
            const existingFilename = renderKeyToFilename.get(ref.renderKey);
            if (existingFilename) {
              nodeIdToFilename.set(ref.nodeId, existingFilename);
              continue;
            }
            // First time seeing this renderKey â€” render & upload
            const buf = bufferMap.get(ref.nodeId);
            if (!buf) continue;
            const filename = makeFilename(ref.name, ref.width, ref.height, takenFilenames);
            renderKeyToFilename.set(ref.renderKey, filename);
            nodeIdToFilename.set(ref.nodeId, filename);
            dropboxImages.push({ filename, buffer: buf });
          }
          // Background images (no dedup â€” heroes are typically unique)
          for (const bg of bgImageNodes) {
            if (nodeIdToFilename.has(bg.nodeId)) continue;
            const buf = bufferMap.get(bg.nodeId);
            if (!buf) continue;
            const filename = makeFilename(`bg-${bg.name}`, bg.width, bg.height, takenFilenames);
            nodeIdToFilename.set(bg.nodeId, filename);
            dropboxImages.push({ filename, buffer: buf });
          }

          // SKIP2 / NOLLM: the deterministic compiler does not read designSpec image
          // src, and (run 14) the bridge is the only engine, so these Figma NODE
          // EXPORTS are never uploaded. The preview upload below still fires on
          // every order; the Figma render and download above are untouched.
          const skipPhaseBUpload = true;

          if (!skipPhaseBUpload && dropboxImages.length > 0) {
            const tUploadStart = Date.now();
            imageUrlMap = await uploadImagesToDropbox(orderId, dropboxImages, log);
            imageExportReport.uploadMs = Date.now() - tUploadStart;
            imageExportReport.uploaded = Object.keys(imageUrlMap).length;
          } else if (skipPhaseBUpload && dropboxImages.length > 0) {
            log("info", "Phase B: node-export upload SKIPPED (compiler order, fallback disabled)", {
              requestId: req.id,
              orderId,
              wouldHaveUploaded: dropboxImages.length,
            });
          }

          // Patch designSpec â€” covers both content[].src and section.bg_image.src
          const patchReport = patchSpecImageSrcs(designSpec, nodeIdToFilename, imageUrlMap);
          imageExportReport.patched = patchReport.patched;
          imageExportReport.missing = patchReport.missing;

          // Upload the preview frame
          if (previewBuffer) {
            try {
              const previewPath = `${getDropboxFolderPath(orderId)}/preview.png`;
              const { directUrl } = await uploadToDropbox(previewPath, previewBuffer);
              previewImageUrl = directUrl;
            } catch (previewErr) {
              log("warn", "Phase B: preview upload failed (non-fatal)", {
                requestId: req.id,
                error: previewErr.message,
              });
            }
          }
        } else {
          log("warn", "Phase B: Dropbox not configured; image src will be empty", { requestId: req.id });
          for (const s of designSpec.sections) {
            for (const c of s.content) delete c._figmaNodeId;
            if (s.bg_image) delete s.bg_image._figmaNodeId;
          }
        }
      } else {
        for (const s of designSpec.sections) {
          for (const c of s.content) delete c._figmaNodeId;
          if (s.bg_image) delete s.bg_image._figmaNodeId;
        }
      }

      imageExportReport.durationMs = Date.now() - imageExportStartTime;
      log("info", "Phase B: image export complete", { requestId: req.id, ...imageExportReport });
    } catch (imgErr) {
      log("error", "Phase B: image export failed, degrading to empty src", {
        requestId: req.id,
        error: imgErr.message,
      });
      imageUrlMap = {};
      for (const s of designSpec.sections) {
        for (const c of s.content) delete c._figmaNodeId;
        if (s.bg_image) delete s.bg_image._figmaNodeId;
      }
    }

    // Stage 2 inputs the bridge path still uses. The direct-API prompt
    // assembly that used to sit here is gone (run 14).
    const hasVisualReference = Boolean(previewBufferForStage2);
    const referenceHtml = REFERENCE_CACHE.get(fileKey);
    const stage2StartTime = Date.now();

    // RUN 14: the Claude Code bridge is the only Stage 2 engine. The header /
    // body / env selector and the direct-API branch are gone.
    const requestedEngine = "claude-code";

    log("info", "Stage 2: Sending Figma spec to Claude", {
      requestId: req.id,
      engine: requestedEngine,
      specSections: designSpec.sections.length,
      imageRefs: imageRefs.length,
      devSpecs: specs.length,
      finalWidth,
      finalFont,
      espPlatform: espPlatform || "none",
      darkMode: (darkMode === true || darkMode === "true"),  // v2.7.10: default false = light-only
      hasVisualReference,                            // v6.6.0
      previewBytesKB: previewBufferForStage2 ? Math.round(previewBufferForStage2.length / 1024) : 0,
      hasReferenceHtml: Boolean(referenceHtml),      // v8.0.0
      referenceHtmlKB: referenceHtml ? Math.round(referenceHtml.length / 1024) : 0,
    });

    let html_raw;
    let engineUsed = requestedEngine;
    // COMPILER ZIP FIX: out-param sink callClaudeCodeBridge fills with the slice
    // map when the deterministic compiler ran (the bridge uploaded the slice PNGs
    // to Dropbox in /bridge-callback). Stays empty on the LLM/fallback path.
    const compilerAssetSink = {};

      // â”€â”€â”€ Claude Code path (Mac bridge, Max 20Ã— subscription) â”€â”€â”€
      try {
        const designImageBase64ForCC = previewBufferForStage2
          ? previewBufferForStage2.toString("base64")
          : null;

        html_raw = await callClaudeCodeBridge({
          designSpec,
          referenceHtml: referenceHtml || null,
          designImageBase64: designImageBase64ForCC,
          model: req.body?.model || BRIDGE_DEFAULT_MODEL,
          requestId: req.id,
          maveloperJobId: req.body?._maveloperJobId || null,
          espPlatform: req.body?.espPlatform || "none",
          // COMPILER FLIP â€” STEP 4: the Figma coordinates parsed for this order
          // (fileKey, nodeId from figmaResult; finalWidth as the design width).
          // Threaded so the bridge can offer this design to the deterministic
          // compiler when it is enabled + allow-listed. Optional and additive.
          figmaFileKey: fileKey,
          figmaNodeId: nodeId,
          figmaDesignWidth: finalWidth,
          // ★★ RUN 3: THE SAME credential this handler resolved and used for its
          // own three Figma calls. The engine re-reads the design from Figma
          // itself, so it needs the identical token or the two halves of one
          // order would read from two different Figma accounts.
          figmaToken,
          log,
          assetSink: compilerAssetSink,
        });
      } catch (err) {
        // A bridge failure ALWAYS returns this 502. There is no fallback engine
        // (run 14 removed the direct-API branch). Response shape preserved:
        // same 502 status, same keys, same engineUsed "claude-code-failed-no-fallback".
        log("error", "Claude Code bridge failed; fallback DISABLED (AI_ENGINE_NO_FALLBACK=true)", {
          requestId: req.id,
          error: err.message,
        });
        return res.status(502).json({
          error: "Claude Code bridge failed and automatic fallback is disabled.",
          details: err.message,
          requestId: req.id,
          engineUsed: "claude-code-failed-no-fallback",
          hint: "Fix the bridge (check the engine service and cc-runner.mjs). There is no fallback engine.",
        });
      }

    // COMPILER ZIP FIX: fold the compiler slice map (if the compiler ran) into
    // imageUrlMap so it reaches result.body.imageUrlMap â†’ /approve, whose ZIP then
    // localises the slice PNGs into images/ exactly like the LLM node exports.
    // INERT on the LLM/fallback path: compilerAssetSink is empty, so mergeCompilerSlices
    // returns the SAME imageUrlMap object by reference (no new keys, byte-identical).
    // The delivered EMAIL html is unaffected â€” html_raw already carries absolute slice
    // URLs and fixImageUrls (below) skips http(s): src, so only the ZIP copy differs.
    imageUrlMap = mergeCompilerSlices(imageUrlMap, compilerAssetSink.compilerImageUrlMap);

    // COMPILER ZIP FIX v2 (drafts persist): the /approve ZIP is built from the
    // imageUrlMap the FRONTEND loads from the `drafts` table (drafts.image_url_map,
    // keyed by order_id) â€” NOT from result.body/maveloper_jobs, and NOT from os_queue
    // (which has no image_url_map column). Threading the merged map through res.json
    // alone therefore never reaches the table /approve reads. Persist it to `drafts`
    // here on the in-memory (non-restart) delivery route. GATED on a non-empty compiler
    // slice map â†’ a no-op on every LLM/figma-only order (the frontend owns those draft
    // rows, which persist byte-for-byte as today). Non-fatal: helper only logs on error.
    if (
      compilerAssetSink.compilerImageUrlMap &&
      Object.keys(compilerAssetSink.compilerImageUrlMap).length > 0
    ) {
      await persistSliceMapToDrafts(supabaseAdmin, log, orderId, imageUrlMap, req.id);
    }

    // --- Post-processing: most rules are no-ops on Figma path, but HTML
    //     hygiene rules (font stacks, malformed self-closing img, Google
    //     Fonts link conversion) still apply.
    const postProcessResult = postProcessHtml(html_raw, {
      imageUrlMap,
      palette: designSpec._palette || [],
      bandMap: [], // Figma path has no band map
      imageDimensionsMap: {}, // Phase A: no dimension data without exporting
      zipWasUploaded: false,
      // Only strip a font the caller EXPLICITLY passed as secondary. The old
      // `|| designSpec.font_heading` default aimed the strip at the design's own
      // brand font (e.g. Clash Grotesk) â€” fixSecondaryFontInBodyStack then removed
      // it from every font-family stack, leaving only the Arial/Helvetica fallback.
      // Never default to the spec's font; when absent, strip nothing.
      secondaryFont: secondaryFont,
      // v9.7.0: Figma/bridge path â†’ hygiene-only. Skips every PDF/OCR/Stage-2-era
      // colour/text/structure corrector so the validated design is never overridden.
      mode: "figma",
      requestId: req.id,
    });
    const html = postProcessResult.html;

    // v9.7.0 (Â§5): assert the hygiene pass did not break a validator guarantee.
    // Never hard-fails â€” logs ERROR + returns violations so they are observable.
    const postProcessAssertions = assertFigmaPostProcess(html_raw, html, designSpec, {
      requestId: req.id,
      source: "generate-from-figma",
    });

    log("info", "Figma generation complete", {
      requestId: req.id,
      orderId,
      engineUsed,                                              // v9.0.2: definitive engine record
      stage2DurationMs: Date.now() - stage2StartTime,
      totalPipelineDurationMs: Date.now() - startTime,
      htmlLength: html.length,
      specSections: designSpec.sections.length,
      googleFontLinkConvertFixes: postProcessResult.report.googleFontLinkConvert?.fixes,
      malformedImgFixes: postProcessResult.report.malformedImgFix?.fixes,
      fontStackQuoteFixes: postProcessResult.report.fontStackQuotes?.fixes,
      secondaryFontStripFixes: postProcessResult.report.secondaryFontStrip?.fixes,
    });

    // --- Return response ---
    res.json({
      html,
      orderId,
      pageCount: 1, // Figma has no pages concept â€” single frame in, single HTML out
      pageImages: previewImageUrl ? [previewImageUrl] : [], // v6.1.0: side-by-side preview
      imageUrlMap,
      imageSource: "figma",
      imageCount: Object.keys(imageUrlMap).length,
      imageExportReport,                                    // v6.1.0: visibility into export status
      engineUsed,                                           // v9.0.2: "claude-code" | "console" | "console-fallback"
      // ★★ RUN 3 - THE PROVENANCE SIGNAL. WHICH FIGMA ACCOUNT PAID FOR THIS.
      // A silent fallback to the Mavlers token is INVISIBLE FOREVER unless every
      // delivered order says which credential produced it. Two fields, neither
      // of which can carry the token: a one-line sentence for a human, and the
      // structured resolution (whose `token` is a boolean by construction) for
      // anything that wants to assert on it.
      figmaCredential: figmaCredentialProvenanceLine(figmaCred),
      figmaCredentialDetail: describeResolution(figmaCred),
      referenceHtmlUsed: Boolean(REFERENCE_CACHE.get(fileKey)), // v8.0.0: was a human-coded reference injected
      figmaSource: {
        fileKey,
        nodeId,
        fileName,
        frameName: sourceFrame.name,
        frameWidth: sourceFrame.width,
        layoutMode,
      },
      designSpec,
      warnings,
      // v9.7.0 (Â§5): post-process assertion violations (empty array = clean). The
      // async wrapper surfaces these into the job's progress_message for DB visibility.
      postProcessAssertions,
      requestId: req.id,
    });
  } catch (err) {
    log("error", "Figma generation error", {
      requestId: req.id,
      error: err.message,
      errorBody: err.error ? JSON.stringify(err.error).substring(0, 2000) : "no error body",
      status: err.status,
      durationMs: Date.now() - startTime,
    });

    let userMessage = "An unexpected error occurred. Please try again.";
    let statusCode = 500;

    if (err.message?.includes("timed out") || err.message?.includes("timeout")) {
      userMessage = "Figma API or Claude took too long. Try again.";
      statusCode = 504;
    } else if (err.status === 429) {
      userMessage = "Maveloper is currently overloaded. Please wait a minute and try again.";
      statusCode = 429;
    } else if (err.status === 401) {
      userMessage = "Backend configuration error. Please contact the Maveloper admin.";
      statusCode = 500;
    } else if (err.message?.includes("Not allowed by CORS")) {
      userMessage = "Request blocked by CORS policy.";
      statusCode = 403;
    }

    res.status(statusCode).json({
      error: "Figma generation failed",
      details: userMessage,
      requestId: req.id,
    });
  }
});

// =====================================================================
// v9.1.0 â€” POST /generate-from-figma-async
//
// Async wrapper around /generate-from-figma. Returns a jobId immediately
// (<1s). Generation runs in background; result is stored in Supabase
// maveloper_jobs table for Lovable to poll via /job-status/:jobId.
//
// Request body: same shape as /generate-from-figma plus optional fields.
//   { figmaUrl, emailWidth?, primaryFont?, secondaryFont?, espPlatform?, darkMode? }
//
// Response (immediate, ~1s):
//   { jobId, status: "pending", requestId }
//
// Background worker writes one of these final states to Supabase:
//   status="completed", result_html=<string>, engine_used=<string>
//   status="failed", error_message=<string>
// =====================================================================
//
// v9.6.0 â€” startFigmaJobAsync: the reusable core of /generate-from-figma-async.
// Extracted (behaviour-preserving) so BOTH the HTTP route and the server-side
// queue runner (queue-runner.js) can start a generation without an HTTP hop.
// The runner has no user JWT, so calling this in-process sidesteps auth entirely.
//
// Params:  { body, requestId, user, headers }  (headers/user optional â€” the
//          runner passes {} / null; the HTTP route passes req.headers / req.user).
// Returns: { statusCode:202, jobId, status, deduped? }        on success
//          { statusCode, error, details }                     on validation/setup fail
//
// The background worker below is byte-for-byte the same logic as before; only the
// req.* references became the passed-in params (req.bodyâ†’body, req.idâ†’requestId,
// req.userâ†’user, req.headersâ†’headers). No generation logic changed.
//
async function startFigmaJobAsync({ body, requestId, user, headers }) {
  body = body || {};
  headers = headers || {};
  const figmaUrl = body.figmaUrl;

  if (!figmaUrl || typeof figmaUrl !== "string") {
    return {
      statusCode: 400,
      error: "Missing figmaUrl",
      details: "Request body must include a figmaUrl field with a Figma share link.",
    };
  }

  if (!supabaseAdmin) {
    return {
      statusCode: 503,
      error: "Async generation unavailable",
      details: "Supabase is not configured on the backend. The async job table is required.",
    };
  }

  // â”€â”€ v9.4.0 DEDUP GUARD (duplicate-generation cascade) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Lovable can fire this endpoint twice for the same design in quick
  // succession (double-submit / re-render / retry), spawning two ~20-min
  // generations. Before creating a new job, return the id of a recent
  // still-active job for the SAME figma_url instead of starting a second.
  const DEDUP_WINDOW_MS = 120000; // 2 min â€” catches rapid double-fires and
                                  // retry-after-timeout; gated on active
                                  // status, so completed jobs never block a
                                  // deliberate re-run, and stuck jobs self-heal.
  try {
    const sinceIso = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const { data: existing } = await supabaseAdmin
      .from("maveloper_jobs")
      .select("id, status, created_at")
      .eq("figma_url", figmaUrl)
      .in("status", ["pending", "running"])
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing && existing.id) {
      log("info", "Dedup: returning existing active job for figma_url", {
        requestId,
        jobId: existing.id,
        status: existing.status,
        figmaUrl: figmaUrl.split("?")[0],
      });
      return {
        statusCode: 202,
        jobId: existing.id,
        status: existing.status,
        deduped: true,
      };
    }
  } catch (dedupErr) {
    // Non-fatal: never block a real generation on the guard.
    log("warn", "Dedup check failed; proceeding to create job", {
      requestId,
      error: dedupErr?.message,
    });
  }
  // â”€â”€ end dedup guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Create the job row immediately. We need the jobId before returning to Lovable.
  // ID-SPACE RECONCILIATION: persist the OWNER-SUPPLIED order id (when the caller
  // provided one â€” the queue runner always does) at INSERT time. /bridge-callback
  // fires DURING generation (before the handler returns and the completion write
  // below runs), and it reads maveloper_jobs.order_id to key the compiler slice
  // folder. Setting it here means those slices land in the OWNER folder, not a
  // bridgeJobId fallback folder. Null when no order id was supplied (unchanged
  // behaviour: the handler then derives one and the completion write records it).
  const insertOrderId = sanitizeOrderId(body.orderId) || null;
  const { data: job, error: insertErr } = await supabaseAdmin
    .from("maveloper_jobs")
    .insert({
      status: "pending",
      figma_url: figmaUrl,
      progress_message: "Job created; waiting to start",
      ...(insertOrderId ? { order_id: insertOrderId } : {}),
    })
    .select("id")
    .single();

  if (insertErr || !job) {
    log("error", "Failed to create maveloper_jobs row", {
      requestId,
      error: insertErr?.message,
    });
    return {
      statusCode: 500,
      error: "Failed to create job",
      details: "Could not initialize the async generation job in Supabase.",
    };
  }

  const jobId = job.id;

  log("info", "Async Figma generation started", {
    requestId,
    jobId,
    figmaUrl: figmaUrl.split("?")[0],
    userId: user?.id ?? "anonymous",
  });

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Background work â€” runs after the caller flushes its 202 response.
  // setImmediate ensures Node finishes flushing the response before
  // we start the long-running task.
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  setImmediate(async () => {
    const bgStartTime = Date.now();
    try {
      await updateJobStatus(jobId, {
        status: "running",
        progress_message: "Generation started; calling /generate-from-figma handler internally",
      }, requestId);

      // Build a fake request mirroring the real one. The existing
      // /generate-from-figma handler will read req.body and req.id from it.
      // v9.3.0: pass _maveloperJobId so callClaudeCodeBridge can tag the
      // Supabase row with bridgeJobId, enabling restart-resilient callbacks.
      const fakeReq = {
        body: { ...body, _maveloperJobId: jobId },
        id: requestId,
        user: user,
        headers: headers || {},
        get: (h) => (headers ? headers[h.toLowerCase()] : undefined),
      };

      // Build a fake response object that captures status + body in memory.
      const { res: fakeRes, result } = createFakeResponse();

      // Invoke the synchronous handler. It will populate `result.body`
      // when it finishes (success or error). This call can take 10-30 min.
      // We DELIBERATELY do not await any Railway HTTP timeout here â€” the
      // outer endpoint has already returned to the client.
      const handlerEntry = app._router?.stack?.find((layer) =>
        layer.route?.path === "/generate-from-figma" && layer.route?.methods?.post
      );

      if (!handlerEntry || !handlerEntry.route) {
        throw new Error("/generate-from-figma route not found in Express router");
      }

      // The route's handler stack includes generateLimiter and the sign-in +
      // seat doors (route-doors.js) before the actual handler. For the
      // internal call we skip those: the HTTP caller has already passed them
      // on the async endpoint, and the queue runner has no user at all. Find
      // the last handler in the route's stack (the actual generation handler).
      const handlerStack = handlerEntry.route.stack;
      const actualHandler = handlerStack[handlerStack.length - 1].handle;

      await actualHandler(fakeReq, fakeRes, (err) => {
        // Express "next" â€” only called on error inside the handler.
        if (err) throw err;
      });

      // Handler completed. Inspect result.
      const durationSec = Math.round((Date.now() - bgStartTime) / 1000);

      if (result.statusCode >= 200 && result.statusCode < 300 && result.body?.html) {
        // SUCCESS
        // v9.7.0 (Â§5): surface post-process assertion violations into the job's
        // progress_message so they are DB-visible via /job-status (not just in logs).
        const ppAssertions = Array.isArray(result.body.postProcessAssertions)
          ? result.body.postProcessAssertions
          : [];
        // RUN 3 - THE PROVENANCE SIGNAL, MADE DURABLE.
        // The response body is ephemeral: the queue runner is the caller and
        // nothing persists it. progress_message IS persisted, IS returned by
        // /job-status, and IS what the console already reads. v9.7.0 set this
        // precedent by surfacing post-process assertions the same way.
        //
        // NOT A SIDECAR FILE. Provenance sidecars in this system have been
        // clobbered before - D117/D121 disclosures were overwritten and 0 of 79
        // sidecars ever carried them. A column on the job row cannot be
        // silently overwritten by a later, unrelated writer.
        const credLine = typeof result.body.figmaCredential === "string"
          ? " | " + result.body.figmaCredential
          : "";
        const progressMsg = (ppAssertions.length > 0
          ? `Generation complete in ${durationSec}s â€” POST-PROCESS WARNING: ${ppAssertions.join("; ")}`
          : `Generation complete in ${durationSec}s`) + credLine;
        await updateJobStatus(jobId, {
          status: "completed",
          result_html: result.body.html,
          engine_used: result.body.engineUsed ?? null,
          // v9.5.0: persist orderId + imageUrlMap so the frontend can call /approve.
          // Both are produced during generation (result.body) but were previously
          // dropped â€” /job-status returned result.orderId/imageUrlMap = undefined,
          // so the frontend disabled the Approve button. Requires the order_id +
          // image_url_map columns (see migration note).
          order_id: result.body.orderId ?? null,
          image_url_map: result.body.imageUrlMap ?? null,
          progress_message: progressMsg,
          completed_at: new Date().toISOString(),
        }, requestId);
        log("info", "Async job completed", { requestId, jobId, durationSec, postProcessViolations: ppAssertions.length });
      } else {
        // FAILURE â€” handler set non-2xx status or no html
        const errMsg = result.body?.error
          ? `${result.body.error}: ${result.body.details ?? ""}`.trim()
          : `Handler returned status ${result.statusCode} with no html`;
        await updateJobStatus(jobId, {
          status: "failed",
          error_message: errMsg.substring(0, 2000),
          completed_at: new Date().toISOString(),
        }, requestId);
        log("warn", "Async job failed", {
          requestId,
          jobId,
          statusCode: result.statusCode,
          error: errMsg,
          durationSec,
        });
      }
    } catch (bgErr) {
      const durationSec = Math.round((Date.now() - bgStartTime) / 1000);
      log("error", "Async job crashed", {
        requestId,
        jobId,
        error: bgErr.message,
        stack: bgErr.stack?.substring(0, 1000),
        durationSec,
      });
      await updateJobStatus(jobId, {
        status: "failed",
        error_message: `Internal error: ${bgErr.message}`.substring(0, 2000),
        completed_at: new Date().toISOString(),
      }, requestId);
    }
  });

  return { statusCode: 202, jobId, status: "pending" };
}

app.post("/generate-from-figma-async", generateLimiter, ...doors.generate, async (req, res) => {
  try {
    const result = await startFigmaJobAsync({
      body: req.body,
      requestId: req.id,
      user: req.user,
      headers: req.headers,
    });

    if (result.error) {
      return res.status(result.statusCode || 500).json({
        error: result.error,
        details: result.details,
        requestId: req.id,
      });
    }

    // Success (202). Mirror the previous response shape exactly, adding
    // `deduped: true` only when the dedup guard short-circuited.
    const payload = { jobId: result.jobId, status: result.status, requestId: req.id };
    if (result.deduped) payload.deduped = true;
    return res.status(202).json(payload);
  } catch (err) {
    log("error", "Async endpoint setup error", {
      requestId: req.id,
      error: err.message,
    });
    res.status(500).json({
      error: "Failed to start async generation",
      details: err.message,
      requestId: req.id,
    });
  }
});

// =====================================================================
// v9.1.0 â€” GET /job-status/:jobId
//
// Returns the current status of an async generation job.
//
// Response shapes by status:
//   pending:   { status: "pending", progress_message }
//   running:   { status: "running", progress_message }
//   completed: { status: "completed", html, engineUsed, completedAt }
//   failed:    { status: "failed", error, completedAt }
// =====================================================================
app.get("/job-status/:jobId", ...doors.job, async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
      return res.status(400).json({
        error: "Invalid jobId format",
        details: "jobId must be a UUID.",
        requestId: req.id,
      });
    }

    if (!supabaseAdmin) {
      return res.status(503).json({
        error: "Async generation unavailable",
        details: "Supabase is not configured on the backend.",
        requestId: req.id,
      });
    }

    const { data: job, error } = await supabaseAdmin
      .from("maveloper_jobs")
      .select("id, status, progress_message, result_html, error_message, engine_used, order_id, image_url_map, created_at, updated_at, completed_at")
      .eq("id", jobId)
      .single();

    if (error || !job) {
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with id ${jobId}.`,
        requestId: req.id,
      });
    }

    const baseResponse = {
      jobId: job.id,
      status: job.status,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      requestId: req.id,
    };

    if (job.status === "completed") {
      return res.json({
        ...baseResponse,
        // Lovable-compatible shape (v9.2.1): result.html + snake_case progress_message
        result: {
          html: job.result_html,
          engineUsed: job.engine_used,
          // v9.5.0: orderId + imageUrlMap so the frontend can call /approve
          orderId: job.order_id ?? null,
          imageUrlMap: job.image_url_map ?? null,
        },
        progress_message: job.progress_message,
        // Legacy top-level fields kept for backward compatibility
        html: job.result_html,
        engineUsed: job.engine_used,
        orderId: job.order_id ?? null,
        imageUrlMap: job.image_url_map ?? null,
        completedAt: job.completed_at,
      });
    }

    if (job.status === "failed") {
      return res.json({
        ...baseResponse,
        error: job.error_message,
        progress_message: job.progress_message,
        completedAt: job.completed_at,
      });
    }

    // pending or running
    return res.json({
      ...baseResponse,
      // Both shapes for compatibility
      progress_message: job.progress_message,
      progressMessage: job.progress_message,
    });
  } catch (err) {
    log("error", "Job-status endpoint error", {
      requestId: req.id,
      error: err.message,
    });
    res.status(500).json({
      error: "Failed to fetch job status",
      details: err.message,
      requestId: req.id,
    });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// v9.3.0 â€” POST /bridge-callback (durable via Supabase)
//
// The Mac bridge calls this endpoint when cc-runner finishes (success OR
// failure). Body shape:
//   Success: { bridgeJobId, html, bytesGenerated, elapsedSeconds, maveloperJobId? }
//   Error:   { bridgeJobId, error, exitCode?, stderr?, maveloperJobId? }
//
// We do two things:
//   1. Write the result to Supabase maveloper_jobs row keyed by bridgeJobId
//      (durable â€” survives Railway restarts so Lovable's poll sees the result).
//   2. Settle the in-memory promise if it still exists (so any awaiting
//      handler can return cleanly â€” common case where Railway didn't restart).
//
// Auth: shared secret in X-Bridge-Secret.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post("/bridge-callback", async (req, res) => {
  const incomingSecret = req.headers["x-bridge-secret"];
  if (!incomingSecret || incomingSecret !== MAC_BRIDGE_SECRET) {
    log("warn", "/bridge-callback unauthorized", {
      requestId: req.id,
      hasHeader: !!incomingSecret,
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { bridgeJobId, html, bytesGenerated, elapsedSeconds, error, exitCode, stderr, maveloperJobId, compilerAssets, compilerCertificate, routeProvenance } = req.body || {};

  if (!bridgeJobId) {
    return res.status(400).json({ error: "Missing bridgeJobId" });
  }

  // ── ★ THE CALLBACK TRANSFER, STATED IN THE LOG ──────────────────────────────
  // recvMs is tunnel-transfer AND JSON parse together (see the middleware pair
  // above express.json) — the two are not separated and this line must not be
  // read as if they were. bytes is the wire Content-Length, i.e. the base64
  // payload as it crossed ngrok, NOT the decoded PNG total; assetBytesBase64
  // below is the share of it that is compiler slice images. `limitBytes` is
  // printed beside them so a payload approaching 35mb is visible BEFORE it is
  // rejected, rather than after.
  const _assetB64 = compilerAssets && typeof compilerAssets === "object"
    ? Object.values(compilerAssets).reduce((s, v) => s + (typeof v === "string" ? v.length : 0), 0)
    : 0;
  log("info", "/bridge-callback payload received", {
    requestId: req.id,
    bridgeJobId,
    recvMs: req._bodyRecvMs ?? null,
    bytes: req._bodyRecvBytes ?? null,
    mb: req._bodyRecvBytes != null ? Number((req._bodyRecvBytes / 1048576).toFixed(2)) : null,
    limitBytes: 35 * 1024 * 1024,
    mbPerSec: req._bodyRecvBytes != null && req._bodyRecvMs > 0
      ? Number((req._bodyRecvBytes / 1048576 / (req._bodyRecvMs / 1000)).toFixed(2))
      : null,
    assetCount: compilerAssets && typeof compilerAssets === "object" ? Object.keys(compilerAssets).length : 0,
    assetBytesBase64: _assetB64,
    htmlBytes: typeof html === "string" ? html.length : 0,
    hasError: Boolean(error),
  });

  // â”€â”€ Durable path: find the maveloper_jobs row by bridgeJobId â”€â”€â”€â”€â”€â”€
  // The row was tagged with `__BRIDGE__:<bridgeJobId>` in error_message
  // at dispatch time (see callClaudeCodeBridge). We look it up here.
  // If maveloperJobId was passed in the body, use it directly as a fast path.
  let dbJobId = maveloperJobId;
  if (!dbJobId && supabaseAdmin) {
    try {
      const { data: rows } = await supabaseAdmin
        .from("maveloper_jobs")
        .select("id")
        .eq("error_message", `__BRIDGE__:${bridgeJobId}`)
        .limit(1);
      if (rows && rows.length > 0) {
        dbJobId = rows[0].id;
      }
    } catch (e) {
      log("warn", "/bridge-callback Supabase lookup failed", {
        requestId: req.id,
        bridgeJobId,
        error: e.message,
      });
    }
  }

  // â”€â”€ COMPILER slice-image upload (additive; INERT on the LLM path) â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // On the deterministic-compiler path the bridge forwards `compilerAssets`: a
  // { relativeSrc: base64PNG } map of the slice images that exist only on the
  // laptop. Upload them with the SAME uploadImagesToDropbox() the PDF/Figma image
  // path uses, then rewrite the delivered HTML's relative <img src> to the returned
  // Dropbox URLs with the SAME fixImageUrls() postProcessHtml() uses. Doing it ONCE
  // here â€” BEFORE both the durable Supabase write and the in-memory promise settle â€”
  // makes BOTH delivery paths (the /generate-from-figma handler that awaits the
  // promise, and the restart-fallback durable write) emit absolute, working URLs.
  //
  // When `compilerAssets` is absent (EVERY LLM-path callback) the block is skipped,
  // `deliverHtml` stays === `html`, and `compilerImageUrlMap` stays null, so the
  // durable write and the settle below are byte-for-byte identical to today.
  let deliverHtml = html;
  let compilerImageUrlMap = null;
  // COMPILER ZIP FIX v2: the REAL order_id (never the bridgeJobId fallback), hoisted so
  // the durable-write branch below can persist the slice map to the `drafts` row that
  // /approve reads. Stays null on the LLM path and on compiler jobs with no order_id row.
  let compilerOrderId = null;
  if (html && compilerAssets && typeof compilerAssets === "object" && Object.keys(compilerAssets).length > 0) {
    const assetCount = Object.keys(compilerAssets).length;
    if (!dropboxConfigured) {
      log("error", "/bridge-callback compiler assets present but Dropbox is not configured â€” delivered images will be broken", {
        requestId: req.id, bridgeJobId, assetCount,
      });
    } else {
      try {
        // Derive an orderId for the Dropbox folder (best-effort; the folder is
        // cosmetic â€” uploadToDropbox returns a self-contained direct URL regardless).
        // Prefer the job row's order_id; fall back to the bridgeJobId.
        let assetOrderId = bridgeJobId;
        if (dbJobId && supabaseAdmin) {
          try {
            const { data: orows } = await supabaseAdmin
              .from("maveloper_jobs").select("order_id").eq("id", dbJobId).limit(1);
            if (orows && orows[0] && orows[0].order_id) {
              assetOrderId = orows[0].order_id;
              compilerOrderId = orows[0].order_id; // real order_id for the drafts write
            }
          } catch { /* keep bridgeJobId */ }
        }
        // Build the image list EXACTLY like the LLM path: [{ filename, buffer }].
        // Key by BASENAME â€” that is what fixImageUrls() matches (src.split('/').pop()).
        // Dedupe by basename (unique within one design's slice set).
        const byBase = new Map();
        for (const [relSrc, b64] of Object.entries(compilerAssets)) {
          if (typeof b64 !== "string") continue;
          const filename = String(relSrc).split("/").pop();
          if (!filename || byBase.has(filename)) continue;
          byBase.set(filename, { filename, buffer: Buffer.from(b64, "base64") });
        }
        const images = [...byBase.values()];
        compilerImageUrlMap = await uploadImagesToDropbox(assetOrderId, images, log);
        const uploaded = Object.keys(compilerImageUrlMap).length;
        // Rewrite the relative slice src â†’ absolute Dropbox URL with the existing
        // helper (skipPositionalFallback = the Figma-safe exact-basename match; it
        // never touches http/https/data srcs, so it is idempotent downstream).
        const rewrite = fixImageUrls(html, compilerImageUrlMap, null, { skipPositionalFallback: true });
        deliverHtml = rewrite.html;
        log("info", "/bridge-callback uploaded compiler slice images and rewrote src", {
          requestId: req.id, bridgeJobId, orderId: assetOrderId,
          assetCount, uploaded, srcReplaced: rewrite.replaced,
          unmatched: rewrite.unmatched,
        });
        if (uploaded < images.length) {
          log("warn", "/bridge-callback partial compiler-slice upload â€” some delivered images may be broken", {
            requestId: req.id, bridgeJobId, uploaded, total: images.length,
          });
        }
      } catch (e) {
        log("error", "/bridge-callback compiler-slice upload failed â€” shipping HTML with relative paths (non-fatal)", {
          requestId: req.id, bridgeJobId, error: e.message,
        });
        deliverHtml = html;
        compilerImageUrlMap = null;
      }
    }
  }

  // â”€â”€ Write durable result to Supabase â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (dbJobId && supabaseAdmin) {
    try {
      if (error) {
        // v9.8.1: cc-runner writes the honest quality-gate reason (IMAGE PARITY /
        // STRUCTURAL COLLAPSE / BRAND FONT â€¦) to STDERR; bridge-server.mjs forwards
        // it in the callback `stderr` field while `error` is the hardcoded generic
        // "Claude Code generation failed". Previously we persisted only `error`, so
        // the categories never reached the lead. Prefer stderr when present; keep the
        // generic `Bridge: <error>` form as the fallback when stderr is empty. The
        // runner (commit 6687309) then copies error_message into os_queue.error_text.
        const exitSuffix = exitCode != null ? ` (exitCode=${exitCode})` : "";
        const gateDetail = String(stderr || "").trim();
        const errMsg = gateDetail
          ? `${gateDetail.substring(0, 1500)}${exitSuffix}`
          : `Bridge: ${String(error).substring(0, 1500)}${exitSuffix}`;
        await supabaseAdmin
          .from("maveloper_jobs")
          .update({
            status: "failed",
            error_message: errMsg,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", dbJobId);
      } else if (html) {
        // v9.7.0 (Â§4): apply the SAME Figma hygiene pass the in-process handler
        // applies, BEFORE persisting. This kills the restart-dependent delivery
        // inconsistency: previously this durable write stored RAW bridge HTML while
        // the normal path stored the (hygiene-processed) HTML â€” so the SAME job
        // delivered different bytes depending on whether Railway restarted.
        // NOTE: /bridge-callback has no designSpec/imageUrlMap context, so the
        // hygiene pass here runs WITHOUT image-URL matching (the bridge already
        // emits absolute Dropbox URLs, so pass-1 would be a no-op anyway) and the
        // brand-font assertion is skipped (no designSpec â†’ no brand_font to check);
        // the count/size/img/anchor assertions still run for observability.
        // Non-fatal: if post-processing throws, we store the raw html.
        // deliverHtml === html on the LLM path (compiler block above was skipped),
        // so passing it + a null imageUrlMap is byte-identical to today; on the
        // compiler path it is the slice-rewritten HTML with absolute Dropbox URLs.
        let finalHtml = deliverHtml;
        try {
          finalHtml = postProcessHtml(deliverHtml, { imageUrlMap: compilerImageUrlMap || undefined, mode: "figma", requestId: req.id }).html;
          assertFigmaPostProcess(deliverHtml, finalHtml, null, { requestId: req.id, source: "bridge-callback" });
        } catch (ppErr) {
          log("warn", "/bridge-callback post-process failed; storing raw html (non-fatal)", {
            requestId: req.id,
            bridgeJobId,
            error: ppErr.message,
          });
          finalHtml = deliverHtml;
        }
        await supabaseAdmin
          .from("maveloper_jobs")
          .update({
            status: "completed",
            result_html: finalHtml,
            // COMPILER ZIP FIX: mirror the slice map onto maveloper_jobs.image_url_map
            // so /job-status (the Lovable poller) also sees it. NOTE: /approve does NOT
            // read this column â€” it reads the `drafts` row (persisted just below). This
            // maveloper_jobs write is kept for /job-status parity, not for the ZIP. Spread
            // is {} on every LLM-path callback (compilerImageUrlMap null), so the
            // image_url_map column is left untouched â€” byte-identical to today.
            ...(compilerImageUrlMap && Object.keys(compilerImageUrlMap).length > 0
              ? { image_url_map: compilerImageUrlMap }
              : {}),
            error_message: null, // clear the __BRIDGE__ tag
            progress_message: `Generation complete (${finalHtml.length} bytes, ${elapsedSeconds}s)`,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", dbJobId);

        // COMPILER ZIP FIX v2 (drafts persist): the maveloper_jobs write above feeds
        // /job-status; the /approve ZIP instead reads the map the frontend loads from
        // the `drafts` table. On the restart/durable route the in-memory figma handler
        // is gone, so this is the ONLY place the slice map can reach `drafts` for a later
        // /approve. Same guard â†’ inert on every LLM-path callback (compilerImageUrlMap
        // null). Uses the REAL order_id only (compilerOrderId; null â†’ helper no-ops).
        if (compilerImageUrlMap && Object.keys(compilerImageUrlMap).length > 0) {
          await persistSliceMapToDrafts(supabaseAdmin, log, compilerOrderId, compilerImageUrlMap, req.id);
        }

        // COMPILER CERTIFICATE (delivery folder): the bridge forwards the frozen
        // compiler's proof numbers (certificate.json + delivered-file verdict) as
        // `compilerCertificate`. Persist to maveloper_jobs.delivery_meta so /approve
        // can render certificate.txt with REAL numbers. Written in its OWN update,
        // wrapped in try/catch, AFTER the completed-write above: if the delivery_meta
        // column has not been migrated yet the failure is isolated (the delivered
        // result_html is already committed) and certificate.txt degrades to an honest
        // "certificate not located" note. Inert on the LLM path (no compilerCertificate).
        // ★ ROUTE PROVENANCE — WHICH ENGINE MADE THIS EMAIL, ON THE JOB ROW.
        // Written into the SAME EXISTING jsonb column as the certificate
        // (maveloper_jobs.delivery_meta). NO new column is invented: a write to a
        // non-existent column is exactly the defect that shipped once already
        // (os_queue.image_url_map) and degraded silently. approve-schema.test.mjs
        // marks delivery_meta pending:true — the owner confirms it with one command;
        // if it is absent this write warns and the FOLDER-side provenance still
        // ships, because the folder copy does not need the DB at all.
        //
        // ★ Unlike the certificate, provenance is written on BOTH routes — the LLM
        // artifact is precisely the one that must carry an engine statement.
        if ((compilerCertificate && typeof compilerCertificate === "object") ||
            (routeProvenance && typeof routeProvenance === "object")) {
          try {
            const deliveryMeta = {};
            if (compilerCertificate && typeof compilerCertificate === "object") {
              deliveryMeta.certificate = compilerCertificate;
              deliveryMeta.generatedBy = "compiler";
            }
            if (routeProvenance && typeof routeProvenance === "object") {
              deliveryMeta.provenance = routeProvenance;
              // The engine's OWN statement outranks the downstream html heuristic.
              deliveryMeta.generatedBy = routeProvenance.engine === "compiler" ? "compiler" : "llm";
              log("info", "/bridge-callback route-provenance recorded", {
                requestId: req.id, bridgeJobId,
                engine: routeProvenance.engine,
                diamondTag: routeProvenance.diamondTag,
                fallback: !!(routeProvenance.fallback && routeProvenance.fallback.occurred),
                guard: (routeProvenance.fallback && routeProvenance.fallback.guard) || null,
              });
            }
            const { error: dmErr } = await supabaseAdmin
              .from("maveloper_jobs")
              .update({ delivery_meta: deliveryMeta })
              .eq("id", dbJobId);
            if (dmErr) {
              log("warn", "/bridge-callback delivery_meta write failed (column not migrated?) â€” certificate.txt will degrade gracefully", {
                requestId: req.id, bridgeJobId, error: dmErr.message,
              });
            }
          } catch (dmThrow) {
            log("warn", "/bridge-callback delivery_meta write threw (non-fatal)", {
              requestId: req.id, bridgeJobId, error: dmThrow.message,
            });
          }
        }
      }
      log("info", "/bridge-callback wrote result to Supabase", {
        requestId: req.id,
        bridgeJobId,
        dbJobId,
        outcome: error ? "failed" : "completed",
      });
    } catch (e) {
      log("error", "/bridge-callback Supabase write failed", {
        requestId: req.id,
        bridgeJobId,
        dbJobId,
        error: e.message,
      });
    }
  } else {
    log("warn", "/bridge-callback no Supabase row found for bridgeJobId â€” result still posted to in-memory promise if exists", {
      requestId: req.id,
      bridgeJobId,
    });
  }

  // â”€â”€ Settle the in-memory promise (fast path for non-restarted Railway) â”€â”€
  const entry = PENDING_BRIDGE_JOBS.get(bridgeJobId);
  if (entry) {
    if (error) {
      log("info", "/bridge-callback settling in-memory promise (rejected)", {
        requestId: req.id,
        bridgeJobId,
      });
      settleBridgeJob(bridgeJobId, { error });
    } else if (html) {
      log("info", "/bridge-callback settling in-memory promise (resolved)", {
        requestId: req.id,
        bridgeJobId,
        bytesGenerated: bytesGenerated || deliverHtml.length,
      });
      // deliverHtml === html on the LLM path â†’ identical to today; on the compiler
      // path it is the slice-rewritten HTML the awaiting /generate-from-figma handler
      // then post-processes (its fixImageUrls no-ops on the now-absolute slice URLs).
      // COMPILER ZIP FIX: also hand back the slice map so the figma handler can fold
      // it into result.body.imageUrlMap (â†’ /approve ZIP localises the slices). Null on
      // the LLM path, so callClaudeCodeBridge leaves its assetSink untouched there.
      settleBridgeJob(bridgeJobId, { html: deliverHtml, compilerImageUrlMap, bytesGenerated: bytesGenerated || deliverHtml.length, elapsedSeconds });
    } else {
      settleBridgeJob(bridgeJobId, { error: "Bridge callback missing html field" });
    }
  } else {
    log("info", "/bridge-callback no in-memory promise (Railway likely restarted) â€” durable Supabase write is the result of record", {
      requestId: req.id,
      bridgeJobId,
      dbJobId,
    });
  }

  return res.status(200).json({
    ok: true,
    settled: error ? "rejected" : "resolved",
    durableWrite: !!dbJobId,
    inMemorySettled: !!entry,
  });
});

// -----------------------------------------------------------------
// Resolve, SERVER-SIDE, everything the /approve delivery folder may need beyond
// the request body: the durable image map, the id generation keyed artifacts by
// (genOrderId), the ESP / dark-mode the order was queued with, and the compiler
// proof certificate. This removes /approve's dependence on the frontend sending a
// complete map â€” the owner cannot change the frontend, so the backend reconciles.
//
// Reconciliation of the two id spaces the owner found:
//   - os_queue.order_id  = the OWNER-supplied name (== the `orderId` arg here)
//   - os_queue.job_id    â†’ maveloper_jobs.id  (the generation job)
//   - maveloper_jobs.order_id = the id GENERATION keyed images/preview under
// We first try maveloper_jobs matched directly on this order id (the reconciled
// path, where generation already used the owner id). If that misses, we hop
// os_queue.order_id â†’ job_id â†’ maveloper_jobs.id. Every step is best-effort and
// tolerant: a missing table/column/row yields nulls, never an approve failure.
// -----------------------------------------------------------------
async function resolveApproveJobMeta(orderId, requestId) {
  // jobRowId: added for the order-confirmation email, which records its own
  // outcome into THIS row's existing delivery_meta jsonb. Additive — every
  // pre-existing consumer of `meta` ignores it.
  // approveRecord: the PRIOR successful approve for this order, read from the
  // same existing delivery_meta jsonb the certificate and provenance come from.
  // null means "no prior approve is known", which means the idempotency guard
  // does not fire — its failure mode is always to deliver.
  const meta = { imageUrlMap: null, genOrderId: null, certificate: null, esp: null, darkMode: null, jobRowId: null, approveRecord: null };
  if (!supabaseAdmin || !orderId) return meta;

  // os_queue: ESP + dark-mode + the job link.
  let jobId = null;
  try {
    // ★ os_queue.order_id IS NOT UNIQUE. `.limit(1)` with no ORDER BY therefore
    // picked an ARBITRARY row whenever an order id had more than one — which the
    // /os double-submit defect made routine — and this row supplies the job link,
    // the ESP and the dark-mode flag for the whole delivery. Picking the wrong
    // one silently mis-labels the delivery folder and can resolve the wrong image
    // map. Ordered newest-first so the choice is at least deterministic and is the
    // run a lead most likely means. (The /os client now derives the row's primary
    // key from the submission so a duplicate active order cannot be created; this
    // is the backend half of the same problem, and it also covers every duplicate
    // already in the table.)
    const { data: q } = await supabaseAdmin
      .from("os_queue")
      .select("job_id, esp, dark_mode")
      .eq("order_id", orderId)
      .order("uploaded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (q) {
      jobId = q.job_id || null;
      meta.esp = q.esp ?? null;
      meta.darkMode = q.dark_mode ?? null;
    }
  } catch (e) {
    log("warn", "Approve: os_queue lookup failed (non-fatal)", { requestId, orderId, error: e.message });
  }

  // maveloper_jobs: durable image map + the generation order id. Try a direct
  // order_id match first (reconciled path), then fall back to the job link.
  const loadJob = async (filterCol, filterVal) => {
    try {
      const { data } = await supabaseAdmin
        .from("maveloper_jobs")
        .select("id, order_id, image_url_map")
        .eq(filterCol, filterVal)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data || null;
    } catch (e) {
      log("warn", "Approve: maveloper_jobs lookup failed (non-fatal)", { requestId, orderId, by: filterCol, error: e.message });
      return null;
    }
  };
  let job = await loadJob("order_id", orderId);
  if (!job && jobId) job = await loadJob("id", jobId);
  if (job) {
    meta.imageUrlMap = job.image_url_map || null;
    meta.genOrderId = job.order_id || null;
    meta.jobRowId = job.id || null;

    // Compiler certificate lives in maveloper_jobs.delivery_meta (jsonb), written
    // by /bridge-callback from the bridge-forwarded compilerCertificate. Selected
    // SEPARATELY so a not-yet-migrated column (absent) never fails the map load.
    try {
      const { data: dm } = await supabaseAdmin
        .from("maveloper_jobs")
        .select("delivery_meta")
        .eq("id", job.id)
        .limit(1)
        .maybeSingle();
      if (dm && dm.delivery_meta && typeof dm.delivery_meta === "object") {
        meta.certificate = dm.delivery_meta.certificate || null;
        // ★ The route-provenance record, for certificate.txt + delivery-notes.txt.
        meta.provenance = dm.delivery_meta.provenance || null;
        // ★★ The prior approve, for the idempotency guard. Read tolerantly:
        // an absent key, a wrong shape or an unknown schema all yield null.
        meta.approveRecord = readApproveRecord(dm.delivery_meta);
      }
    } catch {
      // delivery_meta column not present (migration not run) â†’ certificate stays
      // null â†’ certificate.txt states the compiler cert was not located. Honest.
    }
  }
  return meta;
}

/**
 * ★ ORDER-CONFIRMATION: the os_queue fields the email needs, read in their OWN
 * select. Deliberately NOT folded into resolveApproveJobMeta's existing
 * `select("job_id, esp, dark_mode")`: that select feeds the delivery folder, and
 * widening it would mean any problem with a confirmation-only column could take
 * esp/darkMode down with it. This is the same isolation discipline the
 * delivery_meta read already uses a few lines above ("Selected SEPARATELY so a
 * not-yet-migrated column (absent) never fails the map load").
 *
 * ★ EVERY COLUMN BELOW IS IN THE SHIPPED DDL — no column is invented.
 * supabase-setup.sql:197-224 (os_queue): order_id, figma_url, esp, dark_mode,
 * tat_hours, uploaded_at, deadline, lead_email, started_at, finished_at, and
 * effective_deadline via the idempotent ALTER at :221 (already selected in
 * production by queue-runner.js:197).
 *
 * Returns null on any failure — the caller then skips the email and says why.
 */
async function resolveConfirmationRow(orderId, requestId) {
  if (!supabaseAdmin || !orderId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("os_queue")
      .select("order_id, lead_email, figma_url, esp, dark_mode, tat_hours, uploaded_at, deadline, effective_deadline, started_at, finished_at")
      .eq("order_id", orderId)
      .order("uploaded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      log("warn", "Order-confirmation: os_queue row lookup failed (non-fatal, email will be skipped)", {
        requestId, orderId, error: error.message,
      });
      return null;
    }
    return data || null;
  } catch (e) {
    log("warn", "Order-confirmation: os_queue row lookup threw (non-fatal, email will be skipped)", {
      requestId, orderId, error: e.message,
    });
    return null;
  }
}

// -----------------------------------------------------------------
// POST /approve â€” assemble the LOOSE delivery folder and upload to Dropbox
// Called after dev reviews preview and clicks "Approve & Upload"
// Accepts: { orderId, html, imageUrlMap?, espPlatform? }
// Writes:  /maveloper/<YYYY>/<MM-YYYY>/<ORDER ID>/ with <ORDER ID>.html, images/,
//          preview.png, delivery-notes.txt, certificate.txt (loose, not zipped)
// Returns: { dropboxUrl, orderId, folderPath, imageCount, previewStatus, requestId }
// -----------------------------------------------------------------
app.post("/approve", generateLimiter, ...doors.order, async (req, res) => {
  const startTime = Date.now();
  try {
    const rawOrderId = req.body.orderId;
    const html = req.body.html;
    const bodyImageUrlMap = req.body.imageUrlMap;

    if (!rawOrderId || !html) {
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

    // The OWNER-SUPPLIED order id IS the delivery folder name (Mavlers convention).
    const orderId = sanitizeOrderId(rawOrderId) || String(rawOrderId);
    const folderPath = getDropboxFolderPath(orderId); // /maveloper/<YYYY>/<MM-YYYY>/<orderId>

    // ── ★★ IDEMPOTENCY, ARM 1: the CONCURRENT duplicate ───────────────────────
    // The durable record (arm 2, below) is written at the END of a run, so two
    // calls that overlap both read "no prior approve" and both deliver. That is
    // not theoretical: /approve's client budget is 600 seconds and the failure
    // mode of an automated caller is a retry of a request it believes has
    // stalled. This latch is per-process — it does not cover two Railway
    // replicas — and it is stated as a second line, not as the mechanism.
    const latch = beginApprove(orderId, { requestId: req.id });
    if (!latch.ok) {
      log("warn", "Approve: REFUSED a concurrent duplicate — one approve for this order is already running", {
        requestId: req.id, orderId, heldBy: latch.held.requestId, heldForMs: Date.now() - latch.held.startedAt,
      });
      return res.status(409).json({
        error: "Approve already in progress",
        details: `An approve for ${orderId} is already running. Nothing was rebuilt and no second email was sent. Wait for it to finish.`,
        alreadyInProgress: true,
        orderId,
        requestId: req.id,
      });
    }
    try {

    // â”€â”€ ID-SPACE RECONCILIATION + SERVER-SIDE MAP RESOLUTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // The images/preview were uploaded during generation, possibly keyed by a
    // DIFFERENT id (a frame-derived / FIGMA-<ts> id) than this owner id â€” that is
    // the split the owner found in production. We resolve everything the folder
    // needs WITHOUT depending on the frontend sending a map:
    //   1. The delivered HTML is authoritative â€” it carries an absolute Dropbox URL
    //      for every image the email references. We localise straight from it.
    //   2. As a supplement we pull the durable map + generation id + compiler
    //      certificate from maveloper_jobs (matched by this order id, or via the
    //      os_queue.order_id â†’ os_queue.job_id â†’ maveloper_jobs.id link when the
    //      generation id differs). All best-effort; the HTML alone is sufficient.
    const jobMeta = await resolveApproveJobMeta(orderId, req.id);

    // ── ★★ IDEMPOTENCY, ARM 2: the DURABLE record ─────────────────────────────
    // Approving the same order twice used to re-run this whole route: it rebuilt
    // the delivery folder, re-materialised every image into Dropbox, re-created
    // the share link, and — with ORDER_CONFIRMATION_ENABLED on — SENT THE LEAD A
    // SECOND CONFIRMATION EMAIL. Harmless only for as long as /approve is a
    // deliberate manual click; a defect the day the server-side runner calls it.
    //
    // ★ NO COLUMN WAS INVENTED. The state lives in maveloper_jobs.delivery_meta,
    // the EXISTING jsonb this route already reads (certificate, provenance) and
    // already writes (confirmationEmail). If the column is absent, or no job row
    // matches this order, the record is null and the guard is simply inert —
    // today's behaviour, unchanged.
    //
    // ★ IT CANNOT BLOCK A LEGITIMATE RE-APPROVE. The key is a fingerprint of the
    // DELIVERED BYTES (order id + html), so a re-compile changes it and the
    // re-approve runs in full. And a prior run that shipped short, never got a
    // link, or whose email failed is recorded as incomplete — so a re-approve of
    // identical bytes is treated as the repair it is. `force: true` in the body
    // is the explicit escape hatch.
    const approveFp = approveFingerprint({ orderId, html });
    const decision = decideApprove({
      record: jobMeta.approveRecord,
      fingerprint: approveFp,
      force: req.body.force === true,
    });
    if (!decision.run) {
      log("info", "Approve: DUPLICATE SUPPRESSED — identical bytes already delivered, folder NOT rebuilt and NO second email sent", {
        requestId: req.id, orderId, fingerprint: approveFp,
        firstApprovedAt: decision.prior.at, firstRequestId: decision.prior.requestId,
        dropboxUrl: decision.prior.dropboxUrl,
      });
      return res.json(replayApproveResponse(decision.prior, { requestId: req.id }));
    }
    if (jobMeta.approveRecord) {
      log("info", "Approve: prior approve found and NOT suppressed — this run proceeds", {
        requestId: req.id, orderId, reason: decision.reason,
        priorFingerprint: jobMeta.approveRecord.fingerprint, thisFingerprint: approveFp,
      });
    }

    // Build the URL â†’ local-filename map. THE DELIVERED HTML IS THE AUTHORITY for
    // WHICH images belong in the folder: only URLs the html actually references
    // (collectReferencedUrls) are materialised. The explicit maps (frontend body
    // map, durable maveloper_jobs map) supply only a PREFERRED filename for a
    // referenced URL â€” the basename generation uploaded under â€” they never inject
    // an image the html does not reference.
    //
    // Why "preferred filename only" and not "seed URLs from the map": for a
    // COMPILER order the drafts/body map is the MERGED node-export+slice map
    // (mergeCompilerSlices), so seeding URLs straight from it would drag the ~32
    // unreferenced Figma NODE EXPORTS into images/ next to the 25 referenced
    // slices â€” exactly the clutter the owner found. Driving the set off the
    // delivered html keeps images/ to the referenced files and halves the
    // materialisation work (no node-export round trips for a compiler order).
    const preferredName = {};
    const addMapPreferredNames = (map) => {
      if (!map || typeof map !== "object") return;
      for (const [filename, url] of Object.entries(map)) {
        if (typeof url === "string" && /^https?:\/\//i.test(url) && !(url in preferredName)) {
          preferredName[url] = filename;
        }
      }
    };
    addMapPreferredNames(bodyImageUrlMap);
    addMapPreferredNames(jobMeta.imageUrlMap);

    // Deduped by URL; filename collisions get a numeric suffix so two different
    // URLs never overwrite one images/ file. The assignment algorithm now lives in
    // delivery-folder.js (assignLocalFilenames) so the REAL code — the one both the
    // compiler AND the LLM path depend on — is unit-tested, not a test mirror.
    const urlToFilename = assignLocalFilenames(collectReferencedUrls(html), preferredName);

    const urlList = Object.keys(urlToFilename);
    if (urlList.length === 0) {
      log("warn", "Approve: no referenced image URLs found (html + maps empty) â€” folder will have html only", { requestId: req.id, orderId });
    }
    log("info", "Building delivery FOLDER", { requestId: req.id, orderId, folderPath, referencedImages: urlList.length });

    // â”€â”€ MATERIALISE images/ â€” server-side COPY first, download only as fallback â”€â”€
    // For every referenced URL, place the file at <folder>/images/<basename>:
    //   â€¢ in-place  â€” the URL already resolves to that exact path (the reconciled
    //                 owner-folder case): nothing to do, zero round trips.
    //   â€¢ copy      â€” the URL is a file in THIS Dropbox account at a DIFFERENT path
    //                 (a FIGMA-<ts> / previous-month generation folder): SERVER-SIDE
    //                 filesCopyV2 places it directly; the bytes never touch Railway.
    //   â€¢ download  â€” genuinely external, or a link we do not own / cannot resolve:
    //                 the pre-existing download+upload path, so NO image is dropped.
    // This is what turned ~50 Railway round trips (25 down + 25 up) into 0 for a
    // normal all-in-account order. Per-file route + total time are logged so the
    // owner can SEE the win.
    // Concurrency = DROPBOX_BATCH_SIZE: the copy/metadata calls hit the Dropbox API
    // (stricter limits than the CDN download endpoint), so we keep the SAME batch
    // discipline generation already uses, not the larger CDN-download concurrency.
    const imagesStart = Date.now();
    let nInPlace = 0, nCopy = 0, nDownload = 0, nFailed = 0;
    const materialized = await mapWithConcurrency(urlList, DROPBOX_BATCH_SIZE, async (url) => {
      const filename = urlToFilename[url];
      const destPath = `${folderPath}/images/${filename}`;
      // 1) Zero-bandwidth path: is this URL a file we own? Resolve its account path.
      const srcPath = await resolveDropboxPathFromShareUrl(url);
      if (srcPath) {
        if (srcPath.toLowerCase() === destPath.toLowerCase()) {
          nInPlace++;
          log("info", `Approve image [in-place] ${filename}`, { requestId: req.id, path: destPath });
          return { url, filename, route: "in-place" };
        }
        try {
          const how = await dbxServerCopyOverwrite(srcPath, destPath);
          nCopy++;
          log("info", `Approve image [copy:${how}] ${filename}`, { requestId: req.id, from: srcPath, to: destPath });
          return { url, filename, route: "copy" };
        } catch (copyErr) {
          log("warn", `Approve image copy failed, falling back to download ${filename}`, { requestId: req.id, from: srcPath, error: copyErr?.message });
          // fall through to the download route
        }
      }
      // 2) Fallback: download to Railway, then re-upload (external, or copy failed).
      try {
        const response = await fetchWithTimeout(url, IMAGE_DOWNLOAD_TIMEOUT_MS);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          await uploadFileToDropboxRaw(destPath, Buffer.from(arrayBuffer));
          nDownload++;
          log("info", `Approve image [download] ${filename}`, { requestId: req.id, url: redactUrl(url) });
          return { url, filename, route: "download" };
        }
        log("warn", `Approve: failed to download image ${filename}`, { requestId: req.id, status: response.status, url: redactUrl(url) });
      } catch (dlErr) {
        log("warn", `Approve: failed to download image ${filename}`, { requestId: req.id, error: dlErr.message, aborted: dlErr.name === "AbortError", url: redactUrl(url) });
      }
      nFailed++;
      return null; // dropped â†’ stays an absolute URL in the html (never a dead local ref)
    });
    const images = materialized.filter(Boolean);
    const tImagesMs = Date.now() - imagesStart;
    log("info", "Approve images step complete", {
      requestId: req.id, orderId,
      referenced: urlList.length, inPlace: nInPlace, copied: nCopy, downloaded: nDownload, failed: nFailed,
      imagesMs: tImagesMs,
      // the width this ran at, so the number can be read against the setting
      concurrency: DROPBOX_BATCH_SIZE,
    });

    // Localise ONLY the URLs we actually materialised (a failed one stays an
    // absolute URL rather than a dead local ref). This never mutates the caller's
    // `html`; the delivered EMAIL keeps its absolute Dropbox URLs (two-copy split).
    const localMap = {};
    for (const img of images) localMap[img.url] = img.filename;
    const localHtml = localizeHtml(html, localMap);

    // â”€â”€ Assemble delivery-notes.txt + certificate.txt from the DELIVERED bytes â”€â”€
    // generatedBy: a stored compiler certificate is AUTHORITATIVE (only the compiler
    // path forwards one). Fall back to the delivered-html marker (compiler additive
    // pass comment) when no cert reached us â€” so a compiler order still reads as
    // "compiler" (with an honest "certificate not located" note) even if the comment
    // survived post-processing but the cert did not. No signal â†’ LLM.
    const generatedBy = (jobMeta.certificate || looksCompilerAuthored(html)) ? "compiler" : "llm";
    const esp = jobMeta.esp || req.body.espPlatform || "none";
    const darkMode = detectDarkMode(html) || jobMeta.darkMode === true;
    const fonts = collectFonts(html);
    const ledger = deriveWordFatalLedger(html);
    // ★ ROUTE PROVENANCE reaches BOTH human-facing files. A lead must never
    //   receive an artifact without knowing which engine made it, and on a fallback,
    //   which named guard refused it. jobMeta.provenance is null for an order that
    //   predates this change; both builders then degrade to the old heuristic
    //   wording and say plainly that the wording IS a heuristic.
    const deliveryNotes = buildDeliveryNotes({
      orderId, esp, darkMode, fonts, ledger, generatedBy,
      imageCount: images.length, generatedAt: new Date().toISOString(),
      provenance: jobMeta.provenance || null,
      // D119: the certificate carries the list of elements Figma could not supply.
      // delivery-notes.txt must name them too - the brief requires the absence to be
      // visible in BOTH human-facing files, not just the certificate.
      certificate: jobMeta.certificate || null,
    });
    const certificateText = buildCertificateText({
      generatedBy, certificate: jobMeta.certificate, orderId,
      provenance: jobMeta.provenance || null,
    });

    // â”€â”€ Write the LOOSE folder (no zip â€” Dropbox zips folders on download) â”€â”€â”€â”€â”€â”€
    // The images/ files are ALREADY in place (copied server-side or downloaded above).
    // The remaining three writes are independent paths, so upload them in parallel â€”
    // three small files, well under any Dropbox rate limit.
    await Promise.all([
      uploadFileToDropboxRaw(`${folderPath}/${orderId}.html`, Buffer.from(localHtml, "utf-8")),
      uploadFileToDropboxRaw(`${folderPath}/delivery-notes.txt`, Buffer.from(deliveryNotes, "utf-8")),
      uploadFileToDropboxRaw(`${folderPath}/certificate.txt`, Buffer.from(certificateText, "utf-8")),
    ]);

    // preview.png: generation uploaded it to <genFolder>/preview.png. When the
    // generation id equals this owner id (the reconciled path) it is ALREADY in
    // this folder. Otherwise best-effort copy it across from the generation folder
    // resolved via the job link; if neither works, note the absence (never fake it).
    let previewStatus = "present";
    const previewDest = `${folderPath}/preview.png`;
    if (!(await dropboxPathExists(previewDest))) {
      let copied = false;
      if (jobMeta.genOrderId && jobMeta.genOrderId !== orderId) {
        const genPreview = `${getDropboxFolderPath(jobMeta.genOrderId)}/preview.png`;
        copied = await dropboxCopyFile(genPreview, previewDest);
      }
      previewStatus = copied ? "copied-from-generation-folder" : "absent";
      if (!copied) {
        log("warn", "Approve: preview.png not co-located and could not be resolved from the generation folder", {
          requestId: req.id, orderId, genOrderId: jobMeta.genOrderId || null,
        });
      }
    }

    // ── ★ THE SHARE LINK IS MADE HERE, NOT AT THE END ─────────────────────────
    // The owner reports the Dropbox link taking 40 to 60 seconds to appear. It was
    // created as the LAST step of this route, behind two stages that this file's
    // own comments declare non-blocking housekeeping:
    //
    //   · the images/ prune  — "Best-effort … Never fatal to delivery." It pays a
    //     fixed DROPBOX_PRUNE_PACING_MS cool-down, then a filesDeleteBatch whose
    //     async job is POLLED at DROPBOX_DELETE_POLL_INTERVAL_MS, with up to
    //     DROPBOX_DELETE_MAX_ATTEMPTS retries at DROPBOX_BATCH_RETRY_DELAY_MS.
    //   · the integrity gate — "ON FAILURE THIS SHIPS, LOUDLY. IT DOES NOT BLOCK."
    //     It costs a second full folder listing before it can decide that.
    //
    // Neither changes the link. Pruning only REMOVES unreferenced files from the
    // folder and the gate only ADDS a disclosure file to it; a Dropbox folder link
    // is a live view of the folder, so its value is identical whether it is minted
    // before or after. What the old order did was make the person waiting on the
    // delivery wait on the tidying — and, because os_queue.dropbox_url is written
    // immediately after the link, it also kept the /os console blind for the whole
    // of it. The link and the row write now happen the moment the folder holds
    // everything the delivered html references; the tidying follows.
    //
    // Every stage is timed, so this is a measurement from here on rather than an
    // argument.
    const tShareStart = Date.now();
    // One public share link for the FOLDER (Dropbox zips it for the recipient on
    // download â€” the loose-folder delivery the owner asked for).
    const dropboxUrl = await createFolderShareLink(folderPath);

    log("info", "Delivery folder uploaded to Dropbox", {
      requestId: req.id, orderId, folderPath,
      imageCount: images.length, previewStatus, generatedBy, durationMs: Date.now() - startTime,
    });

    // v9.6.0 (spec Â§9) â€” PERSIST the Dropbox link onto the os_queue row so the
    // "Dropbox" affordance on Completed cards works for everyone, not just the
    // session that clicked Approve (the /os ApproveButton kept it in local React
    // state only, so os_queue.dropbox_url was always null). Response is unchanged.
    //
    // Standalone defect fix for the CURRENT client-driven flow â€” runs whenever the
    // Dropbox upload succeeded, INDEPENDENT of RUNNER_ENABLED (ungated deliberately:
    // os_queue.dropbox_url is dead today, so this must be live before the runner is).
    // Non-fatal: a write failure only warns; the response payload is identical.
    if (supabaseAdmin && orderId) {
      try {
        const { error: dbxErr } = await supabaseAdmin
          .from("os_queue")
          .update({ dropbox_url: dropboxUrl })
          .eq("order_id", orderId)
          .eq("status", "delivered");
        if (dbxErr) {
          log("warn", "Approve: os_queue dropbox_url write-back failed (non-fatal)", {
            requestId: req.id,
            orderId,
            error: dbxErr.message,
          });
        }
      } catch (writeErr) {
        log("warn", "Approve: os_queue dropbox_url write-back threw (non-fatal)", {
          requestId: req.id,
          orderId,
          error: writeErr.message,
        });
      }
    }


    const tHousekeepingStart = Date.now();
    log("info", "Approve: delivery folder share link ready", {
      requestId: req.id, orderId, folderPath,
      shareLinkMs: tHousekeepingStart - tShareStart,
      msFromApproveStart: tHousekeepingStart - startTime,
    });

    // â”€â”€ TRIM images/ to EXACTLY the delivered-html reference set â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Generation Phase B uploaded THIS order's Figma NODE EXPORTS (layer-1.png,
    // group-3.png, vector-2.png, blank-gif.png, â€¦) into <folder>/images/ BEFORE
    // the html existed â€” they had to be reachable as absolute URLs for generation
    // and the /bridge-callback src rewrite. For a COMPILER order the delivered html
    // references ONLY the slice_*@2x.png files, so those node exports are now
    // UNREFERENCED clutter (57 files where the html uses 25) and roughly double the
    // lead's download. The DELIVERED HTML IS THE AUTHORITY: images/ must hold
    // exactly what it references. We could not skip placing them (generation runs
    // before the html), so we remove the unreferenced remainder now â€” after the
    // referenced set is fully materialised. It now runs AFTER the share link is
    // made rather than before it: removing unreferenced files does not change a
    // folder link, and this stage is best-effort, so nobody should wait on it.
    //   â€¢ COMPILER path: node exports pruned â†’ images/ == the referenced slices.
    //   â€¢ LLM path: the node exports ARE the referenced files â†’ keep-set == every
    //     file â†’ nothing removed (folder byte-identical to today).
    // Best-effort: any list/delete failure is logged and skipped â€” the delivered
    // html still resolves every image (nothing referenced is ever a delete target),
    // the folder just keeps a few extra files. Never fatal to delivery.
    //
    // RATE-LIMIT DISCIPLINE (dropbox-prune.js): the first cut fired N concurrent
    // filesDeleteV2 calls right after the ~25 shared-link metadata calls of the
    // materialisation loop â€” Dropbox 429'd the whole burst and every delete was
    // abandoned, so the folder kept its unreferenced files. Now we (1) pace a
    // short gap so the delete phase does not start while the API is hot, then
    // (2) delete ALL unreferenced files in ONE filesDeleteBatch call (polling its
    // async job to completion), with 429 retry + Retry-After-honouring backoff
    // around the batch, its poll, and the serialised per-file fallback. A per-entry
    // failure is a skipped file, never fatal.
    let tPruneMs = 0;
    const tPruneStart = Date.now();
    try {
      const imagesFolder = `${folderPath}/images`;
      const existingNames = await dropboxListFolderNames(imagesFolder);
      const { remove } = planDeliveredImagesFolder(html, urlToFilename, existingNames);
      if (remove.length > 0) {
        // pacing gap â€” let the API cool down after the metadata/copy burst
        await sleepMs(DROPBOX_PRUNE_PACING_MS);
        const { pruned, failed, mode } = await pruneImages(dbx, imagesFolder, remove, {
          sleep: sleepMs,
          log: (level, msg, meta) => log(level, msg, { requestId: req.id, orderId, ...(meta || {}) }),
          maxAttempts: DROPBOX_DELETE_MAX_ATTEMPTS,
          baseDelayMs: DROPBOX_BATCH_RETRY_DELAY_MS,
          interFileMs: DROPBOX_RETRY_INTERVAL_MS,
          pollIntervalMs: DROPBOX_DELETE_POLL_INTERVAL_MS,
          pollTimeoutMs: DROPBOX_DELETE_POLL_TIMEOUT_MS,
        });
        log(failed > 0 ? "warn" : "info", "Approve images/ trimmed to delivered-html reference set", {
          requestId: req.id, orderId, mode,
          existing: existingNames.length, kept: existingNames.length - pruned, pruned,
          failed, // > 0 means some unreferenced files survived the retries â€” folder still delivers
        });
      }
    } catch (pruneErr) {
      log("warn", "Approve: images/ trim skipped (folder list failed) â€” delivered html still resolves, folder may carry extra files", {
        requestId: req.id, orderId, error: pruneErr?.message,
      });
    }
    tPruneMs = Date.now() - tPruneStart;
    // â”€â”€ â˜… DELIVERED-FOLDER INTEGRITY GATE (SEAM_AUDIT I-1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Runs AFTER the share link exists (it declares itself non-blocking two
    // paragraphs down, so it must not delay the link), and it is the FIRST instrument that
    // has ever measured the document the owner actually opens. TEST27-1800
    // shipped 79 of 86 images with `images ok: true, missing: []` on the job
    // record, because every check ran against the workspace copy.
    //
    // â˜… ON FAILURE THIS SHIPS, LOUDLY. IT DOES NOT BLOCK. Four reasons:
    //   1. A lead is waiting. Blocking turns a partly-broken folder into NO
    //      delivery, which is strictly worse for the person waiting on it.
    //   2. The EMAIL copy â€” absolute Dropbox URLs, the thing that actually gets
    //      deployed â€” is unaffected by a folder defect. Withholding a working
    //      email over an offline-convenience artifact is the wrong trade.
    //   3. What failed on TEST27-1800 was not the delivery, it was the SILENCE.
    //      The fix for silence is speech, and the disclosure NAMES every file.
    //   4. This gate has never run in production. A gate that has never run in
    //      production must not be able to stop production â€” if its extraction is
    //      over-broad it would block every order, be switched off within a day,
    //      and close nothing. It earns the right to block by being right first.
    // The disclosure is its own file so it sorts to the TOP of the Dropbox
    // listing: this incident's failure was not missing information, it was that
    // nothing made the information unavoidable.
    let tGateMs = 0;
    const tGateStart = Date.now();
    let folderIntegrity = null;
    try {
      const finalImageNames = await dropboxListFolderNames(`${folderPath}/images`);
      folderIntegrity = gateDeliveredFolderStatic(localHtml, finalImageNames, {
        orderId,
        // A URL we tried and failed to materialise is a DISCLOSED mixed state,
        // not a surprise (server.js materialisation returns null on failure).
        declaredMaterialisationFailures: urlList.filter((u) => !(u in localMap)),
      });
      if (!folderIntegrity.ok) {
        log("error", "â˜… APPROVE SHIPPED AN INCOMPLETE DELIVERY FOLDER â€” disclosed in the folder", {
          requestId: req.id, orderId, folderPath,
          referenced: folderIntegrity.counts.referenced,
          presentInFolder: folderIntegrity.counts.presentInFolder,
          missingFiles: folderIntegrity.missingFiles,
          deadRefs: folderIntegrity.deadRefs,
        });
        await uploadFileToDropboxRaw(
          `${folderPath}/!!!-FOLDER-INCOMPLETE-READ-ME.txt`,
          Buffer.from(folderIntegrity.disclosure, "utf-8")
        );
      } else {
        log("info", "Delivered-folder integrity gate GREEN", {
          requestId: req.id, orderId,
          referenced: folderIntegrity.counts.referenced,
          presentInFolder: folderIntegrity.counts.presentInFolder,
          undeclaredAbsolute: folderIntegrity.counts.undeclaredAbsolute,
        });
      }

      // ── ★ IMAGE-MAP RECONCILIATION, MEASURED ON EVERY APPROVE ───────────────
      // A live order recorded an imageUrlMap of 287 entries while its delivered
      // folder held 114, and the two numbers were waved off as "probably the node
      // exports, correctly excluded". Probably is not a measurement, and the last
      // pair waved off as "two different counts" turned out to be two different
      // UNITS and seven files short. From here on the split is a log line: every
      // map entry is accounted for as referenced+present, unreferenced,
      // a duplicate under another key, or something-else-named, and the four are
      // asserted to sum to the map's size. FREE: it is pure arithmetic over the
      // html, the maps and the folder listing this route already has in hand —
      // no extra Dropbox or Supabase call.
      try {
        const rec = reconcileImageMap({
          imageUrlMap: jobMeta.imageUrlMap || bodyImageUrlMap || {},
          preferredFromBody: bodyImageUrlMap || null,
          deliveredHtml: html,
          folderImageNames: finalImageNames,
        });
        log(rec.balanced && rec.anyReferencedFileMissing !== true ? "info" : "error",
          rec.balanced && rec.anyReferencedFileMissing !== true
            ? "Approve: imageUrlMap reconciled against the delivered html and folder"
            : "★ APPROVE: IMAGE-MAP RECONCILIATION DID NOT BALANCE — the gap is the finding",
          {
            requestId: req.id, orderId,
            summary: summariseReconciliation(rec),
            ...rec.counts,
            gap: rec.gap,
            unreferencedByKind: rec.unreferencedByKind,
            otherByReason: rec.otherByReason,
            referencedMissingFromFolder: (rec.referencedNotInFolder || []).map((m) => m.assignedFilename),
            referencedMissingFromMap: rec.referencedNotInMap.length,
          });
      } catch (recErr) {
        // An accounting instrument must never be able to fail a delivery.
        log("warn", "Approve: image-map reconciliation could not run (delivery unaffected)", {
          requestId: req.id, orderId, error: recErr?.message,
        });
      }
    } catch (gateErr) {
      // The gate must never be the reason a delivery fails. A gate that can
      // crash a delivery is a gate that gets deleted.
      folderIntegrity = { ok: null, error: gateErr?.message || String(gateErr) };
      log("warn", "Delivered-folder integrity gate could not run â€” delivery continues UNVERIFIED", {
        requestId: req.id, orderId, error: gateErr?.message,
      });
    }
    tGateMs = Date.now() - tGateStart;

    log("info", "Approve: post-link housekeeping complete", {
      requestId: req.id, orderId,
      // What the lead used to wait on before the link existed. If these two
      // numbers are large, they are large AFTER the link is already in the row.
      housekeepingMs: Date.now() - tHousekeepingStart,
      pruneMs: tPruneMs,
      gateMs: tGateMs,
    });

    // â”€â”€ â˜…â˜… ORDER-CONFIRMATION EMAIL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // WHY HERE, AND NOWHERE EARLIER. The order is COMPLETE at this line and not
    // one line before it:
    //   â€¢ images/ is materialised and trimmed to the delivered reference set
    //   â€¢ <orderId>.html, delivery-notes.txt, certificate.txt are uploaded
    //   â€¢ preview.png is co-located (or its absence is recorded)
    //   â€¢ the integrity gate has run and disclosed
    //   â€¢ the FOLDER SHARE LINK EXISTS (createFolderShareLink, ~90 lines above)
    //   â€¢ os_queue.dropbox_url is written back
    // The email must carry the Dropbox links, so it CANNOT fire before the share
    // link exists. And it must not fire from the browser or from the queue
    // runner's status='delivered' write: at that point the delivery folder does
    // not exist yet, so the two links the spec requires would both be null.
    //
    // â˜…â˜… IT MUST NEVER BLOCK DELIVERY. Three independent guarantees, because one
    // is not enough for something that sits in the delivery path:
    //   1. sendOrderConfirmation() has NO throw path â€” every failure is a
    //      returned { ok:false } plus a loud error log.
    //   2. This whole block is wrapped in its OWN try/catch. Without it, a throw
    //      from the link/preview/DB calls here would fall into /approve's outer
    //      catch and turn a COMPLETED delivery into a 500 with "Upload failed" â€”
    //      the frontend would report the order as failed when the folder is
    //      sitting in Dropbox, complete. That is precisely the failure mode the
    //      spec forbids, and it is why the inner catch is not redundant.
    //   3. Everything above has already been committed to Dropbox and Supabase.
    //      Nothing in this block can undo any of it.
    //
    // â˜… GATED OFF BY DEFAULT. With ORDER_CONFIRMATION_ENABLED unset, the flag
    // check short-circuits BEFORE the two Dropbox calls below, so production
    // behaviour â€” including request latency and Dropbox API usage â€” is
    // byte-identical to today.
    let confirmationEmail = null;
    if (isConfirmationEnabled(process.env)) {
      try {
        // 1. The queue row: lead_email, figma_url, TAT, the buffered deadline.
        const qRow = await resolveConfirmationRow(orderId, req.id);

        // 2. â˜… THE DIRECT HTML LINK, alongside the folder link. Both are required
        //    by the spec. createFolderShareLink is path-generic
        //    (sharingCreateSharedLinkWithSettings takes any path), so the same
        //    helper serves a file; the name is historical. Best-effort: a failure
        //    here costs the second button, not the email.
        let dropboxHtmlUrl = null;
        try {
          dropboxHtmlUrl = await createFolderShareLink(`${folderPath}/${orderId}.html`);
        } catch (hlErr) {
          log("warn", "Order-confirmation: direct HTML share link failed (email will carry the folder link only)", {
            requestId: req.id, orderId, error: hlErr?.message,
          });
        }

        // 3. â˜… preview.png INLINE, NOT ATTACHED. A cid: part renders in the body
        //    even when the client blocks remote images, which is the strongest
        //    form of inline â€” so we download the bytes. Best-effort: if the
        //    download fails (or previewStatus is "absent") we fall back to the
        //    absolute Dropbox URL, which is still inline in the body and still
        //    not an attachment, and the email says so rather than showing a
        //    broken-image box.
        let previewBytes = null;
        let previewUrl = null;
        if (previewStatus !== "absent") {
          try {
            const dl = await dbx.filesDownload({ path: previewDest });
            const bin = dl?.result?.fileBinary;
            if (bin && bin.length) previewBytes = Buffer.isBuffer(bin) ? bin : Buffer.from(bin);
          } catch (pvErr) {
            log("warn", "Order-confirmation: preview.png download failed â€” falling back to a remote inline URL", {
              requestId: req.id, orderId, error: pvErr?.message,
            });
          }
          if (!previewBytes) {
            try {
              // Share link â†’ direct-access URL. Same two substitutions
              // uploadToDropbox already does (dl=0 â†’ raw=1, then swap the host to
              // dl.dropboxusercontent.com); inlined rather than extracted so this
              // change touches no existing function.
              let u = await createFolderShareLink(previewDest);
              u = u.includes("dl=0") ? u.replace("dl=0", "raw=1") : u + (u.includes("?") ? "&" : "?") + "raw=1";
              previewUrl = u.replace("www.dropbox.com", "dl.dropboxusercontent.com");
            } catch (plErr) {
              log("warn", "Order-confirmation: preview.png share link failed â€” the email will omit the preview", {
                requestId: req.id, orderId, error: plErr?.message,
              });
            }
          }
        }

        // 4. Build the message. Pure â€” no I/O, so this cannot hang.
        //    generationSeconds: the spec asks for generation time IN SECONDS.
        //    Preferred source is the provenance record's own number; this is the
        //    fallback, computed from os_queue.started_at â†’ finished_at (both in
        //    the DDL at supabase-setup.sql:215-216).
        let generationSeconds = null;
        if (qRow && qRow.started_at && qRow.finished_at) {
          const ms = new Date(qRow.finished_at).getTime() - new Date(qRow.started_at).getTime();
          if (Number.isFinite(ms) && ms > 0) generationSeconds = Math.round(ms / 1000);
        }

        const message = buildOrderConfirmation({
          // os_queue (every column verified in supabase-setup.sql:197-224)
          orderId,
          leadEmail: qRow ? qRow.lead_email : null,
          figmaUrl: qRow ? qRow.figma_url : null,
          esp,                                  // resolved above (os_queue.esp / body)
          darkMode,                             // resolved above (html scan OR os_queue.dark_mode)
          tatHours: qRow ? Number(qRow.tat_hours) : null,
          deadline: qRow ? qRow.deadline : null,
          effectiveDeadline: qRow ? (qRow.effective_deadline || qRow.deadline) : null,
          // the delivered artefacts, from THIS request
          deliveredHtml: html,                  // the EMAIL copy (absolute URLs) â€” the bytes the lead sends
          dropboxFolderUrl: dropboxUrl,
          dropboxHtmlUrl,
          previewUrl,
          hasInlinePreviewBytes: !!previewBytes,
          previewStatus,
          imageCount: images.length,
          ledger,                               // deriveWordFatalLedger(html), same ledger delivery-notes.txt uses
          // maveloper_jobs.delivery_meta
          provenance: jobMeta.provenance || null,
          certificate: jobMeta.certificate || null,
          generationSeconds,
          // â˜… Email on Acid: NO field stores this in either repo (no column, no
          //   jsonb key, no API call â€” /os has only a "Coming in the Email on
          //   Acid integration release" tooltip). The spec says "when one
          //   exists"; one never does yet, so the row is simply absent. Wired as
          //   a named parameter so the day a field appears it is a one-line
          //   change here and nothing else.
          emailOnAcidUrl: null,
        });

        // 5. Send. NEVER THROWS.
        const result = await sendOrderConfirmation({
          message, previewBytes, orderId, requestId: req.id, env: process.env, log,
        });
        confirmationEmail = confirmationMetaFor(result, message);

        // 6. â˜… THE FAILURE MUST BE VISIBLE ON THE JOB ROW, NOT ONLY IN A LOG LINE
        //    THAT SCROLLS AWAY. Written into maveloper_jobs.delivery_meta â€” the
        //    SAME EXISTING jsonb column the certificate and provenance already
        //    use (written at /bridge-callback, read at resolveApproveJobMeta).
        //    â˜… NO NEW COLUMN IS INVENTED. Read-modify-write so the certificate
        //    and provenance already in the column are preserved.
        if (supabaseAdmin && jobMeta.jobRowId) {
          try {
            const { data: cur } = await supabaseAdmin
              .from("maveloper_jobs").select("delivery_meta").eq("id", jobMeta.jobRowId).limit(1).maybeSingle();
            const merged = { ...(cur && cur.delivery_meta && typeof cur.delivery_meta === "object" ? cur.delivery_meta : {}), confirmationEmail };
            const { error: cmErr } = await supabaseAdmin
              .from("maveloper_jobs").update({ delivery_meta: merged }).eq("id", jobMeta.jobRowId);
            if (cmErr) {
              log("warn", "Order-confirmation: delivery_meta.confirmationEmail write failed (outcome is still in the log + the /approve response)", {
                requestId: req.id, orderId, error: cmErr.message,
              });
            }
          } catch (cmThrow) {
            log("warn", "Order-confirmation: delivery_meta.confirmationEmail write threw (outcome is still in the log + the /approve response)", {
              requestId: req.id, orderId, error: cmThrow.message,
            });
          }
        }
      } catch (confErr) {
        // Guarantee 2. This catch is the difference between "the lead did not get
        // an email" and "the order reports as failed". It must stay.
        confirmationEmail = { attempted: true, ok: false, reason: "confirmation-block-threw", error: confErr?.message || String(confErr) };
        log("error", "â˜… ORDER-CONFIRMATION BLOCK THREW â€” ORDER SHIPPED ANYWAY. The lead was NOT notified.", {
          requestId: req.id, orderId, error: confErr?.message || String(confErr), stack: confErr?.stack?.split("\n").slice(0, 4).join(" | "),
        });
      }
    }

    // ── ★★ IDEMPOTENCY: RECORD THIS RUN ──────────────────────────────────────
    // Written LAST, so only a run that got this far is remembered — and written
    // as a read-modify-write MERGE, for the same reason the confirmationEmail
    // write above is one: a blind update would delete the certificate, the
    // provenance and the confirmation outcome that share this jsonb. The read
    // happens here rather than being reused from resolveApproveJobMeta because
    // the email block may have written to the column since.
    //
    // Non-fatal in every direction: no job row, no column, or a failed write
    // means the next approve of these bytes simply runs in full, which is
    // exactly today's behaviour. A guard that could fail a delivery would be
    // worse than the duplicate it prevents.
    if (supabaseAdmin && jobMeta.jobRowId) {
      try {
        const approveRecord = buildApproveRecord({
          fingerprint: approveFp, orderId, folderPath, dropboxUrl,
          imageCount: images.length, previewStatus, generatedBy,
          folderIntegrity, confirmationEmail, requestId: req.id,
        });
        const { data: cur } = await supabaseAdmin
          .from("maveloper_jobs").select("delivery_meta").eq("id", jobMeta.jobRowId).limit(1).maybeSingle();
        const merged = {
          ...(cur && cur.delivery_meta && typeof cur.delivery_meta === "object" ? cur.delivery_meta : {}),
          [APPROVE_RECORD_KEY]: approveRecord,
        };
        const { error: apErr } = await supabaseAdmin
          .from("maveloper_jobs").update({ delivery_meta: merged }).eq("id", jobMeta.jobRowId);
        if (apErr) {
          log("warn", "Approve: idempotency record write failed — a repeat approve of these bytes will run in full (today's behaviour)", {
            requestId: req.id, orderId, error: apErr.message,
          });
        } else {
          log("info", "Approve: idempotency record written", {
            requestId: req.id, orderId, fingerprint: approveFp, complete: approveRecord.complete,
          });
        }
      } catch (apThrow) {
        log("warn", "Approve: idempotency record write threw — a repeat approve of these bytes will run in full (today's behaviour)", {
          requestId: req.id, orderId, error: apThrow.message,
        });
      }
    } else {
      log("info", "Approve: no job row for this order — the idempotency record cannot be stored, so a repeat approve will run in full", {
        requestId: req.id, orderId,
      });
    }

    // ── ★ /approve, END TO END, IN ONE LINE (instrument only) ─────────────────
    // FALSIFIED PREMISE, reported rather than obeyed: this phase was NOT invisible.
    // /approve already emitted imagesMs, shareLinkMs, msFromApproveStart,
    // housekeepingMs, pruneMs and gateMs. What did NOT exist is a SINGLE line
    // holding the whole route and its parts together, so reading the cost of the
    // ~108-file delivery folder meant subtracting timestamps across six log lines
    // and hoping none were interleaved with another order's. That is the gap, and
    // it is a smaller gap than the brief assumed.
    //
    // ★ AND THE REST OF THE ROUTE WAS GENUINELY UNTIMED: the confirmation email
    // (a Dropbox share link for the html, a preview.png download, an SMTP send)
    // and the idempotency record sit BETWEEN the last timed stage and this line,
    // and no clock has ever been on them. totalMs minus the named parts is
    // `unaccountedMs`, which is exactly that stretch — named as unaccounted rather
    // than attributed to anything, because nothing here has measured it yet.
    const tApproveTotalMs = Date.now() - startTime;
    const _named = tImagesMs + (tHousekeepingStart - tShareStart) + tPruneMs + tGateMs;
    log("info", "Approve: route complete (end to end)", {
      requestId: req.id, orderId,
      totalMs: tApproveTotalMs,
      imagesMs: tImagesMs,
      shareLinkMs: tHousekeepingStart - tShareStart,
      pruneMs: tPruneMs,
      gateMs: tGateMs,
      unaccountedMs: tApproveTotalMs - _named,
      referencedImages: urlList.length,
      materialised: images.length,
      concurrency: DROPBOX_BATCH_SIZE,
      // ★ THIS RUNS AFTER finished_at. It is not in the engine clock and it is not
      // in the queue row's start-to-finish span; it is time the lead waits that no
      // existing measurement contains.
      afterFinishedAt: true,
    });

    res.json({
      dropboxUrl,
      orderId,
      folderPath,
      imageCount: images.length,
      previewStatus,
      generatedBy,
      // SEAM_AUDIT I-1: the folder's own integrity, so the frontend can surface
      // "this folder is short" instead of the owner discovering it by opening it.
      // ok:null means the gate could not run, which is NOT the same as ok:true.
      folderIntegrity: folderIntegrity
        ? {
            ok: folderIntegrity.ok,
            missingFiles: folderIntegrity.missingFiles || [],
            deadRefs: folderIntegrity.deadRefs || [],
            counts: folderIntegrity.counts || null,
            error: folderIntegrity.error || null,
          }
        : null,
      // â˜… ORDER-CONFIRMATION outcome, so a send failure is visible in the UI the
      // owner is already looking at rather than only in Railway logs. null means
      // the feature is OFF (the default) â€” which is NOT the same as a failure,
      // and the frontend distinguishes the two.
      confirmationEmail,
      requestId: req.id,
    });

    } finally {
      // The latch is released on EVERY exit — success, thrown error, or the
      // early returns above. A latch that can be left held turns one failed
      // approve into an order that can never be approved again.
      latch.release();
    }
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
// v9.6.0 â€” SERVER-SIDE QUEUE RUNNER (shipped DARK behind RUNNER_ENABLED)
//
// Drains os_queue headless so the queue processes with NO /os tab open. The
// instance is ALWAYS constructed (so the routes below have something to talk
// to), but .start() no-ops unless RUNNER_ENABLED === "true" â€” the dark build
// never ticks, never heartbeats, never writes. See queue-runner.js.
// =====================================================================
createSpacesRoutes({ app, supabaseAdmin, requireAuth, log, env: process.env });

// THE MOUNT. Until this line existed, figma-credential-routes.js was imported by
// nothing, so all four routes 404d and no client could store a token - the whole
// per-space credential path was inert. Same shape as createSpacesRoutes directly
// above: same app, same supabaseAdmin, same requireAuth, same log, same env.
// Fails OPEN. A space with no stored credential still resolves to the global
// Mavlers token, so every existing order path behaves exactly as it does today.
createFigmaCredentialRoutes({ app, supabaseAdmin, requireAuth, log, env: process.env });

// THE OAUTH MOUNT. Same shape as the two calls directly above. Fails OPEN: a
// space with no OAuth connection (no row, or org_figma_oauth not yet created)
// resolves through resolveFigmaToken exactly as it does today.
createFigmaOAuthRoutes({ app, supabaseAdmin, requireAuth, log, env: process.env });

const queueRunner = createQueueRunner({
  supabaseAdmin,
  startFigmaJobAsync,
  log,
  env: process.env,
});

// GET /runner/status â€” debug/observability, no auth. Reports the flag + last
// heartbeat + live queue counts. Harmless when dark (runnerEnabled:false).
// ─────────────────────────────────────────────────────────────────────────────
// ★ GET /os/provenance?jobIds=a,b,c — WHICH ENGINE MADE EACH ORDER.
//
// The /os console has every operational fact about an order (deadline, elapsed,
// lead, ESP) and not one QUALITY fact, because the whole provenance record — the
// engine, the diamond tag, the refusal guard on a fallback, live-text coverage,
// slice ratio, property-accuracy range, divergence count, seconds elapsed — lives
// on maveloper_jobs.delivery_meta and the browser has no route to it.
//
// WHY A BACKEND ROUTE RATHER THAN A DIRECT SUPABASE READ. `maveloper_jobs` is not
// declared in the /os repo's supabase-setup.sql, so whether an `authenticated`
// role can SELECT it is not knowable from that repo — and an RLS refusal returns
// an EMPTY RESULT WITH NO ERROR, which would have rendered as "this order has no
// provenance" for every order, forever, indistinguishably from the truth. The
// backend holds supabaseAdmin and already answers /job-status from this table, so
// the fact is served from where it is certainly readable.
//
// RETURNS THE RECORD RAW. No interpretation here: the ratio/range unit rules
// (every quality ratio is 0-1; accuracy is a floor..ceiling range) are already
// written down once in order-confirmation.js, and a second interpretation living
// on a transport route is how two surfaces start quoting one number two ways. The
// /os client ports that reader and is tested against it.
//
// Auth: run 14. Sign-in plus a live seat; the id list is cut down to the jobs
// whose os_queue row is in a space the caller is seated in (route-doors.js).
// ─────────────────────────────────────────────────────────────────────────────
const OS_PROVENANCE_MAX_IDS = 60;

app.get("/os/provenance", ...doors.provenance, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(200).json({ jobs: {}, degraded: "supabase not configured", requestId: req.id });
    }
    const raw = String(req.query.jobIds || "").trim();
    if (!raw) return res.json({ jobs: {}, requestId: req.id });

    const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(isUuid))].slice(
      0,
      OS_PROVENANCE_MAX_IDS,
    );
    if (ids.length === 0) return res.json({ jobs: {}, requestId: req.id });

    const { data, error } = await supabaseAdmin
      .from("maveloper_jobs")
      .select("id, order_id, engine_used, delivery_meta, completed_at")
      .in("id", ids);

    if (error) {
      // The delivery_meta column may not be migrated on this project. That is a
      // DEGRADED answer, not a failure: the console shows "no provenance recorded"
      // rather than an error, exactly as it does for an order that predates the
      // record. Never a 500 — this endpoint must not be able to break the screen.
      log("warn", "/os/provenance read failed (delivery_meta not migrated?)", {
        requestId: req.id, error: error.message, count: ids.length,
      });
      return res.status(200).json({ jobs: {}, degraded: error.message, requestId: req.id });
    }

    const jobs = {};
    for (const row of data ?? []) {
      const dm = row.delivery_meta && typeof row.delivery_meta === "object" ? row.delivery_meta : null;
      jobs[row.id] = {
        orderId: row.order_id ?? null,
        engineUsed: row.engine_used ?? null,
        completedAt: row.completed_at ?? null,
        generatedBy: (dm && dm.generatedBy) || null,
        provenance: (dm && dm.provenance) || null,
        certificate: (dm && dm.certificate) || null,
      };
    }
    return res.json({ jobs, requestId: req.id });
  } catch (err) {
    log("error", "/os/provenance threw", { requestId: req.id, error: err.message });
    return res.status(200).json({ jobs: {}, degraded: err.message, requestId: req.id });
  }
});

app.get("/runner/status", async (req, res) => {
  try {
    const s = await queueRunner.status();
    res.json({ ...s, requestId: req.id });
  } catch (err) {
    res.status(500).json({ error: "Failed to read runner status", details: err.message, requestId: req.id });
  }
});

// POST /queue/run-next â€” manual trigger (replaces the /os "Run next now" button).
// Requires a Supabase JWT (reuse requireAuth). Forces ONE immediate tick. When
// the runner is dark it does NOT dispatch â€” it reports disabled so the button
// stays honest until the flag is flipped.
app.post("/queue/run-next", requireAuth, async (req, res) => {
  try {
    if (!queueRunner.cfg.enabled) {
      return res.json({ dispatched: null, reason: "runner disabled (RUNNER_ENABLED != true)", requestId: req.id });
    }
    const result = await queueRunner.tick();
    res.json({ ...result, requestId: req.id });
  } catch (err) {
    res.status(500).json({ error: "run-next failed", details: err.message, requestId: req.id });
  }
});

// =====================================================================
// SERVER START + PROCESS HANDLERS
// =====================================================================
const server = app.listen(PORT, () => {
  log("info", `Maveloper backend running on port ${PORT}`, {
    framework: "master-v2",
    version: "9.1.0-async-preview",
    dropboxConfigured,
    figmaConfigured,
  });
  // Boot the queue runner. No-ops (just logs a DISABLED boot line) unless
  // RUNNER_ENABLED === "true" â€” so the dark build's only visible effect is one
  // extra log line at startup.
  queueRunner.start();
});

server.timeout = SERVER_TIMEOUT_MS;
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled rejection", { reason: String(reason) });
});

process.on("uncaughtException", (err) => {
  log("error", "Uncaught exception", { error: err.message, stack: err.stack });
  // v5.5.0: route through graceful shutdown instead of immediate exit so
  // in-flight requests (which may be holding large PDF/PNG buffers) get a
  // chance to finish before the pod is killed.
  shutdown("uncaughtException");
});

const shutdown = (signal) => {
  log("info", `${signal} received, shutting down gracefully`);
  server.close(() => {
    log("info", "HTTP server closed");
    process.exit(0);
  });
  // v5.5.0: 30s was too aggressive â€” Stage 2 alone can run for several minutes
  // with 32K max_tokens. Drain window must comfortably exceed the engine
  // dispatch wait for an in-flight Stage 2 to complete.
  setTimeout(() => {
    log("error", `Forced shutdown after ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s timeout`);
    process.exit(1);
  }, SHUTDOWN_DRAIN_TIMEOUT_MS).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
