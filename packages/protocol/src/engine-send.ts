// Engine-to-Channels sends: how the engine signs a delivery (a due
// reminder) to Channels' POST /internal/agent-send, and how Channels
// verifies it. The secret is MANO_ENGINE_SEND_SECRET, held by the engine
// and Channels only; the agent's secret never signs these.
//
// Signed bytes: UTF-8 of
//   "mano-engine-send:v1\n" + METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n"
// followed by the raw request body bytes. METHOD is upper case, PATH is the
// URL path only (no scheme, host or query), TIMESTAMP is the decimal Unix
// seconds sent in x-mano-engine-timestamp. The signature is the lower-case
// hex HMAC-SHA256 in x-mano-engine-signature.
//
// The receiver recomputes METHOD and PATH from its own request, never from
// a header, accepts a timestamp within ENGINE_SEND_WINDOW_SECONDS of its
// clock, compares in constant time, and only then parses the body.
// Within the window a captured request can be replayed; Channels dedupes
// sends on the body's key, so a replay sends nothing new.

export const ENGINE_SEND_TIMESTAMP_HEADER = "x-mano-engine-timestamp";
export const ENGINE_SEND_SIGNATURE_HEADER = "x-mano-engine-signature";
export const ENGINE_SEND_WINDOW_SECONDS = 300;
const PREFIX = "mano-engine-send:v1";

function signedBytes(method: string, path: string, timestamp: string, body: string | Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`${PREFIX}\n${method.toUpperCase()}\n${path}\n${timestamp}\n`);
  const tail = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}

async function macKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signEngineSend(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: string | Uint8Array,
): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await macKey(secret, "sign"), signedBytes(method, path, timestamp, body) as BufferSource);
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type EngineSendRejection = "missing" | "bad_timestamp" | "stale" | "bad_signature";

export async function verifyEngineSend(
  secret: string | undefined,
  request: { method: string; path: string; timestamp: string | null; signature: string | null; body: string | Uint8Array },
  nowSeconds: number,
): Promise<{ ok: true } | { ok: false; reason: EngineSendRejection }> {
  if (!secret || !request.timestamp || !request.signature) return { ok: false, reason: "missing" };
  if (!/^[0-9]{1,12}$/.test(request.timestamp)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(nowSeconds - Number(request.timestamp)) > ENGINE_SEND_WINDOW_SECONDS) return { ok: false, reason: "stale" };
  if (!/^[0-9a-f]{64}$/.test(request.signature)) return { ok: false, reason: "bad_signature" };
  const mac = new Uint8Array(32);
  for (let i = 0; i < 32; i++) mac[i] = parseInt(request.signature.slice(i * 2, i * 2 + 2), 16);
  const ok = await crypto.subtle.verify(
    "HMAC",
    await macKey(secret, "verify"),
    mac as BufferSource,
    signedBytes(request.method, request.path, request.timestamp, request.body) as BufferSource,
  );
  return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
}
