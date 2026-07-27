// ─────────────────────────────────────────────────────────────────────────────
// order-confirmation-transport.js — the SENDING half, behind a pluggable seam.
//
// ★★ WHY A PLUGGABLE TRANSPORT AND A STUB. The confirmation-email spec has been
// complete for three sessions and blocked on ONE decision: which Google
// Workspace credential to use. That decision is the owner's, and it should not
// hold the pipeline hostage. So the pipeline is built in full and ships with a
// STUB transport that writes the rendered message to disk instead of sending.
// When the owner picks a credential path it is ONE CONFIG CHANGE
// (ORDER_CONFIRMATION_TRANSPORT + that path's secrets), not a rebuild.
//
// ★★ NO NEW npm DEPENDENCY. Deliberate. A backend file that imports a module the
// deploy does not have is a crash on boot, and this repo has been bitten by a
// missing-module deploy before. All four transports are built on what is already
// installed: global fetch (undici is a dependency) and node:tls / node:net from
// the standard library. `npm install` is NOT part of turning this on.
//
// ★★ IT MUST NEVER BLOCK DELIVERY. sendOrderConfirmation() has no throw path:
// every transport error, timeout, misconfiguration and render error is caught,
// LOGGED LOUDLY at error level, and returned as { ok:false, error }. The caller
// in /approve treats the result as information, never as control flow. The
// reasoning is the same as the delivered-folder integrity gate
// (server.js:7484-7495): a lead is waiting, the folder and the HTML are already
// in Dropbox, and withholding a completed delivery because a courtesy email
// failed turns a working order into no order. A confirmation email that can
// stall an order is worse than no confirmation email.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";
import tls from "node:tls";
import net from "node:net";
import { buildRfc822 } from "./order-confirmation.js";

// ── the flag ─────────────────────────────────────────────────────────────────
/**
 * ★ THE FLAG: ORDER_CONFIRMATION_ENABLED. Defaults to OFF (absent → false), so
 * merging this changes NOTHING in production until the owner sets it. Only the
 * exact string "true" enables it — not "1", not "yes", not "TRUE " with a space
 * — because a flag that turns on by accident is not a flag.
 */
export const CONFIRMATION_FLAG = "ORDER_CONFIRMATION_ENABLED";

export function isConfirmationEnabled(env = process.env) {
  return env[CONFIRMATION_FLAG] === "true";
}

/** ORDER_CONFIRMATION_TRANSPORT: stub (default) | gmail | smtp | resend. */
export const TRANSPORT_FLAG = "ORDER_CONFIRMATION_TRANSPORT";

export const TRANSPORT_NAMES = ["stub", "gmail", "smtp", "resend"];

// ── TRANSPORT 1 — STUB. Writes to disk. The default. ─────────────────────────
/**
 * Writes three files per order so the owner can inspect exactly what would have
 * been sent, without a credential:
 *
 *   <ORDER>.eml   — the FULL RFC822 message. Double-click it: Outlook, Apple
 *                   Mail and Thunderbird all open a .eml, so the owner sees the
 *                   real rendering WITH THE PREVIEW INLINE, from the same bytes
 *                   a transport would put on the wire. This is the artifact that
 *                   proves "inline, not attached" rather than asserting it.
 *   <ORDER>.html  — the HTML part alone, for a fast browser look. cid: cannot
 *                   resolve in a browser, so the cid src is rewritten to the
 *                   absolute Dropbox preview URL here (and ONLY here — the .eml
 *                   keeps its cid).
 *   <ORDER>.json  — envelope + diagnostics: who it would go to, the bcc, the
 *                   transport that would have carried it, which provenance
 *                   fields were actually read and from where.
 *
 * NOTE ON RAILWAY: the container filesystem is ephemeral, so on the deployed
 * backend these files survive only until the next deploy. That is fine for what
 * the stub is FOR — a local dry-run before the owner picks a credential. It is
 * stated here rather than discovered later.
 */
