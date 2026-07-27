#!/usr/bin/env node
/**
 * asset-refs.test.mjs — THE MIRROR GUARD + the golden vectors.
 *
 * This file is byte-identical in the bridge and the backend. It does two things:
 *
 *   1. MIRROR GUARD. Hashes the block between the CANONICAL markers in the local
 *      asset-refs module and compares it to ASSET_REF_CANON_SHA, which is pinned
 *      to the SAME constant in both repos. Edit one copy and both repos go red —
 *      the collector and the gate cannot silently drift apart.
 *
 *   2. GOLDEN VECTORS. Every mechanism that has actually cost us a delivery, as
 *      a fixed input/output pair. Each vector names the incident it came from.
 *
 * Run:  node asset-refs.test.mjs            (exit 0 = pass)
 *       node asset-refs.test.mjs --print-sha
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_FILE = ["asset-refs.mjs", "asset-refs.js"]
  .map((f) => path.join(__dirname, f))
  .find((p) => fs.existsSync(p));
if (!MODULE_FILE) {
  console.error("FAIL: no asset-refs module beside this test");
  process.exit(1);
}

// ★ PINNED IN BOTH REPOS. Do not update on one side only.
const ASSET_REF_CANON_SHA = "bafec4575b6e44fd519fd74c1aa586bc69304f42f3a9dc265e3a9b8c23875889";

const src = fs.readFileSync(MODULE_FILE, "utf8");
const B = "==== BEGIN CANONICAL";
const E = "==== END CANONICAL ====";
const i = src.indexOf(B);
const j = src.indexOf(E);
if (i < 0 || j < 0) {
  console.error("FAIL: canonical markers not found in " + MODULE_FILE);
  process.exit(1);
}
// Normalise line endings so a git autocrlf checkout cannot flip the hash.
const canon = src.slice(src.indexOf("\n", i) + 1, j).replace(/\r\n/g, "\n");
const sha = crypto.createHash("sha256").update(canon, "utf8").digest("hex");

if (process.argv.includes("--print-sha")) {
  console.log(sha);
  process.exit(0);
}

const mod = await import("file:///" + MODULE_FILE.replace(/\\/g, "/"));
const { extractAssetRefs, distinctAssetUrls, replaceAssetUrl, assetBasename, isRemoteRef } = mod;

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
};

console.log("\nMIRROR GUARD");
check(
  "canonical block matches the pinned cross-repo sha",
  sha === ASSET_REF_CANON_SHA,
  `local ${sha.slice(0, 16)}… vs pinned ${ASSET_REF_CANON_SHA.slice(0, 16)}…`
);

console.log("\nGOLDEN VECTORS — each one is an incident, not a hypothetical");

// ── TEST27-1800: the 7 backgrounds that shipped short ────────────────────────
{
  const html = `<table style="background-image:url(assets/fill_5d11.png)"><img src="assets/s1.png">
    <div style="position:absolute;inset:0;background-image:url(assets/fill_4faa.png)"></div></table>`;
  const urls = distinctAssetUrls(html);
  check("TEST27 · css-url backgrounds are collected alongside img src",
    urls.length === 3 && urls.includes("assets/fill_5d11.png") && urls.includes("assets/fill_4faa.png"),
    JSON.stringify(urls));
  const bgOnly = distinctAssetUrls(html, (r) => r.mech === "css-url");
  check("TEST27 · the background population is separately addressable",
    bgOnly.length === 2, JSON.stringify(bgOnly));
}

// ── The 5 LLM artifacts whose only reference is background="…" ───────────────
{
  const html = `<td background="https://dl.dropboxusercontent.com/scl/fi/H/frame-1.png?rlkey=k&raw=1" bgcolor="#fff">x</td>`;
  const urls = distinctAssetUrls(html);
  check("LLM · HTML background= attribute is collected (invisible to src= AND url())",
    urls.length === 1 && urls[0].endsWith("frame-1.png?rlkey=k&raw=1"), JSON.stringify(urls));
}

// ── job_1779773959367_5508db1a: one logical URL, two byte forms ──────────────
{
  const U = "https://dl.dropboxusercontent.com/scl/fi/H/frame-1.png?rlkey=k&raw=1";
  const html = `<td background="https://dl.dropboxusercontent.com/scl/fi/H/frame-1.png?rlkey=k&amp;raw=1">` +
               `<div style="background-image:url(${U})"></div></td>`;
  const urls = distinctAssetUrls(html);
  check("5508db1a · the entity-encoded and raw forms collapse to ONE logical url",
    urls.length === 1 && urls[0] === U, JSON.stringify(urls));
  const { html: out, replaced } = replaceAssetUrl(html, U, "images/frame-1.png");
  check("5508db1a · BOTH byte forms are replaced (a split/join localiser misses one)",
    replaced === 2 && !out.includes("dropboxusercontent"), `replaced=${replaced}`);
}

// ── Outlook VML background: <v:fill src> falls out of the src scan ───────────
{
  const html = `<!--[if gte mso 9]><v:rect><v:fill type="frame" src="https://x/hero.png" /></v:rect><![endif]-->`;
  const urls = distinctAssetUrls(html);
  check("VML · v:fill src is covered by the src mechanism, no second regex",
    urls.length === 1 && urls[0] === "https://x/hero.png", JSON.stringify(urls));
}

// ── srcset ──────────────────────────────────────────────────────────────────
{
  const html = `<img src="a.png" srcset="a.png 1x, a@2x.png 2x">`;
  const urls = distinctAssetUrls(html);
  check("srcset · every candidate URL is collected, descriptors stripped",
    urls.length === 2 && urls.includes("a@2x.png"), JSON.stringify(urls));
}

// ── Unquoted url() and unquoted src ─────────────────────────────────────────
{
  const html = `<div style=background-image:url(bg.png)><img src=logo.png></div>`;
  const urls = distinctAssetUrls(html);
  check("unquoted · both unquoted url() and unquoted src are collected",
    urls.includes("bg.png") && urls.includes("logo.png"), JSON.stringify(urls));
}

// ── Tokens and non-assets are NOT collected ─────────────────────────────────
{
  const html = `<a href="%%unsub_center_url%%"><img src="%%profile_img%%"></a>` +
               `<img src="{{ hero }}"><img src="data:image/gif;base64,R0lGOD">` +
               `<div style="background:url()"></div>`;
  const refs = extractAssetRefs(html);
  const urls = refs.map((r) => r.url);
  check("tokens · ESP %%…%% and {{…}} placeholders are not asset refs",
    !urls.some((u) => /%%|\{\{/.test(u)), JSON.stringify(urls));
  check("tokens · data: URIs are extracted but classified remote",
    urls.some((u) => u.startsWith("data:")) && isRemoteRef("data:image/gif;base64,R0lGOD"));
  check("tokens · an empty url() is not a reference", !urls.includes(""));
}

// ── background-color must not be mistaken for background= ───────────────────
{
  const html = `<td style="background-color:#D9D9D9;background:#fff" bgcolor="#fff">x</td>`;
  check("no false positive · background-color / background: are not background=",
    extractAssetRefs(html).length === 0, JSON.stringify(extractAssetRefs(html)));
}

// ── basename derivation, incl. the Dropbox query string ─────────────────────
{
  check("basename · Dropbox query string is stripped",
    assetBasename("https://dl.dropboxusercontent.com/scl/fi/H/slice_1_90@2x.png?rlkey=x&raw=1") === "slice_1_90@2x.png");
  check("basename · relative compiler path",
    assetBasename("assets/slices/KEY/slice_1_32@2x.png") === "slice_1_32@2x.png");
}

// ── document order is preserved ─────────────────────────────────────────────
{
  const html = `<div style="background-image:url(first.png)"></div><img src="second.png">`;
  const urls = distinctAssetUrls(html);
  check("order · refs come back in document order regardless of mechanism",
    urls[0] === "first.png" && urls[1] === "second.png", JSON.stringify(urls));
}

// ── rewriteRefsByBasename: the server.js non-src rewrite, callable ──────────
{
  const { rewriteRefsByBasename } = mod;
  const html = `<img src="assets/s1.png"><div style="background-image:url(assets/fill_a.png)"></div>` +
               `<td background="assets/fill_b.png"></td><img src="spacer.gif">`;
  const byName = {
    "s1.png": "https://x/s1.png",
    "fill_a.png": "https://x/fill_a.png",
    "fill_b.png": "https://x/fill_b.png",
  };
  const r = rewriteRefsByBasename(html, byName, { skipMechs: ["src"] });
  check("rewrite · background url() AND background= are rewritten, src is left to pass 1",
    r.replaced === 2 && r.html.includes("url(https://x/fill_a.png)") &&
    r.html.includes(`background="https://x/fill_b.png"`) && r.html.includes(`src="assets/s1.png"`),
    `replaced=${r.replaced}`);
  const r2 = rewriteRefsByBasename(r.html, byName, { skipMechs: ["src"] });
  check("rewrite · idempotent (remote refs skipped, second run is a no-op)",
    r2.replaced === 0 && r2.html === r.html);
  const all = rewriteRefsByBasename(html, byName);
  check("rewrite · with no skipMechs the src refs are rewritten too",
    all.replaced === 3, `replaced=${all.replaced}`);
  const miss = rewriteRefsByBasename(`<div style="background:url(assets/ghost.png)"></div>`, byName);
  check("rewrite · an unmatched ref is REPORTED, never guessed positionally",
    miss.replaced === 0 && miss.unmatched.length === 1 &&
    miss.unmatched[0].basename === "ghost.png" && miss.unmatched[0].mech === "css-url",
    JSON.stringify(miss.unmatched));
  check("rewrite · spacer.gif is never rewritten",
    !rewriteRefsByBasename(html, { "spacer.gif": "https://x/nope.gif" }).html.includes("nope.gif"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
