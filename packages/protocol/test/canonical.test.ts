import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/index.js";

describe("canonical json rejects lone surrogates (RFC 8785 3.2.2.2)", () => {
  it("throws on unpaired surrogates and keeps paired ones", () => {
    expect(() => canonicalJson({ s: "lone high \ud800" })).toThrow(/surrogate/i);
    expect(() => canonicalJson({ s: "lone low \udcff" })).toThrow(/surrogate/i);
    expect(() => canonicalJson(["ok \ud83d\ude00"])).toBeTruthy();
  });
});
