import { describe, expect, it } from "vitest";
import { idempotencyKeyFor } from "@mano/channels";
import { CRISIS_LINE } from "@mano/persona";
import { BUSY_BUBBLE } from "../src/text.js";
import { BUSY_DAILY_CAP } from "../src/runner.js";
import { TEST_CHAT, TEST_HANDLE_HASH, inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

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
