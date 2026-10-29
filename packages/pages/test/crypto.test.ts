import { describe, expect, it } from "vitest";
import { decryptPage, encryptPage, pageAad } from "../src/crypto.js";

function kekB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("page envelope", () => {
  it("round trips through the seal", async () => {
    const kek = kekB64();
    const plain = new TextEncoder().encode('{"kind":"estimate"}');
    const sealed = await encryptPage(plain, kek, "page-id-1");
    expect(sealed.enc).toBe(true);
    const opened = await decryptPage(sealed, kek, "page-id-1");
    expect(new TextDecoder().decode(opened)).toBe('{"kind":"estimate"}');
  });

  it("refuses the wrong key or the wrong page id", async () => {
    const kek = kekB64();
    const sealed = await encryptPage(new TextEncoder().encode("hi"), kek, "page-a");
    await expect(decryptPage(sealed, kekB64(), "page-a")).rejects.toThrow();
    await expect(decryptPage(sealed, kek, "page-b")).rejects.toThrow();
  });

  it("binds the page id as associated data", () => {
    const a = pageAad("page-a");
    const b = pageAad("page-b");
    expect(new TextDecoder().decode(a)).toContain("page-a");
    expect(a).not.toEqual(b);
  });

  it("seals the same bytes differently each time", async () => {
    const kek = kekB64();
    const plain = new TextEncoder().encode("same");
    const one = await encryptPage(plain, kek, "p");
    const two = await encryptPage(plain, kek, "p");
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(two));
  });
});
