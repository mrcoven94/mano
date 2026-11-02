import { describe, expect, it } from "vitest";
import {
  AgentResponder,
  ChannelFailed,
  ChannelRefused,
  computeSignatureHex,
  idempotencyKeyFor,
  SparkResponder,
  StandInResponder,
} from "@mano/channels";
import { signEngineSend } from "@mano/protocol";
import type { TurnInput } from "@mano/channels";
import { handleAgentSend } from "../src/index.js";
import { buildResponder } from "../src/conversation.js";
import type { Env } from "../src/env.js";
import { inboundEvent, makeHarness, TEST_HANDLE_HASH } from "./helpers.js";

const SECRET = "test-agent-secret-not-real";
const ENGINE_SEND_SECRET = "test-engine-send-secret-not-real";

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
    MANO_ENGINE_SEND_SECRET: ENGINE_SEND_SECRET,
    MANO_HANDLE_GRANT_SECRET: "test-grant-secret-not-real",
  };
}

// Signs like Engine does (packages/protocol engine-send.ts): the method,
// path and timestamp are part of the signed bytes.
async function signedSend(body: unknown, secret = ENGINE_SEND_SECRET, opts: { path?: string; method?: string } = {}): Promise<Request> {
  const raw = JSON.stringify(body);
  const t = String(Math.floor(Date.now() / 1000));
  const sig = await signEngineSend(secret, opts.method ?? "POST", opts.path ?? "/internal/agent-send", t, raw);
  return new Request("https://channels.example.test/internal/agent-send", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mano-engine-timestamp": t, "x-mano-engine-signature": sig },
    body: raw,
  });
}

async function agentSigned(body: unknown): Promise<Request> {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = await computeSignatureHex(SECRET, String(t), raw);
  return new Request("https://channels.example.test/internal/agent-send", {
    method: "POST",
    headers: { "x-mano-timestamp": String(t), "x-mano-signature": v1 },
    body: raw,
  });
}

describe("Engine send verification", () => {
  const send = { handleHash: "hh", key: "reminder:rem-1", text: "Reminder: call", generation: 0 };

  it("accepts a send Engine signed with its send secret", async () => {
    const env = agentEnv(async () => Response.json({ sent: true }));
    expect((await handleAgentSend(await signedSend(send), env)).status).toBe(200);
  });

  it("refuses the agent's secret, a signature over another path or method, and a wrong secret", async () => {
    const env = agentEnv(async () => Response.json({ sent: true }));
    expect((await handleAgentSend(await agentSigned(send), env)).status).toBe(401);
    expect((await handleAgentSend(await signedSend(send, ENGINE_SEND_SECRET, { path: "/internal/other" }), env)).status).toBe(401);
    expect((await handleAgentSend(await signedSend(send, ENGINE_SEND_SECRET, { method: "PUT" }), env)).status).toBe(401);
    expect((await handleAgentSend(await signedSend(send, "wrong"), env)).status).toBe(401);
  });

  it("matches the contract's interop vector", async () => {
    expect(await signEngineSend("interop-secret", "POST", "/internal/agent-send", "1761777000", '{"handleHash":"ab"}')).toBe(
      "82cbcf6537db403e7a8b12a4b12dad407291deb044039a06e308d716b23e5bd9",
    );
  });

  it("answers a terminal refusal with a non-empty reason, so Engine drops it instead of retrying", async () => {
    const env = agentEnv(async () => Response.json({ sent: false, reason: "deleted" }));
    const res = await handleAgentSend(await signedSend(send), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: false, reason: "deleted" });
    const blank = agentEnv(async () => Response.json({ sent: false }));
    expect((await handleAgentSend(await signedSend(send), blank)).status).toBe(502);
  });
});

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

