import { describe, expect, it } from "vitest";
import { idempotencyKeyFor } from "@mano/channels";
import { CRISIS_LINE, SELF_DESCRIPTION } from "@mano/persona";
import { BUSY_BUBBLE } from "../src/text.js";
import { BUSY_DAILY_CAP } from "../src/runner.js";
import { TEST_CHAT, TEST_HANDLE_HASH, inboundEvent, lifecycleEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

async function say(h: Harness, id: string, text: string): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now }), "webhook");
  await runTurnAfterBatch(h);
  return h.channel.sends.slice(before).map((s) => s.text);
}

describe("no silence on no-model paths, without detection (follow-up 1)", () => {
  it("answers every message over the budget with the busy and safety line", async () => {
    const h = makeHarness({ budgetUsd: 0 });
    expect(await say(h, "evt_1", "hello")).toContain(BUSY_BUBBLE);
    expect(await say(h, "evt_2", "are you there")).toEqual([BUSY_BUBBLE]);
    expect(await say(h, "evt_3", "hello again")).toEqual([BUSY_BUBBLE]);
  });

  it("sends Sol's self-harm messages the crisis line after a used busy notice", async () => {
    for (const message of ["I took a whole bottle of pills", "I plan to hang myself tonight"]) {
      const h = makeHarness({ budgetUsd: 0 });
      await say(h, "evt_1", "hello");
      expect(await say(h, "evt_2", message), message).toContain(CRISIS_LINE);
    }
  });

  it("caps busy replies per person per day, but never the crisis line", async () => {
    const h = makeHarness({ budgetUsd: 0 });
    let busy = 0;
    for (let i = 0; i < BUSY_DAILY_CAP + 3; i++) {
      busy += (await say(h, `evt_${i}`, `message ${i}`)).filter((t) => t === BUSY_BUBBLE).length;
    }
    expect(busy).toBe(BUSY_DAILY_CAP);
    expect(await say(h, "evt_after", "nobody is answering")).toEqual([]);
    expect(await say(h, "evt_crisis", "I plan to hang myself tonight")).toContain(CRISIS_LINE);
  });
});

describe("legacy sends from before the guard (should 6)", () => {
  function seedUncertain(h: Harness, text: string, messageId: string | null): string {
    const key = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 1, "");
    h.store.addOutbound({
      key, turn: 1, part: 1, tag: "", text, attempts: 1, state: "uncertain", code: null,
      chatId: TEST_CHAT, messageId, createdAtMs: h.now, updatedAtMs: h.now,
    });
    const meta = h.store.meta();
    meta.to = "+15550001001";
    meta.chatId = TEST_CHAT;
    h.store.saveMeta(meta);
    return key;
  }

  it("never replays an unguarded legacy text, and never changes the payload under its key", async () => {
    const h = makeHarness();
    const key = seedUncertain(h, "I'm Muse Spark! — here to help", null);
    await h.runner.resolveUncertain();
    expect(h.channel.sends).toEqual([]);
    expect(h.store.outboundByKey(key)).toMatchObject({ state: "failed", code: "unguarded_legacy", text: "I'm Muse Spark! — here to help" });
  });

  it("reconciles an unguarded legacy send that already landed, without sending again", async () => {
    const h = makeHarness();
    const landed = await h.channel.send({ to: "+15550001001", chatId: TEST_CHAT, text: "I'm Muse Spark! — here to help", idempotencyKey: "provider-side" });
    const key = seedUncertain(h, "I'm Muse Spark! — here to help", landed.messageId);
    await h.runner.resolveUncertain();
    expect(h.channel.sends).toHaveLength(1);
    expect(h.store.outboundByKey(key)?.state).toBe("sent");
  });

  it("still replays a guard-clean legacy text unchanged under its key", async () => {
    const h = makeHarness();
    const key = seedUncertain(h, "Bring the letter to the office.", null);
    await h.runner.resolveUncertain();
    expect(h.channel.sends.map((s) => [s.text, s.idempotencyKey])).toEqual([["Bring the letter to the office.", key]]);
  });
});

