import { describe, expect, it } from "vitest";
import { idempotencyKeyFor } from "@mano/channels";
import { INTRO_BUBBLE } from "../src/text.js";
import {
  TEST_CHANNEL,
  TEST_CHAT,
  TEST_HANDLE,
  TEST_HANDLE_HASH,
  inboundEvent,
  lifecycleEvent,
  makeHarness,
  runTurnAfterBatch,
} from "./helpers.js";

describe("turn batching", () => {
  it("answers three quick messages as one turn", async () => {
    const h = makeHarness();
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "First." }), "webhook")).toBe("queued");
    h.advance(500);
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "Second." }), "webhook")).toBe("queued");
    h.advance(500);
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_3", text: "Third." }), "webhook")).toBe("queued");
    expect(await h.runner.runDueTurn()).toBe("waiting");
    await runTurnAfterBatch(h);
    const prompts = (h.responder as unknown as { prompts: Array<{ texts: string[] }> }).prompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].texts).toEqual([["First.", "Second.", "Third."].join("\n")]);
    expect(h.channel.sends[0].text).toBe(INTRO_BUBBLE);
    expect(h.channel.readCalls).toEqual([TEST_CHAT]);
    expect(h.channel.typingCalls[0]).toEqual({ chatId: TEST_CHAT, state: "started" });
    expect(h.channel.typingCalls[h.channel.typingCalls.length - 1]).toEqual({ chatId: TEST_CHAT, state: "stopped" });
    expect(h.store.meta().introduced).toBe(true);
    expect(await h.runner.runDueTurn()).toBe("idle");
  });

  it("runs one turn at a time, in order", async () => {
    let release!: (text: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      responder: {
        name: "gated",
        respond: async () => {
          const text = await gate;
          return { bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in" };
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "One." }), "webhook");
    h.advance(3000);
    const first = h.runner.runDueTurn();
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "Two." }), "webhook");
    expect(await h.runner.runDueTurn()).toBe("running");
    release("Answer one.");
    expect(await first).toBe("ran");
    h.advance(3000);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(h.store.meta().turn).toBe(2);
  });
});

describe("dedupe", () => {
  it("ignores duplicate and replayed events", async () => {
    const h = makeHarness();
    const event = inboundEvent({ id: "evt_dup", text: "Hello." });
    expect(await h.runner.handleEvent(event, "webhook")).toBe("queued");
    expect(await h.runner.handleEvent(event, "webhook")).toBe("duplicate");
    expect(await h.runner.handleEvent(event, "reconcile")).toBe("duplicate");
    await runTurnAfterBatch(h);
    const prompts = (h.responder as unknown as { prompts: unknown[] }).prompts;
    expect(prompts).toHaveLength(1);
  });

  it("skips stale inbound but records it", async () => {
    const h = makeHarness();
    const event = inboundEvent({ id: "evt_old", text: "Ancient.", occurredAtMs: h.now - 10 * 60 * 1000 });
    expect(await h.runner.handleEvent(event, "reconcile")).toBe("stale");
    expect(await h.runner.handleEvent(event, "reconcile")).toBe("duplicate");
    expect(await h.runner.runDueTurn()).toBe("idle");
  });
});