export function createStubTransport({ dir, log } = {}) {
  const outDir = dir || process.env.ORDER_CONFIRMATION_STUB_DIR || path.join(process.cwd(), "order-confirmations");
  return {
    name: "stub",
    describe: () => `stub → ${outDir}`,
    async send({ message, previewBytes, orderId, date, messageId }) {
      await fs.mkdir(outDir, { recursive: true });
      const safe = String(orderId || "order").replace(/[^A-Za-z0-9._-]/g, "-");
      const eml = buildRfc822(message, { date, messageId, previewBytes });

      const emlPath = path.join(outDir, `${safe}.eml`);
      const htmlPath = path.join(outDir, `${safe}.html`);
      const jsonPath = path.join(outDir, `${safe}.json`);

      // Browser copy: a cid: src cannot resolve outside a mail client, so point
      // it at the real Dropbox preview when we have one, else drop the <img>
      // rather than leave a broken-image box standing in for a preview.
      let browserHtml = message.html;
      if (/src="cid:/.test(browserHtml)) {
        browserHtml = message.previewUrlForBrowser
          ? browserHtml.replace(/src="cid:[^"]*"/g, `src="${message.previewUrlForBrowser}"`)
          : browserHtml.replace(/<img[^>]*src="cid:[^"]*"[^>]*\/?>/g, "");
      }

      await Promise.all([
        fs.writeFile(emlPath, eml, "utf-8"),
        fs.writeFile(
          htmlPath,
          `<!-- STUB RENDER of the order-confirmation email for ${safe}.\n` +
            `     NOT SENT. Transport = stub (${CONFIRMATION_FLAG} gate + ${TRANSPORT_FLAG}=stub).\n` +
            `     Envelope: from ${message.from} → to ${message.to} → bcc ${message.bcc}\n` +
            `     Subject: ${message.subject}\n` +
            `     The .eml next to this file is the real message, with the preview INLINE. -->\n` +
            browserHtml,
          "utf-8",
        ),
        fs.writeFile(
          jsonPath,
          JSON.stringify(
            {
              notSent: true,
              transport: "stub",
              envelope: { from: message.from, to: message.to, bcc: message.bcc, subject: message.subject },
              inlinePreview: {
                mode: message.diagnostics.previewMode,
                bytes: previewBytes ? previewBytes.length : 0,
                attachedAsFile: false,
              },
              diagnostics: message.diagnostics,
              files: { eml: emlPath, html: htmlPath },
            },
            null,
            2,
          ),
          "utf-8",
        ),
      ]);

      if (log) {
        log("info", "★ Order-confirmation STUB wrote the rendered message to disk (NOT sent)", {
          orderId, eml: emlPath, html: htmlPath, json: jsonPath, bytes: eml.length,
        });
      }
      return { ok: true, transport: "stub", sent: false, wrote: { eml: emlPath, html: htmlPath, json: jsonPath } };
    },
  };
}

// ── TRANSPORT 2 — GMAIL API with an OAuth refresh token ──────────────────────
/**
 * Exchanges a long-lived refresh token for an access token, then POSTs the raw
 * message to users.messages.send. Needs, as Railway env vars:
 *   GMAIL_OAUTH_CLIENT_ID · GMAIL_OAUTH_CLIENT_SECRET · GMAIL_OAUTH_REFRESH_TOKEN
 * The refresh token must be minted for shrujal@mavlers.com with the
 * https://www.googleapis.com/auth/gmail.send scope.
 *
 * Bcc handling: the Bcc header is inside the raw message and Gmail honours it,
 * so the bcc copy is delivered without a second API call.
 */
