import { SELF, env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// Round 5, item 4 through a real agent and real sockets: a socket whose
// expiry cannot be armed is closed on the spot instead of idling past
// expiry with no alarm to kill it.

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

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

describe("r5 item 4: unarmable sockets close", () => {
  it("arms a close for a normal session", async () => {
    const person = personStub("r5i4-ok");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(await person.armSocketExpiry(exp)).toBe(true);
    const schedules = await person.listSchedules();
    expect(schedules.some((s) => s.callback === "closeExpiredSessionSockets" && s.time === exp)).toBe(true);
  });

  it("reports false when the scheduler rejects the arming", async () => {
    const person = personStub("r5i4-reject");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    // An unknown callback is a real scheduler rejection, forced
    // deterministically; production always arms the session close. The
    // cast deliberately violates the type contract to reach it.
    expect(await person.armSocketExpiry(exp, "no-such-callback" as "closeExpiredSessionSockets")).toBe(false);
  });

  it("closes a socket whose expiry cannot be armed", async () => {
    // A session centuries out: the scheduler rejects an alarm that far
    // ahead, so arming fails and the socket must close instead of
    // staying open past every sweep. Depends on the platform's alarm
    // horizon; if workerd ever accepts year-2286 alarms, revisit.
    const target = 9999999999;
    const ttl = target - Math.floor(Date.now() / 1000);
    const ticketRes = await SELF.fetch("https://mano.test/api/persons/r5i4-far/ws-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenFor("r5i4-far", ttl)}` },
    });
    expect(ticketRes.status).toBe(200);
    const ticket = ((await ticketRes.json()) as { ticket: string }).ticket;
    const res = await SELF.fetch(`https://mano.test/api/persons/r5i4-far/ws?ticket=${encodeURIComponent(ticket)}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    const seen = listen(res.webSocket!);
    const close = await Promise.race([
      seen.closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Unarmable socket stayed open.")), 5000)),
    ]);
    expect(close.code).toBe(4403);
    expect(close.reason).toBe("Could not schedule session expiry.");
  });

  it("rejects a ticket minted for an unarmable session only at the socket", async () => {
    // Sanity: the ticket itself is valid; only the socket arming fails.
    const target = 9999999999;
    const ttl = target - Math.floor(Date.now() / 1000);
    const ticket = await ticketFor("r5i4-far-ticket", ttl);
    expect(typeof ticket).toBe("string");
  });
});
