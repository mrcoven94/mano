import { describe, expect, it } from "vitest";
import { RecordingChannel, type NormalizedEvent, type Responder } from "@mano/channels";
import { TYPING_HOLD_CAP_MS } from "../src/runner.js";
import { OPT_OUT_BUBBLE } from "../src/text.js";
import { inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

function introduced(h: Harness): Harness {
  const meta = h.store.meta();
  meta.introduced = true;
  h.store.saveMeta(meta);
  return h;
}

async function say(h: Harness, id: string, text: string, overrides: Partial<NormalizedEvent> = {}): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now, ...overrides }), "webhook");
  await runTurnAfterBatch(h);
  return h.channel.sends.slice(before).map((s) => s.text);
}

function typingStart(id: string, at: number): NormalizedEvent {
  return { ...inboundEvent({ id, occurredAtMs: at }), kind: "typing.started", rawType: "typing.started", text: null, messageId: null };
}

function gated(text: string): { responder: Responder; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return {
    release,
    responder: {
      name: "gated",
      maxAttempts: 1,
      respond: async () => {
        await gate;
        return { text: "", bubbles: [], inputChars: 10, outputChars: 0, model: "stand-in", attempts: 1, tapback: "love", ...(text ? { text } : {}) };
      },
    },
  };
}

describe("PR 69 review, blocker 1: a tapback never erases the reply", () => {
  it("sends text when the safety rule rejects the tapback", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: love"] }));
    const sent = await say(h, "evt_1", "my benefits were denied");
    expect(h.channel.reactions).toEqual([]);
    expect(sent.length).toBeGreaterThan(0);
  });

  it("sends text when the tapback has no message to go on", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: love"] }));
    const sent = await say(h, "evt_1", "thank you!!", { messageId: null });
    expect(h.channel.reactions).toEqual([]);
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe("PR 69 review, blocker 2: a failed tapback falls back to text, and text never waits on a tapback", () => {
  it("still sends the words when the reaction call fails (PR 74 review 3: no reaction-only replies)", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: love\nanytime!"] }));
    h.channel.react = async () => {
      throw new Error("reaction rejected");
    };
    const sent = await say(h, "evt_1", "thank you!!");
    await h.decorations.idle();
    expect(sent).toEqual(["anytime!"]);
    expect(h.store.outbounds().some((r) => r.tag === "react" && r.state === "failed")).toBe(true);
  });

  it("sends the text before the tapback is even attempted", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: like\nI'll check in at 7"] }));
    let release!: () => void;
    const order: string[] = [];
    const realSend = h.channel.send.bind(h.channel);
    h.channel.send = async (input) => {
      order.push("text");
      return realSend(input);
    };
    h.channel.react = async () => {
      order.push("tapback");
      await new Promise<void>((resolve) => (release = resolve));
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "ok sounds good", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const turn = h.runner.runDueTurn();
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(["text", "tapback"]);
    release();
    await turn;
  });
});

describe("PR 69 review, blocker 3: tapbacks respect STOP", () => {
  it("sends no tapback after the person opts out mid-turn", async () => {
    const { responder, release } = gated("");
    const h = introduced(makeHarness({ responder }));
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "thank you!!", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const turn = h.runner.runDueTurn();
    await new Promise((r) => setTimeout(r, 10));
    await h.runner.handleEvent(inboundEvent({ id: "evt_stop", text: "STOP", occurredAtMs: h.now }), "webhook");
    release();
    await turn;
    expect(h.channel.reactions).toEqual([]);
    expect(h.channel.sends.map((s) => s.text)).toEqual([OPT_OUT_BUBBLE]);
  });
});

describe("PR 69 review, blocker 4: nested quotes", () => {
  it("still catches a stack name inside a quote inside a quote", async () => {
    const h = introduced(makeHarness({ replies: [`the note says 'try "Muse Spark" today'.`] }));
    const sent = (await say(h, "evt_1", "what does it say")).join(" ");
    expect(sent).not.toMatch(/muse|spark/i);
  });
});

describe("PR 69 review, should 6: one fixed hold deadline", () => {
  it("ignores later and duplicate typing starts for the pending turn", async () => {
    const h = introduced(makeHarness({ replies: ["one answer"] }));
    const start = h.now;
    await h.runner.handleEvent(typingStart("evt_t1", h.now), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "so the letter says", occurredAtMs: h.now }), "webhook");
    for (let i = 0; i < 3; i++) {
      h.advance(3000);
      await h.runner.handleEvent(typingStart(`evt_t${i + 2}`, h.now), "webhook");
      await h.runner.handleEvent(typingStart("evt_t1", h.now), "webhook");
    }
    h.now = start + TYPING_HOLD_CAP_MS + 100;
    expect(await h.runner.runDueTurn()).toBe("ran");
  });

  it("ignores a stale typing start", async () => {
    const h = introduced(makeHarness({ replies: ["answer"] }));
    await h.runner.handleEvent(typingStart("evt_old", h.now - TYPING_HOLD_CAP_MS - 1000), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hello?", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    expect(await h.runner.runDueTurn()).toBe("ran");
  });
});

describe("PR 69 review, should 7: no typing after the final stop", () => {
  it("drains an in-flight keepalive before stopping", async () => {
    const completed: string[] = [];
    let calls = 0;
    let releaseRefresh!: () => void;
    const channel = new RecordingChannel();
    channel.setTyping = async (_chatId, state) => {
      calls += 1;
      if (state === "started" && calls === 2) await new Promise<void>((resolve) => (releaseRefresh = resolve));
      completed.push(state);
    };
    let releaseModel!: () => void;
    const gate = new Promise<void>((resolve) => (releaseModel = resolve));
    const responder: Responder = {
      name: "slow",
      maxAttempts: 1,
      respond: async () => {
        await gate;
        return { text: "hey", bubbles: ["hey"], inputChars: 10, outputChars: 3, model: "stand-in", attempts: 1 };
      },
    };
    const h = introduced(makeHarness({ responder, config: { typingRefreshMs: 10 } }));
    (h.runner as unknown as { deps: { channel: RecordingChannel } }).deps.channel = channel;
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hi", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const turn = h.runner.runDueTurn();
    await new Promise((r) => setTimeout(r, 40));
    releaseModel();
    await new Promise((r) => setTimeout(r, 20));
    releaseRefresh();
    await turn;
    expect(completed[completed.length - 1]).toBe("stopped");
  });
});

describe("PR 69 review round 2: alternating typing never extends the hold", () => {
  it("answers by the first start plus the cap when every stop is followed by a new start", async () => {
    const h = introduced(makeHarness({ replies: ["one answer"] }));
    const t0 = h.now;
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "so the letter says", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(typingStart("evt_s0", h.now), "webhook");
    let ranAt: number | null = null;
    for (let i = 1; i <= 10 && ranAt === null; i++) {
      h.advance(3000);
      await h.runner.handleEvent({ ...typingStart(`evt_stop_${i}`, h.now), kind: "typing.stopped", rawType: "typing.stopped" }, "webhook");
      await h.runner.handleEvent(typingStart(`evt_start_${i}`, h.now), "webhook");
      if ((await h.runner.runDueTurn()) === "ran") ranAt = h.now;
    }
    expect(ranAt).not.toBeNull();
    expect(ranAt! - t0).toBeLessThanOrEqual(TYPING_HOLD_CAP_MS + 3000);
    expect(h.channel.sends.map((s) => s.text)).toEqual(["one answer"]);
  });
});
