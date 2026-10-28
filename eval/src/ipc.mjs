// IPC model broker, child side. The system under test runs with no network
// at all; model calls and link checks travel over the fork IPC channel to
// the parent, which holds the key and an allowlist. brokerFetch is a
// fetch-compatible function: pass it as fetchImpl. Anything the parent
// denies rejects, and every caller fails closed.
//
// Protocol for third-party system entries (no import needed):
// - Parent to child once, when the broker is enabled:
//   { channel: "mano-eval-broker-hello", keyAvailable: bool }
// - Child to parent per fetch:
//   { channel: "mano-eval-broker", id, url, method, headers, body? }
// - Parent to child per fetch:
//   { channel: "mano-eval-broker", id, ok: true, statusOk, status, json }
//   or { channel: "mano-eval-broker", id, ok: false, error }
// The parent allows only POST https://api.meta.ai/v1/responses (key
// injected server-side) and GET https://security.cloudflare-dns.com/dns-query.
const CHANNEL = "mano-eval-broker";
const HELLO = "mano-eval-broker-hello";

export function childBroker({ timeoutMs = 120000, helloTimeoutMs = 5000 } = {}) {
  if (typeof process.send !== "function") return null;
  let nextId = 1;
  const pending = new Map();
  let helloResolve = null;
  const failAll = (err) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };
  process.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.channel === HELLO && helloResolve) {
      const r = helloResolve;
      helloResolve = null;
      r({ keyAvailable: msg.keyAvailable === true });
      return;
    }
    if (msg.channel !== CHANNEL || !pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve({ ok: msg.statusOk === true, status: msg.status ?? 0, json: async () => msg.json ?? null });
    else p.reject(new Error(msg.error || "broker denied the request"));
  });
  process.on("disconnect", () => failAll(new Error("broker disconnected")));
  const fetch = async (url, opts = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("broker timeout"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        process.send({
          channel: CHANNEL,
          id,
          url: String(url),
          method: opts.method || "GET",
          headers: opts.headers && typeof opts.headers === "object" ? opts.headers : {},
          body: typeof opts.body === "string" ? opts.body : undefined,
        });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  };
  // The parent announces itself right after fork. On timeout assume a key
  // and proceed: a broken broker then fails loudly per request, while a
  // missing key reports "not run" instead of fake errors.
  fetch.hello = () => new Promise((resolve) => {
    helloResolve = resolve;
    setTimeout(() => {
      if (helloResolve) {
        helloResolve = null;
        resolve({ keyAvailable: true });
      }
    }, helloTimeoutMs);
  });
  return fetch;
}
