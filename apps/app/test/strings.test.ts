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

  it("keeps the unavailable-document line free of any claim about sending", () => {
    expect(en.docUnavailable.toLowerCase()).not.toMatch(/sent|send/);
    expect(es.docUnavailable.toLowerCase()).not.toMatch(/envi/);
  });

  it("keeps tab titles short enough to fit a 320px phone", () => {
    // Four tabs share 320px, about 70px each, and a tab label at 12px fits
    // about ten characters.
    for (const strings of [en, es]) {
      for (const title of [strings.tabsAgent, strings.tabsApprovals, strings.tabsDeadlines, strings.tabsMore]) {
        expect(title.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it("tells a resident the demo is sample data, in words a resident uses", () => {
    expect(en.demoMode).toContain("sample data");
    expect(en.demoMode).toContain("real office");
    expect(es.demoMode).toContain("datos de ejemplo");
    expect(es.demoMode).toContain("oficina real");
    expect(`${en.demoMode} ${es.demoMode}`).not.toMatch(/engine|stand-in|motor|provisional/i);
  });

  it("does not use the imperative tab title as the name of the list", () => {
    // "Aprobar" on a button after a decision would read as approve again.
    expect(es.approvalsTitle).toBe("Aprobaciones");
    expect(es.tabsApprovals).toBe("Aprobar");
    expect(es.approvalsPending).toBe("Esperando su respuesta");
  });

  it("explains a failed code request in the person's language", () => {
    expect(en.codeNotSent).toMatch(/could not send/i);
    expect(es.codeNotSent).toMatch(/No pudimos enviar/);
  });

  it("keeps the working line from claiming the mail was sent or read", () => {
    expect(en.workingMail).not.toMatch(/\b(sent|read|reading|received)\b/i);
    expect(es.workingMail).not.toMatch(/\b(envi[óe]|envió|leyendo|leí|recibi)/i);
  });

  it("keeps the receipt's next step from promising what an office will do", () => {
    expect(en.receiptNext).toMatch(/cannot promise/);
    expect(es.receiptNext).toMatch(/no puede prometer/);
    expect(`${en.receiptNext} ${es.receiptNext}`).not.toMatch(/will (approve|answer|reply|decide)|aprobará|responderá/i);
  });

  it("keeps developer words out of everything a resident reads", () => {
    const developerWords = /\bengine\b|stand-in|\bmotor\b|demo flag|not configured|idempot|\bpolicy\b/i;
    for (const value of [...Object.values(en), ...Object.values(es)]) {
      expect(value).not.toMatch(developerWords);
    }
  });

  it("resolves both languages", () => {
    expect(stringsFor("en").send).toBe("Send");
    expect(stringsFor("es").send).toBe("Enviar");
  });
});
