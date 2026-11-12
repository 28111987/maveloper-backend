// order-control.fake-engine.mjs - A FAKE ENGINE FOR order-control.test.mjs (run 17).
//
// A small local HTTP server standing in for C:\maveloper-bridge\bridge-server.mjs.
// It never runs the real engine. It speaks the bridge's wire shapes as they are
// at engine 217a3bb (POST /generate answers 202 { jobId, bridgeJobId, status },
// then POSTs { bridgeJobId, html, bytesGenerated, elapsedSeconds, generatedAt }
// to the payload's callbackUrl with X-Bridge-Secret; GET /health answers 200),
// and it can be scripted per test:
//
//   startupMs      a cold start: the first request of any kind starts the
//                  instance and EVERY request is held until it is ready, the
//                  way Cloud Run holds requests during an instance start
//   acceptDelayMs  extra time before /generate answers 202 (after start-up)
//   buildMs        how long a build takes before the callback
//   dieAfterAccept accept, then never call back, and forget the job
//   callbackTwice  post the same result twice
//   jobsRoute      answer GET /jobs/:bridgeJobId as the run 17 engine spec says
//                  (200 { known: true, state } or 404 { known: false }); false
//                  answers 404 { error: "Not found" } like bridge-server.mjs:493
//   slowHealthMs   /health answers after this long
//
// Every POST /generate is recorded with its bridgeJobId, so a test can count
// BUILDS per order: a build is a /generate whose body was read and accepted.
//
// RUN 18: every POST /generate body is ALSO recorded as received, raw text and
// parsed, in `requests` (accepted or not, in arrival order), and each build
// carries its own `raw` and `payload`, so a test can read exactly what the
// backend sent (payload.engine among it) and compare two arms byte for byte.
//
// RUN 19: THE TWO DRAIN SIGNALS OF THE TOPAZ-3 ENGINE (topaz3-sp cd03753f,
// bridge-server.mjs, as the run 19 brief quotes them), off unless a test asks:
//   drainFirst     answer S-DRAIN to the first N POST /generate: the body is read
//                  first, then 503, header Retry-After, the exact body below; the
//                  order is NOT registered, NOT built, and no callback follows
//   retryAfter     the Retry-After header value for S-DRAIN (a string; null = no
//                  header); retryAfterSeq, when set, gives one value per refusal
//   drainAlways    answer S-DRAIN to every POST /generate
//   reject         { status, contentType, body } answer every POST /generate
//                  with exactly this (the controls: a 503 without the draining
//                  body, a 500, an HTML page)
//   stopAfterMs    accept (202), then after this long send S-STOP's ONE callback
//                  instead of a result; stopTimes = how many builds (in accept
//                  order) are stopped (Infinity = every one); later builds normal
//   lateNormalAfterMs  after an S-STOP, ALSO post the stopped id's normal result
//                  this long after the S-STOP (the old instance finished after
//                  all); lateCarriesJobId adds maveloperJobId to that callback
//   dedupe         ONE BUILD PER bridgeJobId: a POST whose id is already held
//                  answers 202 { status: "duplicate" } and builds nothing
//                  (bridge-server.mjs:286-297 at cd03753f)
// Every refusal is in `drains`, every S-STOP in `stops`.
export const DRAIN_BODY = '{"status":"draining","error":"This engine is shutting down for an update and takes no new orders. Send the order again: another engine takes it.","engineDraining":true}';
export const STOP_ERROR = "The engine was stopped before this order finished building, because the server running it was shut down. Nothing was delivered. Please place the order again.";
import { createServer } from "node:http";

