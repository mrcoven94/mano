import { describe, expect, it } from "vitest";
import {
  AgentResponder,
  ChannelRefused,
  computeSignatureHex,
  idempotencyKeyFor,
  SparkResponder,
  StandInResponder,
} from "@mano/channels";
import { handleAgentSend } from "../src/index.js";
import { buildResponder } from "../src/conversation.js";
import type { Env } from "../src/env.js";
import { inboundEvent, makeHarness, TEST_HANDLE_HASH } from "./helpers.js";

const SECRET = "test-agent-secret-not-real";

function agentEnv(stub: (url: string, init: RequestInit) => Promise<Response>): Env {
  return {
    CONVERSATION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: stub }),
    } as unknown as Env["CONVERSATION"],
    CHANNEL_STATE: null as unknown as Env["CHANNEL_STATE"],
    EVENTS: null as unknown as Env["EVENTS"],
    FILES: null as unknown as Env["FILES"],
    BLOOIO_API_KEY: "",
    BLOOIO_CHANNEL_ID: "",
    BLOOIO_WEBHOOK_SECRET: "",
    MANO_HANDLE_PEPPER: "",
    ENCRYPTION_KEK_B64: "",
    MANO_AGENT_SECRET: SECRET,
    MANO_HANDLE_GRANT_SECRET: "test-grant-secret-not-real",
  };
}

async function signedSend(body: unknown, secret = SECRET): Promise<Request> {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = await computeSignatureHex(secret, String(t), raw);
  return new Request("https://channels.example.test/internal/agent-send", {
    method: "POST",
    headers: { "x-mano-timestamp": String(t), "x-mano-signature": v1 },
    body: raw,
  });
}

describe("agent-send ingress", () => {
  it("rejects bad signatures and bad bodies", async () => {
    const env = agentEnv(async () => Response.json({ sent: true }));
    const badSig = await handleAgentSend(await signedSend({ handleHash: "h", key: "k", text: "t" }, "wrong"), env);
    expect(badSig.status).toBe(401);
    const badBody = await handleAgentSend(await signedSend({ handleHash: "h" }), env);
    expect(badBody.status).toBe(400);
    const noGeneration = await handleAgentSend(await signedSend({ handleHash: "h", key: "k", text: "t" }), env);
    expect(noGeneration.status).toBe(400);
  });

  it("routes to the conversation and relays its answer", async () => {
    const seen: string[] = [];
    const env = agentEnv(async (url: string, init: RequestInit) => {
      seen.push(`${url} ${init.body}`);
      return Response.json({ sent: true }, { status: 200 });
    });
    const res = await handleAgentSend(await signedSend({ handleHash: "hh", key: "rem_1", text: "Reminder: call", generation: 3 }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, reason: null });
    expect(seen).toEqual(['https://conversation/internal/agent-send {"handleHash":"hh","key":"rem_1","text":"Reminder: call","generation":3}']);
  });

  it("relays budget backpressure as 429", async () => {
    const env = agentEnv(async () => Response.json({ sent: false, reason: "budget" }, { status: 429 }));
    const res = await handleAgentSend(await signedSend({ handleHash: "hh", key: "k", text: "t", generation: 0 }), env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ sent: false, reason: "budget" });
  });
});

describe("agent responder selection", () => {
  const base = agentEnv(async () => new Response("no"));
  it("uses the agent when configured, else the plain responder", () => {
    const agent = buildResponder({ ...base, AGENT_URL: "https://agent.example", META_MODEL_API_KEY: "k", MANO_REPLY_MODEL: "muse-spark-1.3" }, TEST_HANDLE_HASH);
    expect(agent).toBeInstanceOf(AgentResponder);
    expect(agent.name).toBe("agent");
    const spark = buildResponder({ ...base, META_MODEL_API_KEY: "k", MANO_REPLY_MODEL: "muse-spark-1.3" }, TEST_HANDLE_HASH);
    expect(spark).toBeInstanceOf(SparkResponder);
    const standin = buildResponder({ ...base }, TEST_HANDLE_HASH);
    expect(standin).toBeInstanceOf(StandInResponder);
    // Without a handle there is no conversation address, so no agent.
    expect(buildResponder({ ...base, AGENT_URL: "https://agent.example" })).toBeInstanceOf(StandInResponder);
  });
});

