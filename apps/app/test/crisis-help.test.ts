import { afterEach, describe, expect, it } from "vitest";
import { crisisLineForSignIn, forgetCrisisLine, noteCrisisLine } from "../lib/crisis-help";

const T0 = 1_000_000;
const LINE = "Please call or text 988. Call 911.";

afterEach(() => forgetCrisisLine());

describe("crisis help across a sign-out", () => {
  it("keeps the line for the sign-in screen, then lets it go after a while", () => {
    expect(crisisLineForSignIn(T0)).toBeNull();
    noteCrisisLine(LINE, T0);
    expect(crisisLineForSignIn(T0 + 60_000)).toBe(LINE);
    expect(crisisLineForSignIn(T0 + 31 * 60_000)).toBeNull();
  });

  it("drops it when asked", () => {
    noteCrisisLine(LINE, T0);
    forgetCrisisLine();
    expect(crisisLineForSignIn(T0)).toBeNull();
  });
});
