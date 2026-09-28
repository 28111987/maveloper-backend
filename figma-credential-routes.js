/**
 * figma-credential-routes.js — HOW A CLIENT PUTS THEIR OWN FIGMA TOKEN IN.
 * =============================================================================
 *
 * ★★ THE POINT OF THIS FILE, IN ONE SENTENCE: THE CLIENT PASTES THEIR OWN TOKEN
 * AND THE OWNER NEVER HOLDS IT AND NEVER SEES IT.
 *
 * That is not a promise this module makes and then keeps by being careful. It is
 * a property of the API SHAPE, and there are four separate structures below that
 * each enforce it independently, because a single guard is a single thing to
 * forget:
 *
 *   1. `PUBLIC_COLUMNS` — every SELECT on this table names its columns and
 *      `token` is not among them. There is no `select('*')` in this file, and a
 *      test asserts that textually.
 *   2. `publicShape()` — the ONLY value any route returns. It is built field by
 *      field from a fixed list; it cannot pass through a column that arrives
 *      from the database, so a column added later is invisible here by default
 *      rather than exposed by default.
 *   3. `sendSafe()` — every response in this file goes through it, and it runs
 *      the SERIALISED body through run 1's leak gate before it is written to the
 *      socket. If a token ever reaches a response body, the client gets a 500
 *      and Railway gets a loud log line. The leak is converted into an outage,
 *      which is the correct trade for a secret.
 *   4. THE DATABASE HAS NO POLICY. RLS is on with zero policies, so the browser
 *      cannot read the column even if every line above were deleted.
 *
 * The owner is not a special case anywhere in that list. There is no
 * platform-owner override, no support route, no "reveal" endpoint. An owner who
 * needs to know whether a client's credential works presses the same TEST button
 * the client does, and reads the same pass/fail.
 *
 * ─── ★★ WHY THE WRITE SEALS THE TOKEN BEFORE THE INSERT ─────────────────────
 * Run 1 flagged, and this run confirmed, that `log_statement` cannot be read
 * from this machine. Under `log_statement = 'mod'` or `'all'`, Postgres logs an
 * INSERT's BOUND PARAMETER VALUES in full — `log_parameter_max_length` defaults
 * to -1 — so "we used a parameterised statement" does NOT make the write safe.
 * Parameterisation defeats SQL injection; it does not defeat statement logging.
 *
 * So the value bound into the INSERT is CIPHERTEXT (figma-credential-crypto.js),
 * and the setting becomes irrelevant. The route REFUSES TO WRITE with a 503 if
 * no sealing key is configured rather than falling back to plaintext: a fallback
 * that silently downgrades a security property is worse than an outage, because
 * an outage gets fixed.
 *
 * ─── THE SHAPE IS spaces.js's SHAPE ─────────────────────────────────────────
 * `createFigmaCredentialRoutes({ app, supabaseAdmin, requireAuth, log, env })`
 * mirrors `createSpacesRoutes` exactly, takes the same injected dependencies,
 * and keeps the service-role key server-side for the same reason.
 *
 * ★★ THIS FILE IS NOT MOUNTED. Nothing in server.js calls it. Generation is
 * untouched, no order path reads the credential, and the global FIGMA_API_TOKEN
 * remains in use. Mounting is one line and it is named at the foot of this file.
 */

import {
  validatePastedToken,
  findTokenLeaks,
  CREDENTIAL_TABLE,
} from "./figma-credential.js";
import { readKey, sealToken, openToken, lastFour, KEY_ENV } from "./figma-credential-crypto.js";
import { figmaAuthHeaders } from "./figma-auth-header.js";

/**
 * ★ THE EXPLICIT COLUMN LIST, AND IT IS THE ONLY ONE IN THIS FILE.
 *
 * Run 1's handoff named this as "the one leak this run's gate cannot catch for
 * you": a `select('*')` would pull `token` into a route handler's local scope,
 * and from there into a response body or a log line by one careless spread.
 *
 * It is a CONSTANT rather than a string typed at each call site so that there is
 * exactly one place to be wrong, and so the test can assert its contents rather
 * than assert a habit.
 */
export const PUBLIC_COLUMNS =
  "org_id,label,token_kind,expires_at,is_active,created_at,created_by,updated_at,last_used_at,token_last4,last_test_at,last_test_ok,last_test_note";

/** The same list, minus the columns run 2's companion SQL adds. */
const PUBLIC_COLUMNS_LEGACY =
  "org_id,label,token_kind,expires_at,is_active,created_at,created_by,updated_at,last_used_at";