export function createGmailTransport({ env = process.env, log, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const clientId = env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GMAIL_OAUTH_REFRESH_TOKEN;
  const configured = !!(clientId && clientSecret && refreshToken);

  return {
    name: "gmail",
    configured,
    describe: () =>
      configured
        ? "gmail API (OAuth refresh token)"
        : "gmail API — NOT CONFIGURED (needs GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN)",
    async send({ message, previewBytes, date, messageId, orderId }) {
      if (!configured) {
        throw new Error(
          "gmail transport selected but not configured: set GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and GMAIL_OAUTH_REFRESH_TOKEN",
        );
      }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }).toString(),
          signal: ac.signal,
        });
        if (!tokenRes.ok) {
          const body = await tokenRes.text().catch(() => "");
          throw new Error(`gmail token exchange failed (${tokenRes.status}): ${body.slice(0, 300)}`);
        }
        const { access_token: accessToken } = await tokenRes.json();
        if (!accessToken) throw new Error("gmail token exchange returned no access_token");

        const raw = buildRfc822(message, { date, messageId, previewBytes });
        // Gmail wants base64url of the raw RFC822 bytes.
        const b64url = Buffer.from(raw, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

        const sendRes = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: b64url }),
          signal: ac.signal,
        });
        if (!sendRes.ok) {
          const body = await sendRes.text().catch(() => "");
          throw new Error(`gmail send failed (${sendRes.status}): ${body.slice(0, 300)}`);
        }
        const out = await sendRes.json().catch(() => ({}));
        if (log) log("info", "Order-confirmation sent via Gmail API", { orderId, gmailId: out.id || null });
        return { ok: true, transport: "gmail", sent: true, providerId: out.id || null };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

// ── TRANSPORT 3 — SMTP (Workspace relay OR app password) ─────────────────────
/**
 * A minimal, dependency-free SMTP client on node:tls / node:net. Covers BOTH
 * credential paths the owner may choose, because they differ only in env values:
 *
 *   • Workspace SMTP relay  — SMTP_HOST=smtp-relay.gmail.com, port 587, and
 *     depending on the relay's configured authentication either IP allow-listing
 *     (no SMTP_USER/SMTP_PASS) or SMTP auth.
 *   • App password          — SMTP_HOST=smtp.gmail.com, port 465 or 587,
 *     SMTP_USER=shrujal@mavlers.com, SMTP_PASS=<16-char app password>.
 *
 * Env: SMTP_HOST · SMTP_PORT (465 implicit TLS, else STARTTLS) · SMTP_USER ·
 *      SMTP_PASS · SMTP_SECURE ("true" forces implicit TLS)
 *
 * RCPT TO is issued for the lead AND the bcc address — that is what actually
 * delivers a blind copy; the Bcc header alone does not.
 */
export function createSmtpTransport({ env = process.env, log, timeoutMs = 30000 } = {}) {
  const host = env.SMTP_HOST;
  const port = Number(env.SMTP_PORT || 587);
  const user = env.SMTP_USER || null;
  const pass = env.SMTP_PASS || null;
  const secure = env.SMTP_SECURE === "true" || port === 465;
  const configured = !!host;

  return {
    name: "smtp",
    configured,
    describe: () =>
      configured
        ? `smtp ${host}:${port} (${secure ? "implicit TLS" : "STARTTLS"}${user ? ", AUTH LOGIN" : ", no auth — relay must allow-list this IP"})`
        : "smtp — NOT CONFIGURED (needs at least SMTP_HOST)",
    async send({ message, previewBytes, date, messageId, orderId }) {
      if (!configured) throw new Error("smtp transport selected but not configured: set SMTP_HOST (and SMTP_PORT/SMTP_USER/SMTP_PASS as your path requires)");

      const raw = buildRfc822(message, { date, messageId, previewBytes });
      // DATA dot-stuffing (RFC 5321 §4.5.2): a body line that begins with "." is
      // doubled, or the server would read it as end-of-data.
      const dotStuffed = raw.replace(/\r\n\./g, "\r\n..");
      const recipients = [message.to, message.bcc].filter(Boolean);

      await smtpExchange({
        host, port, secure, user, pass, timeoutMs,
        from: message.from,
        recipients,
        data: dotStuffed,
      });

      if (log) log("info", "Order-confirmation sent via SMTP", { orderId, host, port, recipients: recipients.length });
      return { ok: true, transport: "smtp", sent: true, providerId: null };
    },
  };
}

/**
 * One SMTP conversation, start to finish. Rejects on any unexpected reply code
 * or on timeout; the caller's never-throws wrapper turns that into a logged
 * { ok:false }.
 */
