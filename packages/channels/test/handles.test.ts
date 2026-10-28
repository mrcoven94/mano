import { describe, expect, it } from "vitest";
import { hashHandle, idempotencyKeyFor, normalizeHandle } from "../src/handles.js";

describe("normalizeHandle", () => {
  it("normalizes phone numbers", () => {
    expect(normalizeHandle("+1 (801) 920-3370")).toBe("+18019203370");
    expect(normalizeHandle("  +15551234567 ")).toBe("+15551234567");
    expect(normalizeHandle("15551234567")).toBe("+15551234567");
  });

  it("normalizes Apple ID emails", () => {
    expect(normalizeHandle("Jordan@Example.com")).toBe("jordan@example.com");
  });

  it("rejects junk", () => {
    expect(normalizeHandle("")).toBeNull();
    expect(normalizeHandle("not a handle")).toBeNull();
    expect(normalizeHandle("a@b")).toBeNull();
    expect(normalizeHandle("+")).toBeNull();
  });
});

describe("hashHandle", () => {
  it("is deterministic and pepper-sensitive", async () => {
    const a = await hashHandle("+15551234567", "pepper-one");
    const b = await hashHandle("+15551234567", "pepper-one");
    const c = await hashHandle("+15551234567", "pepper-two");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("idempotencyKeyFor", () => {
  it("is deterministic per conversation, generation, turn and part", () => {
    const key = idempotencyKeyFor("abc123", 0, 2, 1);
    expect(key).toBe(idempotencyKeyFor("abc123", 0, 2, 1));
    expect(key).not.toBe(idempotencyKeyFor("abc123", 0, 2, 2));
    expect(key).not.toBe(idempotencyKeyFor("abc123", 0, 3, 1));
    expect(key).not.toBe(idempotencyKeyFor("def456", 0, 2, 1));
    expect(key).not.toBe(idempotencyKeyFor("abc123", 1, 2, 1));
    expect(idempotencyKeyFor("abc123", 0, 2, 0, "interim")).not.toBe(idempotencyKeyFor("abc123", 0, 2, 0));
  });
});