/** Postgres: column does not exist. The companion migration has not been run. */
const PG_UNDEFINED_COLUMN = "42703";
/** Postgres: relation does not exist. Run 1's SQL has not been run. */
const PG_UNDEFINED_TABLE = "42P01";

/**
 * Figma's cheapest authenticated endpoint. Named as a constant so the cost
 * claim in the console and the call here cannot drift apart.
 */
export const FIGMA_TEST_ENDPOINT = "https://api.figma.com/v1/me";

/**
 * ★ HOW LONG A CLIENT MUST WAIT BETWEEN TESTS, AND WHY THERE IS A WAIT AT ALL.
 *
 * The test button spends the CLIENT'S OWN Figma rate-limit budget, not Mavlers'.
 * Figma meters the REST API per user, and a low-tier seat has a small allowance,
 * so a button that can be held down is a button that can exhaust a client's
 * month. Sixty seconds makes the control feel instant to a human who presses it
 * once and impossible to use as a loop.
 */
export const TEST_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// THE SHAPE THAT LEAVES
// ---------------------------------------------------------------------------

/**
 * ★★ THE ONLY VALUE ANY ROUTE IN THIS FILE RETURNS.
 *
 * Built field by field from a fixed list. It does NOT spread the row, and the
 * difference matters more than it looks: a spread returns whatever the database
 * hands over, so the day somebody adds a column, the API starts publishing it
 * and nothing says so. This function publishes what it was written to publish,
 * and a new column is invisible until a human adds a line here.
 *
 * `token` HAS NO LINE HERE AND NEVER WILL.
 */
export function publicShape(row, { now = Date.now() } = {}) {
  if (!row) return null;
  const expiresAt = row.expires_at ?? null;
  const expired = expiresAt != null && new Date(expiresAt).getTime() <= now;
  return {
    orgId: row.org_id ?? null,
    label: row.label ?? null,
    tokenKind: row.token_kind ?? null,
    // THE MASKED HINT. Four characters or nothing — never a padded placeholder,
    // which would read as data.
    hint: row.token_last4 ?? null,
    expiresAt,
    expired,
    isActive: row.is_active !== false,
    createdAt: row.created_at ?? null,
    createdBy: row.created_by ?? null,
    updatedAt: row.updated_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    lastTestAt: row.last_test_at ?? null,
    // THREE STATES, NOT TWO. null means never tested, and the console renders
    // that in those words rather than as a failure or as a pass.
    lastTestOk: row.last_test_ok ?? null,
    lastTestNote: row.last_test_note ?? null,
  };
}

/**
 * ★★ THE LAST GATE BEFORE THE SOCKET.
 *
 * Every response in this file goes through here, and here the SERIALISED body is
 * scanned by run 1's detector. If a token-shaped run is found the body is
 * DISCARDED and the caller gets a 500.
 *
 * ★ WHY A 500 AND NOT A REDACTION. Redacting would let the bug ship quietly
 * forever — the endpoint would keep working, the token would keep almost
 * leaking, and nobody would look. A 500 is a broken feature somebody fixes on
 * the first report. A secret is the one case where failing loudly beats
 * degrading gracefully.
 *
 * ★ AND THE FAILURE MESSAGE DOES NOT CONTAIN THE SECRET. A gate that prints the
 * value to prove the value leaked is the same defect it is reporting. The log
 * line carries the FIELD PATHS and the COUNT, never the match.
 */
export function sendSafe(res, status, body, log) {
  let serialised;
  try {
    serialised = JSON.stringify(body ?? {});
  } catch {
    serialised = "";
  }
  // ★ findTokenLeaks returns { ok, leaks } — NOT an array. Reading it as an
  // array makes `.length` undefined, `undefined > 0` false, and this whole gate
  // a no-op that reports green forever. It was written that way first and the
  // suite caught it; the destructure is the fix and §3e is the proof.
  const { ok, leaks } = findTokenLeaks([serialised]);
  if (!ok) {
    if (typeof log === "function") {
      log("error", "figma-credential: RESPONSE BLOCKED, token-shaped value in body", {
        status,
        leakCount: leaks.length,
        // The keys, so it is diagnosable. Not the values, ever.
        bodyKeys: body && typeof body === "object" ? Object.keys(body) : [],
      });
    }
    return res.status(500).json({
      error: "Response withheld",
      details:
        "A credential-shaped value was found in this response and it was blocked before it was sent. " +
        "This is a bug in the backend, not in your token. Nothing was disclosed.",
    });
  }
  return res.status(status).json(body);
}

// ---------------------------------------------------------------------------
// AUTHORISATION
// ---------------------------------------------------------------------------

