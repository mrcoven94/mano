// Canonical JSON (RFC 8785) for hashing and signing: sorted object keys,
// no insignificant whitespace, shortest round-trip numbers. Shared by the
// protocol signatures and the gateway approval hashes so both sides agree
// on one byte form.

// Lone surrogates have no byte form to hash (RFC 8785 section 3.2.2.2),
// so they are rejected instead of silently stringified.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function canonicalString(s: string): string {
  if (LONE_SURROGATE.test(s)) {
    throw new Error("canonicalJson: lone surrogates cannot be hashed.");
  }
  return JSON.stringify(s);
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: only finite numbers can be hashed.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined && typeof record[key] !== "function")
      .sort();
    return `{${keys.map((key) => `${canonicalString(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("canonicalJson: only plain JSON values can be hashed.");
}
