// figma-credential.test.mjs
// ---------------------------------------------------------------------------
// THE LEAK GATE + THE RESOLVER'S FALLBACK LADDER.
//
// ★ NO REAL CREDENTIAL APPEARS IN THIS FILE. Every token-shaped string below is
// a synthetic literal that says so in its own characters. The gate is exercised
// against fakes; it detects by SHAPE, so a fake proves it exactly as well as a
// real one would, and a real one would then live in a tracked test fixture
// forever.
//
// ★ NO NETWORK, NO SUPABASE, NO CREDENTIALS NEEDED. The resolver is driven with
// a stub `db`, so this runs anywhere:
//     cd /c/Users/shrujal_mavlers/Desktop/maveloper-backend && node figma-credential.test.mjs
//
// ★ WHY SECTION 1 IS THE POINT OF THE WHOLE FILE.
// bridge-server.mjs:270 is:
//       console.log(`[bridge] Spawning: node ${runnerArgs.join(" ")}`);
// It prints every cc-runner flag verbatim into Cloud Run logs. Run 3 will carry
// the per-space token to cc-runner as SPAWN ENV, never as a flag, because:
//   (a) argv is world-readable to any other process on the box (`ps`, Task
//       Manager) — the token leaks even with logging switched off; and
//   (b) that log line would write a CLIENT'S Figma credential into logs Mavlers
//       retains, which is precisely the custody problem this design exists to
//       remove.
// bridge-server.mjs:273 spawns a FRESH process per job with NO env option, so a
// per-job env IS a per-order token by construction and zero frozen bytes change.
//
// A GATE NOBODY HAS SEEN GO RED IS NOT A GATE. Section 1 therefore runs the
// FAILS-FIRST PROOF as a first-class assertion: it feeds the gate a token-shaped
// string in argv and FAILS THE SUITE IF THE GATE STAYS GREEN.
// ---------------------------------------------------------------------------
import {
  resolveFigmaToken,
  validatePastedToken,
  looksLikeFigmaToken,
  redactTokens,
  findTokenLeaks,
  assertNoTokenLeak,
  describeResolution,
  scrubToken,
  normalisedOrgId,
  credentialProvenanceLine,
} from "./figma-credential.js";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(t) { console.log(`\n${t}`); }

// Synthetic, self-describing, never valid at Figma.
const FAKE_ORG_TOKEN    = "figd_THIS_IS_NOT_A_REAL_TOKEN_org_0000000000000";
const FAKE_GLOBAL_TOKEN = "figd_THIS_IS_NOT_A_REAL_TOKEN_global_00000000000";
const FAKE_OAUTH_TOKEN  = "figu_THIS_IS_NOT_A_REAL_TOKEN_oauth_000000000000";

const ORG = "11111111-2222-3333-4444-555555555555";

// A stub Supabase client shaped like the one call the resolver makes.
function stubDb(row, { error = null, thrower = false } = {}) {
  return {
    from() {
      if (thrower) throw new Error("simulated client explosion");
      const q = {
        select() { return q; },
        eq() { return q; },
        async maybeSingle() { return { data: row, error }; },
      };
      return q;
    },
  };
}

// ===========================================================================
section("1. THE LEAK GATE — FAILS-FIRST PROOF");
// ===========================================================================

// 1a. THE PROOF. Build the argv that run 3 MUST NOT build: the token as a flag,
//     plus the exact log line bridge-server.mjs:270 would emit from it.
{
  const badArgs = [
    "cc-runner.mjs",
    "--job-id", "job_1785165822134_33b25015",
    "--figma-file-key", "abc123",
    "--figma-token", FAKE_ORG_TOKEN,          // <-- the defect
  ];
  const badLog = `[bridge] Spawning: node ${badArgs.join(" ")}`;

  const shapeOnly = findTokenLeaks({ argv: badArgs, logs: [badLog] });
  ok("1a  gate goes RED on a token in argv (fails-first)",
     shapeOnly.ok === false && shapeOnly.leaks.length >= 1,
     `expected leaks, got ok=${shapeOnly.ok} leaks=${shapeOnly.leaks.length}`);

  ok("1a  RED names argv AND the spawn log line, separately",
     shapeOnly.leaks.some(l => l.where.startsWith("$.argv")) &&
     shapeOnly.leaks.some(l => l.where.startsWith("$.logs")),
     shapeOnly.leaks.map(l => l.where).join(", "));

  ok("1a  assertNoTokenLeak THROWS on that argv",
     (() => { try { assertNoTokenLeak({ argv: badArgs }); return false; } catch { return true; } })());

  // A gate that prints the secret in order to report the secret is the same bug.
  const report = (() => { try { assertNoTokenLeak({ argv: badArgs, logs: [badLog] }); return ""; } catch (e) { return e.message; } })();
  ok("1a  the gate's OWN failure message does not contain the token",
     report.length > 0 && !report.includes(FAKE_ORG_TOKEN));
}

