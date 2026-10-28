import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";
import { setModelClientFactoryForTests } from "../src/model-client.js";

afterEach(() => {
  setModelClientFactoryForTests(null);
});

// Round 3, blockers 1 and 2: real sockets. A bad ticket is rejected by
// the worker before the Agents SDK accepts the socket, so no private
// state reaches it; and a ticket only opens its own route.

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

async function waitForText(messages: string[], text: string, what: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!messages.join("\n").includes(text)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("r3 blockers 1 and 2: tickets are redeemed before any state flows", () => {
  it("rejects a garbage ticket with no socket and no state", async () => {
    const res = await upgrade("r3sock-maria", "garbage");
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it("rejects a missing ticket with no socket", async () => {
    const res = await upgrade("r3sock-maria", null);
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it("opens a real socket on a valid ticket and chats", async () => {
    setModelClientFactoryForTests(() => ({
      async complete() {
        return { text: "Socket reply.", model: "fake" };
      },
    }));
    const ticket = await ticketFor("r3sock-chat");
    const res = await upgrade("r3sock-chat", ticket);
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const seen = listen(ws);
    await waitFor(seen.messages, 1, "agent state");
    expect(seen.messages.join("\n")).toContain("r3sock-chat");
    ws.send("hello over the socket");
    await waitForText(seen.messages, "Socket reply.", "chat reply");
    ws.close();
  });

  it("refuses someone else's ticket on this route and keeps the owner", async () => {
    const eveTicket = await ticketFor("r3sock-eve");
    const res = await upgrade("r3sock-alice", eveTicket);
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();

    // Alice's untouched agent still belongs to Alice, not Eve.
    setModelClientFactoryForTests(() => ({
      async complete() {
        return { text: "Still Alice.", model: "fake" };
      },
    }));
    const chat = await SELF.fetch("https://mano.test/api/persons/r3sock-alice/chat", {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenFor("r3sock-alice")}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(chat.status).toBe(200);
  });

  it("closes an idle socket past session expiry on the next broadcast", async () => {
    const ticket = await ticketFor("r3sock-idle", 1);
    const res = await upgrade("r3sock-idle", ticket);
    expect(res.status).toBe(101);
    const seen = listen(res.webSocket!);
    await waitFor(seen.messages, 1, "agent state");

    // The 1-second session lapses while the socket sits idle.
    await new Promise((r) => setTimeout(r, 1500));
    // Any state-changing call broadcasts, and the broadcast sweeps
    // expired sockets without waiting for a client message.
    const action = await SELF.fetch("https://mano.test/api/persons/r3sock-idle/action", {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenFor("r3sock-idle")}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "send",
        recipient: "sandbox-agency",
        purpose: "notice",
        payload: {},
        idempotencyKey: `r3sweep-${crypto.randomUUID()}`,
        actor: "foreground",
      }),
    });
    expect(action.status).toBe(200);
    const close = await Promise.race([
      seen.closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Idle socket was not swept.")), 5000)),
    ]);
    expect(close.code).toBe(4408);
  });
});