function smtpExchange({ host, port, secure, user, pass, timeoutMs, from, recipients, data }) {
  return new Promise((resolve, reject) => {
    let socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = "";
    let settled = false;
    let upgraded = secure;

    const timer = setTimeout(() => fail(new Error(`SMTP timeout after ${timeoutMs}ms (${host}:${port})`)), timeoutMs);

    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); try { socket.destroy(); } catch {} resolve(v); } };
    const fail = (e) => { if (!settled) { settled = true; clearTimeout(timer); try { socket.destroy(); } catch {} reject(e); } };

    // The command script. Each step waits for a reply whose code is in `expect`.
    const steps = [];
    steps.push({ send: null, expect: [220] }); // server greeting
    steps.push({ send: `EHLO maveloper`, expect: [250] });
    if (!secure) {
      steps.push({ send: `STARTTLS`, expect: [220], then: "upgrade" });
      steps.push({ send: `EHLO maveloper`, expect: [250] });
    }
    if (user && pass) {
      steps.push({ send: `AUTH LOGIN`, expect: [334] });
      steps.push({ send: Buffer.from(user, "utf-8").toString("base64"), expect: [334] });
      steps.push({ send: Buffer.from(pass, "utf-8").toString("base64"), expect: [235] });
    }
    steps.push({ send: `MAIL FROM:<${from}>`, expect: [250] });
    for (const r of recipients) steps.push({ send: `RCPT TO:<${r}>`, expect: [250, 251] });
    steps.push({ send: `DATA`, expect: [354] });
    steps.push({ send: `__DATA__`, expect: [250] });
    steps.push({ send: `QUIT`, expect: [221], last: true });

    let i = 0;

    const write = (line) => {
      if (line === "__DATA__") socket.write(data.endsWith("\r\n") ? data + ".\r\n" : data + "\r\n.\r\n");
      else socket.write(line + "\r\n");
    };

    const advance = () => {
      // Send the NEXT step's command (step 0 has none — we wait for the greeting).
      i++;
      if (i >= steps.length) return done({ ok: true });
      const s = steps[i];
      if (s.send) write(s.send);
    };

    const onReply = (code, text) => {
      const s = steps[i];
      if (!s.expect.includes(code)) {
        return fail(new Error(`SMTP ${host}:${port} step ${i} (${s.send || "greeting"}) expected ${s.expect.join("/")} got ${code}: ${text.slice(0, 200)}`));
      }
      if (s.last) return done({ ok: true });
      if (s.then === "upgrade") {
        // Swap the plaintext socket for a TLS one, keeping the same handlers.
        const plain = socket;
        plain.removeAllListeners("data");
        socket = tls.connect({ socket: plain, servername: host }, () => {
          upgraded = true;
          attach();
          advance();
        });
        socket.on("error", fail);
        return;
      }
      advance();
    };

    const attach = () => {
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        // A multi-line reply repeats the code with "-"; the final line uses " ".
        let nl;
        while ((nl = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const m = /^(\d{3})([ -])(.*)$/.exec(line);
          if (!m) continue;
          if (m[2] === "-") continue; // continuation — keep reading
          onReply(Number(m[1]), m[3] || line);
          if (settled) return;
        }
      });
    };

    socket.on("error", fail);
    socket.on("close", () => { if (!settled) fail(new Error(`SMTP connection closed unexpectedly (${host}:${port}, tls=${upgraded})`)); });
    attach();
  });
}

// ── TRANSPORT 4 — a transactional service (Resend) ───────────────────────────
/**
 * One POST, no OAuth, no SMTP. Env: RESEND_API_KEY.
 * ★ The honest catch, which is why this is not the recommendation: a
 * transactional service can only send FROM a domain the owner has verified in
 * that service with SPF/DKIM records. The spec pins FROM to shrujal@mavlers.com,
 * a Google Workspace mailbox on a domain whose DNS Mavlers IT controls, so this
 * path requires a DNS change and makes mavlers.com mail leave Google. That is a
 * bigger decision than picking a credential.
 */