// 1b. THE GREEN CASE. The run-3 shape: token in spawn ENV, absent from argv and
//     from the log line. The gate must pass on argv+logs while the token is
//     demonstrably still being carried.
{
  const goodArgs = [
    "cc-runner.mjs",
    "--job-id", "job_1785165822134_33b25015",
    "--figma-file-key", "abc123",
  ];
  const goodLog = `[bridge] Spawning: node ${goodArgs.join(" ")}`;
  const spawnEnv = { ...process.env, FIGMA_TOKEN: FAKE_ORG_TOKEN };

  const r = findTokenLeaks({ argv: goodArgs, logs: [goodLog] }, { secrets: [FAKE_ORG_TOKEN] });
  ok("1b  gate is GREEN when the token rides in spawn env, not argv", r.ok === true,
     r.leaks.map(l => l.where).join(", "));

  // NOT VACUOUS: prove the token really is present in the env being handed over,
  // so the green above is "carried safely", not "not carried at all".
  ok("1b  and the env being handed to spawn DOES carry it (green is not vacuous)",
     spawnEnv.FIGMA_TOKEN === FAKE_ORG_TOKEN);
  ok("1b  pointing the same gate AT the env goes RED — env is a secret channel, not a safe one",
     findTokenLeaks({ env: spawnEnv }).ok === false);
}

// 1c. THE EXACT DETECTOR. A secret whose shape the regex does not anticipate
//     must still be caught when the caller hands over the known value.
{
  const oddball = "sk-not-figma-shaped-but-still-a-secret-999";
  const shape = findTokenLeaks({ argv: ["--tok", oddball] });
  ok("1c  shape detector alone MISSES a non-figd_ secret", shape.ok === true);
  const exact = findTokenLeaks({ argv: ["--tok", oddball] }, { secrets: [oddball] });
  ok("1c  exact detector catches it when the value is supplied",
     exact.ok === false && exact.leaks[0].detector === "exact");
  ok("1c  exact-detector sample is redacted",
     exact.leaks[0].sample.includes("[REDACTED]") && !exact.leaks[0].sample.includes(oddball));
}

// 1d. Nesting + other carriers. A token hidden in a nested error/response body
//     must be found, not just a flat array.
{
  const nested = { res: { body: { debug: { cmd: `node cc.mjs --t ${FAKE_ORG_TOKEN}` } } } };
  const r = findTokenLeaks(nested);
  ok("1d  finds a token nested inside a response body", r.ok === false);
  ok("1d  reports the full path to it", r.leaks[0].where === "$.res.body.debug.cmd", r.leaks[0].where);
  ok("1d  OAuth-shaped (figu_) is also treated as a secret", findTokenLeaks({ a: FAKE_OAUTH_TOKEN }).ok === false);
  ok("1d  clean structures stay green", findTokenLeaks({ argv: ["--job-id", "job_1"], logs: ["[bridge] ok"] }).ok === true);
}

// 1e. redactTokens is what a caller would wrap a log line in.
{
  const line = `[bridge] Spawning: node cc.mjs --figma-token ${FAKE_ORG_TOKEN} --job-id j1`;
  const red = redactTokens(line);
  ok("1e  redactTokens removes the value", !red.includes(FAKE_ORG_TOKEN));
  ok("1e  redactTokens keeps the rest of the line readable", red.includes("--job-id j1") && red.includes("figd_[REDACTED]"));
  ok("1e  a redacted line passes the gate", findTokenLeaks({ logs: [red] }).ok === true);
}

// ===========================================================================
section("2. SHAPE VALIDATION");
// ===========================================================================
{
  ok("2  accepts a figd_ personal/plan token", validatePastedToken(FAKE_ORG_TOKEN).ok === true);
  ok("2  rejects empty", validatePastedToken("").ok === false);
  ok("2  rejects a wrong prefix", validatePastedToken("ghp_1234567890abcdef").ok === false);
  ok("2  rejects an OAuth figu_ token as a PASTED credential", validatePastedToken(FAKE_OAUTH_TOKEN).ok === false);
  ok("2  rejects a truncated paste", validatePastedToken("figd_12").ok === false);
  ok("2  rejects a value with an embedded newline", validatePastedToken("figd_abcdefgh\nijkl").ok === false);

  // The BOM incident, re-run. A PowerShell-written value must not be read as a
  // bad credential — that misdiagnosis cost a full cycle once already.
  const bom = "﻿" + FAKE_ORG_TOKEN + "\r\n";
  ok("2  a BOM+CRLF paste is scrubbed, not rejected", validatePastedToken(bom).ok === true);
  ok("2  and scrubbing yields the exact token", scrubToken(bom) === FAKE_ORG_TOKEN);

  // The rejection message must not echo the rejected value back.
  const rej = validatePastedToken("ghp_SECRETSECRETSECRET").error;
  ok("2  a rejection message does not echo the rejected value", !rej.includes("SECRETSECRETSECRET"));

  ok("2  looksLikeFigmaToken is not fooled by the word figd_", looksLikeFigmaToken("figd_") === false);
  ok("2  looksLikeFigmaToken finds one mid-sentence", looksLikeFigmaToken(`prefix ${FAKE_ORG_TOKEN} suffix`) === true);
}

