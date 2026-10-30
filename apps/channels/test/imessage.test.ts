import { describe, expect, it } from "vitest";
import type { NormalizedEvent, Responder } from "@mano/channels";
import { CRISIS_LINE } from "@mano/persona";
import { TYPING_HOLD_CAP_MS } from "../src/runner.js";
import { TEST_CHAT, inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

function introduced(h: Harness): Harness {
  const meta = h.store.meta();
  meta.introduced = true;
  h.store.saveMeta(meta);
  return h;
}

async function say(h: Harness, id: string, text: string): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now }), "webhook");
  await runTurnAfterBatch(h);
  // Reactions run outside the turn; wait for them.
  await h.decorations.idle();
  return h.channel.sends.slice(before).map((s) => s.text);
}

function typingEvent(kind: "typing.started" | "typing.stopped", id: string, at: number): NormalizedEvent {
  return { ...inboundEvent({ id, occurredAtMs: at }), kind, rawType: kind, text: null, messageId: null };
}

describe("tapbacks (LAP-636)", () => {
  it("answers thanks with words and a heart on top (every reply has words, PR 74 review 3)", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: love\nanytime!"] }));
    expect(await say(h, "evt_thx", "thank you!!")).toEqual(["anytime!"]);
    expect(h.channel.reactions).toEqual([{ chatId: TEST_CHAT, messageId: "msg_evt_thx", reaction: "love" }]);
  });

  it("sends a tapback plus text when the model writes both", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: like\nI'll check in at 7"] }));
    expect(await say(h, "evt_ok", "ok sounds good")).toEqual(["I'll check in at 7"]);
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual(["like"]);
  });

  it("never puts a heart on bad news, and never reacts in a crisis", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: love\nthat's a lot to get hit with"] }));
    expect(await say(h, "evt_bad", "they cut my food stamps. i have 2 kids")).toEqual(["that's a lot to get hit with"]);
    expect(h.channel.reactions).toEqual([]);
    const c = introduced(makeHarness({ replies: ["REACT: like\nI'm here."] }));
    const sent = await say(c, "evt_c", "I want to die");
    expect(sent[0]).toBe(CRISIS_LINE);
    expect(c.channel.reactions).toEqual([]);
  });
});

