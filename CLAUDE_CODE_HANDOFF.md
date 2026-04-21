[CLAUDE_CODE_HANDOFF.md](https://github.com/user-attachments/files/26920467/CLAUDE_CODE_HANDOFF.md)
# MAVELOPER — CLAUDE CODE HANDOFF (v5.1.3)

Complete context for migrating all code review + fix work from claude.ai/chat to Claude Code.
Read this file top-to-bottom before touching any code.

---

## 1. WHAT MAVELOPER IS

AI-powered tool that converts email design PDFs → production-ready Mavlers-framework HTML.
Developer uploads: design PDF + ZIP of image assets. Output: HTML email code with Dropbox-hosted images.

**Owner:** Shrujal Gajjar, Creative Services Manager at Mavlers (Ahmedabad, India).

**Scale plan:** 5 internal devs (phase 1) → 25 devs (phase 2) → 100+ devs (phase 3).

---

## 2. ARCHITECTURE (current — v5.1.3)

```
Lovable frontend (React)
    ↓  POST /generate { pdfBase64, assetsZipBase64, devInputs }
Node.js backend on Railway Pro
    ├─ Step 1: Rasterize PDF → PNG (pdf-to-png-converter, 1.6x scale)
    ├─ Step 2: Extract ZIP in memory (adm-zip)
    ├─ Step 3: Upload images to Dropbox (parallel batch 3, retry, refresh-token OAuth)
    ├─ Step 4: STAGE 1 — Design analysis (single full-design Claude call)
    │       ↳ Input: tiled JPEG(s) + pixel palette + OCR text + band map + image asset list
    │       ↳ Output: JSON spec with logical sections, spans, embedded Dropbox URLs
    ├─ Step 5: STAGE 2 — Code generation (Claude call, text-only)
    │       ↳ Input: JSON spec + dev overrides + Master Framework in system prompt
    │       ↳ Output: production HTML
    ├─ Step 6: POST-PROCESS (deterministic, Node.js)
    │       ├─ fixImageUrls — replace local paths with Dropbox URLs (filename match)
    │       ├─ fixNearWhite — normalize JPEG-shifted near-white to #FFFFFF
    │       ├─ fixAlertBarContrast — black text on warm bg, white on dark
    │       ├─ fixActivityFeed — unwrap bullet lists of day+time patterns to plain rows
    │       └─ fixThinBands — drop hallucinated thin stripes
    └─ Return: { html, orderId, imageUrlMap, designSpec, pageImages }
    
Frontend preview + Approve
    ↓  POST /approve { orderId, html, imageUrlMap }
Build ZIP (HTML + images) → upload to Dropbox → return shareable link
```

### Infrastructure
| Service | Role | Detail |
|---|---|---|
| Lovable | Frontend | https://maveloper.lovable.app |
| Vercel | Frontend hosting (alt) | https://maveloper.vercel.app |
| Railway Pro ($20/mo) | Backend | https://maveloper-backend-production.up.railway.app |
| GitHub | Repo | `maveloper-backend` (server.js, band-detector.js, package.json) |
| Anthropic API | Claude Sonnet 4.5 | env: `CLAUDE_API_KEY`, model: `claude-sonnet-4-5` alias |
| Dropbox | Image + ZIP hosting | App name `maveloper-v2`, App folder `Apps/maveloper-v2/` |
| Email on Acid | Cross-client testing (Phase 4) | existing Mavlers enterprise account |

### Railway environment variables
- `CLAUDE_API_KEY`
- `PORT` (auto)
- `CLAUDE_MODEL` (optional, defaults to `claude-sonnet-4-5`)
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

---

## 3. FILE STRUCTURE (GitHub repo)

```
maveloper-backend/
├── server.js          (~2550 lines, v5.1.3 — all pipeline logic, prompts, routes)
├── band-detector.js   (377 lines — pixel-row band detection, palette builder, OCR post-processing)
└── package.json       (unchanged since v3.1.0 — dependencies only)
```

### Dependencies (package.json)
```json
{
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "cors": "^2.8.5",
    "express": "^4.21.0",
    "express-rate-limit": "^7.4.0",
    "helmet": "^8.0.0",
    "pdf-to-png-converter": "^3.3.0",
    "sharp": "^0.33.5",
    "adm-zip": "^0.5.16",
    "dropbox": "^10.34.0",
    "pdf-parse": "^1.1.1",
    "tesseract.js": "^5.0.0"
  }
}
```

### Critical server.js constants
```js
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 10;
const RASTERIZE_TIMEOUT_MS = 60 * 1000;
const ANTHROPIC_TIMEOUT_MS = 480 * 1000;   // 8 min
const SERVER_TIMEOUT_MS = 600 * 1000;      // 10 min
const RASTERIZE_SCALE = 1.6;
const TILE_MAX_HEIGHT = 6000;              // stays under Claude's 8000px dimension cap
const TILE_OVERLAP = 300;
const TILE_TARGET_MAX_BYTES = 2 * 1024 * 1024;
```

---

## 4. VERSION HISTORY (complete)

| Version | Change |
|---|---|
| v1.0 – v1.1.3 | Initial backend, Master Framework prompt, security hardening (14/14 Layer 1 checks), Vercel→Railway migration |
| v1.2.0 | Move 2: Dropbox integration, ZIP upload, /generate + /approve routes |
| v1.2.1 – v1.3.8 | Visual matching, parallel uploads, URL conversion fixes, fault-tolerant uploads, PDF compression, image validation filters |
| v1.4.0 – v1.4.2 | Aggressive compression, 32K max_tokens, timeouts raised |
| v2.0.0 – v2.1.0 | Developer input fields (width/font/ESP/dark mode), text alignment rules, 10-pair analysis gap-closing |
| v3.x | Two-stage pipeline (Stage 1 Vision→JSON, Stage 2 JSON→HTML); worked structurally but color/section precision lost |
| v4.0.0 – v4.0.1 | Deterministic band detection in Node.js; per-band Claude classification with pixel-sampled colors; rate-limit fixes (429) |
| v5.0.0 | **Major rearchitecture.** Single full-design Stage 1 call with pixel palette + OCR + band map; spans array for multi-color headings; universal brand-agnostic design |
| v5.0.1 | Tile tall PDFs at 6000px max height to stay under Claude Vision 8000px cap (fixed 400 invalid_request) |
| v5.1.0 | **Post-processing layer added.** Deterministic fixups: fixImageUrls, fixNearWhite, fixAlertBarContrast, fixActivityFeed, fixThinBands |
| v5.1.1 | Added diagnostic logging to identify URL replacement failure state |
| v5.1.2 | Retry Dropbox uploads; hard-fail on empty map to prevent shipping broken HTML |
| v5.1.3 | **Current.** Raise Stage 1 max_tokens to 32000; auto-repair truncated JSON (closes open strings/braces/brackets) |

### Current deployed version: **v5.1.3**
Health check returns: `{"status":"ok", "version":"5.1.3", "framework":"master-v2", "dropboxConfigured":true}`

---

## 5. KNOWN FAILURE MODES (verified across tests 1–5)

### Still unresolved as of v5.1.3

Based on tests with Collarts design PDF. Pixel-perfect parity with developer-coded HTML is the success criterion.

| # | Failure | Versions affected | Root cause hypothesis |
|---|---|---|---|
| A | Wrong section bg color (e.g., cream #F5F5E8 benefits cards rendered on near-white instead) | 5.0.0, 5.1.0 | Stage 1 Claude picks most-prevalent palette color as universal default; doesn't differentiate "card" sections from wrapper |
| B | Dark testimonial rendered black when design shows pink/peach | 4.0.1, 5.0.0, 5.1.0 | Pink is not a prominent pixel color in the palette; Claude classifies as dark section from JPEG |
| C | Section bg vs text contrast wrong in some sections (white text on green testimonial when design has black text) | 5.1.0 | Stage 2 default text color on saturated bg is inverted |
| D | Heading order sometimes wrong (primary heading appears before hero image instead of after) | 5.1.0 | Stage 1 sequences logical sections by content importance, not by y-position |
| E | 4-image dark gallery 2x2 grid fragmented | 4.0.1, 5.1.0 | Stage 2 layout template for nested columns doesn't force equal width |
| F | CTA buttons rendered as standalone sections instead of embedded in parent content | 5.1.0 | Stage 1 treats CTAs as top-level sections |
| G | Some sections classified wrong type (e.g., orphan image where merged card expected) | 5.0.0, 5.1.0 | Band misclassification |

### Resolved

- v4.0.1 → v5.0.0: Fixed heading color-split (spans rendering)
- v4.0.1 → v5.0.0: Removed Frame 8 hallucinated dark logo
- v5.0.0 → v5.1.0: Image URLs now Dropbox (when upload succeeds)
- v5.0.0 → v5.1.0: #FDFDFA near-white normalized to #FFFFFF
- v5.0.0 → v5.1.0: Alert bar text contrast fixed (black on orange)
- v5.0.0 → v5.1.0: Activity feed unwrapped from bullet lists
- v5.0.0 → v5.1.0: Hallucinated thin bands (#40E340, #BFF5BF) dropped
- v5.1.2: Upload failure now hard-fails instead of silent broken HTML
- v5.1.3: JSON truncation fallback

---

## 6. PROMPT ARCHITECTURE

### Stage 1 prompt (v5.0.0)
- Identifies itself as email design analyst
- Receives: tiled images + pixel-sampled color palette + OCR text + band map + image asset list + dev overrides
- Outputs: JSON design spec
- Key rules:
  - LOGICAL SECTIONS, not raw bands (merge related bands)
  - BAND COVERAGE (every band's y-range must be covered)
  - COLORS FROM PALETTE (never invent hex values)
  - TEXT FROM OCR (verbatim, no paraphrasing)
  - MULTI-COLOR HEADINGS USE SPANS (one td with multiple span elements, not stacked rows)
  - IMAGES carry embedded src URL from the asset list
  - ALIGNMENT matches visual observation per text element
  - REPEATED VARIANTS both preserved (e.g., dark + light preheader)

### Stage 2 prompt (Master Framework, ~7000 tokens)
- 10 universal rules (100% adoption across 100-email analysis)
- Mandatory DOCTYPE, head block, canonical CSS reset, main table structure, bulletproof CTA template, dark mode strategy, fluid-hybrid multi-column template
- em_ class vocabulary
- Anti-patterns (17 total) including: no `<p>` tags, no `<h1-h6>`, no `<div>` (except hidden preheader), no `<button>`, no flexbox/grid, no named colors, no `<font>` tags
- Span rendering template for multi-color headings
- Explicit image URL handling (use spec.content[].src verbatim)
- Final checklist (20 items) to verify before output

---

## 7. POST-PROCESSING PIPELINE (v5.1.0 — critical)

Deterministic Node.js fixups that run AFTER Stage 2 produces HTML. These are reliability-guarantees that don't depend on Claude following prompt instructions.

### Functions in server.js

```js
fixImageUrls(html, imageUrlMap)
  → Scans `src="..."` attributes
  → If src looks like relative path, extracts filename (last path segment)
  → Looks up filename in imageUrlMap (case-insensitive)
  → Replaces src with the matched Dropbox URL
  → Returns { html, replaced, unmatched }

fixNearWhite(html, palette)
  → Finds all hex values with R,G,B ≥ 248 but not exactly #FFFFFF
  → Replaces all occurrences with #FFFFFF throughout
  → Returns { html, normalizedColors, count }

fixAlertBarContrast(html)
  → Matches <!-- Section_N: alert_bar --> ... <!-- // Section_N -->
  → Extracts bgcolor
  → If bg dark → force text #FFFFFF; if bg bright/warm → force text #000000
  → Parses style="..." attrs and replaces color: #XXX values
  → Returns { html, fixes }

fixActivityFeed(html)
  → Finds <ul>...</ul> blocks
  → If 50%+ of <li> items match day-of-week OR time patterns (e.g., "Wed 15 Jan 2.45pm")
  → Unwraps to plain <table><tr><td> rows
  → Returns { html, fixes }

fixThinBands(html, palette)
  → Collects bgcolors used ONLY inside thin_colored_band sections (hallucinated)
  → Collects bgcolors used elsewhere (real design colors)
  → For each thin_colored_band: drop if color only appears in thin bands AND isn't dark
  → Distance threshold: 20 in RGB space to adjacent real colors
  → Returns { html, removed }

postProcessHtml(html, { imageUrlMap, palette })
  → Runs all 5 fixes in order
  → Returns { html, report: {...per-fix stats} }
```

### Universal design constraint
All fixes use generic color math (saturation, luminance, distance) — no brand-specific hex values. The functions work on any design regardless of brand.

---

## 8. BAND DETECTOR (band-detector.js)

Pixel-row scanning of the full PDF raster. Produces structural metadata Stage 1 uses.

```js
detectBands(pngBuffer)
  → Scans each row's dominant color
  → Groups consecutive similar-color rows into bands
  → Returns { width, height, bands: [{y_start, y_end, height, bg_hex, is_thin, is_content, row_coverage_ratio}] }

buildColorPalette(bands)
  → Aggregates bands by color (32-step RGB bucket)
  → Weighted average RGB by pixel height
  → Filters: must be saturated (R/G/B diff >40) OR substantially prevalent (≥50px total)
  → Returns top 20 by prevalence: [{hex, rgb, total_height_px, band_count, is_saturated, is_grayscale}]

samplePixelColor(pngBuffer, x, y)
  → Returns exact hex value at pixel coordinate

cropBand(pngBuffer, y_start, y_end)
  → Returns cropped PNG buffer for a specific band range
  → Currently unused in v5 pipeline (kept for future per-region analysis)

postProcessOcr(rawText)
  → Collapses letter-spaced ALL-CAPS runs ("E X P E R T" → "EXPERT")
  → Doubled spaces → single space
  → Stray space before punctuation
  → Missing space after sentence punctuation + uppercase
  → Strips stray single-letter tokens (preserves 'a', 'i')
```

### Tunable parameters
```js
const MIN_BAND_HEIGHT_PX = 2;
const COLOR_SIMILARITY_THRESHOLD = 25;
const DOMINANT_COLOR_RATIO = 0.7;
const ROW_SAMPLE_STEP = 2;
const BIN_STEP = 16;
const PALETTE_MIN_PREVALENCE_PX = 50;
const PALETTE_MAX_COLORS = 20;
const PALETTE_GRAYSCALE_TOLERANCE = 12;
```

---

## 9. TEST ARTIFACTS

Currently available in Maveloper project:

| File | Role |
|---|---|
| `Design_File_OF661625831626.pdf` | Collarts design reference (17871px tall at 1.6x scale) |
| `Coded_by_Developer_OF661625831626.html` | Developer-coded gold standard (35 named sections, pixel-perfect) |
| `images.zip` | 29 images for Collarts (banner_img1-5, icon_img1-3, image_01-14, logo_img1-2, Frame 8, spacer.gif, etc.) |
| `OF522117005616.pdf` | Kenect corporate design (for universal validation — 12948px tall) |
| `Coded_by_Human_Developer_7.html` | Kenect developer reference |

### Previous test outputs (for diffing)
- `Generated_by_Maveloper__3rd_Time_.html` — v4.0.1
- `Generated_by_Maveloper__4th_Test_.html` — v5.0.0
- `Generated_by_Maveloper__5th_Test__.html` — v5.1.0

---

## 10. PERMANENT PROJECT RULES (Shrujal's instructions)

These apply to every turn, every fix, every iteration. Never violate.

### A. Universal code rule (pre-delivery audit mandatory)
Before shipping ANY code, grep for:
- Brand names: `collart|kenect|driven|tanium|philippa|motoromart|1300.818|\+61`
- Collarts hex: `#00DA00, #F5F5E8, #FF9E1F, #170804, #180703`
- Kenect hex: `#022C87, #FFE695, #231F20, #D9D9D9, #FAF8F9`

If any match exists in executable code OR prompt templates → genericize before delivery.
Only generic framework values (`#000000, #FFFFFF`) and synthetic teaching hex values are permitted.

### B. Exhaustive inspection standard (permanent)
Any inspection, investigation, review, QA, analysis, comparison, or overview of Maveloper output vs design/developer HTML must be exhaustive element-by-element — covering every section, block, module, component, color, dimension, and element. Never surface-level.

### C. No quick / temporary / small-tweak fixes
Before suggesting any solution:
1. Do the full exhaustive inspection
2. Trace every failure to its exact line/root cause
3. Present one comprehensive plan addressing ALL issues together
4. One thorough delivery > many incremental ones

### D. Universal architecture, no brand bleed
All code must work on ANY email design PDF. No hardcoded brand logic. No Collarts-centric or Kenect-centric assumptions. Prompts use generic placeholders (`#COLOR`, `[HEADING]`, `FONT_STACK`).

### E. Communication style
- Short replies by default; no long explanations unless asked
- File deliveries: 2-5 lines max of context (commit message, deploy steps)
- No walkthroughs, no root-cause essays, no "what to expect" sections unless requested

### F. Default work mode (auto-apply every turn)
1. Read ALL attached files + prior artifacts end-to-end BEFORE any code
2. Diagnose first — name every failure, trace to exact line/root cause
3. Compare v-latest output vs developer HTML section-by-section, element-by-element; produce mismatch table; fix ALL in ONE delivery
4. Pixel-perfect parity with developer HTML = only success criterion
5. Never ship diagnostic-only or partial fixes when a real fix is possible in the same turn

### G. Full-potential rules (auto-apply)
- Diff actual files, never eyeball screenshots
- Test every fix locally on the real uploaded artifact before shipping; show before/after proof
- If a failure repeats across 2+ versions, the architecture is wrong — propose structural rework, not another prompt/threshold tweak
- Never claim "fixed" based on logic alone — only after reproduction test passes on real input

### H. Proactive next steps after every code delivery
Include: exact deploy steps (Git commit message, Railway redeploy instructions), what logs/outputs Shrujal should share back, what Claude will do with that info.

### I. Child safety, legal, general ethics: standard defaults apply.

---

## 11. OUTSTANDING WORK TO COMPLETE v5.1.3 → LAUNCH

### Current test status (5th test, v5.1.0 baseline; v5.1.2/5.1.3 fixes not yet validated on real output)

After deploying v5.1.3 and running Collarts test, inspect output for these remaining failures:

**CRITICAL (block launch)**
- [ ] Cream #F5F5E8 benefits bg missing (Failure A)
- [ ] Dark testimonial pink bg (Failure B)
- [ ] Green testimonial text contrast (Failure C)

**MAJOR (block launch)**
- [ ] Heading order / hero image placement (Failure D)
- [ ] 4-image gallery 2x2 grid layout (Failure E)
- [ ] CTA buttons embedded in parent sections (Failure F)

**INTEGRATION TESTING (before phase 1 rollout)**
- [ ] Same exhaustive inspection on Kenect PDF (universal design check)
- [ ] End-to-end test: PDF upload → Lovable preview → Approve → ZIP download
- [ ] Email on Acid cross-client rendering test (CORE tier: Apple Mail iPhone, Gmail Android/Web Chrome, Outlook 2016+ Windows, Outlook Web)

**OPERATIONAL (pre-launch)**
- [ ] Anthropic billing alerts at 50%/80% of monthly cap (recommend $500/mo minimum for 25 devs)
- [ ] Backup payment method on Anthropic account
- [ ] Rollback procedure documented
- [ ] Internal developer onboarding doc

---

## 12. FRONTEND STATE (Lovable)

Known pending issues (parked until backend is solid):

| # | Issue | Status |
|---|---|---|
| 5 | HTML preview shows outer background | Fix delivered, needs verification |
| 14 | Preview renders in dark mode | Fix delivered, needs verification |
| 15 | Preview width mismatch | Fix delivered, needs verification |
| 17 | Images in iframe may not load (sandbox) | Partially fixed |
| 18 | imageUrlMap not passed to /approve | Backend fallback added, frontend root cause may persist |
| Progress | Smart progress indicator | Lovable prompt delivered, needs testing |

---

## 13. SHRUJAL — PERSONAL + PROJECT CONTEXT

- Role: Creative Services and Operations Manager at Mavlers (Ahmedabad, India)
- Teams: SMEs across US (Nitisha), EU (Tejal), AU (Zalak)
- Clients: Driven Brands (developers Prit, Sujith), Tanium (designer Vishwal)
- Contact: shrujal@mavlers.com, design@mavlers.com
- Calendar: https://calendar.app.google/BwosY1vKsAMhxZfc6
- Communication: professional, concise, action-oriented; one clear recommendation preferred; copy-paste-ready outputs

### Parallel projects (context only, not Maveloper)
- Mavlers Ops (Lovable + Supabase CRUD dashboard)
- Driven Brands daily Apps Script reports
- Vibe Prospecting B2B lead generation

### Mavlers design system (for any branded UI work)
- Font: Poppins family
- Palette: black, dark grey, white, yellow `#FFDD2F`
- Em-dashes replaced with hyphens in writing
- Yellow accent bars before section headings
- Capsule CTA buttons
- Branded CTA footer with calendar booking link

### Maveloper brand
- Name: Maveloper
- Tagline: "Born at Mavlers"
- Accent color: Lime `#C1FF72`
- Aesthetic: Dark glassmorphic, "Bloomberg terminal designed by Linear"
- Logo: Mavmak (two overlapping angular shapes)

---

## 14. HOW TO RESUME IN CLAUDE CODE

### Step 1: Clone repo
```bash
git clone <repo-url> maveloper-backend
cd maveloper-backend
```

### Step 2: Read these files in this exact order
1. `CLAUDE_CODE_HANDOFF.md` (this file)
2. `band-detector.js` — understand palette + band detection
3. `server.js` — understand pipeline flow (search for `STAGE 1 —`, `STAGE 2 —`, `POST-PROCESSING`)
4. Most recent test artifacts (design PDF + developer HTML + generated output)

### Step 3: Before any code change, always:
1. Read the current test output (most recent `Generated_by_Maveloper_...html`)
2. Diff against `Coded_by_Developer_...html`
3. List every failure in a table with: section, expected, actual, root cause, line in server.js
4. Present the table first
5. Only after approval → write code

### Step 4: Deploy flow
```bash
# After code change
git add server.js band-detector.js
git commit -m "fix: vX.Y.Z — <short summary>"
git push
# Railway auto-redeploys in ~90s
curl https://maveloper-backend-production.up.railway.app/health
# Verify version string in response
```

### Step 5: Test flow
- Same Collarts PDF + ZIP through Lovable
- Download generated HTML + copy Railway logs
- Exhaustive inspection
- Iterate or approve

---

## 15. THINGS TO NEVER DO

1. **Never** hardcode brand colors or names in code or prompts
2. **Never** ship a file without the pre-delivery audit (grep for brand strings + Collarts/Kenect hex values)
3. **Never** iterate on prompt rules when the architecture is the problem (2+ version pattern)
4. **Never** claim "fixed" without reproduction test on real input
5. **Never** silently catch Dropbox/API errors — fail loud so the HTML isn't broken
6. **Never** bypass post-processing
7. **Never** remove the `_palette` and `_band_map` fields from designSpec (Stage 2 and post-process depend on them)
8. **Never** reduce Stage 1 max_tokens below 32000 (JSON truncation at 16000 has been proven to happen)
9. **Never** exceed Claude Vision 8000px dimension cap (tile if necessary)
10. **Never** merge `images/` relative paths into HTML without running fixImageUrls first

---

## 16. CURRENT KNOWN LIMITATIONS

- Stage 1 processing time: ~15–30 seconds (one full-design call)
- Stage 2 processing time: ~60–120 seconds (32K token generation)
- Total pipeline: ~2–3 minutes for typical Collarts-size email
- Rate limit: Single call per /generate = no Anthropic rate-limit pressure
- Dropbox: 29/29 uploads usually succeed; occasional single-image retry needed

---

## 17. ESCALATION PATHS

- Anthropic billing / API issues: platform.claude.com dashboard
- Dropbox token / permissions: dropbox.com/developers/apps → `maveloper-v2` app
- Railway deploy / env vars: railway.app → `maveloper-backend` project
- Frontend issues: Lovable project "Maveloper"

---

## END OF HANDOFF DOCUMENT (v5.1.3)

Next decisions to make in claude.ai/chat (planning):
- Validate v5.1.3 on Collarts PDF
- Identify next structural problem if failures A–G persist
- Prioritize: Dropbox URL reliability → color fidelity → section sequencing → grid layout

Next code work in Claude Code (execution):
- Receive diagnostic reports from chat
- Trace failures to exact lines
- Produce mismatch tables
- Ship one comprehensive fix per major iteration
