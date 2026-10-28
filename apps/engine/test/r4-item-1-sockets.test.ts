import { SELF, env as testEnv } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";
import { setModelClientFactoryForTests } from "../src/model-client.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

afterEach(() => {
  setModelClientFactoryForTests(null);
});

// Round 4, item 1 through real sockets and real agents: every socket
// gets a close scheduled at session expiry, and the agent rechecks
// expiry before every send, including the chat reply.

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

async function tokenFor(sub: string, ttlSeconds = 3600): Promise<string> {
  return mintSessionToken({ kind: "person", sub }, TEST_SESSION_SECRET, ttlSeconds);
}

async function ticketFor(sub: string, ttlSeconds = 3600): Promise<string> {
  const res = await SELF.fetch(`https://mano.test/api/persons/${sub}/ws-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${await tokenFor(sub, ttlSeconds)}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { ticket: string }).ticket;
}

async function upgrade(personId: string, ticket: string | null): Promise<Response> {
  const query = ticket === null ? "" : `?ticket=${encodeURIComponent(ticket)}`;
  return SELF.fetch(`https://mano.test/api/persons/${personId}/ws${query}`, {
    headers: { Upgrade: "websocket" },
  });
}

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function listen(ws: WebSocket) {
  const messages: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => {
      resolve({ code: (event as CloseEvent).code, reason: (event as CloseEvent).reason });
    });
  });
  ws.addEventListener("message", (event) => {
    messages.push(String((event as MessageEvent).data));
  });
  ws.accept();
  return { messages, closed };
}

async function waitFor(messages: string[], count: number, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (messages.length < count) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("r4 item 1: sockets close at session expiry", () => {
  it("schedules a close at session expiry for the socket", async () => {
    const res = await upgrade("r4s1-sched", await ticketFor("r4s1-sched"));
    expect(res.status).toBe(101);
    const seen = listen(res.webSocket!);
    await waitFor(seen.messages, 1, "agent state");

    const schedules = await personStub("r4s1-sched").listSchedules();
    const closes = schedules.filter((s) => s.callback === "closeExpiredSessionSockets");
    expect(closes.length).toBeGreaterThanOrEqual(1);
    // About an hour out: the 3600-second session behind the ticket.
    const nowSec = Date.now() / 1000;
    for (const close of closes) {
      expect(close.time).toBeGreaterThan(nowSec + 3500);
      expect(close.time).toBeLessThan(nowSec + 3700);
    }
    res.webSocket!.close();
  });

  it("closes an idle socket when the scheduled expiry fires", async () => {
    const res = await upgrade("r4s1-idle", await ticketFor("r4s1-idle", 1));
    expect(res.status).toBe(101);
    const seen = listen(res.webSocket!);
    await waitFor(seen.messages, 1, "agent state");

    // The 1-second session lapses while the socket sits idle with no
    // broadcast to sweep it. The scheduled close fires on its own; the
    // explicit call afterwards only proves the handler is idempotent.
    await new Promise((r) => setTimeout(r, 1500));
    const close = await Promise.race([
      seen.closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Idle socket was not closed.")), 5000)),
    ]);
    expect(close.code).toBe(4408);
    const again = await personStub("r4s1-idle").closeExpiredSessionSockets({});
    expect(again.closed).toBe(0);
  });

  it("sends no reply when the session expires mid-chat", async () => {
    setModelClientFactoryForTests(() => ({
      async complete() {
        // Slow enough to straddle the 2-second session below.
        await new Promise((r) => setTimeout(r, 2500));
        return { text: "Too slow.", model: "fake" };
      },
    }));
    const res = await upgrade("r4s1-midchat", await ticketFor("r4s1-midchat", 2));
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const seen = listen(ws);
    await waitFor(seen.messages, 1, "agent state");
    ws.send("hello over the socket");

    const close = await Promise.race([
      seen.closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Socket was not closed.")), 8000)),
    ]);
    expect(close.code).toBe(4408);
    expect(seen.messages.join("\n")).not.toContain("Too slow.");
  }, 15000);
});
