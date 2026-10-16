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
  };
  let readyAt = null;           // null = cold; a number = when start-up ends
  const jobs = new Map();       // bridgeJobId -> { state, accepted, payload }
  const builds = [];            // { bridgeJobId, at, maveloperJobId, hasToken }
  const health = [];            // timestamps of /health answered
  const callbacks = [];         // { bridgeJobId, status, at }
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
      try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: "Invalid JSON body" }); }
      const { bridgeJobId, callbackUrl } = payload;
      if (!bridgeJobId || !callbackUrl) return send(res, 400, { error: "Missing bridgeJobId or callbackUrl" });
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
      });
      log(`[fake-engine] accepted ${bridgeJobId}${aborted ? " (caller already gone)" : ""}`);
      send(res, 202, { jobId: "fake_" + builds.length, bridgeJobId, status: "accepted" });

      if (opts.dieAfterAccept) {
        // the instance is shut down: the job is simply gone, no callback ever
        setTimeout(() => jobs.delete(bridgeJobId), 50);
        return;
      }
      const started = Date.now();
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