export function createResendTransport({ env = process.env, log, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const key = env.RESEND_API_KEY;
  const configured = !!key;
  return {
    name: "resend",
    configured,
    describe: () => (configured ? "resend API" : "resend — NOT CONFIGURED (needs RESEND_API_KEY)"),
    async send({ message, previewBytes, orderId }) {
      if (!configured) throw new Error("resend transport selected but not configured: set RESEND_API_KEY");
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const body = {
          from: `Maveloper <${message.from}>`,
          to: [message.to],
          bcc: message.bcc ? [message.bcc] : undefined,
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
          // Resend carries an inline image as an attachment with a content_id;
          // the cid: reference in the HTML then resolves in the client, so it
          // still renders INLINE in the body rather than as a download.
          attachments:
            previewBytes && message.inlineImages.length
              ? [{
                  filename: message.inlineImages[0].filename,
                  content: Buffer.from(previewBytes).toString("base64"),
                  content_id: message.inlineImages[0].cid,
                  content_type: message.inlineImages[0].contentType,
                }]
              : undefined,
        };
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(`resend send failed (${res.status}): ${txt.slice(0, 300)}`);
        }
        const out = await res.json().catch(() => ({}));
        if (log) log("info", "Order-confirmation sent via Resend", { orderId, resendId: out.id || null });
        return { ok: true, transport: "resend", sent: true, providerId: out.id || null };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

// ── the selector ─────────────────────────────────────────────────────────────
/**
 * Resolve the configured transport. Defaults to "stub" — an unset or unknown
 * value writes to disk rather than silently not sending, because a typo in a
 * transport name must not look identical to a working send.
 */
export function createTransport({ env = process.env, log, fetchImpl, stubDir } = {}) {
  const raw = (env[TRANSPORT_FLAG] || "stub").trim().toLowerCase();
  const name = TRANSPORT_NAMES.includes(raw) ? raw : "stub";
  if (name !== raw && log) {
    log("warn", `Order-confirmation: unknown ${TRANSPORT_FLAG}="${raw}" — falling back to the stub transport (nothing will be sent)`, {
      known: TRANSPORT_NAMES,
    });
  }
  switch (name) {
    case "gmail": return createGmailTransport({ env, log, ...(fetchImpl ? { fetchImpl } : {}) });
    case "smtp": return createSmtpTransport({ env, log });
    case "resend": return createResendTransport({ env, log, ...(fetchImpl ? { fetchImpl } : {}) });
    default: return createStubTransport({ dir: stubDir || env.ORDER_CONFIRMATION_STUB_DIR, log });
  }
}

// ── ★ THE NEVER-THROWS SEND ──────────────────────────────────────────────────
/**
 * Send the confirmation. **This function has no throw path.**
 *
 * Every outcome is a return value:
 *   { attempted:false, reason:"flag-off" }        → the flag is not "true"
 *   { attempted:false, reason:"no-lead-email" }   → os_queue.lead_email was null
 *   { attempted:true,  ok:true,  ... }            → sent, or written by the stub
 *   { attempted:true,  ok:false, error }          → LOUD failure, order ships
 *
 * The `message` is built by the caller (buildOrderConfirmation) and passed in, so
 * a render failure is caught here too — the render reads DB-sourced strings, and
 * a malformed one must not be able to reach /approve's own try/catch.
 *
 * ★ THE LOUD LOG. On failure this logs at ERROR with a leading ★ and the string
 * "ORDER SHIPPED ANYWAY", matching the vocabulary the delivered-folder gate
 * already uses (server.js:7509). The point of the marker is that it is greppable
 * in Railway logs and reads as an incident, not a debug line.
 */
export async function sendOrderConfirmation({
  message,
  previewBytes = null,
  orderId,
  requestId,
  env = process.env,
  log = () => {},
  transport = null,
  date = null,
  messageId = null,
} = {}) {
  const started = Date.now();

  if (!isConfirmationEnabled(env)) {
    log("info", "Order-confirmation skipped — flag off", {
      requestId, orderId, flag: CONFIRMATION_FLAG, value: env[CONFIRMATION_FLAG] ?? "(unset)",
    });
    return { attempted: false, ok: null, reason: "flag-off", flag: CONFIRMATION_FLAG, transport: null, ms: 0 };
  }

  if (!message || !message.to || !String(message.to).includes("@")) {
    // A missing lead_email is a DATA gap, not a transport failure. Named
    // separately so the owner is not sent hunting through SMTP logs for it.
    log("error", "★ ORDER-CONFIRMATION NOT SENT — no usable lead email on the queue row. ORDER SHIPPED ANYWAY.", {
      requestId, orderId, to: message ? message.to : null,
      note: "os_queue.lead_email is NOT NULL in the DDL, so an empty value here means the row was written by a path that bypassed the /os intake form.",
    });
    return { attempted: false, ok: false, reason: "no-lead-email", transport: null, ms: Date.now() - started };
  }

  let t = transport;
  try {
    if (!t) t = createTransport({ env, log });
  } catch (selErr) {
    log("error", "★ ORDER-CONFIRMATION NOT SENT — transport could not be constructed. ORDER SHIPPED ANYWAY.", {
      requestId, orderId, error: selErr?.message || String(selErr),
    });
    return { attempted: false, ok: false, reason: "transport-construct-failed", error: selErr?.message || String(selErr), transport: null, ms: Date.now() - started };
  }

  try {
    const result = await t.send({ message, previewBytes, orderId, date, messageId });
    const ms = Date.now() - started;
    log("info", "Order-confirmation dispatched", {
      requestId, orderId, transport: t.name, sent: !!result.sent, ms,
      to: message.to, bcc: message.bcc,
      placeholderLinks: message.diagnostics ? message.diagnostics.placeholderCount : null,
      engine: message.diagnostics ? message.diagnostics.engine : null,
      ...(result.wrote ? { wrote: result.wrote } : {}),
      ...(result.providerId ? { providerId: result.providerId } : {}),
    });
    return { attempted: true, ok: true, reason: null, transport: t.name, sent: !!result.sent, wrote: result.wrote || null, providerId: result.providerId || null, ms };
  } catch (err) {
    const ms = Date.now() - started;
    // ★★ THE WHOLE POINT OF THIS FILE. Loud, named, and NOT rethrown.
    log("error", "★ ORDER-CONFIRMATION SEND FAILED — ORDER SHIPPED ANYWAY. The lead was NOT notified.", {
      requestId, orderId,
      transport: t.name,
      transportConfig: typeof t.describe === "function" ? t.describe() : null,
      error: err?.message || String(err),
      errorName: err?.name || null,
      to: message.to,
      ms,
      whatToDo:
        "The delivery folder, the HTML and the Dropbox share link are all complete and unaffected — " +
        "only the courtesy email is missing. Notify the lead by hand for this order, then fix the transport.",
    });
    return {
      attempted: true, ok: false, reason: "transport-error",
      transport: t.name,
      error: err?.message || String(err),
      ms,
    };
  }
}

/**
 * A compact, JSON-serialisable record of the outcome, for
 * maveloper_jobs.delivery_meta.confirmationEmail — an EXISTING jsonb column
 * (server.js:7052), so ★ NO NEW COLUMN IS INVENTED. This is what makes a failure
 * visible ON THE JOB ROW rather than only in a log line that scrolls away.
 */
export function confirmationMetaFor(result, message) {
  return {
    attempted: !!result.attempted,
    ok: result.ok,
    reason: result.reason || null,
    transport: result.transport || null,
    sent: result.sent ?? null,
    error: result.error || null,
    ms: result.ms ?? null,
    to: message ? message.to : null,
    bcc: message ? message.bcc : null,
    subject: message ? message.subject : null,
    placeholderLinks: message && message.diagnostics ? message.diagnostics.placeholderCount : null,
    engine: message && message.diagnostics ? message.diagnostics.engine : null,
    previewMode: message && message.diagnostics ? message.diagnostics.previewMode : null,
  };
}

export default {
  CONFIRMATION_FLAG,
  TRANSPORT_FLAG,
  TRANSPORT_NAMES,
  isConfirmationEnabled,
  createStubTransport,
  createGmailTransport,
  createSmtpTransport,
  createResendTransport,
  createTransport,
  sendOrderConfirmation,
  confirmationMetaFor,
};
