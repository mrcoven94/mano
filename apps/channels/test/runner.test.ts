import { describe, expect, it } from "vitest";
import { ChannelUncertain, RecordingChannel, ResponderFailed, idempotencyKeyFor } from "@mano/channels";
import { ConversationRunner, DEFAULT_RUNNER_CONFIG } from "../src/runner.js";
import { INTRO_BUBBLE } from "../src/text.js";
import {
  TEST_CHANNEL,
  TEST_CHAT,
  TEST_HANDLE,
  TEST_HANDLE_HASH,
  TEST_KEK_B64,
  inboundEvent,
  lifecycleEvent,
  makeHarness,
  runTurnAfterBatch,
} from "./helpers.js";

describe("turn batching", () => {
  it("answers three quick messages as one turn", async () => {
    const h = makeHarness();
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "First.", occurredAtMs: h.now }), "webhook")).toBe("queued");
    h.advance(500);
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "Second.", occurredAtMs: h.now }), "webhook")).toBe("queued");
    h.advance(500);
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_3", text: "Third.", occurredAtMs: h.now }), "webhook")).toBe("queued");
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

  it("answers over-cap input across turns, each input exactly once", async () => {
    const h = makeHarness({ replies: ["First answer.", "Second answer."] });
    const a = "a".repeat(4000);
    const b = "b".repeat(4000);
    await h.runner.handleEvent(inboundEvent({ id: "evt_a", text: a, occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_b", text: b, occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const prompts = (h.responder as unknown as { prompts: Array<{ texts: string[] }> }).prompts;
    expect(prompts).toHaveLength(2);
    expect(prompts[0].texts).toEqual([a]);
    expect(prompts[1].texts).toEqual([b]);
    expect(h.store.meta().turn).toBe(2);
    expect(h.store.pending()).toHaveLength(0);
  });

  it("carries the remainder of one oversized message into the next turn", async () => {
    const h = makeHarness({ replies: ["Answer one.", "Answer two."] });
    const big = "x".repeat(6000);
    await h.runner.handleEvent(inboundEvent({ id: "evt_big", text: big, occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const prompts = (h.responder as unknown as { prompts: Array<{ texts: string[] }> }).prompts;
    expect(prompts).toHaveLength(2);
    expect(prompts[0].texts[0]).toHaveLength(4000);
    expect(prompts[1].texts[0]).toHaveLength(2000);
    expect(prompts[0].texts[0] + prompts[1].texts[0]).toBe(big);
    expect(h.store.pending()).toHaveLength(0);
  });

  it("runs one turn at a time, in order", async () => {
    let release!: (text: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      responder: {
        name: "gated",
        maxAttempts: 1,
        respond: async () => {
          const text = await gate;
          return { text, bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1 };
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "One.", occurredAtMs: h.now }), "webhook");
    h.advance(3000);
    const first = h.runner.runDueTurn();
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "Two.", occurredAtMs: h.now }), "webhook");
    expect(await h.runner.runDueTurn()).toBe("running");
    release("Answer one.");
    expect(await first).toBe("ran");
    h.advance(3000);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(h.store.meta().turn).toBe(2);
  });
});

describe("groups", () => {
  const GROUP = { id: "grp_family", name: "Family" };

  it("records group messages and never answers them", async () => {
    const h = makeHarness();
    const event = inboundEvent({ id: "evt_grp", text: "Hi all.", chatId: "chat_group", group: GROUP, occurredAtMs: h.now });
    expect(await h.runner.handleEvent(event, "webhook")).toBe("recorded");
    expect(h.store.pending()).toHaveLength(0);
    expect(await h.runner.runDueTurn()).toBe("idle");
    expect(h.channel.sends).toHaveLength(0);
    expect(await h.runner.handleEvent(event, "webhook")).toBe("duplicate");
  });

  it("answers a private message in its own chat when a group message lands too", async () => {
    const h = makeHarness({ replies: ["Private answer."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_priv", text: "Private.", chatId: "chat_solo", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(
      inboundEvent({ id: "evt_grp", text: "Group.", chatId: "chat_group", group: GROUP, occurredAtMs: h.now }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(h.channel.sends.length).toBeGreaterThan(0);
    for (const send of h.channel.sends) {
      expect(send.chatId).toBe("chat_solo");
    }
  });

  it("runs one turn per 1:1 chat", async () => {
    const h = makeHarness({ replies: ["Answer A.", "Answer B."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_a", text: "Q A.", chatId: "chat_a", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_b", text: "Q B.", chatId: "chat_b", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.meta().turn).toBe(2);
    const toA = h.channel.sends.filter((s) => s.chatId === "chat_a").map((s) => s.text);
    const toB = h.channel.sends.filter((s) => s.chatId === "chat_b").map((s) => s.text);
    expect(toA).toContain("Answer A.");
    expect(toB).toContain("Answer B.");
    expect(toA).not.toContain("Answer B.");
    expect(toB).not.toContain("Answer A.");
  });
});

describe("interrupted turns", () => {
  function seedUnfinished(
    h: ReturnType<typeof makeHarness>,
    opts: { turn: number; answerJson?: string | null; costUsd?: number | null; costSettled?: boolean },
  ): void {
    const meta = h.store.meta();
    meta.turn = opts.turn;
    meta.chatId = TEST_CHAT;
    meta.to = TEST_HANDLE;
    meta.lastInboundMs = h.now - 5000;
    h.store.saveMeta(meta);
    h.store.addPending({
      eventId: "evt_crash",
      receivedAtMs: h.now - 5000,
      chatId: TEST_CHAT,
      to: TEST_HANDLE,
      text: "Do not lose this.",
      attachments: [],
      fromReconcile: false,
    });
    const items = h.store.pending();
    h.store.startTurn({
      turn: opts.turn,
      itemsJson: JSON.stringify(items),
      chatId: TEST_CHAT,
      to: TEST_HANDLE,
      answerJson: opts.answerJson ?? null,
      costUsd: opts.costUsd ?? null,
      costSettled: opts.costSettled ?? false,
      attempts: 0,
      state: "started",
      createdAtMs: h.now - 4000,
      updatedAtMs: h.now - 4000,
    });
  }

  it("resumes an interrupted turn instead of losing it", async () => {
    const h = makeHarness({ replies: ["Recovered answer."] });
    seedUnfinished(h, { turn: 5 });
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(h.store.meta().turn).toBe(5);
    expect(h.channel.sends.map((s) => s.text)).toContain("Recovered answer.");
    expect(h.store.pending()).toHaveLength(0);
    expect(h.store.unfinishedTurn()).toBeNull();
    expect(await h.runner.runDueTurn()).toBe("idle");
  });

  it("reuses the persisted answer without a second model call or duplicate", async () => {
    const h = makeHarness({ replies: ["Must not be used."] });
    const introKey = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 5, 0);
    seedUnfinished(h, {
      turn: 5,
      answerJson: JSON.stringify([
        { part: 0, tag: "", text: INTRO_BUBBLE },
        { part: 1, tag: "", text: "Persisted answer." },
      ]),
      costUsd: 0,
      costSettled: true,
    });
    h.store.addOutbound({
      key: introKey, turn: 5, part: 0, tag: "", text: INTRO_BUBBLE, attempts: 0, state: "sent", code: null,
      chatId: TEST_CHAT, messageId: "msg_intro_5", createdAtMs: h.now, updatedAtMs: h.now,
    });
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(0);
    expect(h.channel.sends.filter((s) => s.idempotencyKey === introKey)).toHaveLength(0);
    expect(h.channel.sends.map((s) => s.text)).toContain("Persisted answer.");
    expect(h.channel.sends).toHaveLength(1);
  });

  it("clears a stale running flag with no turn behind it", async () => {
    const h = makeHarness();
    const meta = h.store.meta();
    meta.running = true;
    h.store.saveMeta(meta);
    expect(await h.runner.runDueTurn()).toBe("idle");
    expect(h.store.meta().running).toBe(false);
  });
});

describe("delete", () => {
  it("bumps the generation and drops pre-delete events", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.length).toBeGreaterThan(0);
    h.store.wipe(h.now + 1000);
    const meta = h.store.meta();
    expect(meta.generation).toBe(1);
    expect(meta.deletedAtMs).toBe(h.now + 1000);
    expect(meta.turn).toBe(1);
    // A redelivered pre-delete event is recorded and dropped.
    const redelivery = inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now });
    expect(await h.runner.handleEvent(redelivery, "webhook")).toBe("dropped");
    expect(h.store.pending()).toHaveLength(0);
    expect(await h.runner.runDueTurn()).toBe("idle");
    // A new message starts a fresh generation with fresh keys.
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "Again.", occurredAtMs: h.now + 2000 }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.meta().turn).toBe(2);
    for (const send of h.channel.sends.slice(2)) {
      expect(send.idempotencyKey).toContain("-g1-");
    }
  });

  it("stops an in-flight turn instead of writing into the new generation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      responder: {
        name: "gated",
        maxAttempts: 1,
        respond: async () => {
          await gate;
          return { text: "Late.", bubbles: ["Late."], inputChars: 10, outputChars: 5, model: "stand-in", attempts: 1 };
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    h.advance(3000);
    const turn = h.runner.runDueTurn();
    await new Promise((r) => setTimeout(r, 10));
    h.store.wipe(h.now);
    release();
    expect(await turn).toBe("stopped");
    expect(h.channel.sends).toHaveLength(0);
    expect(h.store.outbounds()).toHaveLength(0);
  });

  it("never records a send that completed after a delete", async () => {
    const h = makeHarness();
    const wiping = {
      ...h.channel,
      send: async (input: Parameters<typeof h.channel.send>[0]) => {
        const result = await RecordingChannel.prototype.send.call(h.channel, input);
        h.store.wipe(h.now);
        return result;
      },
    };
    const runner = new ConversationRunner({
      store: h.store,
      channel: wiping as unknown as typeof h.channel,
      responder: h.responder,
      files: h.files,
      kekB64: TEST_KEK_B64,
      spend: {
        reserve: async (key: string, worst: number) => h.ledger.reserve(key, worst),
        settle: async (key: string, actual: number) => void h.ledger.settle(key, actual),
        release: async (key: string) => void h.ledger.release(key),
        byteReserve: async (key: string, bytes: number) => h.ledger.byteReserve(key, bytes),
        byteSettle: async (key: string, actual: number) => void h.ledger.byteSettle(key, actual),
        byteRelease: async (key: string) => void h.ledger.byteRelease(key),
      },
      logger: h.logger,
      nowMs: () => h.now,
      fetchFn: async () => new Response("missing", { status: 404 }),
      config: { handleHash: TEST_HANDLE_HASH, ...DEFAULT_RUNNER_CONFIG },
    });
    await expect(
      runner.sendBubble({ turn: 1, part: 1, tag: "", text: "Hi.", chatId: TEST_CHAT, to: TEST_HANDLE }),
    ).rejects.toThrow("generation moved on");
    expect(h.store.outbounds()).toHaveLength(0);
  });
});

