import { describe, expect, it } from "vitest";
import { documentAad, decryptForPerson, encryptForPerson, sha256Hex } from "../src/crypto.js";

const KEK_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("envelope encryption", () => {
  it("round-trips bytes", async () => {
    const plaintext = new TextEncoder().encode("synthetic attachment bytes");
    const blob = await encryptForPerson(plaintext, KEK_B64, documentAad("person-a", "doc-1"));
    const back = await decryptForPerson(blob, KEK_B64, documentAad("person-a", "doc-1"));
    expect(new TextDecoder().decode(back)).toBe("synthetic attachment bytes");
  });

  it("refuses the wrong person or document", async () => {
    const blob = await encryptForPerson(new TextEncoder().encode("x"), KEK_B64, documentAad("person-a", "doc-1"));
    await expect(decryptForPerson(blob, KEK_B64, documentAad("person-b", "doc-1"))).rejects.toThrow();
    await expect(decryptForPerson(blob, KEK_B64, documentAad("person-a", "doc-2"))).rejects.toThrow();
  });

  it("hashes deterministically", async () => {
    expect(await sha256Hex("mano")).toBe(await sha256Hex(new TextEncoder().encode("mano")));
    expect(await sha256Hex("mano")).toMatch(/^[0-9a-f]{64}$/);
  });
});