describe("the receive time a turn carries to the agent", () => {
  it("is when Channels received the turn's latest message", async () => {
    const seen: TurnInput[] = [];
    const h = makeHarness({
      responder: {
        name: "agent",
        maxAttempts: 1,
        respond: async (input) => {
          seen.push(input);
          return { text: "ok", bubbles: ["ok"], inputChars: 2, outputChars: 2, model: "agent", attempts: 1 };
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_t1", text: "first", occurredAtMs: h.now }), "webhook");
    h.advance(200);
    const latest = h.now;
    await h.runner.handleEvent(inboundEvent({ id: "evt_t2", text: "YES", occurredAtMs: h.now }), "webhook");
    h.advance(5000);
    await h.runner.runDueTurn();
    expect(seen[0].receivedAtMs).toBe(latest);
  });
});

describe("what an Engine reminder send reports", () => {
  function chattingHarness() {
    const h = makeHarness();
    const meta = h.store.meta();
    meta.chatId = "chat_agent";
    meta.to = "+15550001001";
    meta.introduced = true;
    h.store.saveMeta(meta);
    return h;
  }

  it("a send the provider refused is reported as not sent, with the reason, and stays that way", async () => {
    const h = chattingHarness();
    h.channel.send = async () => {
      throw new ChannelRefused(403, "blocked", "refused");
    };
    expect(await h.runner.sendAgentText({ key: "reminder:r1", text: "Reminder: call", generation: 0 })).toEqual({ sent: false, reason: "refused" });
    expect(await h.runner.sendAgentText({ key: "reminder:r1", text: "Reminder: call", generation: 0 })).toEqual({ sent: false, reason: "refused" });
  });

  it("a send that failed for good is reported as not sent", async () => {
    const h = chattingHarness();
    h.channel.send = async () => {
      throw new ChannelFailed(400, "bad_request", "failed");
    };
    expect(await h.runner.sendAgentText({ key: "reminder:r2", text: "Reminder: call", generation: 0 })).toEqual({ sent: false, reason: "failed" });
  });
});

describe("reporting what the person was shown", () => {
  const QUESTION = "Ready to send: renewal. Reply YES to send exactly this, or NO to stop.";
  type Report = { approvalId: string; approval: string; generation: number; sent: string[] };

  function reporting(reports: Report[], opts: { failFirst?: number } = {}) {
    let failures = opts.failFirst ?? 0;
    const h = makeHarness({
      responder: {
        name: "agent",
        maxAttempts: 1,
        respond: async () => ({
          text: QUESTION,
          bubbles: [QUESTION],
          inputChars: 10,
          outputChars: QUESTION.length,
          model: "agent",
          attempts: 1,
          presentation: { approvalId: "appr_1", approval: QUESTION },
        }),
      },
      reportPresentation: async (p, sent) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("agent unreachable");
        }
        reports.push({ ...p, sent });
        return true;
      },
    });
    const meta = h.store.meta();
    meta.introduced = true;
    h.store.saveMeta(meta);
    return h;
  }

  it("reports the question with the texts that actually went out, after they went out", async () => {
    const reports: Report[] = [];
    const h = reporting(reports);
    await h.runner.handleEvent(inboundEvent({ id: "evt_shown", text: "file it", occurredAtMs: h.now }), "webhook");
    h.advance(5000);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ approvalId: "appr_1", approval: QUESTION, generation: 0 });
    expect(reports[0].sent.join(" ")).toContain("Reply YES to send exactly this");
  });

  it("a report that failed is kept and sent again on the next run", async () => {
    const reports: Report[] = [];
    const h = reporting(reports, { failFirst: 1 });
    await h.runner.handleEvent(inboundEvent({ id: "evt_retry", text: "file it", occurredAtMs: h.now }), "webhook");
    h.advance(5000);
    expect(await h.runner.runDueTurn()).toBe("retry");
    expect(reports).toHaveLength(0);
    h.advance(60_000);
    await h.runner.runDueTurn();
    expect(reports).toHaveLength(1);
    expect(await h.runner.runDueTurn()).toBe("idle");
  });

  it("a resumed answer reports its question once its send goes through", async () => {
    const reports: Report[] = [];
    const h = reporting(reports);
    const realSend = h.channel.send.bind(h.channel);
    let down = true;
    h.channel.send = async (input) => {
      if (down) throw new Error("provider unreachable");
      return realSend(input);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_resume", text: "file it", occurredAtMs: h.now }), "webhook");
    h.advance(5000);
    expect(await h.runner.runDueTurn()).toBe("retry");
    expect(reports).toHaveLength(0);
    down = false;
    h.advance(10 * 60_000);
    while ((await h.runner.runDueTurn()) === "retry") h.advance(10 * 60_000);
    expect(reports).toHaveLength(1);
  });

  it("reports nothing for a send the provider refused", async () => {
    const reports: Report[] = [];
    const h = reporting(reports);
    const realSend = h.channel.send.bind(h.channel);
    h.channel.send = async (input) => {
      if (input.text.includes("Reply YES")) throw new ChannelRefused(403, "blocked", "refused");
      return realSend(input);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_refused", text: "file it", occurredAtMs: h.now }), "webhook");
    h.advance(5000);
    await h.runner.runDueTurn();
    expect(reports.flatMap((r) => r.sent).join(" ")).not.toContain("Reply YES");
  });
});

describe("dev routes", () => {
  it("the local delete route does not exist unless MANO_DEV_ROUTES is set", async () => {
    const worker = (await import("../src/index.js")).default;
    const env = agentEnv(async () => Response.json({ ok: true }));
    const res = await worker.fetch(new Request("https://c.test/dev/delete", { method: "POST", body: '{"handle":"+18015550100"}' }), env);
    expect(res.status).toBe(404);
  });
});
