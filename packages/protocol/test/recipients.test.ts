import { describe, expect, it } from "vitest";
import { RECIPIENT_NAMES, UNNAMED_RECIPIENT, recipientName } from "../src/index.js";

describe("recipient names", () => {
  it("names the sandbox portal the way the portal names itself", () => {
    expect(recipientName("sandbox-agency-portal")).toBe("the State Benefits Renewal Office test portal");
  });

  it("never hands back a raw ID it has no name for", () => {
    for (const id of ["sandbox:county-portal", "org:food-bank", "", "__proto__", "toString", "constructor"]) {
      expect(recipientName(id)).toBe(UNNAMED_RECIPIENT);
    }
    expect(UNNAMED_RECIPIENT).toBe("an office Mano has no name for");
  });

  it("gives every name as plain words, never an ID", () => {
    for (const [id, name] of Object.entries(RECIPIENT_NAMES)) {
      expect(name).not.toContain(id);
      expect(name).toMatch(/^[A-Za-z ]+$/);
    }
  });
});
