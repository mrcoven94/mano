// Handles name the other party: a phone number or an Apple ID email. Both
// are normalized here so one person maps to one conversation.

export function normalizeHandle(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) {
    const lower = trimmed.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) return null;
    return lower;
  }
  const digits = trimmed.replace(/[^0-9+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) {
    if (!/^\+[1-9][0-9]{6,14}$/.test(digits)) return null;
    return digits;
  }
  if (!/^[0-9]{7,15}$/.test(digits)) return null;
  return `+${digits}`;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The conversation key. The raw handle never appears in a log line, a
// queue key or a Durable Object name; this hash does.
export async function hashId(value: string, pepper: string, domain: string): Promise<string> {
  return hmacSha256Hex(pepper, `${domain}:${value}`);
}

export async function hashHandle(handle: string, pepper: string): Promise<string> {
  return hashId(handle, pepper, "mano-handle:v1");
}

// Chat IDs are phone numbers on 1:1 chats. Logs carry this hash, never
// the ID itself.
export async function hashChatId(chatId: string, pepper: string): Promise<string> {
  return hashId(chatId, pepper, "mano-chat:v1");
}

// Deterministic idempotency key for one outbound bubble. Same
// conversation, turn and part always yields the same key, so a retry after
// a timeout replays instead of duplicating. The tag separates one-off
// bubbles (the "working on it" note) from numbered answer parts.
export function idempotencyKeyFor(handleHash: string, generation: number, turn: number, part: number, tag = ""): string {
  const base = `mano-${handleHash.slice(0, 16)}-g${generation}-t${turn}-p${part}`;
  return tag ? `${base}-${tag}` : base;
}