describe("dedupe", () => {
  it("ignores duplicate and replayed events", async () => {
    const h = makeHarness();
    const event = inboundEvent({ id: "evt_dup", text: "Hello.", occurredAtMs: h.now });
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

  it("quarantines undated inbound instead of treating it as new", async () => {
    const h = makeHarness();
    const event = inboundEvent({ id: "evt_nodate", text: "No time.", occurredAtMs: null });
    expect(await h.runner.handleEvent(event, "webhook")).toBe("quarantined");
    expect(h.store.pending()).toHaveLength(0);
    expect(await h.runner.runDueTurn()).toBe("idle");
    expect(h.lines.join("\n")).toContain("inbound_quarantined");
  });
});

describe("outbound lifecycle", () => {
  it("resolves out-of-order delivery events", async () => {
    const h = makeHarness({ replies: ["Short answer."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
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
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const answer = h.channel.sends.find((s) => s.text === "Short answer.")!;
    await h.runner.handleEvent(lifecycleEvent("message.failed", "evt_fail", answer.messageId, "service_unavailable"), "webhook");
    expect(h.store.outboundByMessageId(answer.messageId)).toMatchObject({ state: "failed", code: "service_unavailable" });
  });

  it("holds a receipt that arrives before the send response", async () => {
    const h = makeHarness({ replies: ["Short answer."] });
    await h.runner.handleEvent(lifecycleEvent("message.delivered", "evt_early", "msg_test_1"), "webhook");
    expect(h.lines.join("\n")).toContain("receipt_held");
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.outboundByMessageId("msg_test_1")?.state).toBe("delivered");
  });

  it("ignores a receipt that names another chat", async () => {
    const h = makeHarness({ replies: ["Short answer."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const answer = h.channel.sends.find((s) => s.text === "Short answer.")!;
    const foreign = { ...lifecycleEvent("message.read", "evt_foreign", answer.messageId), chatId: "chat_other" };
    await h.runner.handleEvent(foreign, "webhook");
    expect(h.store.outboundByMessageId(answer.messageId)?.state).toBe("sent");
    expect(h.lines.join("\n")).toContain("receipt_unmatched");
  });
});

describe("send reconcile", () => {
  it("replays the same key after a timeout without duplicating", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    const introKey = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 0);
    h.channel.scriptFailure(introKey, { kind: "timeout-then-present", messageId: "msg_lost_1" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.filter((s) => s.idempotencyKey === introKey)).toHaveLength(1);
    expect(h.store.outboundByKey(introKey)).toMatchObject({ state: "sent", messageId: "msg_lost_1" });
  });

  it("creates one message when the first attempt never landed", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    const introKey = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 0);
    h.channel.scriptFailure(introKey, { kind: "timeout-then-absent" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.filter((s) => s.idempotencyKey === introKey)).toHaveLength(1);
    expect(h.store.outboundByKey(introKey)!.state).toBe("sent");
  });

  it("stays uncertain when the replay also fails, then resolves on a later tick", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    let failures = 2;
    const inner = h.channel.send.bind(h.channel);
    h.channel.send = async (input) => {
      if (failures > 0) {
        failures -= 1;
        throw new ChannelUncertain("Provider down in test.", 1);
      }
      return inner(input);
    };
    const opts = { turn: 1, part: 1, tag: "", text: "Answer.", chatId: TEST_CHAT, to: TEST_HANDLE };
    const first = await h.runner.sendBubble(opts);
    expect(first.state).toBe("uncertain");
    expect(h.channel.sends).toHaveLength(0);
    expect(h.channel.lookupCalls).toHaveLength(0);
    expect(h.lines.join("\n")).toContain("send_still_uncertain");
    expect(await h.runner.resolveUncertain()).toBe(1);
    const key = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 1);
    expect(h.store.outboundByKey(key)).toMatchObject({ state: "sent", text: "Answer." });
    expect(h.channel.sends).toHaveLength(1);
    expect(h.channel.sends[0].text).toBe("Answer.");
  });

  it("looks up a named message before replaying it", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    const opts = { turn: 1, part: 1, tag: "", text: "Answer.", chatId: TEST_CHAT, to: TEST_HANDLE };
    const key = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 1);
    await h.runner.sendBubble(opts);
    h.store.updateOutbound(key, { state: "uncertain" });
    const result = await h.runner.sendBubble(opts);
    expect(result).toMatchObject({ state: "sent", fresh: true });
    expect(h.channel.lookupCalls).toHaveLength(1);
    expect(h.channel.sends).toHaveLength(1);
    expect(h.lines.join("\n")).toContain("send_reconciled");
  });
});

describe("infrastructure retries", () => {
  it("keeps the turn and its input when settlement fails, then resumes", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const realSettle = h.ledger.settle.bind(h.ledger);
    let fails = 1;
    h.ledger.settle = (key: string, actual: number) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("ledger down");
      }
      return realSettle(key, actual);
    };
    expect(await h.runner.runDueTurn()).toBe("retry");
    expect(h.store.pending()).toHaveLength(1);
    expect(h.store.unfinishedTurn()).toMatchObject({ turn: 1, attempts: 1 });
    expect(h.channel.sends).toHaveLength(0);
    expect(h.lines.join("\n")).toContain("turn_infra_error");
    expect(h.runner.retryAfterMs()).toBe(5000);
    // The answer was already paid for, so the hold stays until the
    // retry's settlement succeeds.
    expect(h.ledger.reserve("probe:1", 5).allowed).toBe(false);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(h.channel.sends.map((s) => s.text)).toContain("Answer.");
    expect(h.store.pending()).toHaveLength(0);
    expect(h.store.unfinishedTurn()).toBeNull();
    expect(h.ledger.reserve("probe:1", 5).allowed).toBe(true);
    expect(h.ledger.spent().spentUsd).toBe(0);
  });

  it("retries when the reservation itself fails, without calling the model", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const realReserve = h.ledger.reserve.bind(h.ledger);
    let fails = 1;
    h.ledger.reserve = (key: string, worst: number) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("ledger down");
      }
      return realReserve(key, worst);
    };
    expect(await h.runner.runDueTurn()).toBe("retry");
    expect(h.store.pending()).toHaveLength(1);
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(0);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(h.channel.sends.map((s) => s.text)).toContain("Answer.");
  });

  it("keeps the turn and input when a send throws a generic error", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    let down = true;
    const inner = h.channel.send.bind(h.channel);
    h.channel.send = async (input) => {
      if (down) throw new Error("socket hangup");
      return inner(input);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    expect(await h.runner.runDueTurn()).toBe("retry");
    expect(h.store.pending()).toHaveLength(1);
    expect(h.store.unfinishedTurn()).toMatchObject({ turn: 1, attempts: 1 });
    expect(h.channel.sends).toHaveLength(0);
    down = false;
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(h.channel.sends).toHaveLength(2);
    expect(new Set(h.channel.sends.map((s) => s.idempotencyKey)).size).toBe(2);
    expect(h.store.pending()).toHaveLength(0);
  });

  it("retries uncertain replies on later alarms with no new input", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    let down = true;
    const inner = h.channel.send.bind(h.channel);
    h.channel.send = async (input) => {
      if (down) throw new ChannelUncertain("Provider down in test.", 1);
      return inner(input);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    expect(await h.runner.runDueTurn()).toBe("retry");
    const firstDelay = h.runner.retryAfterMs();
    expect(firstDelay).toBe(5000);
    expect(await h.runner.runDueTurn()).toBe("retry");
    expect(h.runner.retryAfterMs()).toBeGreaterThan(firstDelay);
    down = false;
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(h.channel.sends).toHaveLength(2);
    expect(new Set(h.channel.sends.map((s) => s.idempotencyKey)).size).toBe(2);
    expect(h.runner.needsRetry()).toBe(false);
  });

  it("keeps the spend hold until a failed settlement succeeds", async () => {
    // Budget 10 fits the $9.20 worst-case hold but not hold plus probe.
    const h = makeHarness({
      budgetUsd: 10,
      config: { usdPer1kChars: 1 },
      responder: {
        name: "metered",
        maxAttempts: 1,
        respond: async () => ({
          text: "Answer.",
          bubbles: ["Answer."],
          inputChars: 1000,
          outputChars: 1000,
          model: "muse-spark-1.3",
          attempts: 1,
        }),
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const realSettle = h.ledger.settle.bind(h.ledger);
    let fails = 1;
    h.ledger.settle = (key: string, actual: number) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("ledger down");
      }
      return realSettle(key, actual);
    };
    expect(await h.runner.runDueTurn()).toBe("retry");
    expect(h.ledger.reserve("probe:1", 2).allowed).toBe(false);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(h.ledger.spent().spentUsd).toBeCloseTo(2);
    expect(h.ledger.reserve("probe:1", 2).allowed).toBe(true);
  });

  it("releases the hold when the turn errors before paid work", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const realAnswer = h.store.updateTurnAnswer.bind(h.store);
    let fails = 1;
    h.store.updateTurnAnswer = ((...args: Parameters<typeof realAnswer>) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("storage down");
      }
      return realAnswer(...args);
    }) as typeof realAnswer;
    expect(await h.runner.runDueTurn()).toBe("retry");
    expect(h.ledger.reserve("probe:1", 5).allowed).toBe(true);
    h.ledger.release("probe:1");
    expect(await h.runner.runDueTurn()).toBe("ran");
  });
});

