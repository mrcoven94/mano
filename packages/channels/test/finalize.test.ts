import { describe, expect, it } from "vitest";
import { CRISIS_LINE, CRISIS_LINE_ES, SELF_DESCRIPTION } from "@mano/persona";
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

describe("safety-05: the crisis line once, and the safety question still a question", () => {
  const noLinks = { checkUrl: async () => ({ ok: true, reason: "ok", host: "" }), checkHost: async () => ({ ok: true, reason: "ok", host: "" }) } as never;
  it("sends the Spanish line once, drops the model's repeat, and keeps ¿...?", async () => {
    const model = "Me alegra mucho que me lo hayas dicho.\nPor favor llama o manda texto al 988 ahora mismo.\nSi estás en peligro ahora mismo, llama al 911. estoy aquí contigo, estás a salvo en este momento";
    const out = await finalizeReply(model, { crisis: true, checker: noLinks, crisisLine: CRISIS_LINE_ES });
    expect(out.bubbles).toEqual([CRISIS_LINE_ES, "Me alegra mucho que me lo hayas dicho.", "estoy aquí contigo, ¿estás a salvo en este momento?"]);
  });

  it("does the same in English", async () => {
    const model = "I'm really glad you told me. Please call or text 988 right now, it's free and open 24/7\nif you're in danger right now, call 911. I'm here with you. are you safe at this moment";
    const out = await finalizeReply(model, { crisis: true, checker: noLinks });
    expect(out.bubbles).toEqual([CRISIS_LINE, "I'm really glad you told me.", "I'm here with you. are you safe at this moment?"]);
  });
});
