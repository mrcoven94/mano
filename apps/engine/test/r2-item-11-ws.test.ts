import { env as testEnv, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken, mintWsTicket, verifyWsTicket } from "../src/auth.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// Item 11: WebSocket auth uses a 60-second single-use ticket from an
// authenticated POST. Query-string session tokens are gone, and sockets
// close when the session expires.

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

describe("r2 item 11: single-use websocket tickets", () => {
  it("mints tickets that verify for 60 seconds", async () => {
    const sessionExp = Math.floor(Date.now() / 1000) + 3600;
    const ticket = await mintWsTicket("r2i11-maria", sessionExp, TEST_SESSION_SECRET);
    const claims = await verifyWsTicket(ticket.ticket, TEST_SESSION_SECRET);
    expect(claims).toMatchObject({ sub: "r2i11-maria", sessionExp });
    expect(ticket.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    expect(await verifyWsTicket(ticket.ticket, "wrong-secret")).toBeNull();
    expect(await verifyWsTicket("v1.bogus.bogus", TEST_SESSION_SECRET)).toBeNull();
  });

  it("redeems a ticket once, then rejects the replay", async () => {
    const person = personStub("r2i11-ticket");
    const sessionExp = Math.floor(Date.now() / 1000) + 3600;
    const ticket = await mintWsTicket("r2i11-ticket", sessionExp, TEST_SESSION_SECRET);
    const first = await person.redeemWsTicket(ticket.ticket, "r2i11-ticket");
    expect(first).toMatchObject({ ok: true, subject: "r2i11-ticket" });
    const replay = await person.redeemWsTicket(ticket.ticket, "r2i11-ticket");
    expect(replay.ok).toBe(false);
    expect(replay.ok ? "" : replay.reason).toMatch(/already used/i);
  });

  it("rejects a ticket whose session already expired", async () => {
    const person = personStub("r2i11-expired");
    const ticket = await mintWsTicket("r2i11-expired", Math.floor(Date.now() / 1000) - 10, TEST_SESSION_SECRET);
    const redeemed = await person.redeemWsTicket(ticket.ticket, "r2i11-expired");
    expect(redeemed.ok).toBe(false);
    expect(redeemed.ok ? "" : redeemed.reason).toMatch(/expir/i);
  });

  it("rejects a ticket naming a different person than the route", async () => {
    const person = personStub("r2i11-alice");
    const ticket = await mintWsTicket("r2i11-eve", Math.floor(Date.now() / 1000) + 3600, TEST_SESSION_SECRET);
    const redeemed = await person.redeemWsTicket(ticket.ticket, "r2i11-alice");
    expect(redeemed.ok).toBe(false);
    expect(redeemed.ok ? "" : redeemed.reason).toMatch(/different person/i);
  });

  it("issues tickets from an authenticated POST only", async () => {
    const token = await mintSessionToken({ kind: "person", sub: "r2i11-http" }, TEST_SESSION_SECRET);
    const res = await SELF.fetch("https://mano.test/api/persons/r2i11-http/ws-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string };
    expect(typeof body.ticket).toBe("string");

    const noAuth = await SELF.fetch("https://mano.test/api/persons/r2i11-http/ws-ticket", { method: "POST" });
    expect(noAuth.status).toBe(403);
  });

  it("no longer accepts a session token on the websocket query string", async () => {
    const token = await mintSessionToken({ kind: "person", sub: "r2i11-http" }, TEST_SESSION_SECRET);
    const res = await SELF.fetch(`https://mano.test/api/persons/r2i11-http/ws?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(400);
  });
});