describe("refusals", () => {
  it("records a 403 once and never retries it", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    const answerKey = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 1);
    h.channel.scriptFailure(answerKey, { kind: "refuse", status: 403, code: "conversation_content_restricted" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.outboundByKey(answerKey)).toMatchObject({ state: "refused", code: "conversation_content_restricted" });
    expect(h.channel.sends.filter((s) => s.idempotencyKey === answerKey)).toHaveLength(0);
  });

  it("records a 429 once and answers the next turn", async () => {
    const h = makeHarness({ replies: ["Answer one.", "Answer two."] });
    const answerKey = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 1);
    h.channel.scriptFailure(answerKey, { kind: "refuse", status: 429, code: "conversation_streak_limit" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.outboundByKey(answerKey)).toMatchObject({ state: "refused", code: "conversation_streak_limit" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "Still here.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const turn2 = h.channel.sends.find((s) => s.idempotencyKey === idempotencyKeyFor(TEST_HANDLE_HASH, 0, 2, 1))!;
    expect(turn2.text).toBe("Answer two.");
    expect(h.store.meta().introduced).toBe(true);
  });

  it("records a definitive failure once and finishes the turn", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    const introKey = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 0);
    const answerKey = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 1);
    h.channel.scriptFailure(introKey, { kind: "fail", status: 404, code: "chat_not_found" });
    h.channel.scriptFailure(answerKey, { kind: "fail", status: 404, code: "chat_not_found" });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.outboundByKey(introKey)).toMatchObject({ state: "failed", code: "chat_not_found" });
    expect(h.store.outboundByKey(answerKey)).toMatchObject({ state: "failed", code: "chat_not_found" });
    expect(h.runner.needsRetry()).toBe(false);
    expect(await h.runner.runDueTurn()).toBe("idle");
  });

  it("counts refused sends toward the per-handle limits, once", async () => {
    const h = makeHarness();
    const key = idempotencyKeyFor(TEST_HANDLE_HASH, 0, 1, 1);
    h.channel.scriptFailure(key, { kind: "refuse", status: 403, code: "conversation_content_restricted" });
    const opts = { turn: 1, part: 1, tag: "", text: "Answer.", chatId: TEST_CHAT, to: TEST_HANDLE };
    const result = await h.runner.sendBubble(opts);
    expect(result).toMatchObject({ state: "refused", counted: true });
    expect(h.store.meta().hourCount).toBe(1);
    expect(h.store.meta().dayCount).toBe(1);
    const again = await h.runner.sendBubble(opts);
    expect(again.counted).toBe(false);
    expect(h.store.meta().hourCount).toBe(1);
  });
});

