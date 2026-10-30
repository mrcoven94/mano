import { describe, expect, it } from "vitest";
import { CRISIS_LINE, SELF_DESCRIPTION } from "@mano/persona";
import { LinkChecker, OPT_OUT_BUBBLE, finalizeReply } from "../src/index.js";

const blocked = new LinkChecker({ fetchFn: (async () => new Response("down", { status: 503 })) as typeof fetch });

describe("finalizeReply (exported for Quality)", () => {
  it("guards, strips blocked links and splits one bubble per line", async () => {
    const out = await finalizeReply("I'm Muse Spark!\nsee https://blocked.example now", { modelIds: [], crisis: false, checker: blocked });
    expect(out.bubbles).toEqual([SELF_DESCRIPTION, "see (link removed) now"]);
    expect(out.removed).toBe(1);
  });

  it("puts the crisis line first on a crisis turn, and alone when there is no text", async () => {
    expect((await finalizeReply("Can you tell me more?", { crisis: true, checker: blocked })).bubbles[0]).toBe(CRISIS_LINE);
    expect((await finalizeReply("", { crisis: true, checker: blocked })).bubbles).toEqual([CRISIS_LINE]);
  });

  it("exports the opt-out text", () => {
    expect(OPT_OUT_BUBBLE).toContain("unsubscribed");
  });
});