export function createFakeEngine({ secret, log = () => {} } = {}) {
  const opts = {
    startupMs: 0,
    acceptDelayMs: 0,
    buildMs: 200,
    dieAfterAccept: false,
    callbackTwice: false,
    jobsRoute: true,
    slowHealthMs: 0,
    html: null,
    drainFirst: 0,
    drainAlways: false,
    retryAfter: "5",
    retryAfterSeq: null,
    reject: null,
    stopAfterMs: null,
    stopTimes: 0,
    lateNormalAfterMs: null,
    lateCarriesJobId: false,
    dedupe: false,
  };
  let readyAt = null;           // null = cold; a number = when start-up ends
  const jobs = new Map();       // bridgeJobId -> { state, accepted, payload }
  const builds = [];            // { bridgeJobId, at, maveloperJobId, hasToken }
  const health = [];            // timestamps of /health answered
  const callbacks = [];         // { bridgeJobId, status, at }
  const requests = [];          // { at, raw, payload } every POST /generate body as received
  const drains = [];            // { at, bridgeJobId, retryAfter } every S-DRAIN refusal
  const stops = [];             // { at, bridgeJobId, status } every S-STOP callback
  let stoppedSoFar = 0;
  const timers = new Set();

  const wait = (ms) => new Promise((r) => { const t = setTimeout(() => { timers.delete(t); r(); }, ms); timers.add(t); });

  async function untilReady() {
    if (readyAt === null) readyAt = Date.now() + opts.startupMs;
    const left = readyAt - Date.now();
    if (left > 0) await wait(left);
  }

  function send(res, code, body) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function postCallback(callbackUrl, body) {
    try {
      const r = await fetch(callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bridge-secret": secret },
        body: JSON.stringify(body),
      });
      callbacks.push({ bridgeJobId: body.bridgeJobId, status: r.status, at: Date.now() });
      log(`[fake-engine] callback ${body.bridgeJobId} -> ${r.status}`);
    } catch (e) {
      callbacks.push({ bridgeJobId: body.bridgeJobId, status: "threw " + e.message, at: Date.now() });
    }
  }

  const server = createServer(async (req, res) => {
    let raw = "";
    let aborted = false;
    req.on("aborted", () => { aborted = true; });
    res.on("close", () => { if (!res.writableEnded) aborted = true; });
    try {
      for await (const c of req) raw += c;
    } catch { return; }
    await untilReady();
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      if (opts.slowHealthMs) await wait(opts.slowHealthMs);
      if (aborted) return;
      health.push(Date.now());
      return send(res, 200, { status: "ok", claudeCliAvailable: true, bridgeVersion: "fake" });
    }

    const jm = /^\/jobs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && jm) {
      if (!opts.jobsRoute) return send(res, 404, { error: "Not found" });
      if (req.headers["x-bridge-secret"] !== secret) return send(res, 401, { error: "Unauthorized" });
      const j = jobs.get(decodeURIComponent(jm[1]));
      if (!j) return send(res, 404, { bridgeJobId: jm[1], known: false, instanceId: "fake-1" });
      return send(res, 200, { bridgeJobId: jm[1], known: true, state: j.state, instanceId: "fake-1" });
    }

    if (req.method === "POST" && url.pathname === "/generate") {
      if (req.headers["x-bridge-secret"] !== secret) return send(res, 401, { error: "Unauthorized" });
      let payload;
      try { payload = JSON.parse(raw); } catch { requests.push({ at: Date.now(), raw, payload: null }); return send(res, 400, { error: "Invalid JSON body" }); }
      requests.push({ at: Date.now(), raw, payload });
      const { bridgeJobId, callbackUrl } = payload;
      if (opts.reject) {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(opts.reject.status, { "content-type": opts.reject.contentType || "application/json" });
        return res.end(opts.reject.body);
      }
      // RUN 19 S-DRAIN: the body has been read; refused before registration.
      if (opts.drainAlways || drains.length < opts.drainFirst) {
        const ra = Array.isArray(opts.retryAfterSeq) ? opts.retryAfterSeq[drains.length % opts.retryAfterSeq.length] : opts.retryAfter;
        drains.push({ at: Date.now(), bridgeJobId, retryAfter: ra });
        if (res.writableEnded || res.destroyed) return;
        const h = { "content-type": "application/json" };
        if (ra !== null && ra !== undefined) h["retry-after"] = String(ra);
        res.writeHead(503, h);
        log(`[fake-engine] draining: refused ${bridgeJobId}`);
        return res.end(DRAIN_BODY);
      }
      if (!bridgeJobId || !callbackUrl) return send(res, 400, { error: "Missing bridgeJobId or callbackUrl" });
      if (opts.dedupe && jobs.has(bridgeJobId)) {
        return send(res, 202, { jobId: "dup", bridgeJobId, status: "duplicate" });
      }
      if (opts.acceptDelayMs) await wait(opts.acceptDelayMs);
      // THE REAL BRIDGE BUILDS WHETHER OR NOT THE CALLER IS STILL THERE once the
      // body is read (bridge-server.mjs:233-245): so does this one.
      const job = { state: "building", payload };
      jobs.set(bridgeJobId, job);
      builds.push({
        bridgeJobId,
        at: Date.now(),
        maveloperJobId: payload.maveloperJobId || null,
        hasToken: typeof payload.figmaToken === "string" && payload.figmaToken.length > 0,
        callerGone: aborted,
        raw,
        payload,
      });
      log(`[fake-engine] accepted ${bridgeJobId}${aborted ? " (caller already gone)" : ""}`);
      send(res, 202, { jobId: "fake_" + builds.length, bridgeJobId, status: "accepted" });

      if (opts.dieAfterAccept) {
        // the instance is shut down: the job is simply gone, no callback ever
        setTimeout(() => jobs.delete(bridgeJobId), 50);
        return;
      }
      const started = Date.now();
      // RUN 19 S-STOP: this build is stopped before it finishes.
      if (opts.stopAfterMs !== null && stoppedSoFar < opts.stopTimes) {
        stoppedSoFar++;
        await wait(opts.stopAfterMs);
        job.state = "calling-back";
        const stopBody = {
          bridgeJobId,
          ...(payload.maveloperJobId ? { maveloperJobId: payload.maveloperJobId } : {}),
          error: STOP_ERROR,
          exitCode: null,
          signal: "SIGTERM",
          engineStopped: true,
          elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
          stderr: "[fake build] section 2 of 5 written\n",
        };
        await postCallback(callbackUrl, stopBody);
        stops.push({ at: Date.now(), bridgeJobId, status: callbacks[callbacks.length - 1]?.status });
        job.state = "done";
        if (opts.lateNormalAfterMs !== null) {
          await wait(opts.lateNormalAfterMs);
          const html = `<!doctype html><html><body><table><tr><td>FAKE BUILD ${bridgeJobId}</td></tr></table></body></html>`;
          await postCallback(callbackUrl, {
            bridgeJobId,
            ...(opts.lateCarriesJobId && payload.maveloperJobId ? { maveloperJobId: payload.maveloperJobId } : {}),
            html,
            bytesGenerated: html.length,
            elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
            generatedAt: new Date().toISOString(),
          });
        }
        return;
      }
      await wait(opts.buildMs);
      job.state = "calling-back";
      const html = opts.html || `<!doctype html><html><body><table><tr><td>FAKE BUILD ${bridgeJobId}</td></tr></table></body></html>`;
      const body = {
        bridgeJobId,
        html,
        bytesGenerated: html.length,
        elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        generatedAt: new Date().toISOString(),
      };
      await postCallback(callbackUrl, body);
      if (opts.callbackTwice) await postCallback(callbackUrl, body);
      job.state = "done";
      return;
    }
    send(res, 404, { error: "Not found" });
  });

  return {
    opts,
    builds,
    health,
    callbacks,
    requests,
    drains,
    stops,
    jobs,
    set(o) { Object.assign(opts, o); },
    cold() { readyAt = null; },
    forget() { jobs.clear(); },
    async listen(port = 0) {
      await new Promise((r) => server.listen(port, "127.0.0.1", r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}
