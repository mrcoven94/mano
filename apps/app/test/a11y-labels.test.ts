import { describe, expect, it } from "vitest";
import { attachToggleLabel, tabLabel, voiceRecordLabel } from "../lib/a11y-labels";
import { en, es } from "../lib/strings";

describe("labels that follow state", () => {
  it("names the plus button for what it does now", () => {
    expect(attachToggleLabel(false, en)).toBe("Photograph your mail");
    expect(attachToggleLabel(true, en)).toBe("Close photo and voice options");
    expect(attachToggleLabel(false, es)).toBe("Fotografíe su correo");
    expect(attachToggleLabel(true, es)).toBe("Cerrar las opciones de fotos y voz");
  });

  it("names the mic for what it does now", () => {
    expect(voiceRecordLabel(false, en)).toBe("Voice note");
    expect(voiceRecordLabel(true, en)).toBe("Recording… tap to stop");
    expect(voiceRecordLabel(false, es)).toBe("Nota de voz");
    expect(voiceRecordLabel(true, es)).toBe("Grabando… toque para detener");
  });

  it("speaks a tab's badge count only when there is one", () => {
    expect(tabLabel("Approvals", { position: 2, total: 4, count: 2 }, "android", en)).toBe("Approvals, 2");
    expect(tabLabel("Approvals", { position: 2, total: 4, count: 0 }, "web", en)).toBe("Approvals");
    expect(tabLabel("More", { position: 4, total: 4 }, "android", en)).toBe("More");
  });

  it("says it is a tab and which one on iOS, in the person's language", () => {
    expect(tabLabel("Agent", { position: 1, total: 4 }, "ios", en)).toBe("Agent, tab, 1 of 4");
    expect(tabLabel("Approvals", { position: 2, total: 4, count: 1 }, "ios", en)).toBe("Approvals, 1, tab, 2 of 4");
    expect(tabLabel("Agente", { position: 1, total: 4 }, "ios", es)).toBe("Agente, pestaña, 1 de 4");
  });
});
