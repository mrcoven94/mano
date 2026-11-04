import { describe, expect, it } from "vitest";
import { decideEngineMode } from "../lib/mode";

describe("decideEngineMode", () => {
  it("prefers a configured engine", () => {
    expect(decideEngineMode({ engineUrl: "https://engine.test", demo: false })).toEqual({ mode: "live" });
    expect(decideEngineMode({ engineUrl: "https://engine.test", demo: true })).toEqual({ mode: "live" });
  });

  it("runs the stand-in only with the demo flag", () => {
    expect(decideEngineMode({ engineUrl: null, demo: true })).toEqual({ mode: "stand-in" });
  });

  it("fails without either", () => {
    expect(decideEngineMode({ engineUrl: null, demo: false })).toEqual({ error: "missing-engine" });
  });
});