// ===========================================================================
section("3. THE RESOLVER'S FALLBACK LADDER");
// ===========================================================================
{
  const G = { globalToken: FAKE_GLOBAL_TOKEN };
  const future = new Date(Date.now() + 86400e3).toISOString();
  const past   = new Date(Date.now() - 86400e3).toISOString();
  const live   = { org_id: ORG, token: FAKE_ORG_TOKEN, label: "Acme design account", token_kind: "plan", expires_at: future, is_active: true };

  const t = async (name, orgId, opts, expectSource, expectReason) => {
    const r = await resolveFigmaToken(orgId, opts);
    ok(name, r.source === expectSource && r.reason === expectReason,
       `got source=${r.source} reason=${r.reason}`);
    return r;
  };

  const hit = await t("3  a live org credential WINS", ORG, { db: stubDb(live), ...G }, "org", "org-credential");
  ok("3  ...and returns that org token, not the global", hit.token === FAKE_ORG_TOKEN);
  ok("3  ...and surfaces label + expiry + kind for the console",
     hit.label === "Acme design account" && hit.expiresAt === future && hit.tokenKind === "plan");

  await t("3  no orgId            -> global", null, { db: stubDb(live), ...G }, "global", "no-org-id");
  await t("3  no db client        -> global", ORG, { ...G }, "global", "no-db-client");
  await t("3  no row for the org  -> global", ORG, { db: stubDb(null), ...G }, "global", "no-row-for-org");
  await t("3  is_active = false   -> global", ORG, { db: stubDb({ ...live, is_active: false }), ...G }, "global", "revoked");
  await t("3  malformed stored    -> global", ORG, { db: stubDb({ ...live, token: "not-a-token" }), ...G }, "global", "malformed");
  await t("3  missing table / RLS refusal -> global", ORG,
          { db: stubDb(null, { error: { code: "42P01", message: "relation does not exist" } }), ...G },
          "global", "lookup-failed:42P01");
  await t("3  client throws       -> global", ORG, { db: stubDb(null, { thrower: true }), ...G }, "global", "lookup-threw");

  // EXPIRY — the behaviour nothing in the product has today.
  const exp = await t("3  expired credential  -> global", ORG, { db: stubDb({ ...live, expires_at: past }), ...G }, "global", "expired");
  ok("3  ...and expired is REPORTED so a caller can say why, not just 403",
     exp.expired === true && exp.expiresAt === past && exp.label === "Acme design account");

  // NULL expiry is USABLE. Getting this backwards would break every pre-expiry
  // personal access token in existence.
  const noExp = await t("3  NULL expiry is usable, not expired", ORG, { db: stubDb({ ...live, expires_at: null }), ...G }, "org", "org-credential");
  ok("3  ...and reports expired=false with a null date", noExp.expired === false && noExp.expiresAt === null);

  // Boundary: expiry exactly now is expired (<=), not usable.
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const boundary = await resolveFigmaToken(ORG, { db: stubDb({ ...live, expires_at: "2026-01-01T00:00:00.000Z" }), now: nowMs, ...G });
  ok("3  expiry exactly at `now` counts as expired", boundary.reason === "expired");

  // Every global fallback must return the SAME value production uses today.
  for (const r of [await resolveFigmaToken(null, G), await resolveFigmaToken(ORG, { db: stubDb(null), ...G })]) {
    ok("3  every fallback returns the UNCHANGED global token", r.token === FAKE_GLOBAL_TOKEN);
  }

  // No global either -> 'none', and STILL no throw.
  const none = await resolveFigmaToken(ORG, { db: stubDb(null), globalToken: "" });
  ok("3  no org and no global -> source 'none', token null, NO THROW",
     none.source === "none" && none.token === null);
}

