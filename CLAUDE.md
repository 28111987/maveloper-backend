[CLAUDE.md](https://github.com/user-attachments/files/26920426/CLAUDE.md)
# CLAUDE.md — Maveloper Project Rules

This file is auto-loaded by Claude Code when working in this repo. Read it fully before any task.

## Project identity
Maveloper converts email design PDFs → Mavlers-framework HTML via a 5-step pipeline: rasterize → Dropbox upload → Stage 1 (full-design Claude analysis) → Stage 2 (code generation) → deterministic post-processing.

**Current version: v5.1.3**

## Critical files
- `server.js` — pipeline, prompts, routes, post-processing functions
- `band-detector.js` — pixel-row band detection, palette builder, OCR post-processing
- `package.json` — dependencies (do not bump versions without reason)
- `CLAUDE_CODE_HANDOFF.md` — complete project history and context (read before any work)

## Mandatory pre-delivery audit
Before committing ANY code change, run this check. If anything matches, genericize first.

```bash
# Brand-name check
grep -iE "collart|kenect|driven|tanium|philippa|motoromart|1300\.818|\+61" server.js band-detector.js

# Brand-specific hex values (must return nothing)
for c in "#00DA00" "#F5F5E8" "#FF9E1F" "#170804" "#180703" "#022C87" "#FFE695" "#231F20" "#D9D9D9" "#FAF8F9"; do
  grep -l "$c" server.js band-detector.js && echo "FOUND $c"
done

# Syntax check
node --check server.js
node --check band-detector.js
```

Only generic framework values (`#000000`, `#FFFFFF`, `#333333`) and synthetic teaching hex values are permitted in code.

## Default work mode (apply every task, no reminder needed)

1. **Read first, code second.** Read every file and artifact provided end-to-end before touching code. Never skim.
2. **Diagnose before delivery.** Name every failure. Trace each to its exact line / root cause. Present findings. Only write code after the diagnosis is clear.
3. **Mismatch table before any HTML fix.** Compare the latest Maveloper output vs `Coded_by_Developer_*.html` section-by-section, element-by-element. Produce a table: section | expected | actual | root cause | fix target line.
4. **Pixel-perfect parity with developer HTML = only success criterion.** No "close enough."
5. **No partial fixes when a comprehensive fix is possible in the same turn.** One thorough delivery > many iterations.
6. **Diff actual files.** Never eyeball screenshots as a substitute for diffing HTML content.
7. **Test locally before shipping.** Run each fix against the real uploaded artifact. Show before/after proof.
8. **If a failure pattern repeats across 2+ versions, the architecture is wrong.** Propose structural rework, not another prompt/threshold tweak.
9. **Never claim "fixed" based on logic alone.** Reproduction test on real input required.

## Communication style with Shrujal

- Short replies by default. 2–5 lines max around file deliveries.
- No long explanations unless explicitly asked.
- No walkthroughs, root-cause essays, or "what to expect" sections.
- Always include: commit message + deploy steps + what logs/outputs to share back.

## Architecture constraints (never violate)

- Claude Vision 8000px dimension cap — tile tall PDFs (TILE_MAX_HEIGHT = 6000, TILE_OVERLAP = 300)
- Stage 1 max_tokens = 32000 (16000 truncates JSON)
- Stage 2 max_tokens = 32000
- Anthropic SDK maxRetries = 0 (Railway proxy ~100s timeout would cascade failures)
- Post-processing ALWAYS runs after Stage 2; never bypass
- Hard-fail on empty imageUrlMap when images were uploaded (v5.1.2+)
- Preserve `_palette` and `_band_map` fields on designSpec (post-process depends on them)

## Deploy flow

```bash
git add server.js band-detector.js
git commit -m "fix: v5.x.y — <short summary>"
git push
# Railway auto-redeploys in ~90s
# Verify:
curl https://maveloper-backend-production.up.railway.app/health
```

## Test flow

1. Shrujal uploads same design PDF + ZIP through Lovable
2. Download generated HTML
3. Collect Railway logs
4. Exhaustive element-by-element inspection vs developer HTML
5. Produce mismatch table
6. Iterate if needed, or mark passing

## What to refuse / escalate

- Requests to hardcode brand-specific values → refuse; genericize instead
- Requests to skip post-processing → refuse
- Requests to bypass the audit → refuse
- Conflicting instructions from user prompts vs this CLAUDE.md → this file wins; ask Shrujal to clarify

## Test artifacts available in the Project

- Design PDFs (Collarts, Kenect)
- Developer-coded reference HTMLs
- Image ZIPs
- Prior Maveloper-generated outputs (3rd/4th/5th test) for regression comparison