describe("outbound lifecycle", () => {
  it("resolves out-of-order delivery events", async () => {
    const h = makeHarness({ replies: ["Short answer."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi." }), "webhook");
    await runTurnAfterBatch(h);
    const answer = h.channel.sends.find((s) => s.text === "Short answer.")!;
    expect(answer).toBeDefined();
    await h.runner.handleEvent(lifecycleEvent("message.read", "evt_read", answer.messageId), "webhook");
    await h.runner.handleEvent(lifecycleEvent("message.delivered", "evt_dlv", answer.messageId), "webhook");
    const row = h.store.outboundByMessageId(answer.messageId)!;
    expect(row.state).toBe("read");
    await h.runner.handleEvent(lifecycleEvent("message.failed", "evt_fail", answer.messageId, "delivery_unconfirmed"), "webhook");
    expect(h.store.outboundByMessageId(answer.messageId)!.state).toBe("read");
  });

  it("records failures with the provider code", async () => {
    const h = makeHarness({ replies: ["Short answer."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi." }), "webhook");
    await runTurnAfterBatch(h);
    const answer = h.channel.sends.find((s) => s.text === "Short answer.")!;
    await h.runner.handleEvent(lifecycleEvent("message.failed", "evt_fail", answer.messageId, "service_unavailable"), "webhook");
    expect(h.store.outboundByMessageId(answer.messageId)).toMatchObject({ state: "failed", code: "service_unavailable" });
  });
});

describe("send reconcile", () => {
  it("replays the same key after a timeout without duplicating", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    const introKey = idempotencyKeyFor(TEST_HANDLE_HASH, 1, 0);
    h.channel.scriptFailure(introKey, { kind: "timeout-then-present", messageId: "msg_lost_1" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi." }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.filter((s) => s.idempotencyKey === introKey)).toHaveLength(1);
    expect(h.store.outboundByKey(introKey)).toMatchObject({ state: "sent", messageId: "msg_lost_1" });
  });

  it("creates one message when the first attempt never landed", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    const introKey = idempotencyKeyFor(TEST_HANDLE_HASH, 1, 0);
    h.channel.scriptFailure(introKey, { kind: "timeout-then-absent" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi." }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.filter((s) => s.idempotencyKey === introKey)).toHaveLength(1);
    expect(h.store.outboundByKey(introKey)!.state).toBe("sent");
  });
});

describe("refusals", () => {
  it("records a 403 once and never retries it", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    const answerKey = idempotencyKeyFor(TEST_HANDLE_HASH, 1, 1);
    h.channel.scriptFailure(answerKey, { kind: "refuse", status: 403, code: "conversation_content_restricted" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi." }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.outboundByKey(answerKey)).toMatchObject({ state: "refused", code: "conversation_content_restricted" });
    expect(h.channel.sends.filter((s) => s.idempotencyKey === answerKey)).toHaveLength(0);
  });

  it("records a 429 once and answers the next turn", async () => {
    const h = makeHarness({ replies: ["Answer one.", "Answer two."] });
    const answerKey = idempotencyKeyFor(TEST_HANDLE_HASH, 1, 1);
    h.channel.scriptFailure(answerKey, { kind: "refuse", status: 429, code: "conversation_streak_limit" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi." }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.outboundByKey(answerKey)).toMatchObject({ state: "refused", code: "conversation_streak_limit" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "Still here." }), "webhook");
    await runTurnAfterBatch(h);
    const turn2 = h.channel.sends.find((s) => s.idempotencyKey === idempotencyKeyFor(TEST_HANDLE_HASH, 2, 1))!;
    expect(turn2.text).toBe("Answer two.");
    expect(h.store.meta().introduced).toBe(true);
  });
});

describe("opt-out and close", () => {
  it("goes quiet on STOP until the person texts again", async () => {
    const h = makeHarness();
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_stop", text: "STOP" }), "webhook")).toBe("opted-out");
    expect(h.channel.sends).toHaveLength(1);
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_stop2", text: "STOP" }), "webhook")).toBe("opted-out");
    expect(h.channel.sends).toHaveLength(1);
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_back", text: "Hello again." }), "webhook")).toBe("queued");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.length).toBeGreaterThan(1);
    expect(h.store.meta().optedOut).toBe(false);
  });

  it("holds sends while closed and resumes on re-engagement", async () => {
    const h = makeHarness();
    await h.runner.handleEvent(
      { ...inboundEvent({ id: "evt_c" }), kind: "chat.closed", rawType: "chat.closed", text: null, direction: null },
      "webhook",
    );
    expect(h.store.meta().closed).toBe(true);
    const suppressed = await h.runner.sendBubble({ turn: 1, part: 1, tag: "", text: "Nope.", chatId: TEST_CHAT, to: TEST_HANDLE });
    expect(suppressed).toMatchObject({ state: "refused", code: "conversation_closed" });
    expect(h.channel.sends).toHaveLength(0);
    await h.runner.handleEvent(inboundEvent({ id: "evt_back", text: "I am back." }), "webhook");
    expect(h.store.meta().closed).toBe(false);
    await runTurnAfterBatch(h);
    expect(h.channel.sends.length).toBeGreaterThan(0);
  });
});

describe("limits", () => {
  it("says busy once an hour, then stays quiet", async () => {
    const h = makeHarness();
    const meta = h.store.meta();
    meta.hourKey = new Date(h.now).toISOString().slice(0, 13);
    meta.hourCount = 20;
    meta.dayKey = new Date(h.now).toISOString().slice(0, 10);
    meta.dayCount = 20;
    h.store.saveMeta(meta);
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "One." }), "webhook");
    await runTurnAfterBatch(h);
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "Two." }), "webhook");
    await runTurnAfterBatch(h);
    const busy = h.channel.sends.filter((s) => s.text.includes("busy"));
    expect(busy).toHaveLength(1);
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(0);
    h.advance(3600_000 + 1000);
    await h.runner.handleEvent(inboundEvent({ id: "evt_3", text: "Later." }), "webhook");
    await runTurnAfterBatch(h);
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(1);
  });

  it("holds turns when the daily model budget is spent", async () => {
    const h = makeHarness({ budgetUsd: 0.000001 });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hello." }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends).toHaveLength(1);
    expect(h.channel.sends[0].text).toContain("busy");
  });

  it("records real model spend", async () => {
    const h = makeHarness({
      responder: {
        name: "metered",
        respond: async () => ({ bubbles: ["Answer."], inputChars: 1000, outputChars: 1000, model: "muse-spark-1.3" }),
      },
      config: { usdPer1kChars: 0.01 },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi." }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.ledger.check(0).spentUsd).toBeCloseTo(0.02);
  });
});

describe("log safety", () => {
  it("never logs message text, names or numbers", async () => {
    const h = makeHarness({ replies: ["Answer SENTINEL-ZULU-9."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "My name is SENTINEL-ALPHA-7, call SENTINEL-555-0199." }), "webhook");
    await runTurnAfterBatch(h);
    await h.runner.handleEvent(
      lifecycleEvent("message.failed", "evt_f", h.channel.sends[0].messageId, "service_unavailable"),
      "webhook",
    );
    const logs = h.lines.join("\n");
    expect(logs).not.toContain("SENTINEL-ALPHA-7");
    expect(logs).not.toContain("SENTINEL-ZULU-9");
    expect(logs).not.toContain("SENTINEL-555-0199");
    expect(logs).not.toContain(TEST_HANDLE);
    const queued = h.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.eventId === "evt_1");
    expect(queued).toMatchObject({ event: "inbound_queued", eventId: "evt_1", handle: TEST_HANDLE_HASH });
  });
});

describe("first reply", () => {
  it("introduces Mano once, then answers", async () => {
    const h = makeHarness({ replies: ["Answer one.", "Answer two."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi Mano" }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends[0].text).toBe(INTRO_BUBBLE);
    expect(h.channel.sends[1].text).toBe("Answer one.");
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "More." }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends[2].text).toBe("Answer two.");
    expect(h.channel.sends.filter((s) => s.text === INTRO_BUBBLE)).toHaveLength(1);
    expect(TEST_CHANNEL).toBe("ch_test_line");
  });
});
