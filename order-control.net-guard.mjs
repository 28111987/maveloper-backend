// order-control.net-guard.mjs - TEST-ONLY PRELOAD for order-control.test.mjs (run 17).
//
//   node --import ./order-control.net-guard.mjs server.js
//
// figma-parser.js:24 and figma-image-export.js:22 hard-code https://api.figma.com,
// so the server under test would reach the real Figma. This preload rewrites
// every request to api.figma.com onto the local fake Figma the test serves
// ($OC_FIGMA_URL), lets requests to 127.0.0.1 / localhost through, and REFUSES
// everything else (Supabase, Railway, Dropbox, Google, Cloud Run): the request
// throws and one line {"ocNetRefused":"<host>"} goes to stderr so the test can
// count it. Nothing here is loaded in production; server.js is unchanged by it.
const realFetch = globalThis.fetch;
const FIGMA = process.env.OC_FIGMA_URL || "";

globalThis.fetch = async function guardedFetch(input, init) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(href);
  if (u.hostname === "api.figma.com" && FIGMA) {
    const to = FIGMA.replace(/\/$/, "") + u.pathname + u.search;
    return realFetch(to, init);
  }
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(input, init);
  process.stderr.write(JSON.stringify({ ocNetRefused: u.hostname }) + "\n");
  throw new Error(`order-control: network refused to ${u.hostname}`);
};