describe("PR 67 review, through the send path", () => {
  it("replaces contracted self-identities (blocker 1)", async () => {
    for (const reply of ["I'm an assistant powered by Microsoft.", "I’m built by Google."]) {
      const h = makeHarness({ replies: [reply] });
      const sent = await say(h, "evt_1", "who made you");
      expect(sent.slice(1), reply).toEqual([SELF_DESCRIPTION]);
    }
  });

  it("sends document explanations unchanged (should 3)", async () => {
    const reply = "This is Ohio's food assistance renewal form. Sign page 2.";
    const h = makeHarness({ replies: [reply] });
    expect((await say(h, "evt_1", "what is this form")).slice(1)).toEqual([reply]);
  });

  it("keeps a legacy send uncertain through a lookup outage, then lets a receipt settle it (should 2)", async () => {
    const h = makeHarness();
    const key = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 1, "");
    h.store.addOutbound({
      key, turn: 1, part: 1, tag: "", text: "I'm Muse Spark! — here to help", attempts: 0, state: "uncertain", code: null,
      chatId: TEST_CHAT, messageId: "msg_legacy_1", createdAtMs: h.now, updatedAtMs: h.now,
    });
    const realLookup = h.channel.lookupMessage.bind(h.channel);
    h.channel.lookupMessage = async () => {
      throw new Error("lookup down");
    };
    await h.runner.resolveUncertain();
    expect(h.store.outboundByKey(key)).toMatchObject({ state: "uncertain", attempts: 1 });
    expect(h.channel.sends).toEqual([]);
    expect(h.runner.needsRetry()).toBe(true);
    h.channel.lookupMessage = realLookup;
    await h.runner.handleEvent(lifecycleEvent("message.delivered", "evt_receipt", "msg_legacy_1"), "webhook");
    expect(h.store.outboundByKey(key)?.state).toBe("delivered");
    expect(h.channel.sends).toEqual([]);
  });
});

describe("PR 67 review round 2, through the send path", () => {
  it("replaces a self-reference that names a listed AI company or assistant (blocker 1)", async () => {
    // Round 4 rule 4: companies count in first person or a maker clause only.
    for (const reply of ["I'm Google Assistant. How can I help?", "I'm Alexa, your helper.", "I was made by Apple, I'm Siri."]) {
      const h = makeHarness({ replies: [reply] });
      const sent = (await say(h, "evt_1", "who is this")).slice(1).join(" ");
      expect(sent, reply).toContain(SELF_DESCRIPTION);
      expect(sent, reply).not.toMatch(/google|alexa|siri/i);
    }
  });

  it("sends a sentence about a form created by the county unchanged (regression 2)", async () => {
    const reply = "I'm reviewing a renewal form created by the county. Sign page 2.";
    const h = makeHarness({ replies: [reply] });
    expect((await say(h, "evt_1", "can you check this")).slice(1)).toEqual([reply]);
  });

  it("does not treat a bottle of water or formula as a crisis (regression 3)", async () => {
    for (const message of ["I took a bottle of water to my SNAP interview.", "I take a bottle of formula to daycare."]) {
      const h = makeHarness({ replies: ["Good, that works."] });
      const sent = await say(h, "evt_1", message);
      expect(sent.slice(1), message).toEqual(["Good, that works."]);
      expect(sent.join(" "), message).not.toContain(CRISIS_LINE);
    }
  });
});

describe("listed names in benefits help, through the send path (lead decision)", () => {
  it("sends a reply about Amazon and EBT unchanged", async () => {
    const reply = "I'd check whether Amazon takes your EBT card.";
    const h = makeHarness({ replies: [reply] });
    expect((await say(h, "evt_1", "can i use snap online")).slice(1)).toEqual([reply]);
  });
});

describe("a caseworker named Claude, through the send path (lead decision)", () => {
  it("sends the reply unchanged", async () => {
    const reply = "Your caseworker Claude will call Friday.";
    const h = makeHarness({ replies: [reply] });
    expect((await say(h, "evt_1", "when will they call")).slice(1)).toEqual([reply]);
  });
});