describe("typing (LAP-636)", () => {
  it("keeps the typing indicator alive while Mano works, then stops it", async () => {
    let release!: (text: string) => void;
    const gate = new Promise<string>((resolve) => (release = resolve));
    const slow: Responder = {
      name: "slow",
      maxAttempts: 1,
      respond: async () => {
        const text = await gate;
        return { text, bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1 };
      },
    };
    const h = introduced(makeHarness({ responder: slow, config: { typingRefreshMs: 15 } }));
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hi", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const turn = h.runner.runDueTurn();
    await new Promise((r) => setTimeout(r, 60));
    release("hey");
    await turn;
    const states = h.channel.typingCalls.map((t) => t.state);
    expect(states.filter((s) => s === "started").length).toBeGreaterThanOrEqual(2);
    expect(states[states.length - 1]).toBe("stopped");
  });

  it("stops typing when the model fails", async () => {
    const broken: Responder = {
      name: "broken",
      maxAttempts: 1,
      respond: async () => {
        throw new Error("model down");
      },
    };
    const h = introduced(makeHarness({ responder: broken }));
    await say(h, "evt_1", "hi");
    expect(h.channel.typingCalls[h.channel.typingCalls.length - 1].state).toBe("stopped");
  });

  it("holds the reply while the person is still typing", async () => {
    const h = introduced(makeHarness({ replies: ["one answer"] }));
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "so the letter says", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(typingEvent("typing.started", "evt_t1", h.now), "webhook");
    h.advance(h.batchMs + 100);
    expect(await h.runner.runDueTurn()).toBe("waiting");
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "that i owe money", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(typingEvent("typing.stopped", "evt_t2", h.now), "webhook");
    h.advance(h.batchMs + 100);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(h.channel.sends.map((s) => s.text)).toEqual(["one answer"]);
  });

  it("caps the hold so a stuck typing indicator never delays the reply past about 8 seconds", async () => {
    const h = introduced(makeHarness({ replies: ["answer"] }));
    await h.runner.handleEvent(typingEvent("typing.started", "evt_t1", h.now), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hello?", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    expect(await h.runner.runDueTurn()).toBe("waiting");
    h.advance(TYPING_HOLD_CAP_MS);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(TYPING_HOLD_CAP_MS).toBeLessThanOrEqual(8000);
  });

  it("marks the message read when Mano starts working", async () => {
    const h = introduced(makeHarness({ replies: ["ok"] }));
    await say(h, "evt_1", "hi");
    expect(h.channel.readCalls).toContain(TEST_CHAT);
  });
});

describe("inline replies (LAP-636)", () => {
  it("replies inline to the earlier question in a burst", async () => {
    const h = introduced(makeHarness({ replies: ["Friday, Nov 14"] }));
    await h.runner.handleEvent(inboundEvent({ id: "evt_q", text: "when is my renewal due?", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_x", text: "also hi lol", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.map((s) => [s.text, s.replyTo])).toEqual([["Friday, Nov 14", "msg_evt_q"]]);
  });

  it("does not reply inline to a single message", async () => {
    const h = introduced(makeHarness({ replies: ["Friday, Nov 14"] }));
    await say(h, "evt_q", "when is my renewal due?");
    expect(h.channel.sends[0].replyTo ?? null).toBeNull();
  });
});

describe("reaction webhooks (LAP-636)", () => {
  it("records a tapback on Mano's message and never approves anything", async () => {
    const h = introduced(makeHarness({ replies: ["Here is what I'd send."] }));
    await h.runner.requestApproval({ id: "apr_1", code: "ABCD12", summary: "Synthetic approval.", ttlMs: 3600_000 });
    await say(h, "evt_1", "draft it");
    const approvalMessage = h.channel.sends[0].messageId;
    const reaction: NormalizedEvent = {
      ...inboundEvent({ id: "evt_r", occurredAtMs: h.now }),
      kind: "reaction",
      rawType: "message.reaction",
      text: null,
      messageId: approvalMessage,
      reaction: { value: "like", action: "add" },
    };
    await h.runner.handleEvent(reaction, "webhook");
    h.advance(h.batchMs + 100);
    expect(await h.runner.runDueTurn()).toBe("idle");
    expect(h.store.pendingApprovals(h.now)).toHaveLength(1);
    expect(h.lines.join("\n")).toContain("reaction_received");
  });
});

describe("crisis first contact (LAP-636)", () => {
  it("skips the friendly intro and opens with the crisis line", async () => {
    const h = makeHarness({ replies: ["I'm here."] });
    const sent = await say(h, "evt_1", "I want to die");
    expect(sent[0]).toBe(CRISIS_LINE);
  });
});

describe("Spanish crisis (PR 69)", () => {
  it("opens a Spanish crisis turn with the Spanish crisis line", async () => {
    const { CRISIS_LINE_ES } = await import("@mano/persona");
    const h = makeHarness({ replies: ["Estoy aquí contigo."] });
    expect((await say(h, "evt_1", "quiero morir, ya no puedo más"))[0]).toBe(CRISIS_LINE_ES);
  });
});

describe("PR 69 review round 3, through the runner", () => {
  it("opens reflexive and future Spanish self-harm with the Spanish crisis line (1)", async () => {
    const { CRISIS_LINE_ES } = await import("@mano/persona");
    for (const message of ["voy a matarme", "me voy a hacer daño", "me quiero hacer daño", "estoy pensando en quitarme la vida"]) {
      const h = makeHarness({ replies: ["Estoy aquí contigo."] });
      const sent = await say(h, "evt_1", message);
      expect(sent[0], message).toBe(CRISIS_LINE_ES);
      expect(sent.join(" "), message).toMatch(/\b988\b.*\b911\b|\b911\b.*\b988\b/);
    }
  });

  it("catches Llama the model in Spanish and passes llama as call (2)", async () => {
    const leak = makeHarness({ replies: ["Uso Llama de código abierto para responderte."] });
    await leak.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hola", occurredAtMs: leak.now }), "webhook");
    await runTurnAfterBatch(leak);
    expect(leak.channel.sends.map((s) => s.text).join(" ")).not.toMatch(/llama/i);
    for (const reply of ["Llama al 911 si estás en peligro.", "Llama a tu oficina mañana.", "Llama 911 ahora."]) {
      const h = introduced(makeHarness({ replies: [reply] }));
      expect(await say(h, "evt_1", "qué hago"), reply).toEqual([reply]);
    }
  });
});

describe("Spanish benefits information survives the guard", () => {
  it("sends se llama unchanged", async () => {
    const h = introduced(makeHarness({ replies: ["La oficina se llama DSHS."] }));
    expect(await say(h, "evt_1", "cómo se llama la oficina")).toEqual(["La oficina se llama DSHS."]);
  });
});

describe("PR 69 final round: llama, through the runner", () => {
  it("catches Llama identity constructions", async () => {
    for (const reply of ["Llama powers me.", "My provider is llama.", "I'm powered by Llama.", "Mi proveedor es Llama."]) {
      const h = introduced(makeHarness({ replies: [reply] }));
      expect((await say(h, "evt_1", "who made you")).join(" "), reply).not.toMatch(/llama/i);
    }
  });

  it("keeps Spanish calls with times and phone numbers", async () => {
    for (const reply of ["Llama 24 horas antes de tu entrevista de SNAP.", "Llama 1-800-555-0100"]) {
      const h = introduced(makeHarness({ replies: [reply] }));
      expect(await say(h, "evt_1", "qué hago"), reply).toEqual([reply]);
    }
  });
});