describe("runner.sendAgentText", () => {
  function chatting(): ReturnType<typeof makeHarness> {
    const h = makeHarness();
    const meta = h.store.meta();
    meta.chatId = "chat_agent";
    meta.to = "+15550001001";
    h.store.saveMeta(meta);
    return h;
  }

  it("sends through the normal outbound path", async () => {
    const h = chatting();
    const result = await h.runner.sendAgentText({ key: "rem_1", text: "Reminder: call the office", generation: 0 });
    expect(result).toEqual({ sent: true });
    expect(h.channel.sends.map((s) => s.text)).toEqual(["Reminder: call the office"]);
    expect(h.store.agentSend("rem_1")?.state).toBe("sent");
  });

  it("dedupes redeliveries under the same key", async () => {
    const h = chatting();
    await h.runner.sendAgentText({ key: "rem_1", text: "Reminder: call", generation: 0 });
    const retry = await h.runner.sendAgentText({ key: "rem_1", text: "Reminder: call", generation: 0 });
    expect(retry).toEqual({ sent: true, duplicate: true });
    expect(h.channel.sends).toHaveLength(1);
  });

  it("refuses opted-out, closed, and unknown conversations", async () => {
    const h = chatting();
    const meta = h.store.meta();
    meta.optedOut = true;
    h.store.saveMeta(meta);
    expect(await h.runner.sendAgentText({ key: "a", text: "hi", generation: 0 })).toEqual({ sent: false, reason: "opted_out" });
    meta.optedOut = false;
    meta.closed = true;
    h.store.saveMeta(meta);
    expect(await h.runner.sendAgentText({ key: "b", text: "hi", generation: 0 })).toEqual({ sent: false, reason: "closed" });
    const fresh = makeHarness();
    expect(await fresh.runner.sendAgentText({ key: "c", text: "hi", generation: 0 })).toEqual({ sent: false, reason: "unknown" });
    expect(h.channel.sends).toHaveLength(0);
  });

  it("returns budget when the ledger refuses", async () => {
    const poor = makeHarness({ budgetUsd: 0 });
    const meta = poor.store.meta();
    meta.chatId = "chat_agent";
    meta.to = "+15550001001";
    poor.store.saveMeta(meta);
    expect(await poor.runner.sendAgentText({ key: "a", text: "Reminder: call", generation: 0 })).toEqual({
      sent: false,
      reason: "budget",
    });
    expect(poor.channel.sends).toHaveLength(0);
  });

  it("resumes the same turn after a failed send", async () => {
    const h = chatting();
    const realSend = h.channel.send.bind(h.channel);
    h.channel.send = async () => {
      throw new Error("boom");
    };
    await expect(h.runner.sendAgentText({ key: "rem_9", text: "Reminder: call", generation: 0 })).rejects.toThrow();
    const firstTurn = h.store.agentSend("rem_9")?.turn;
    expect(firstTurn).toBeGreaterThan(0);
    h.channel.send = realSend;
    const result = await h.runner.sendAgentText({ key: "rem_9", text: "Reminder: call", generation: 0 });
    expect(result.sent).toBe(true);
    expect(h.store.agentSend("rem_9")?.turn).toBe(firstTurn);
    // One provider send under the deterministic key: the retry resumes
    // the same turn instead of doubling the text.
    expect(h.channel.sends).toHaveLength(1);
    expect(h.channel.sends[0].idempotencyKey).toBe(idempotencyKeyFor(TEST_HANDLE_HASH, 0, firstTurn!, 1, "agent"));
  });

  it("a deletion while the text is being prepared stops the send", async () => {
    const dns = () => Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
    let h!: ReturnType<typeof makeHarness>;
    h = makeHarness({
      fetchFn: (async () => {
        h.store.wipe(h.now);
        return dns();
      }) as typeof fetch,
    });
    const meta = h.store.meta();
    meta.chatId = "chat_agent";
    meta.to = "+15550001001";
    h.store.saveMeta(meta);
    const generation = h.store.meta().generation;
    await h.runner.sendAgentText({ key: "rem_w", text: "Reminder: your form is at https://example.org/form", generation }).catch(() => undefined);
    expect(h.channel.sends).toHaveLength(0);
  });

  it("a delivery made before a deletion never sends after it, even once the person is back", async () => {
    const h = chatting();
    const before = h.store.meta().generation;
    h.store.wipe(h.now);
    const meta = h.store.meta();
    meta.chatId = "chat_agent";
    meta.to = "+15550001001";
    h.store.saveMeta(meta);
    const result = await h.runner.sendAgentText({ key: "rem_old", text: "Reminder: call", generation: before });
    expect(result).toEqual({ sent: false, reason: "deleted" });
    expect(h.channel.sends).toHaveLength(0);
  });

  it("a retry keeps the generation its first attempt recorded", async () => {
    const h = chatting();
    const generation = h.store.meta().generation;
    h.channel.send = async () => {
      throw new Error("boom");
    };
    await expect(h.runner.sendAgentText({ key: "rem_r", text: "Reminder: call", generation })).rejects.toThrow();
    expect(h.store.agentSend("rem_r")?.generation).toBe(generation);
  });
});

describe("reporting what the person was shown", () => {
  function reporting(seen: string[][], text: string) {
    return makeHarness({
      responder: {
        name: "agent",
        maxAttempts: 1,
        respond: async () => ({
          text,
          bubbles: [text],
          inputChars: 10,
          outputChars: text.length,
          model: "agent",
          attempts: 1,
          afterSent: async (sent: string[]) => {
            seen.push(sent);
          },
        }),
      },
    });
  }

  it("hands the responder the texts that actually went out, after they went out", async () => {
    const seen: string[][] = [];
    const h = reporting(seen, "Ready to send: renewal. Reply YES to send exactly this, or NO to stop.");
    const meta = h.store.meta();
    meta.introduced = true;
    h.store.saveMeta(meta);
    await h.runner.handleEvent(inboundEvent({ id: "evt_shown", text: "file it", occurredAtMs: h.now }), "webhook");
    h.advance(5000);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(seen).toHaveLength(1);
    expect(seen[0].join(" ")).toContain("Reply YES to send exactly this");
    expect(h.channel.sends.map((s) => s.text).join(" ")).toContain("Reply YES to send exactly this");
  });

  it("reports nothing for a send the provider refused", async () => {
    const seen: string[][] = [];
    const h = reporting(seen, "Ready to send: renewal. Reply YES to send exactly this, or NO to stop.");
    const meta = h.store.meta();
    meta.introduced = true;
    h.store.saveMeta(meta);
    const realSend = h.channel.send.bind(h.channel);
    h.channel.send = async (input) => {
      if (input.text.includes("Reply YES")) throw new ChannelRefused(403, "blocked", "refused");
      return realSend(input);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_refused", text: "file it", occurredAtMs: h.now }), "webhook");
    h.advance(5000);
    await h.runner.runDueTurn();
    expect(seen.flat().join(" ")).not.toContain("Reply YES");
  });
});
