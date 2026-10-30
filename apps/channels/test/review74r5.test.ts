// Sol's final review of PR 74 at 307b660: four findings, each a runner
// test that failed before the fix, plus the one switch for all reactions.
import { describe, expect, it } from "vitest";
import { ChannelFailed, ChannelUncertain, type Responder, type RespondHooks, type TurnInput } from "@mano/channels";
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

function slow(text: string, ms: number): Responder {
  return {
    name: "slow",
    maxAttempts: 1,
    respond: async (_t: TurnInput, _h: RespondHooks = {}) => {
      await new Promise((r) => setTimeout(r, ms));
      return { text, bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1 };
    },
  };
}

describe("Sol final round, 1: the turn's epoch is captured before its first await", () => {
  it("sends no reaction when STOP and a re-engaging message land during the budget reservation", async () => {
    const h = introduced(makeHarness({ responder: reply("anytime!", "love") }));
    const reserve = h.ledger.reserve.bind(h.ledger);
    let once = true;
    (h.ledger as unknown as { reserve: (k: string, w: number) => Promise<unknown> }).reserve = async (key: string, worst: number) => {
      if (once) {
        once = false;
        await h.runner.handleEvent(inboundEvent({ id: "evt_stop", text: "STOP", occurredAtMs: h.now }), "webhook");
        h.advance(1000);
        await h.runner.handleEvent(inboundEvent({ id: "evt_back", text: "hi again", occurredAtMs: h.now }), "webhook");
      }
      return reserve(key, worst);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "thank you", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    await h.runner.runDueTurn();
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([]);
  });
});

describe("Sol final round, 2: the eyes are sent at most once", () => {
  it("never re-sends the eyes when the turn runs again after a crash", async () => {
    const h = introduced(makeHarness({ responder: slow("here it is", 60), config: { eyesAfterMs: 10 } }));
    let eyes = 0;
    const react = h.channel.react.bind(h.channel);
    h.channel.react = async (chatId, messageId, reaction) => {
      if (reaction === EYES) eyes += 1;
      return react(chatId, messageId, reaction);
    };
    const save = h.store.updateTurnAnswer.bind(h.store);
    let crash = true;
    h.store.updateTurnAnswer = (...args: Parameters<typeof save>) => {
      if (crash) {
        crash = false;
        throw new Error("crash before the answer was saved");
      }
      return save(...args);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "can you look at my case", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    expect(await h.runner.runDueTurn()).toBe("retry");
    await h.decorations.idle();
    expect(eyes).toBe(1);
    await h.runner.runDueTurn();
    await h.decorations.idle();
    expect(eyes).toBe(1);
    expect(h.store.outbounds().filter((r) => r.tag === "eyes")).toHaveLength(1);
  });
});

describe("Sol final round, 3: the eyes are a status signal, not a sentiment", () => {
  it("puts the eyes on a slow turn about bad news", async () => {
    const h = introduced(makeHarness({ responder: slow("that's a hard one. let's look at the letter", 60), config: { eyesAfterMs: 10 } }));
    await say(h, "evt_1", "they denied my medicaid");
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual([EYES]);
  });

  it("still puts no sentiment reaction on bad news", async () => {
    const h = introduced(makeHarness({ responder: reply("that's a hard one", "love") }));
    await say(h, "evt_1", "thanks, they denied my medicaid");
    expect(h.channel.reactions).toEqual([]);
  });

  it("puts no eyes on a reaction text", async () => {
    const h = introduced(makeHarness({ responder: slow("ok", 60), config: { eyesAfterMs: 10 } }));
    await say(h, "evt_1", "Loved “your renewal is due Friday”");
    expect(h.channel.reactions).toEqual([]);
  });
});

describe("Sol final round, 4: a reaction only after the reply's words were accepted", () => {
  it("drops the reaction when the reply's text is refused (422)", async () => {
    const h = introduced(makeHarness({ responder: reply("anytime!", "love") }));
    h.channel.send = async () => {
      throw new ChannelFailed(422, "invalid", "refused in test");
    };
    await say(h, "evt_1", "thank you").catch(() => []);
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([]);
  });

  it("drops the reaction when the reply's text outcome is unknown", async () => {
    const h = introduced(makeHarness({ responder: reply("anytime!", "love") }));
    h.channel.send = async () => {
      throw new ChannelUncertain("down in test", 1);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "thank you", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    await h.runner.runDueTurn();
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([]);
  });
});

describe("one switch turns off every reaction and the eyes", () => {
  it("sends no reaction and no eyes when reactions are off", async () => {
    const thanks = introduced(makeHarness({ responder: reply("anytime!", "love"), config: { reactionsEnabled: false } }));
    expect(await say(thanks, "evt_1", "thank you")).toEqual(["anytime!"]);
    expect(thanks.channel.reactions).toEqual([]);
    const slowTurn = introduced(makeHarness({ responder: slow("here it is", 60), config: { eyesAfterMs: 10, reactionsEnabled: false } }));
    await say(slowTurn, "evt_1", "can you look at my case");
    expect(slowTurn.channel.reactions).toEqual([]);
  });

  it("is on by default and off only when MANO_REACTIONS_ENABLED is false", async () => {
    const { reactionsEnabled } = await import("../src/conversation.js");
    expect(reactionsEnabled({} as never)).toBe(true);
    expect(reactionsEnabled({ MANO_REACTIONS_ENABLED: "true" } as never)).toBe(true);
    expect(reactionsEnabled({ MANO_REACTIONS_ENABLED: "false" } as never)).toBe(false);
  });
});
