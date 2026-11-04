import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, timeZoneForState } from "../src/index.js";

// What a clock reads against UTC in winter and in summer, the thing a person
// sees when a nudge arrives. Stated by clock, not by zone name, so this table
// checks the answers from outside and does not repeat the one in the source.
const CLOCKS = {
  "GMT-05:00 GMT-04:00": ["CT", "DC", "DE", "FL", "GA", "IN", "KY", "MA", "MD", "ME", "MI", "NC", "NH", "NJ", "NY", "OH", "PA", "RI", "SC", "VA", "VT", "WV"],
  "GMT-06:00 GMT-05:00": ["AL", "AR", "IA", "IL", "KS", "LA", "MN", "MO", "MS", "ND", "NE", "OK", "SD", "TN", "TX", "WI"],
  "GMT-07:00 GMT-06:00": ["CO", "ID", "MT", "NM", "UT", "WY"],
  "GMT-07:00 GMT-07:00": ["AZ"],
  "GMT-08:00 GMT-07:00": ["CA", "NV", "OR", "WA"],
  "GMT-09:00 GMT-08:00": ["AK"],
  "GMT-10:00 GMT-10:00": ["HI"],
  "GMT-04:00 GMT-04:00": ["PR", "VI"],
  "GMT+10:00 GMT+10:00": ["GU", "MP"],
  "GMT-11:00 GMT-11:00": ["AS"],
};

function clock(zone: string): string {
  return [Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15)]
    .map((at) => {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at);
      return parts.find((part) => part.type === "timeZoneName")?.value;
    })
    .join(" ");
}

describe("timeZoneForState", () => {
  const cases = Object.entries(CLOCKS).flatMap(([expected, states]) => states.map((state) => [state, expected] as const));

  it("covers the 50 states, DC and the five territories", () => {
    expect(cases).toHaveLength(56);
    expect(new Set(cases.map(([state]) => state)).size).toBe(56);
  });

  it.each(cases)("%s reads %s, winter then summer", (state, expected) => {
    expect(clock(timeZoneForState(state))).toBe(expected);
  });

  it("reads a state however the profile wrote its case and spacing", () => {
    expect(timeZoneForState(" ny ")).toBe(timeZoneForState("NY"));
    expect(timeZoneForState("Hi")).toBe(timeZoneForState("HI"));
  });

  it("falls back to Pacific when the state is missing or unknown", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/Los_Angeles");
    for (const state of [null, undefined, "", "  ", "Atlantis", "ZZ", "__proto__", "constructor", "toString"]) {
      expect(timeZoneForState(state)).toBe(DEFAULT_TIME_ZONE);
    }
  });
});