describe("opt-out and close", () => {
  it("goes quiet on STOP until the person texts again", async () => {
    const h = makeHarness();
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_stop", text: "STOP", occurredAtMs: h.now }), "webhook")).toBe("opted-out");
    expect(h.channel.sends).toHaveLength(1);
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_stop2", text: "STOP", occurredAtMs: h.now }), "webhook")).toBe("opted-out");
    expect(h.channel.sends).toHaveLength(1);
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_back", text: "Hello again.", occurredAtMs: h.now }), "webhook")).toBe("queued");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.length).toBeGreaterThan(1);
    expect(h.store.meta().optedOut).toBe(false);
  });

  it("holds sends while closed and resumes on re-engagement", async () => {
    const h = makeHarness();
    await h.runner.handleEvent(
      { ...inboundEvent({ id: "evt_c", occurredAtMs: h.now }), kind: "chat.closed", rawType: "chat.closed", text: null, direction: null },
      "webhook",
    );
    expect(h.store.meta().closed).toBe(true);
    const suppressed = await h.runner.sendBubble({ turn: 1, part: 1, tag: "", text: "Nope.", chatId: TEST_CHAT, to: TEST_HANDLE });
    expect(suppressed).toMatchObject({ state: "refused", code: "conversation_closed" });
    expect(h.channel.sends).toHaveLength(0);
    await h.runner.handleEvent(inboundEvent({ id: "evt_back", text: "I am back.", occurredAtMs: h.now }), "webhook");
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
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "One.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "Two.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const busy = h.channel.sends.filter((s) => s.text.includes("busy"));
    expect(busy).toHaveLength(1);
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(0);
    h.advance(3600_000 + 1000);
    await h.runner.handleEvent(inboundEvent({ id: "evt_3", text: "Later.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(1);
  });

  it("holds turns when the daily model budget is spent", async () => {
    const h = makeHarness({ budgetUsd: 0.000001 });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hello.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends).toHaveLength(1);
    expect(h.channel.sends[0].text).toContain("busy");
  });

  it("caps buffered inbound before the alarm", async () => {
    const h = makeHarness();
    const big = "x".repeat(4000);
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: big, occurredAtMs: h.now }), "webhook")).toBe("queued");
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: big, occurredAtMs: h.now }), "webhook")).toBe("queued");
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_3", text: "One more.", occurredAtMs: h.now }), "webhook")).toBe("recorded");
    expect(h.store.pending()).toHaveLength(2);
    expect(h.lines.join("\n")).toContain("inbound_capped");
  });

  it("records real model spend", async () => {
    const h = makeHarness({
      responder: {
        name: "metered",
        maxAttempts: 1,
        respond: async () => ({ text: "Answer.", bubbles: ["Answer."], inputChars: 1000, outputChars: 1000, model: "muse-spark-1.3", attempts: 2 }),
      },
      config: { usdPer1kChars: 0.01 },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    // Two attempts at 1000 input chars plus 1000 output chars at $0.01/1k.
    expect(h.ledger.spent().spentUsd).toBeCloseTo(0.03);
  });
});

