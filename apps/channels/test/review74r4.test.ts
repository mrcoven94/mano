// Sol's fourth review of PR 74 at f7cb266: three reproductions, each a
// runner test that failed before the structural fix.
import { describe, expect, it } from "vitest";
import { ChannelUncertain, type Responder, type RespondHooks, type TurnInput } from "@mano/channels";
import { EYES } from "@mano/persona";
import { inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

function introduced(h: Harness): Harness {
  h.store.patchMeta({ introduced: true });
  return h;
}

async function say(h: Harness, id: string, text: string): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now }), "webhook");
  await runTurnAfterBatch(h);
  await h.decorations.idle();
  return h.channel.sends.slice(before).map((s) => s.text);
}

function reply(text: string, tapback: string | null): Responder {
  return {
    name: "fixed",
    maxAttempts: 1,
    respond: async () => ({ text, bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1, tapback: tapback as never }),
  };
}

// STOP (or a close), then a message sent after it that re-engages.
async function stopThenReengage(h: Harness, how: "stop" | "close"): Promise<void> {
  if (how === "stop") {
    await h.runner.handleEvent(inboundEvent({ id: "evt_stop", text: "STOP", occurredAtMs: h.now }), "webhook");
  } else {
    await h.runner.handleEvent({ ...inboundEvent({ id: "evt_close", occurredAtMs: h.now }), kind: "chat.closed", rawType: "chat.closed", text: null, messageId: null }, "webhook");
  }
  h.advance(1000);
  await h.runner.handleEvent(inboundEvent({ id: "evt_back", text: "hi again", occurredAtMs: h.now }), "webhook");
}

// Answers after `during` runs, with an optional heads-up.
function answersAfter(during: () => Promise<void>, text: string, tapback: string | null, headsUp = false): Responder {
  return {
    name: "during",
    maxAttempts: 1,
    respond: async (_t: TurnInput, hooks: RespondHooks = {}) => {
      await during();
      if (headsUp) await hooks.onHeadsUp?.("Let me look into that.");
      return { text, bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1, tapback: tapback as never };
    },
  };
}

describe("Sol round 4, repro 1: no late decoration after STOP or a close, even once the person re-engages", () => {
  for (const how of ["stop", "close"] as const) {
    it(`sends no reply reaction from a turn that ran across a ${how} and a re-engaging message`, async () => {
      let h!: Harness;
      h = introduced(makeHarness({ responder: answersAfter(() => stopThenReengage(h, how), "anytime!", "love") }));
      await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "thank you", occurredAtMs: h.now }), "webhook");
      h.advance(h.batchMs + 100);
      await h.runner.runDueTurn();
      await h.decorations.idle();
      expect(h.channel.reactions).toEqual([]);
    });

    it(`puts no eyes on a message from before a ${how}, even once the person re-engages`, async () => {
      let h!: Harness;
      h = introduced(makeHarness({ responder: answersAfter(() => stopThenReengage(h, how), "here it is", null, true) }));
      await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "can you look at my case", occurredAtMs: h.now }), "webhook");
      h.advance(h.batchMs + 100);
      await h.runner.runDueTurn();
      await h.decorations.idle();
      expect(h.channel.reactions.filter((r) => r.reaction === EYES)).toEqual([]);
    });
  }

  it("keeps the decoration epoch moving forward across STOP, a close, re-engagement and a delete", async () => {
    const h = introduced(makeHarness({ replies: ["ok"] }));
    const start = h.store.meta().decorationEpoch;
    await stopThenReengage(h, "stop");
    const afterStop = h.store.meta().decorationEpoch;
    expect(afterStop).toBeGreaterThan(start);
    await stopThenReengage(h, "close");
    expect(h.store.meta().decorationEpoch).toBeGreaterThan(afterStop);
    const beforeWipe = h.store.meta().decorationEpoch;
    h.store.wipe(h.now);
    expect(h.store.meta().decorationEpoch).toBeGreaterThan(beforeWipe);
  });
});

describe("Sol round 4, repro 2: bad news riding along with thanks", () => {
  for (const text of ["thanks, my benefits expired", "thanks, I'm homeless", "thank you, the shelter is full tonight", "ok, my car got towed"]) {
    it(`puts no reaction on "${text}"`, async () => {
      const h = introduced(makeHarness({ responder: reply("that's a lot. let's look at it together", text.startsWith("ok") ? "like" : "love") }));
      await say(h, "evt_1", text);
      expect(h.channel.reactions).toEqual([]);
    });
  }

  for (const [text, tapback] of [["thanks!!", "love"], ["thank you so much", "🙏"], ["ok sounds good", "like"], ["done, mailed it", "💪"], ["lol", "laugh"]] as const) {
    it(`still reacts to the short pure form "${text}"`, async () => {
      const h = introduced(makeHarness({ responder: reply("ha, ok", tapback) }));
      await say(h, "evt_1", text);
      expect(h.channel.reactions.map((r) => r.reaction)).toEqual([tapback]);
    });
  }
});

describe("Sol round 4, repro 3: a reaction is sent at most once", () => {
  it("never issues a reaction again on a resumed turn when the first call's outcome was unknown", async () => {
    const h = introduced(makeHarness({ responder: reply("anytime!", "love"), decorationTimeoutMs: 40 }));
    let calls = 0;
    let hang = true;
    h.channel.react = async () => {
      calls += 1;
      if (hang) await new Promise<never>(() => {});
    };
    let down = true;
    const send = h.channel.send.bind(h.channel);
    h.channel.send = async (input) => {
      if (down) throw new ChannelUncertain("Provider down in test.", 1);
      return send(input);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "thank you", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    expect(await h.runner.runDueTurn()).toBe("retry");
    await h.decorations.idle();
    expect(calls).toBe(1);
    down = false;
    hang = false;
    expect(await h.runner.runDueTurn()).toBe("ran");
    await h.decorations.idle();
    expect(calls).toBe(1);
    const row = h.store.outbounds().find((r) => r.tag === "react");
    expect(row?.state).toBe("sending");
  });
});