// ===========================================================================
section("4. THE RESOLVER ITSELF MUST NOT LEAK");
// ===========================================================================
{
  const live = { org_id: ORG, token: FAKE_ORG_TOKEN, label: "Acme", token_kind: "personal", expires_at: null, is_active: true };
  const r = await resolveFigmaToken(ORG, { db: stubDb(live), globalToken: FAKE_GLOBAL_TOKEN });

  // describeResolution is THE shape a caller should log. If it can leak, every
  // caller that logs an outcome leaks.
  const desc = describeResolution(r);
  ok("4  describeResolution() is log-safe",
     findTokenLeaks(desc, { secrets: [FAKE_ORG_TOKEN, FAKE_GLOBAL_TOKEN] }).ok === true);
  ok("4  ...and JSON.stringify of it is too (this is what log() does)",
     findTokenLeaks({ line: JSON.stringify(desc) }, { secrets: [FAKE_ORG_TOKEN] }).ok === true);
  ok("4  ...while still carrying the facts a caller needs",
     desc.resolved === true && desc.source === "org" && desc.label === "Acme");

  // NOT VACUOUS: the raw resolution DOES contain the token, so section 4's green
  // is describeResolution() doing work, not an empty object.
  ok("4  the RAW resolution does contain the token (proves 4 is not vacuous)",
     findTokenLeaks(r).ok === false);

  // A stored value that fails the shape check must never be RETURNED — it would
  // be sent to Figma and come back 403, reading exactly like an expired token.
  const junk = "PASTED-THE-WRONG-THING-ENTIRELY";
  const bad = await resolveFigmaToken(ORG, { db: stubDb({ ...live, token: junk }), globalToken: FAKE_GLOBAL_TOKEN });
  ok("4  a malformed stored token is never returned — the global is, instead",
     bad.token === FAKE_GLOBAL_TOKEN && bad.reason === "malformed");
  // Scanned for the JUNK value specifically. A whole-resolution shape scan would
  // fire on `token: <the global>`, which is SUPPOSED to be there — so that scan
  // would be measuring the wrong thing and passing for the wrong reason.
  ok("4  ...and the malformed value does not appear in the resolution at all",
     !JSON.stringify(bad).includes(junk));
  ok("4  ...nor in the log-safe description of it",
     !JSON.stringify(describeResolution(bad)).includes(junk));
}

// ===========================================================================
section("5. THE WIRING — ★ RUN 3 INVERTED THIS SECTION ON PURPOSE");
// ===========================================================================
// Runs 1 and 2 asserted NOTHING on the order path imported this module, because
// nothing did: the subsystem was built and deliberately left unmounted.
//
// ★ RUN 3 MOUNTS IT, SO THE OLD ASSERTION IS NOW EXACTLY BACKWARDS. Leaving it
// as written would have forced the choice between a red suite and quietly
// deleting the check, and "delete the gate that went red" is how a codebase
// loses its instruments one at a time. The invariant is therefore RESTATED as
// its mirror image and still fails loudly if the wiring is ever ripped out:
// server.js and queue-runner.js MUST now reference the subsystem, BY NAME.
{
  const { readFileSync: _rf } = await import("node:fs");
  const _here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  for (const f of ["server.js", "queue-runner.js"]) {
    let src = "";
    try { src = _rf(_here + f, "utf8"); } catch { /* handled below */ }
    ok(`5  ${f} IS wired to the credential subsystem (run 3)`,
       src !== "" && /figma-credential/.test(src),
       src === "" ? `${f} could not be read — the check is vacuous` : "the wiring is GONE; orders are back on the Mavlers token");
  }
}

// ===========================================================================
section("5b. THE OLD NO-OP CHECK, KEPT FOR THE FILES THAT ARE STILL UNMOUNTED");
// ===========================================================================
{
  // A structural check, not a promise: if any shipped file imports this module,
  // this run is no longer a no-op and this test says so.
  const { readdirSync, readFileSync } = await import("node:fs");
  const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  // ── AMENDED BY RUN 2, AND THE AMENDMENT NARROWS THE EXCLUSION RATHER THAN
  // WIDENING IT. ────────────────────────────────────────────────────────────
  // As written in run 1 this excluded exactly two filenames, because exactly two
  // existed. Run 2 added figma-credential-crypto.js and
  // figma-credential-routes.js, which import the resolver BY DESIGN — they are
  // the credential subsystem, not consumers of it — and this check went red on
  // its own siblings.
  //
  // ★ THE INVARIANT WAS NEVER "no file imports this". It was "NOTHING ON THE
  // ORDER PATH REACHES THIS", and the filename list was a proxy for that which
  // stopped being accurate the moment the subsystem had more than one file.
  // Weakening the proxy silently would be the wrong repair, so the exclusion is
  // stated as a PREFIX and the thing it lets through is then asserted directly
  // below — the excluded family is itself proven unmounted, by name.
  // ★ RUN 3 ADDS TWO NAMES TO THE EXCLUSION, AND PAYS FOR BOTH IN §5 ABOVE.
  // server.js and queue-runner.js are now wired BY DESIGN. They are excluded
  // here and then asserted PRESENT by name in §5, so the exclusion cannot hide
  // a missing wiring - it is the same pay-for-your-exclusion discipline run 2
  // used for the figma-credential* prefix.
  const WIRED_BY_DESIGN = new Set(["server.js", "queue-runner.js"]);
  const files = readdirSync(here).filter(f =>
    (f.endsWith(".js") || f.endsWith(".mjs")) && !f.startsWith("figma-credential") && !WIRED_BY_DESIGN.has(f));
  const importers = files.filter(f => {
    try { return /figma-credential/.test(readFileSync(here + f, "utf8")); } catch { return false; }
  });
  ok(`5b no OTHER shipped file imports figma-credential (scanned ${files.length})`,
     importers.length === 0, importers.join(", "));

  // ★ AND THE EXCLUSION IS PAID FOR HERE. These are the three files that would
  // have to change for a credential to reach generation — run 1 §5 named all
  // three. Checking them BY NAME means the prefix exclusion above cannot hide a
  // wiring: a `figma-credential-anything.js` that server.js imported would still
  // fail this.
  for (const f of ["figma-parser.js"]) {
    let src = "";
    try { src = readFileSync(here + f, "utf8"); } catch { /* absent is fine */ }
    ok(`5b ${f} does not reference the credential subsystem`,
       src !== "" && !/figma-credential/.test(src),
       src === "" ? `${f} could not be read — the check is vacuous` : "it now imports it");
  }
}

