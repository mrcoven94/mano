// Logging carries event IDs, the hashed handle and states. Message text,
// names and numbers must never reach a log line; tests assert that with
// sentinel text.

export type LogFieldValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogFieldValue>;

export type LogSink = (line: string) => void;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export function formatLogLine(level: string, event: string, fields: LogFields = {}): string {
  return JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
}

export function createLogger(sink: LogSink = console.log): Logger {
  return {
    info: (event, fields) => sink(formatLogLine("info", event, fields)),
    warn: (event, fields) => sink(formatLogLine("warn", event, fields)),
  };
}

// What a log line may say about an error: its class name only. Messages
// can carry phone numbers, URLs and text, so they never reach a log.
export function errName(err: unknown): string {
  return err instanceof Error ? err.name || "Error" : "unknown";
}

// What a log line may say about an idempotency key: a hash of it.
// Caller-supplied keys are secrets, and derived keys carry handle-hash
// material, so neither is printed. Synchronous on purpose: the send path
// logs inline. Unkeyed and untruncated; it correlates lines for one send
// during debugging, nothing more.
export function logKeyHash(key: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
