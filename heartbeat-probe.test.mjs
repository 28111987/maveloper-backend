// heartbeat-probe.test.mjs - WHEN A HEARTBEAT MAY ASK THE ENGINE /health (19 NOV 2026).
// ---------------------------------------------------------------------------
// Run: node heartbeat-probe.test.mjs        (exit 0 = all pass)
//
// The engine runs containerConcurrency 1. A /health probe sent while it builds
// an order makes Cloud Run start a SECOND instance just to answer (engine chat,
// 19 NOV). An idle probe wakes an idle engine (1434d1d). So a beat probes only
// when the queue was read, nothing is processing and something is pending.
//
// Catches: a probe while an order is processing; a probe on an idle queue; a
// probe when the counts could not be read; and a beat that stops writing its
// own heartbeat when it does not probe (the console would read the runner dead).

import { createQueueRunner, heartbeatProbeDecision } from "./queue-runner.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  x FAIL:", msg); } };

// ── 1. the pure decision ────────────────────────────────────────────────────
const d = heartbeatProbeDecision;
ok(d({ processing: 0, pending: 0 }).probe === false, "idle queue: no probe");
ok(d({ processing: 1, pending: 0 }).probe === false, "processing: no probe");
ok(d({ processing: 1, pending: 3 }).probe === false, "processing with a backlog: still no probe");
ok(d({ processing: 0, pending: 1 }).probe === true, "pending only: probe (the engine is about to wake anyway)");
ok(d({ processing: null, pending: null }).probe === false, "counts unknown: no probe");
ok(d({ processing: null, pending: 2 }).probe === false, "processing unknown: no probe");
ok(d({ processing: 0, pending: null }).probe === false, "pending unknown: no probe");
ok(d(null).probe === false, "no counts object: no probe");
ok(/^idle - not probed/.test(d({ processing: 0, pending: 0 }).note), "the idle note keeps 1434d1d's words");
ok(/^building - not probed/.test(d({ processing: 1, pending: 0 }).note), "the building note says why");
ok(!/[\u2014\u2013]/.test([d({ processing: 0, pending: 0 }), d({ processing: 1, pending: 0 }), d(null)].map((x) => x.note).join(" ")), "no em or en dash in a note");

// ── 2. the runner's own heartbeat, against a fake Supabase and a fake fetch ──
function fakeDb(processing, pending, { countError = false } = {}) {
  const upserts = [];
  return {
    upserts,
    from(table) {
      return {
        select() {
          return {
            eq(_col, status) {
              if (countError) return Promise.resolve({ count: null, error: { message: "fetch failed" } });
              return Promise.resolve({ count: status === "processing" ? processing : pending, error: null });
            },
          };
        },
        upsert(row) { upserts.push({ table, row }); return Promise.resolve({ error: null }); },
      };
    },
  };
}

async function beat(processing, pending, opts = {}) {
  const db = fakeDb(processing, pending, opts);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200 }; };
  try {
    const r = createQueueRunner({
      supabaseAdmin: db,
      startFigmaJobAsync: async () => ({}),
      log: () => {},
      env: { MAC_BRIDGE_URL: "https://engine.test", ...(opts.env || {}) },
    });
    await r.heartbeat();
    return { calls, upserts: db.upserts, state: r.state };
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const b = await beat(1, 0);
  ok(b.calls.length === 0, "a beat during a build sends NO request to the engine");
  ok(b.upserts.length === 1 && b.upserts[0].row.engine_online === null, "...and writes engine_online NULL");
  ok(Boolean(b.upserts[0]?.row.runner_last_seen), "...and still writes its own heartbeat");
}
{
  const b = await beat(0, 0);
  ok(b.calls.length === 0, "an idle beat sends no request to the engine");
  ok(b.upserts[0]?.row.engine_online === null, "...and writes NULL");
}
{
  const b = await beat(0, 0, { countError: true });
  ok(b.calls.length === 0, "a beat that cannot read the queue sends no request");
  ok(Boolean(b.upserts[0]?.row.runner_last_seen), "...and still writes its own heartbeat");
}
{
  const b = await beat(0, 2);
  ok(b.calls.length === 1 && b.calls[0] === "https://engine.test/health", "a beat with only pending orders asks /health once");
  ok(b.upserts[0]?.row.engine_online === true, "...and writes what the engine answered");
}
{
  const b = await beat(1, 0, { env: { HEARTBEAT_ALWAYS: "1" } });
  ok(b.calls.length === 1, "HEARTBEAT_ALWAYS=1 still restores the old probe on every beat");
}

console.log(`heartbeat-probe.test.mjs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
