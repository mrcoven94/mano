import { describe, expect, it } from "vitest";
import { isToken, mintToken, PAGE_TTL_MS, tokenStorageId } from "../src/tokens.js";

describe("mintToken", () => {
  it("mints 128 bit tokens as 22 url safe chars", () => {
    for (let i = 0; i < 25; i++) {
      const token = mintToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isToken(token)).toBe(true);
    }
  });

  it("never repeats across a thousand mints", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(mintToken());
    expect(seen.size).toBe(1000);
  });

  it("rejects anything that is not a minted token", () => {
    expect(isToken("")).toBe(false);
    expect(isToken("short")).toBe(false);
    expect(isToken("A".repeat(22) + "=")).toBe(false);
    expect(isToken("A B_CDEFGHIJKLMNOPQRS")).toBe(false);
    expect(isToken(null)).toBe(false);
    expect(isToken(undefined)).toBe(false);
    expect(isToken(42)).toBe(false);
  });
});

describe("tokenStorageId", () => {
  it("derives a stable opaque id that is not the token", async () => {
    const token = mintToken();
    const id = await tokenStorageId(token);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain(token);
    expect(await tokenStorageId(token)).toBe(id);
  });

  it("derives different ids for different tokens", async () => {
    expect(await tokenStorageId(mintToken())).not.toBe(await tokenStorageId(mintToken()));
  });
});

describe("PAGE_TTL_MS", () => {
  it("is seven days", () => {
    expect(PAGE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