describe("log safety", () => {
  it("never logs message text, names or numbers", async () => {
    const h = makeHarness({ replies: ["Answer SENTINEL-ZULU-9."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "My name is SENTINEL-ALPHA-7, call SENTINEL-555-0199.", occurredAtMs: h.now }), "webhook");
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

  it("never logs error message text, only the error name", async () => {
    const h = makeHarness({
      responder: {
        name: "exploding",
        maxAttempts: 1,
        respond: async () => {
          throw new Error("call +15550009999 exploded");
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const logs = h.lines.join("\n");
    expect(logs).toContain("responder_failed");
    expect(logs).not.toContain("+15550009999");
    expect(logs).toContain('"err":"Error"');
    expect(logs).toContain('"reason":null');
    const starved = makeHarness({
      responder: {
        name: "starved",
        maxAttempts: 1,
        respond: async () => {
          throw new ResponderFailed("Model run incomplete.", 1, 500, "run_incomplete");
        },
      },
    });
    await starved.runner.handleEvent(inboundEvent({ id: "evt_3", text: "Hi.", occurredAtMs: starved.now }), "webhook");
    await runTurnAfterBatch(starved);
    expect(starved.lines.join("\n")).toContain('"reason":"run_incomplete"');
    const h2 = makeHarness({ replies: ["Answer."] });
    await h2.runner.handleEvent(inboundEvent({ id: "evt_2", text: "Hi.", occurredAtMs: h2.now }), "webhook");
    h2.advance(h2.batchMs + 100);
    const realSettle = h2.ledger.settle.bind(h2.ledger);
    let fails = 1;
    h2.ledger.settle = (key: string, actual: number) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("sms +15550009999 failed");
      }
      return realSettle(key, actual);
    };
    expect(await h2.runner.runDueTurn()).toBe("retry");
    const logs2 = h2.lines.join("\n");
    expect(logs2).toContain("turn_infra_error");
    expect(logs2).not.toContain("+15550009999");
  });

  it("never logs phone-shaped chat IDs or email handles", async () => {
    const h = makeHarness({ replies: ["Answer."] });
    // 1:1 chat IDs are phone numbers on some providers; handles can be emails.
    await h.runner.handleEvent(
      inboundEvent({ id: "evt_pii", text: "SENTINEL-CHAT-3.", chatId: "+15550001999", handle: "sentinel.person@example.test", occurredAtMs: h.now }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    const logs = h.lines.join("\n");
    expect(logs).not.toContain("+15550001999");
    expect(logs).not.toContain("sentinel.person@example.test");
    expect(logs).not.toContain("SENTINEL-CHAT-3");
  });
});

describe("first reply", () => {
  it("introduces Mano once, then answers", async () => {
    const h = makeHarness({ replies: ["Answer one.", "Answer two."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hi Mano", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends[0].text).toBe(INTRO_BUBBLE);
    expect(h.channel.sends[1].text).toBe("Answer one.");
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "More.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends[2].text).toBe("Answer two.");
    expect(h.channel.sends.filter((s) => s.text === INTRO_BUBBLE)).toHaveLength(1);
    expect(TEST_CHANNEL).toBe("ch_test_line");
  });
});