// ===========================================================================
section("8. ★★ THE UNSEAL GATE — THE ONE THAT CANNOT PASS IF THE SILENT");
section("   FALLBACK REGRESSES");
// ===========================================================================
// ★ THE FAILURE MODE THIS EXISTS FOR HAS NO SYMPTOM.
// Run 2 seals the stored token. If resolveFigmaToken forgets to unseal it, the
// sealed value fails the `figd_` shape check, the resolver returns reason
// `malformed`, and the order FALLS BACK TO THE GLOBAL MAVLERS TOKEN. There is no
// error, no warning, no 403 and no visible difference. It looks like it works
// while every client order reads from the wrong Figma account.
//
// So this section does not test a message or a flag. It performs the ROUND TRIP
// and asserts the resolved token is BYTE-IDENTICAL to the one that was sealed.
{
  const { sealToken, readKey, isSealed } = await import("./figma-credential-crypto.js");
  const { writeFileSync, unlinkSync, readFileSync: rfs } = await import("node:fs");

  // A synthetic 32-byte key. Deterministic so a failure is reproducible; it is
  // not a secret and it opens nothing but the fixture sealed three lines below.
  const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
  const keyRead = readKey(KEY_B64);
  ok("8  the test's own sealing key reads as 32 bytes (not a vacuous setup)", keyRead.ok);

  const sealed = sealToken(FAKE_ORG_TOKEN, keyRead.key);
  ok("8  the fixture actually sealed (not a vacuous setup)", sealed.ok && isSealed(sealed.sealed));
  ok("8  ...and the sealed form does NOT contain the plaintext token",
     sealed.ok && !sealed.sealed.includes(FAKE_ORG_TOKEN));
  ok("8  ...and the sealed form would FAIL the figd_ shape check on its own",
     sealed.ok && validatePastedToken(sealed.sealed).ok === false);

  const sealedRow = {
    org_id: ORG, token: sealed.sealed, label: "Acme design account",
    token_kind: "personal", expires_at: null, is_active: true,
  };

  // ───────────────────────────────────────────────────────────────────────
  // 8a. THE ASSERTION THAT MATTERS.
  // ───────────────────────────────────────────────────────────────────────
  const r = await resolveFigmaToken(ORG, {
    db: stubDb(sealedRow), globalToken: FAKE_GLOBAL_TOKEN, key: keyRead.key,
  });
  ok("8a ★ a SEALED row resolves to source 'org', NOT the global fallback",
     r.source === "org" && r.reason === "org-credential", `got source=${r.source} reason=${r.reason}`);
  ok("8a ★ THE ROUND TRIP: resolved token === the token that was sealed",
     r.token === FAKE_ORG_TOKEN, `got ${r.token === FAKE_GLOBAL_TOKEN ? "THE GLOBAL TOKEN (silent fallback!)" : String(r.token).slice(0, 12) + "..."}`);
  ok("8a ...and the resolution is marked wasSealed, so provenance can say so",
     r.wasSealed === true);

  // The key read from the ENVIRONMENT, not passed in — the shape production uses.
  {
    const prev = process.env.FIGMA_CRED_KEY;
    process.env.FIGMA_CRED_KEY = KEY_B64;
    const viaEnv = await resolveFigmaToken(ORG, { db: stubDb(sealedRow), globalToken: FAKE_GLOBAL_TOKEN });
    if (prev === undefined) delete process.env.FIGMA_CRED_KEY; else process.env.FIGMA_CRED_KEY = prev;
    ok("8a ...and it round-trips with the key read from FIGMA_CRED_KEY in env",
       viaEnv.source === "org" && viaEnv.token === FAKE_ORG_TOKEN);
  }

  // 8b. The degradations are NAMED and still fall back safely.
  const wrongKey = readKey(Buffer.alloc(32, 9).toString("base64"));
  const bad = await resolveFigmaToken(ORG, { db: stubDb(sealedRow), globalToken: FAKE_GLOBAL_TOKEN, key: wrongKey.key });
  ok("8b wrong key -> reason 'unopenable', global token, NO THROW",
     bad.reason === "unopenable" && bad.token === FAKE_GLOBAL_TOKEN, `got ${bad.reason}`);

  const noKey = await resolveFigmaToken(ORG, {
    db: stubDb(sealedRow), globalToken: FAKE_GLOBAL_TOKEN, env: {},
  });
  ok("8b sealed row + NO key -> its OWN reason 'no-seal-key', not 'malformed'",
     noKey.reason === "no-seal-key" && noKey.token === FAKE_GLOBAL_TOKEN, `got ${noKey.reason}`);

  // 8c. A PLAINTEXT row still works. The migration-ordering guarantee.
  const plain = await resolveFigmaToken(ORG, {
    db: stubDb({ ...sealedRow, token: FAKE_ORG_TOKEN }), globalToken: FAKE_GLOBAL_TOKEN, key: keyRead.key,
  });
  ok("8c a PLAINTEXT row (written before sealing existed) still resolves",
     plain.source === "org" && plain.token === FAKE_ORG_TOKEN);
  ok("8c ...and is reported wasSealed=false so the two are distinguishable",
     plain.wasSealed === false);

  // ───────────────────────────────────────────────────────────────────────
  // 8d. ★★ FAILS-FIRST, AGAINST THE REAL SHIPPING SOURCE.
  // ───────────────────────────────────────────────────────────────────────
  // NOT a re-implementation of the old resolver - that would prove only that a
  // copy I wrote behaves as I expected. This reads figma-credential.js off disk,
  // DELETES THE UNSEALING STEP from the text, loads the mutant as a module, and
  // asserts it exhibits the silent fallback. If the mutant still round-trips,
  // the unseal is not what makes 8a pass and this whole section is decorative.
  const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const SRC = HERE + "figma-credential.js";
  const MUT = HERE + "figma-credential.UNSEAL-MUTANT.tmp.mjs";
  const original = rfs(SRC, "utf8");

  // Replace the unseal with run 1's behaviour: hand the RAW ROW straight on.
  const mutated = original.replace(
    /const opened = openToken\(row\.token, sealingKey\);/,
    "const opened = { ok: true, token: row.token, wasSealed: false }; // MUTANT: unseal removed"
  );
  ok("8d the mutation actually applied (NOT a silent no-match)", mutated !== original);

  try {
    writeFileSync(MUT, mutated, "utf8");
    const mod = await import(new URL("file:///" + MUT.replace(/\\/g, "/")).href);
    const mr = await mod.resolveFigmaToken(ORG, {
      db: stubDb(sealedRow), globalToken: FAKE_GLOBAL_TOKEN, key: keyRead.key,
    });
    ok("8d ★ RED CONFIRMED: with the unseal removed, a valid sealed credential",
       mr.token === FAKE_GLOBAL_TOKEN && mr.source === "global",
       `expected the SILENT GLOBAL FALLBACK, got source=${mr.source} token=${mr.token === FAKE_ORG_TOKEN ? "the org token (gate is decorative!)" : "?"}`);
    ok("8d ★ ...and it reported reason 'malformed' - INDISTINGUISHABLE, to any",
       mr.reason === "malformed", `got ${mr.reason}`);
    console.log("       ^ that is the failure mode: a real credential, silently unused,");
    console.log("         reported as 'malformed', with the order still succeeding.");
  } finally {
    try { unlinkSync(MUT); } catch { /* best effort */ }
  }
  ok("8d the mutant module was removed from disk", (() => {
    try { rfs(MUT, "utf8"); return false; } catch { return true; }
  })());
}

