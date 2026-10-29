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
    for (const reply of ["This is Google Assistant. How can I help?", "I'm Alexa, your helper.", "You're chatting with Siri."]) {
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
