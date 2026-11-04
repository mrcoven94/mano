import { describe, expect, it } from "vitest";
import { announceOptions, announcesByCall, liveRegionProps } from "../lib/live-region";

describe("live regions", () => {
  it("speaks through the call only on iOS, so no platform hears it twice", () => {
    expect(announcesByCall("ios")).toBe(true);
    expect(announcesByCall("android")).toBe(false);
    expect(announcesByCall("web")).toBe(false);
  });

  it("marks an urgent message as an alert that cuts in", () => {
    expect(liveRegionProps(true)).toEqual({ role: "alert", "aria-live": "assertive" });
    expect(announceOptions(true)).toEqual({ queue: false });
  });

  it("lets anything else wait its turn", () => {
    expect(liveRegionProps(false)).toEqual({ role: "status", "aria-live": "polite" });
    expect(announceOptions(false)).toEqual({ queue: true });
  });
});