/**
 * ★★ THE GATE, AND AN HONEST ACCOUNT OF WHAT WAS REUSED.
 *
 * The brief said: use the existing authorisation shape, do not invent a second
 * one. There are three in this product and I reused the one that answers this
 * question, having first established that the other two answer a DIFFERENT one:
 *
 *   `requireAuth` (server.js:396)     REUSED VERBATIM, injected, not copied. It
 *       establishes WHO IS CALLING via supabaseAdmin.auth.getUser. Every route
 *       below is mounted behind it.
 *
 *   `requirePlatformOwner` (spaces.js:41)     DELIBERATELY NOT USED, and run 1
 *       said why: it gates on the PLATFORM_OWNERS env list, so using it here
 *       would mean only Mavlers staff could install a credential — which makes
 *       the owner handle the client's token, the exact thing this design removes.
 *
 *   `isOsAdmin` (console src/lib/osAccess.ts:93)     ITS QUERY SHAPE IS REUSED,
 *       its SCOPE is not, and the difference is a real vulnerability:
 *       ★ isOsAdmin asks "does this person hold an owner seat ANYWHERE", because
 *       it only decides whether to render an Admin tab. Asked verbatim here it
 *       would let the owner of space A install a credential into space B. It is
 *       the right question for a tab and the wrong question for a tenant write.
 *       So the same query gains one filter — `.eq('org_id', org.id)` — and
 *       becomes "does this person hold an owner seat IN THIS SPACE".
 *
 * ★★ AND IT INHERITS ALL THREE OF THIS PROJECT'S AUTH BUGS AS RULES, because
 * each was a reading of a result rather than a wrong query:
 *
 *   maybeSingle() LOCKED THE OWNER OUT. It errors on more than one row, and one
 *     person may hold seats in several spaces. NOT USED on email_allowlist here.
 *     (It IS used on `orgs` by slug below — one row by a unique key is exactly
 *     the case maybeSingle is for. The bug was never maybeSingle; it was
 *     maybeSingle on a multi-row question.)
 *
 *   limit(1) RETURNS A TRUTHY EMPTY ARRAY and admitted every Google account for
 *     one deploy. So the read below is `.length > 0`, NEVER `!!data`, and there
 *     is a test that feeds it `[]` and asserts a 403.
 *
 *   isOsAdmin BROKE AT SIX SEATS by fetching one arbitrary row and inspecting
 *     its `is_owner`. So the FILTER carries the question — `.eq('is_owner',
 *     true)` — and PRESENCE is the answer. The result is identical at one seat
 *     or two hundred, which is the property the old read lacked.
 *
 * ★ EVERY UNCERTAINTY DENIES. A lookup error, an absent column, an absent table,
 * a missing email claim: all 403 or 503. This gate has no fail-open branch.
 */
export function createRequireSpaceAdmin({ supabaseAdmin, log }) {
  return async function requireSpaceAdmin(req, res, next) {
    const slug = String(req.params.slug || "").toLowerCase();
    const email = String(req.user?.email || "").toLowerCase().trim();

    if (!email) {
      return sendSafe(res, 403, {
        error: "Not permitted",
        details: "Your sign-in carries no email address, so no space seat can be matched to it.",
      }, log);
    }

    // The space. maybeSingle IS correct here: `slug` is unique on orgs, so the
    // question genuinely has at most one answer.
    let org = null;
    try {
      const { data, error } = await supabaseAdmin
        .from("orgs")
        .select("id,name,slug,is_deleted")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw new Error(error.message);
      org = data;
    } catch (err) {
      log("error", "figma-credential: space lookup failed", { slug, error: err.message });
      return sendSafe(res, 503, {
        error: "Could not check that space",
        details: "The space directory did not answer. Nothing was changed.",
      }, log);
    }

    if (!org) {
      return sendSafe(res, 404, { error: "No space with that name" }, log);
    }
    if (org.is_deleted) {
      // ABSENCE STATED AS ABSENCE — a closed space is not a permission error and
      // must not read as one.
      return sendSafe(res, 404, {
        error: "That space is closed",
        details: "A closed space cannot hold a Figma credential.",
      }, log);
    }

    // THE SEAT. The isOsAdmin query, scoped to THIS space.
    let seats = null;
    try {
      const { data, error } = await supabaseAdmin
        .from("email_allowlist")
        .select("email")
        .eq("email", email)
        .eq("org_id", org.id)      // ★ THE FILTER isOsAdmin DOES NOT HAVE.
        .eq("is_owner", true)      // ★ THE QUESTION IS IN THE FILTER, not in a read.
        .limit(1);
      if (error) {
        // 42703 = no is_owner column, i.e. the admin migration has not been run.
        // It is an operator fact, not a permission fact, and it says so.
        if (error.code === PG_UNDEFINED_COLUMN) {
          log("warn", "figma-credential: email_allowlist has no is_owner column", { slug });
          return sendSafe(res, 503, {
            error: "Space roles are not configured",
            details:
              "email_allowlist has no is_owner column, so no one can be identified as a space admin. " +
              "supabase/migrations/20260808_0001_order_close.sql has not been run.",
          }, log);
        }
        throw new Error(error.message);
      }
      seats = data;
    } catch (err) {
      log("error", "figma-credential: seat lookup failed", { slug, error: err.message });
      return sendSafe(res, 503, {
        error: "Could not check your access",
        details: "The seat directory did not answer. Nothing was changed.",
      }, log);
    }

    // ★ LENGTH, NOT TRUTHINESS. `[]` is truthy.
    if ((seats?.length ?? 0) === 0) {
      return sendSafe(res, 403, {
        error: "Only a space admin may manage this space's Figma credential",
        details:
          "You are signed in as " + email + " and you do not hold an admin seat in this space. " +
          "A Figma credential grants standing access to a Figma account, so it is the space's own " +
          "admin who installs it — not Mavlers, and not an admin of another space.",
      }, log);
    }

    req.space = { id: org.id, name: org.name, slug: org.slug };
    return next();
  };
}