// ===========================================================================
section("9. ★ THE NULL org_id CASE — THE `String(r.org_id ?? 'null')` TRAP");
// ===========================================================================
// Historical os_queue rows have a null user_id already, and org_id is no
// different. The per-space LOCK bug was this exact shape: an id stringified
// upstream turned every key into the literal text "null", the lock silently
// never matched, and four theories were checked and all four were wrong before
// anyone read the select list.
//
// THE REQUIREMENT IS TWOFOLD: fall back to the GLOBAL token, AND DO NOT THROW.
{
  const G = { globalToken: FAKE_GLOBAL_TOKEN };
  const live = { org_id: ORG, token: FAKE_ORG_TOKEN, label: "Acme", token_kind: "personal", expires_at: null, is_active: true };

  // Every shape a null org id can arrive in, including the three that are
  // TRUTHY STRINGS and would otherwise sail past a plain `if (!orgId)`.
  const NULLISH = [
    ["null",              null],
    ["undefined",         undefined],
    ["empty string",      ""],
    ["whitespace only",   "   "],
    ['★ the literal string "null"',      "null"],
    ['★ the literal string "undefined"', "undefined"],
    ['★ the literal string "NaN"',       "NaN"],
    ["NaN",               NaN],
  ];

  for (const [name, value] of NULLISH) {
    let r = null, threw = null;
    try {
      r = await resolveFigmaToken(value, { db: stubDb(live), ...G });
    } catch (e) { threw = e; }
    ok(`9  org_id = ${name} DOES NOT THROW`, threw === null, threw ? threw.message : "");
    ok(`9  org_id = ${name} -> the GLOBAL token`,
       r != null && r.token === FAKE_GLOBAL_TOKEN && r.source === "global",
       r ? `got source=${r.source} reason=${r.reason}` : "threw");
    ok(`9  org_id = ${name} -> reason 'no-org-id' (never a DB round trip)`,
       r != null && r.reason === "no-org-id", r ? `got ${r.reason}` : "threw");
    ok(`9  org_id = ${name} -> normalised to null, never echoed as "null"`,
       r != null && r.orgId === null, r ? `got orgId=${JSON.stringify(r.orgId)}` : "threw");
  }

  // ★ THE CONTROL. If the normaliser were over-eager and nulled a REAL id, every
  // assertion above would still pass and the feature would be dead on arrival.
  const real = await resolveFigmaToken(ORG, { db: stubDb(live), ...G });
  ok("9  CONTROL: a real org id is NOT normalised away (else §9 is vacuous)",
     real.source === "org" && real.token === FAKE_ORG_TOKEN && real.orgId === ORG);
  const numeric = await resolveFigmaToken(4242, { db: stubDb(live), ...G });
  ok("9  CONTROL: a NUMERIC org id survives too", numeric.source === "org" && numeric.orgId === 4242);
}

