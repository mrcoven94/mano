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
    expect(tabLabel("Approvals", 2)).toBe("Approvals, 2");
    expect(tabLabel("Approvals", 0)).toBe("Approvals");
    expect(tabLabel("More")).toBe("More");
  });
});