// ---------------------------------------------------------------------------
// THE ROUTES
// ---------------------------------------------------------------------------

export function createFigmaCredentialRoutes({ app, supabaseAdmin, requireAuth, log, env = process.env, fetchImpl = null }) {
  const requireSpaceAdmin = createRequireSpaceAdmin({ supabaseAdmin, log });
  const doFetch = fetchImpl || globalThis.fetch;

  /**
   * Read the row with the new columns, falling back to the legacy list if the
   * companion migration has not been run.
   *
   * ★ DEGRADES RATHER THAN BREAKS — the shape AdminConsole's own header
   * describes. A human runs the migration and a robot runs the deploy, so they
   * will be out of order at least once, and the screen that tells the owner to
   * run the migration must not itself be the screen that 500s.
   */
  async function readRow(orgId) {
    let { data, error } = await supabaseAdmin
      .from(CREDENTIAL_TABLE)
      .select(PUBLIC_COLUMNS)
      .eq("org_id", orgId)
      .maybeSingle();

    if (error && error.code === PG_UNDEFINED_COLUMN) {
      ({ data, error } = await supabaseAdmin
        .from(CREDENTIAL_TABLE)
        .select(PUBLIC_COLUMNS_LEGACY)
        .eq("org_id", orgId)
        .maybeSingle());
      if (!error) return { row: data, error: null, degraded: true };
    }
    return { row: data ?? null, error: error ?? null, degraded: false };
  }

  function tableMissing(res) {
    return sendSafe(res, 503, {
      error: "The credential store does not exist yet",
      details:
        "org_figma_credentials has not been created. Run org_figma_credentials.sql and then " +
        "org_figma_credentials_run2.sql in the Supabase SQL editor. Until then, every order in " +
        "every space uses the Mavlers Figma token, which is what happens today.",
    }, log);
  }

  // =========================================================================
  // GET — THE METADATA. NEVER THE VALUE.
  // =========================================================================
  /**
   * ★ WHAT THIS RETURNS WHEN THERE IS NO CREDENTIAL, AND WHY IT IS NOT 404.
   *
   * It returns 200 with `credential: null` and a `fallback` sentence. A 404
   * would make "this space has no credential" indistinguishable from "this
   * endpoint does not exist" at the client, and the console would have to guess
   * which. ABSENCE IS A FACT THIS ROUTE KNOWS, so it states it — including what
   * happens instead, because "no credential" without "so we use the Mavlers
   * token" is a blank the reader fills in wrongly.
   */
  app.get("/os/spaces/:slug/figma-credential", requireAuth, requireSpaceAdmin, async (req, res) => {
    try {
      const { row, error, degraded } = await readRow(req.space.id);
      if (error) {
        if (error.code === PG_UNDEFINED_TABLE) return tableMissing(res);
        throw new Error(error.message);
      }
      return sendSafe(res, 200, {
        space: req.space,
        credential: publicShape(row),
        // ★ THE ABSENCE SENTENCE. Shipped from the server so the console cannot
        // render a different account of the fallback than the backend has.
        fallback:
          "Orders in this space use the Mavlers Figma token. Every design must be shared " +
          "into the Mavlers Figma account for it to be read.",
        // Says WHY a hint or a test result is missing, rather than letting the
        // console render "never tested" for a column that does not exist.
        migrationPending: degraded ? "org_figma_credentials_run2.sql" : null,
      }, log);
    } catch (err) {
      log("error", "figma-credential: read failed", { slug: req.space.slug, error: err.message });
      return sendSafe(res, 500, { error: "Could not read this space's credential", details: err.message }, log);
    }
  });

  // =========================================================================
  // PUT — THE WRITE. WRITE-ONLY, SEALED, AND IT REFUSES RATHER THAN DOWNGRADES.
  // =========================================================================
  app.put("/os/spaces/:slug/figma-credential", requireAuth, requireSpaceAdmin, async (req, res) => {
    const { token: raw, label, tokenKind, expiresAt } = req.body ?? {};

    // 1. SHAPE. Rejects loudly, and `validatePastedToken` is written never to
    //    echo the rejected value back into the response body.
    const check = validatePastedToken(raw);
    if (!check.ok) {
      return sendSafe(res, 400, { error: "That token was not accepted", details: check.error }, log);
    }

    const cleanLabel = String(label ?? "").trim();
    if (!cleanLabel) {
      return sendSafe(res, 400, {
        error: "A label is required",
        details:
          "The token itself is never shown again, so the label is the only way to tell which " +
          "Figma account this credential belongs to. Name the account, not the person.",
      }, log);
    }
    if (cleanLabel.length > 80) {
      return sendSafe(res, 400, { error: "That label is too long", details: "Keep it under 80 characters." }, log);
    }

    const kind = String(tokenKind ?? "personal").trim().toLowerCase();
    if (kind !== "personal" && kind !== "plan") {
      return sendSafe(res, 400, {
        error: "Unknown token kind",
        details: "Expected 'personal' (a Figma personal access token) or 'plan' (an Org/Enterprise plan access token).",
      }, log);
    }

    // EXPIRY. Optional, but if given it must be a real future date.
    let expiry = null;
    if (expiresAt != null && String(expiresAt).trim() !== "") {
      const t = new Date(String(expiresAt));
      if (Number.isNaN(t.getTime())) {
        return sendSafe(res, 400, { error: "That expiry date could not be read", details: "Use YYYY-MM-DD." }, log);
      }
      if (t.getTime() <= Date.now()) {
        return sendSafe(res, 400, {
          error: "That expiry date has already passed",
          details:
            "A credential stored with a past expiry would be refused on the first order and the " +
            "failure would look like a bad token. Check the date on the token in Figma.",
        }, log);
      }
      expiry = t.toISOString();
    }

    // 2. ★★ THE SEAL. THE REFUSAL IS THE FEATURE.
    const keyRead = readKey(env[KEY_ENV]);
    if (!keyRead.ok) {
      log("error", "figma-credential: write refused, no sealing key", {
        slug: req.space.slug,
        // The REASON, not the key. There is no key to print here anyway — this
        // branch is reached precisely because it is absent or wrong-sized.
        reason: keyRead.error.slice(0, 60),
      });
      return sendSafe(res, 503, {
        error: "Credentials cannot be stored yet",
        details: keyRead.error,
      }, log);
    }
    const sealed = sealToken(check.token, keyRead.key);
    if (!sealed.ok) {
      return sendSafe(res, 500, { error: "Could not store that credential", details: sealed.error }, log);
    }

    // 3. THE WRITE. ★ PARAMETERISED — the Supabase client sends the values as a
    //    JSON body and PostgREST BINDS them; nothing here interpolates a value
    //    into SQL text, and there is no string concatenation anywhere near this
    //    call. That defeats injection. It does NOT defeat statement logging,
    //    which is why `sealed.sealed` and not `check.token` is what is bound.
    const row = {
      org_id: req.space.id,
      token: sealed.sealed,
      label: cleanLabel,
      token_kind: kind,
      expires_at: expiry,
      is_active: true,
      created_by: String(req.user?.email || "").toLowerCase(),
      updated_at: new Date().toISOString(),
      token_last4: lastFour(check.token),
      // A NEW credential invalidates the old test result. Leaving the previous
      // pass in place would show a green test for a token that was never tried.
      last_test_at: null,
      last_test_ok: null,
      last_test_note: null,
    };

    try {
      let { error } = await supabaseAdmin.from(CREDENTIAL_TABLE).upsert(row, { onConflict: "org_id" });

      if (error && error.code === PG_UNDEFINED_COLUMN) {
        // The companion migration has not been run. Store what the table can
        // hold, and SAY the hint is missing rather than silently dropping it.
        const { token_last4, last_test_at, last_test_ok, last_test_note, ...legacy } = row;
        ({ error } = await supabaseAdmin.from(CREDENTIAL_TABLE).upsert(legacy, { onConflict: "org_id" }));
        if (!error) {
          const after = await readRow(req.space.id);
          return sendSafe(res, 200, {
            space: req.space,
            credential: publicShape(after.row),
            stored: true,
            migrationPending: "org_figma_credentials_run2.sql",
            note: "Stored. The last-four hint and the test record need org_figma_credentials_run2.sql.",
          }, log);
        }
      }

      if (error) {
        if (error.code === PG_UNDEFINED_TABLE) return tableMissing(res);
        throw new Error(error.message);
      }
    } catch (err) {
      // ★★ THE ONE log() CALL ON THE WRITE PATH THAT CARRIES AN ERROR STRING,
      // AND THE REASON IT IS SAFE. server.js:4365's log() JSON-stringifies its
      // extras with NO redaction, so anything handed to it reaches Railway
      // verbatim. `err.message` here is a PostgREST/Postgres error string — and
      // Postgres error messages can quote a failing value. The token is NOT in
      // scope of that risk because the value bound into the statement is
      // CIPHERTEXT, so the worst case is a sealed blob in a log line, which is
      // not a secret. The test suite asserts this by driving a failing upsert
      // whose error message contains the SEALED value and checking the captured
      // log call for leaks.
      log("error", "figma-credential: write failed", { slug: req.space.slug, error: err.message });
      return sendSafe(res, 500, { error: "Could not store that credential", details: err.message }, log);
    }

    const after = await readRow(req.space.id);
    // ★ log() ON THE SUCCESS PATH CARRIES NO TOKEN AND NO SEALED VALUE — only
    // the space, the label a human typed, and the kind.
    log("info", "figma-credential: stored", {
      slug: req.space.slug,
      label: cleanLabel,
      tokenKind: kind,
      hasExpiry: Boolean(expiry),
    });

    return sendSafe(res, 200, {
      space: req.space,
      credential: publicShape(after.row),
      stored: true,
    }, log);
  });

  // =========================================================================
  // DELETE — REVOKE. A FLAG, NOT A DELETE.
  // =========================================================================
  /**
   * ★ is_active = false RATHER THAN A ROW DELETE, matching the spaces rule that
   * rows are retired by a flag and kept for the audit trail. `created_by` and
   * `created_at` survive, so "who installed a credential on this client, and
   * when" is still answerable after it is withdrawn — which is exactly the
   * question that gets asked after an incident.
   *
   * ★ THE TOKEN VALUE IS OVERWRITTEN, not kept. A revoked credential has no
   * reason to keep holding live access, and a retired-but-readable secret is the
   * orphan case run 1's ON DELETE CASCADE was written against.
   */
  app.delete("/os/spaces/:slug/figma-credential", requireAuth, requireSpaceAdmin, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from(CREDENTIAL_TABLE)
        .update({ is_active: false, token: "revoked", updated_at: new Date().toISOString() })
        .eq("org_id", req.space.id)
        .select(PUBLIC_COLUMNS_LEGACY);

      if (error) {
        if (error.code === PG_UNDEFINED_TABLE) return tableMissing(res);
        throw new Error(error.message);
      }

      // ★ ASK FOR THE ROWS BACK. AdminConsole's own header states the rule: RLS
      // filters rows BEFORE triggers fire, so a forbidden UPDATE changes
      // nothing, raises nothing, and PostgREST answers 200 with an empty array.
      // In a permissions table that silent success reads exactly like a real
      // one. Nothing here is reported as done on a 200.
      if ((data?.length ?? 0) === 0) {
        return sendSafe(res, 404, {
          error: "Nothing to revoke",
          details: "This space has no stored Figma credential. Orders here already use the Mavlers token.",
        }, log);
      }

      log("info", "figma-credential: revoked", { slug: req.space.slug, by: String(req.user?.email || "").toLowerCase() });
      return sendSafe(res, 200, {
        space: req.space,
        credential: publicShape(data[0]),
        revoked: true,
        fallback: "Orders in this space now use the Mavlers Figma token again.",
      }, log);
    } catch (err) {
      log("error", "figma-credential: revoke failed", { slug: req.space.slug, error: err.message });
      return sendSafe(res, 500, { error: "Could not revoke that credential", details: err.message }, log);
    }
  });

  // =========================================================================
  // POST /test — THE TEST BUTTON.
  // =========================================================================
  /**
   * ★★ WHICH ENDPOINT, AND WHY IT IS THE CHEAPEST ONE.
   *
   * `GET https://api.figma.com/v1/me`. It takes NO file key, returns a handful
   * of fields about the account the token belongs to, and touches no document.
   * There is no cheaper authenticated call in the Figma REST API — every other
   * endpoint needs a file or project key and reads real content.
   *
   * ★ IT PROVES AUTHENTICATION, NOT FILE ACCESS, AND THOSE ARE DIFFERENT.
   * A token can be perfectly valid and still be unable to read the file an order
   * names, because Figma scopes plan access tokens to a resource allowlist. So
   * when the caller supplies a figmaUrl this route ALSO does
   * `GET /v1/files/:key?depth=1` — `depth=1` returns the document node and its
   * immediate children and nothing below, which is the cheapest form of a file
   * read. The two results are reported SEPARATELY, because "your token works but
   * cannot see that file" is the answer that actually helps and a merged
   * pass/fail destroys it.
   *
   * ★★ AND IT SPENDS THE CLIENT'S RATE LIMIT, WHICH THE CONSOLE SAYS OUT LOUD.
   * The call is made with the CLIENT'S token, so it is metered against THEIR
   * Figma account, not Mavlers'. A low-tier seat has a small monthly REST
   * allowance and a test button is exactly the kind of control somebody presses
   * six times when they are unsure. Three things hold that down:
   *   · it is a BUTTON — never on page load, never on a poll, never on a save;
   *   · TEST_COOLDOWN_MS between presses, enforced here and not only in the UI;
   *   · one /v1/me per press, and the file check only when a URL is supplied.
   * This module has NOT verified Figma's current per-seat allowance against the
   * live API — no network call was made by this run — so the console states the
   * cost as a fact about whose budget is spent, not as a number it cannot prove.
   */
  app.post("/os/spaces/:slug/figma-credential/test", requireAuth, requireSpaceAdmin, async (req, res) => {
    const { token: pasted, figmaUrl } = req.body ?? {};

    // THE TOKEN UNDER TEST. Either one the client just pasted (tested BEFORE it
    // is stored, which is the point — "verify it can read a file BEFORE an order
    // depends on it") or the stored one, unsealed here and never returned.
    let token = null;
    let testing = "stored";

    if (pasted != null && String(pasted).trim() !== "") {
      const check = validatePastedToken(pasted);
      if (!check.ok) return sendSafe(res, 400, { error: "That token was not accepted", details: check.error }, log);
      token = check.token;
      testing = "pasted";
    } else {
      const keyRead = readKey(env[KEY_ENV]);
      if (!keyRead.ok) return sendSafe(res, 503, { error: "Cannot test the stored credential", details: keyRead.error }, log);
      try {
        const { data, error } = await supabaseAdmin
          .from(CREDENTIAL_TABLE)
          .select("token,is_active,last_test_at")
          .eq("org_id", req.space.id)
          .maybeSingle();
        if (error) {
          if (error.code === PG_UNDEFINED_TABLE) return tableMissing(res);
          throw new Error(error.message);
        }
        if (!data) {
          return sendSafe(res, 404, {
            error: "Nothing to test",
            details: "This space has no stored Figma credential. Paste one to test it before saving.",
          }, log);
        }
        if (data.is_active === false) {
          return sendSafe(res, 409, { error: "That credential is revoked", details: "Paste a new token to replace it." }, log);
        }
        // THE COOLDOWN, ENFORCED SERVER-SIDE. A UI-only cooldown is not a
        // cooldown — it is a suggestion a page refresh clears.
        if (data.last_test_at) {
          const since = Date.now() - new Date(data.last_test_at).getTime();
          if (since >= 0 && since < TEST_COOLDOWN_MS) {
            return sendSafe(res, 429, {
              error: "Tested a moment ago",
              details:
                "Each test spends one call from your own Figma account's rate limit, so this waits " +
                Math.ceil((TEST_COOLDOWN_MS - since) / 1000) +
                "s between presses.",
            }, log);
          }
        }
        const opened = openToken(data.token, keyRead.key);
        if (!opened.ok) {
          return sendSafe(res, 500, { error: "Could not read the stored credential", details: opened.error }, log);
        }
        const check = validatePastedToken(opened.token);
        if (!check.ok) {
          return sendSafe(res, 500, {
            error: "The stored credential is not usable",
            details: "It is not shaped like a Figma token. Paste it again.",
          }, log);
        }
        token = check.token;
      } catch (err) {
        log("error", "figma-credential: test read failed", { slug: req.space.slug, error: err.message });
        return sendSafe(res, 500, { error: "Could not read the stored credential", details: err.message }, log);
      }
    }

    // --- THE CALL. -----------------------------------------------------------
    const result = { testing, auth: null, file: null };

    try {
      const r = await doFetch(FIGMA_TEST_ENDPOINT, { headers: figmaAuthHeaders(token) });
      // ★ THE BODY IS READ FOR TWO NAMED FIELDS AND DISCARDED. It is never
      // spread into the response and never handed to log(): a response body is
      // attacker-influenced text and this run's whole subject is what reaches a
      // log line.
      let who = null;
      if (r.ok) {
        const b = await r.json().catch(() => ({}));
        who = { email: b?.email ?? null, handle: b?.handle ?? null };
      }
      result.auth = {
        ok: r.ok,
        status: r.status,
        // A FIXED SENTENCE CHOSEN BY STATUS — never Figma's response text, which
        // could echo the request.
        note: r.ok
          ? "Figma recognised this token."
          : r.status === 403
          ? "Figma refused this token. It is wrong, revoked, or expired."
          : r.status === 429
          ? "Figma rate-limited this account. The token may still be fine — try later."
          : "Figma answered " + r.status + ".",
        account: who,
      };
    } catch (err) {
      result.auth = { ok: false, status: 0, note: "Could not reach Figma at all.", account: null };
    }

    // THE FILE CHECK, only when a URL is supplied and only when auth passed.
    const key = parseFigmaFileKey(figmaUrl);
    if (result.auth?.ok && key) {
      try {
        const r = await doFetch("https://api.figma.com/v1/files/" + encodeURIComponent(key) + "?depth=1", {
          headers: figmaAuthHeaders(token),
        });
        result.file = {
          ok: r.ok,
          status: r.status,
          key,
          note: r.ok
            ? "This token can read that file."
            : r.status === 404
            ? "That file is not visible to this token. Check it is in the same Figma account, or share it with the account this token belongs to."
            : r.status === 403
            ? "This token is valid but not allowed to read that file."
            : "Figma answered " + r.status + " for that file.",
        };
      } catch {
        result.file = { ok: false, status: 0, key, note: "Could not reach Figma for the file check." };
      }
    } else if (figmaUrl && !key) {
      result.file = { ok: false, status: 0, key: null, note: "That does not look like a Figma file URL, so the file check was skipped." };
    }

    // RECORD IT, when we were testing the stored credential.
    if (testing === "stored") {
      const passed = Boolean(result.auth?.ok) && (result.file ? Boolean(result.file.ok) : true);
      try {
        await supabaseAdmin
          .from(CREDENTIAL_TABLE)
          .update({
            last_test_at: new Date().toISOString(),
            last_test_ok: passed,
            last_test_note: result.file && !result.file.ok ? result.file.note : result.auth?.note ?? null,
          })
          .eq("org_id", req.space.id);
      } catch {
        // A test result that could not be recorded must not fail the test the
        // human just ran and is watching. The answer is on screen either way.
      }
    }

    // ★ log() ON THE TEST PATH: the outcome and the status, never the token and
    // never the response body.
    log("info", "figma-credential: tested", {
      slug: req.space.slug,
      testing,
      authOk: Boolean(result.auth?.ok),
      authStatus: result.auth?.status ?? null,
      fileOk: result.file ? Boolean(result.file.ok) : null,
    });

    return sendSafe(res, 200, { space: req.space, ...result }, log);
  });
}

/**
 * Pull a file key out of a Figma URL. Returns null for anything else.
 *
 * Both `/file/<key>/...` and the newer `/design/<key>/...` forms, because the
 * product has orders on record in both shapes.
 */
export function parseFigmaFileKey(url) {
  const s = String(url ?? "");
  const m = s.match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]{10,})/);
  return m ? m[1] : null;
}

export default { createFigmaCredentialRoutes, createRequireSpaceAdmin, publicShape, sendSafe, parseFigmaFileKey, PUBLIC_COLUMNS };

/*
 * ---------------------------------------------------------------------------
 * ★ MOUNTING IT. ONE LINE, AND IT IS NOT IN server.js TODAY.
 *
 * Beside createSpacesRoutes at server.js:8249:
 *
 *   import { createFigmaCredentialRoutes } from "./figma-credential-routes.js";
 *   createFigmaCredentialRoutes({ app, supabaseAdmin, requireAuth, log, env: process.env });
 *
 * UNMOUNTED ON PURPOSE FOR THIS RUN. Mounting it adds four routes that write to
 * a table which does not exist yet and that refuse without FIGMA_CRED_KEY; both
 * are the owner's to sequence. Generation does not read any of this either way.
 * ---------------------------------------------------------------------------
 */