// ===========================================================================
section("10. THE PROVENANCE LINE — READABLE, AND INCAPABLE OF CARRYING A TOKEN");
// ===========================================================================
{
  const { credentialProvenanceLine } = await import("./figma-credential.js");
  const org = await resolveFigmaToken(ORG, {
    db: stubDb({ org_id: ORG, token: FAKE_ORG_TOKEN, label: "Acme design account", token_kind: "personal", expires_at: null, is_active: true }),
    globalToken: FAKE_GLOBAL_TOKEN,
  });
  const glob = await resolveFigmaToken(null, { globalToken: FAKE_GLOBAL_TOKEN });

  const lineOrg = credentialProvenanceLine(org);
  const lineGlob = credentialProvenanceLine(glob);
  console.log(`       org    -> ${lineOrg}`);
  console.log(`       global -> ${lineGlob}`);

  ok("10 the org line names the space's own token and its label",
     /this space's own token/.test(lineOrg) && lineOrg.includes("Acme design account"));
  ok("10 the global line says GLOBAL and gives the reason",
     /global Mavlers token/.test(lineGlob) && lineGlob.includes("no-org-id"));
  ok("10 the two lines are DISTINGUISHABLE (an instrument that discriminates)",
     lineOrg !== lineGlob);

  // ★ NO TOKEN, BY CONSTRUCTION AND BY SCAN.
  for (const [n, l] of [["org", lineOrg], ["global", lineGlob]]) {
    ok(`10 the ${n} provenance line carries NO token`,
       findTokenLeaks(l, { secrets: [FAKE_ORG_TOKEN, FAKE_GLOBAL_TOKEN] }).ok);
  }
  // ★ osVoice HOUSE RULE: it lands in user-facing progress_message text.
  for (const [n, l] of [["org", lineOrg], ["global", lineGlob]]) {
    ok(`10 the ${n} line has NO EM DASH (osVoice house rule)`, !l.includes("—"), l);
    // eslint-disable-next-line no-control-regex
    ok(`10 the ${n} line is pure ASCII (survives a PS 5.1 / Windows-1252 hop)`,
       /^[\x20-\x7E]*$/.test(l), l);
  }
}

// ===========================================================================
section("11. ★★ THE log() EXTRAS — THE MOST LIKELY LEAK POINT, MEASURED");
// ===========================================================================
// server.js:4365 is:
//     const log = (level, msg, extra = {}) =>
//       console.log(JSON.stringify({ level, msg, ts: ..., ...extra }));
// It JSON-stringifies WHATEVER IT IS GIVEN WITH NO REDACTION. Run 3 adds log
// calls on the credential path, so the question "could one of them serialise a
// token" has to be answered by measurement, not by reading the call sites and
// feeling reassured.
//
// ★ TWO INDEPENDENT ANSWERS, because either alone is weak:
//   A. RUNTIME - drive log()'s exact serialisation with a REAL resolution that
//      holds a REAL (synthetic) token, and scan the bytes it emits.
//   B. SOURCE  - scan every log() call in server.js that mentions the
//      credential, and require that none of them passes a raw token expression.
// And a NOT-BLIND CONTROL on each, because a scanner that cannot find a needle
// it was handed is not evidence of absence.
{
  // log()'s body, reproduced exactly. server.js cannot be imported - it binds a
  // port and starts the queue runner on import - so the two lines are mirrored
  // here and the SOURCE check below pins them to the real file.
  const logLine = (level, msg, extra = {}) =>
    JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra });

  const live = {
    org_id: ORG, token: FAKE_ORG_TOKEN, label: "Acme design account",
    token_kind: "plan", expires_at: null, is_active: true,
  };
  const resolved = await resolveFigmaToken(ORG, { db: stubDb(live), globalToken: FAKE_GLOBAL_TOKEN });
  ok("11 the resolution under test really holds the token (setup not vacuous)",
     resolved.token === FAKE_ORG_TOKEN);

  // ── A. RUNTIME ───────────────────────────────────────────────────────
  // This is the EXACT shape server.js now logs on the credential path.
  const emitted = logLine("info", "Figma credential resolved", {
    requestId: "req_test", ...describeResolution(resolved),
  });
  console.log(`       emitted: ${emitted}`);
  ok("11A the emitted log line contains NO token (shape + exact-needle scan)",
     findTokenLeaks(emitted, { secrets: [FAKE_ORG_TOKEN, FAKE_GLOBAL_TOKEN] }).ok, emitted);
  ok("11A ...and it still carries the facts worth logging",
     /"source":"org"/.test(emitted) && /"resolved":true/.test(emitted));

  // ★ NOT-BLIND CONTROL. Hand the SAME scanner the SAME line with the raw
  // resolution spread in, which is the mistake being guarded against.
  const careless = logLine("info", "Figma credential resolved", { requestId: "req_test", ...resolved });
  const caught = findTokenLeaks(careless, { secrets: [FAKE_ORG_TOKEN] });
  ok("11A ★ CONTROL: the scanner CATCHES the careless `...resolved` spread (not blind)",
     caught.ok === false && caught.leaks.length >= 1);
  ok("11A ★ CONTROL: and the leak report itself is REDACTED, not a second leak",
     caught.leaks.every(l => !String(l.sample).includes(FAKE_ORG_TOKEN)));

  // ── B. SOURCE ────────────────────────────────────────────────────────
  const { readFileSync: rf2 } = await import("node:fs");
  const H2 = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  let sv = "";
  try { sv = rf2(H2 + "server.js", "utf8"); } catch { /* reported below */ }
  ok("11B server.js was read (else every check below is vacuous)", sv.length > 1000);

  const svLines = sv.split(/\r?\n/);
  // Every log() call mentioning the credential, and every line that could put a
  // raw token into an extras object.
  const suspicious = svLines
    .map((l, i) => ({ n: i + 1, t: l.trim() }))
    .filter(s =>
      // a raw token expression appearing inside an object literal / log extras
      /(^|[^A-Za-z])(figmaToken|figmaCred\.token|\.\.\.figmaCred)\b/.test(s.t) &&
      /log\(|console\.(log|warn|error)/.test(s.t));
  ok("11B NO log()/console call in server.js references a raw token expression",
     suspicious.length === 0, suspicious.map(s => `:${s.n} ${s.t}`).join(" | "));

  // The credential log call must pass describeResolution, whose `token` is a
  // boolean by construction - not the resolution object.
  const credLog = svLines.findIndex(l => /"Figma credential resolved"/.test(l));
  ok("11B the credential log call exists in server.js (premise is real)", credLog >= 0);
  const credLogBlock = svLines.slice(credLog, credLog + 5).join("\n");
  ok("11B ...and it logs describeResolution(figmaCred), never figmaCred itself",
     /describeResolution\(figmaCred\)/.test(credLogBlock) && !/\.\.\.figmaCred\b(?!\))/.test(credLogBlock),
     credLogBlock.replace(/\s+/g, " ").slice(0, 160));

  // ★ NOT-BLIND CONTROL for the source scan.
  const plantedSrc = sv.replace(
    /log\("info", "Figma credential resolved", \{/,
    'log("info", "Figma credential resolved", { leaked: figmaToken,'
  );
  ok("11B ★ CONTROL: the needle was actually planted in the source copy", plantedSrc !== sv);
  const plantedHits = plantedSrc.split(/\r?\n/).map(l => l.trim())
    .filter(t => /(^|[^A-Za-z])(figmaToken|figmaCred\.token|\.\.\.figmaCred)\b/.test(t)
                 && /log\(|console\.(log|warn|error)/.test(t));
  ok("11B ★ CONTROL: the source scanner FINDS the planted raw-token extra (not blind)",
     plantedHits.length === 1, `found ${plantedHits.length}`);

  // ── C. THE RESPONSE BODY. It crosses a network boundary to the console. ──
  const body = {
    figmaCredential: credentialProvenanceLine(resolved),
    figmaCredentialDetail: describeResolution(resolved),
  };
  ok("11C the provenance fields on the response body carry NO token",
     findTokenLeaks(body, { secrets: [FAKE_ORG_TOKEN, FAKE_GLOBAL_TOKEN] }).ok,
     JSON.stringify(body));

  // ── D. THE progress_message. It is stored, and it is USER-FACING. ────────
  const progressMsg = `Generation complete in 412s | ${credentialProvenanceLine(resolved)}`;
  console.log(`       progress_message: ${progressMsg}`);
  ok("11D the durable progress_message carries NO token",
     findTokenLeaks(progressMsg, { secrets: [FAKE_ORG_TOKEN, FAKE_GLOBAL_TOKEN] }).ok);
  ok("11D ...and it names which account was used, readably",
     /this space's own token/.test(progressMsg) && progressMsg.includes("Acme design account"));
}

console.log(`\n${"=".repeat(64)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) { console.log("FAILURES:"); failures.forEach(f => console.log("  - " + f)); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
