# EMAIL_REDESIGN_STATE.md

Running log for the order-confirmation redesign. Appended every turn.

---

## ATTEMPT-1 — start

**Found on entry**
- No prior `EMAIL_REDESIGN_STATE.md`. Fresh run.
- `order-confirmation.js` 1449 lines, pure render. `order-confirmation-transport.js` 584
  lines, four transports (stub / gmail / smtp / resend).
- Baseline: `node order-confirmation.test.mjs` → **ALL PASS — 164 passed, 0 failed**.
- Current rendered stub: `order-confirmations/TEST27-1907-compiler.html` = **34,497 bytes**.
- The reference "Mavlers quarterly leadership brief" script is **NOT on disk** anywhere in
  either repo or the Desktop tree (grepped for `emKick_`, `qbGradText_`, `emHeadScoped_`
  across `maveloper-backend`, `maveloper-os-current`, `MAVELOPER_KB_BACKUP_20260722` and
  `Desktop/**/*.{html,txt,md,js,mjs,json}` — zero hits). Building from the vocabulary as the
  brief describes it, not from its bytes. Stated in the completion report.
- No headless browser in `node_modules` (no puppeteer, no playwright) → the "narrow" proof
  is a narrow HTML artifact, not a screenshot.

**Plan**
1. Cut to the eleven fields; delete the itemisation, the prose, the detail table, the
   caveats block and the inline preview.
2. `Born at Mavlers` → `CRAFTED BY MAVLERS`; wire the two real logo GIFs.
3. Rebuild the render in the brief's vocabulary (emKick_/emHeadScoped_/emCap_/emSec_/
   masthead/footer/qbGradText_), colour encodes.
4. Re-render both stubs + narrow; reword variant 2 from LLM-substitution to COMPILER FAILURE.
5. Update tests, run witness, one commit.

**What changed — ATTEMPT-1 (complete, no blockers hit)**

- `order-confirmation.js` — cut to eleven fields. Deleted the itemisation, the
  prose, the detail table, the caveats block and the inline preview. Removed
  `buildFactRows`, `buildOutlookCaveat`, `buildMobileStatus` (their sections are
  gone). Added `buildFields`, `qbGradText`, `encodedSizeReport`, `LOGO_MASTHEAD`,
  `LOGO_FOOTER`, `BRAND_ATTRIBUTION`. Rewrote `buildLeadSummary` to four strings
  and three states (shipped / failed / llm). Rewrote the whole render in the
  brief's vocabulary. `inlineImages` is now always empty.
- `readProvenanceFacts` — now reads `compiler.refusalGuard` / `.refusalReason` /
  `.shipped` INDEPENDENTLY of the fallback block. Without that, a refused compile
  (which no longer hands off to an LLM) rendered as a clean compiler ship.
- Two real bugs found and fixed mid-run: (a) the `failed` branch was unreachable
  behind the `shipped` branch; (b) link rows took the section accent, so a FAILED
  order rendered its working Figma link in failure red.
- `darkMode: undefined` no longer renders "Light only" — the row is omitted.
- Logo geometry read off the real GIF headers (600x120 and 500x500), not guessed.
- `order-confirmation.test.mjs` — 164 → **251 passed, 0 failed**.
- `order-confirmation.witness.mjs` — variant 2 reworded to a COMPILER FAILURE;
  added the narrow (375px) render, the before/after byte witness, the logo /
  colour-law / encoded-size witnesses. **28 held, 0 broke**, exit 0.
- Deleted the three stale `TEST27-1907-llm-fallback.*` artifacts.
- `npm run check` OK. All 9 other suites pass. `/approve` and `server.js`
  untouched. `figma-parser.js` NOT staged.
- Wrote `EMAIL_REDESIGN_COMPLETE.md`.

Bytes: rendered HTML **34,497 → 22,299** (−35.4%). Encoded worst case 30,452 of
Gmail's 102,400 → 70.3% headroom.

**ATTEMPT-1 — DONE.** One commit, revertable with `git revert --no-edit HEAD`.
