import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto.js";

describe("sha256Hex", () => {
  it("hashes deterministically", async () => {
    expect(await sha256Hex("mano")).toBe(await sha256Hex(new TextEncoder().encode("mano")));
    expect(await sha256Hex("mano")).toMatch(/^[0-9a-f]{64}$/);
  });
});
