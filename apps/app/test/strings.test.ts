import { describe, expect, it } from "vitest";
import { en, es, stringsFor } from "../lib/strings";

describe("strings", () => {
  it("keeps English and Spanish keys in lockstep", () => {
    const enKeys = Object.keys(en).sort();
    const esKeys = Object.keys(es).sort();
    expect(esKeys).toEqual(enKeys);
  });

  it("leaves no string empty", () => {
    for (const value of [...Object.values(en), ...Object.values(es)]) {
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("names no model or provider in any user-visible string", () => {
    const banned = ["muse", "spark", "wonder", "glimmer", "meta", "openai", "anthropic", "llm"];
    for (const value of [...Object.values(en), ...Object.values(es)]) {
      for (const word of banned) {
        expect(value.toLowerCase()).not.toContain(word);
      }
    }
  });

  it("resolves both languages", () => {
    expect(stringsFor("en").send).toBe("Send");
    expect(stringsFor("es").send).toBe("Enviar");
  });
});
