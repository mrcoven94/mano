import { describe, expect, it } from "vitest";
import { b64decode, b64encode, b64ToUtf8, utf8ToB64 } from "../lib/base64";

describe("base64", () => {
  it("encodes known vectors", () => {
    expect(utf8ToB64("hello")).toBe("aGVsbG8=");
    expect(utf8ToB64("")).toBe("");
    expect(b64encode(new Uint8Array([255, 0, 254]))).toBe("/wD+");
  });

  it("round-trips bytes including multibyte text", () => {
    const original = "Fotografié mi correo 📬";
    expect(b64ToUtf8(utf8ToB64(original))).toBe(original);
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect([...b64decode(b64encode(bytes))]).toEqual([...bytes]);
  });

  it("rejects bad input", () => {
    expect(() => b64decode("abc")).toThrow("length");
    expect(() => b64decode("!!!!")).toThrow("character");
  });
});