describe("PR 67 review round 3, through the send path", () => {
  it("puts 988 and 911 on a crisis turn the narrow detector missed (1)", async () => {
    const h = makeHarness({ replies: ["Can you tell me more?"] });
    const answer = (await say(h, "evt_1", "I am going to jump off a bridge")).slice(1).join(" ");
    expect(answer).toMatch(/\b988\b/);
    expect(answer).toMatch(/\b911\b/);
  });

  it("keeps the model's own words after the crisis line (1, made structural in round 4)", async () => {
    const h = makeHarness({ replies: ["Please call 911 right now. I'm here."] });
    const answer = (await say(h, "evt_1", "I am going to jump off a bridge")).slice(1);
    expect(answer[0]).toBe(CRISIS_LINE);
    expect(answer.join(" ")).toContain("Please call 911 right now. I'm here.");
  });

  it("replaces a maker clause with Meta anywhere in the sentence (2b)", async () => {
    const h = makeHarness({ replies: ["I'm Mano, powered by Meta. I can help with your renewal."] });
    expect((await say(h, "evt_1", "who are you")).slice(1)).toEqual(["I'm Mano, an automated assistant. I can help with your renewal."]);
  });

  it("sends an Amazon Fresh EBT explanation unchanged (2d)", async () => {
    const reply = "This is the Amazon Fresh page where you can use your EBT card.";
    const h = makeHarness({ replies: [reply] });
    expect((await say(h, "evt_1", "where do i shop online")).slice(1)).toEqual([reply]);
  });

  it("still replaces our own stack anywhere and other names in first-person identity (2a, 2c)", async () => {
    for (const reply of ["Mano runs on Llama.", "I am Amazon Nova.", "My name is Google."]) {
      const h = makeHarness({ replies: [reply] });
      expect((await say(h, "evt_1", "who are you")).slice(1), reply).toEqual([SELF_DESCRIPTION]);
    }
  });
});

describe("PR 67 review round 4, through the send path", () => {
  it("always opens a crisis answer with the fixed crisis line, and the cap never drops it (1)", async () => {
    const long = Array.from({ length: 100 }, () => "I'm here with you and we will get through tonight together.").join(" ");
    const h = makeHarness({ replies: [`Please call 911 now. ${long} Call 988.`] });
    const answer = (await say(h, "evt_1", "I want to die")).slice(1);
    expect(answer[0]).toBe(CRISIS_LINE);
    expect(answer.length).toBeLessThanOrEqual(4);
    expect(answer.join(" ")).toMatch(/\b988\b/);
    expect(answer.join(" ")).toMatch(/\b911\b/);
  });

  it("opens with the crisis line for Sol's two inputs, even after a generic reply (2)", async () => {
    for (const message of ["I want to slit my wrists", "I am going to throw myself off a bridge"]) {
      const h = makeHarness({ replies: ["Can you tell me more?"] });
      const answer = (await say(h, "evt_1", message)).slice(1);
      expect(answer[0], message).toBe(CRISIS_LINE);
    }
  });

  it("catches our stack anywhere (3)", async () => {
    for (const reply of ["I'm Mano, Meta's assistant.", "You're talking with Spark."]) {
      const h = makeHarness({ replies: [reply] });
      expect((await say(h, "evt_1", "who are you")).slice(1), reply).toEqual([SELF_DESCRIPTION]);
    }
  });

  it("sends Sol's two benefits sentences unchanged (4)", async () => {
    for (const reply of [
      "This is the Amazon Fresh page, where a virtual assistant can help you use your EBT card.",
      'On the renewal form, write "My name is Maria Garcia" and sign page 2.',
    ]) {
      const h = makeHarness({ replies: [reply] });
      expect((await say(h, "evt_1", "what do i do")).slice(1), reply).toEqual([reply]);
    }
  });
});

describe("the most common benefits sentence is not a crisis (lead decision)", () => {
  it("sends no crisis line for in danger of losing or of being", async () => {
    for (const message of ["I am in danger of losing my benefits.", "we're in danger of being evicted"]) {
      const h = makeHarness({ replies: ["Let's look at the letter. What date is on it?"] });
      const sent = await say(h, "evt_1", message);
      expect(sent.slice(1), message).toEqual(["Let's look at the letter. What date is on it?"]);
      expect(sent, message).not.toContain(CRISIS_LINE);
    }
  });

  it("still opens with the crisis line for explicit danger", async () => {
    for (const message of ["I'm in danger", "I am in immediate danger", "I'm not safe here"]) {
      const h = makeHarness({ replies: ["Can you tell me more?"] });
      expect((await say(h, "evt_1", message)).slice(1)[0], message).toBe(CRISIS_LINE);
    }
  });
});
