import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { signInCode, mintWebSession } from "../src/auth.js";
import { handleApi, type StateStub, type WebEnv } from "../src/handler.js";
import { WebStore, type Sql } from "../src/store.js";

function sqlite(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: unknown[]) {
      if (params.length === 0 && query.split(";").filter((p) => p.trim()).length > 1) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const stmt = db.prepare(query);
      const args = params as Array<string | number | null>;
      if (/^\s*SELECT/i.test(query)) return { toArray: () => stmt.all(...args) as unknown[] };
      stmt.run(...args);
      return { toArray: () => [] };
    },
  };
}

const GRANT = "test-grant-secret-not-real";
const EMAIL = "maria@example.org";

interface Harness {
  env: WebEnv;
  sent: { to: string; text: string }[];
  agentCalls: { url: string; body: Record<string, unknown> }[];
  setAgent(reply: (url: string) => Response): void;
  failEmail(): void;
  clock: { now: number };
}

function harness(): Harness {
  const stores = new Map<string, WebStore>();
  const sent: Harness["sent"] = [];
  const agentCalls: Harness["agentCalls"] = [];
  let agent: (url: string) => Response = () => Response.json({ status: "replied", text: "Hello from Mano." });
  let emailFails = false;
  const clock = { now: Date.parse("2026-11-03T12:00:00Z") };
  const env: WebEnv = {
    stateFor(name) {
      let store = stores.get(name);
      if (!store) {
        store = new WebStore(sqlite());
        stores.set(name, store);
      }
      return store as unknown as StateStub;
    },
    async sendEmail(message) {
      if (emailFails) throw new Error("domain not onboarded");
      sent.push({ to: message.to, text: message.text });
    },
    MANO_WEB_FROM: "sign-in@example.org",
    MANO_HANDLE_GRANT_SECRET: GRANT,
    MANO_AGENT_SECRET: "test-agent-secret-not-real",
    MANO_HANDLE_PEPPER: "test-pepper-not-real",
    AGENT_URL: "https://agent.test",
    now: () => clock.now,
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("cloudflare-dns.com")) return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
      agentCalls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return agent(url);
    }) as typeof fetch,
  };
  return { env, sent, agentCalls, clock, setAgent: (fn) => (agent = fn), failEmail: () => (emailFails = true) };
}

const post = (path: string, body: unknown, token?: string) =>
  new Request(`https://web.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function signIn(h: Harness): Promise<{ token: string; personId: string }> {
  const asked = await handleApi(post("/api/auth/request-code", { email: EMAIL }), h.env);
  const { challengeId } = (await asked.json()) as { challengeId: string };
  const code = await signInCode(GRANT, challengeId, EMAIL);
  const opened = await handleApi(post("/api/auth/verify-code", { email: EMAIL, challengeId, code }), h.env);
  expect(opened.status).toBe(200);
  return (await opened.json()) as { token: string; personId: string };
}

describe("sign-in", () => {
  it("emails the code, opens one session and refuses a replay of the same code", async () => {
    const h = harness();
    const asked = await handleApi(post("/api/auth/request-code", { email: " Maria@Example.org " }), h.env);
    expect(asked.status).toBe(200);
    const { challengeId, maskedEmail } = (await asked.json()) as { challengeId: string; maskedEmail: string };
    expect(maskedEmail).toBe("m***@example.org");
    const code = await signInCode(GRANT, challengeId, EMAIL);
    expect(h.sent[0].to).toBe(EMAIL);
    expect(h.sent[0].text).toContain(code);

    const verify = () => handleApi(post("/api/auth/verify-code", { email: EMAIL, challengeId, code }), h.env);
    const opened = await verify();
    expect(opened.status).toBe(200);
    const session = (await opened.json()) as { personId: string; token: string; expiresAt: string };
    expect(session.personId).toMatch(/^handle-[0-9a-f]{64}$/);
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(h.clock.now);
    expect((await verify()).status).toBe(401);
  });

  it("closes a challenge after five wrong codes, even for the right one", async () => {
    const h = harness();
    const { challengeId } = (await (await handleApi(post("/api/auth/request-code", { email: EMAIL }), h.env)).json()) as { challengeId: string };
    const code = await signInCode(GRANT, challengeId, EMAIL);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      expect((await handleApi(post("/api/auth/verify-code", { email: EMAIL, challengeId, code: wrong }), h.env)).status).toBe(401);
    }
    expect((await handleApi(post("/api/auth/verify-code", { email: EMAIL, challengeId, code }), h.env)).status).toBe(401);
  });

  it("refuses a code for another address and an expired code", async () => {
    const h = harness();
    const { challengeId } = (await (await handleApi(post("/api/auth/request-code", { email: EMAIL }), h.env)).json()) as { challengeId: string };
    const other = "someone@example.org";
    const forOther = await signInCode(GRANT, challengeId, other);
    expect((await handleApi(post("/api/auth/verify-code", { email: other, challengeId, code: forOther }), h.env)).status).toBe(401);
    h.clock.now += 11 * 60_000;
    const code = await signInCode(GRANT, challengeId, EMAIL);
    expect((await handleApi(post("/api/auth/verify-code", { email: EMAIL, challengeId, code }), h.env)).status).toBe(401);
  });

  it("limits codes per address and leaves no challenge when the email fails", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) expect((await handleApi(post("/api/auth/request-code", { email: EMAIL }), h.env)).status).toBe(200);
    expect((await handleApi(post("/api/auth/request-code", { email: EMAIL }), h.env)).status).toBe(429);

    const down = harness();
    down.failEmail();
    const res = await handleApi(post("/api/auth/request-code", { email: EMAIL }), down.env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("Sign-in email is not turned on yet.");
  });

  it("fails closed with no secrets", async () => {
    const h = harness();
    h.env.MANO_HANDLE_GRANT_SECRET = undefined;
    expect((await handleApi(post("/api/auth/request-code", { email: EMAIL }), h.env)).status).toBe(503);
  });
});

describe("chat", () => {
  it("runs a signed agent turn and keeps both sides of the conversation", async () => {
    const h = harness();
    const { token, personId } = await signIn(h);
    const res = await handleApi(post(`/api/persons/${personId}/chat`, { message: "Hi", clientOpId: "op-1" }, token), h.env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: string }).reply).toBe("Hello from Mano.");
    const turn = h.agentCalls[0];
    expect(turn.url).toBe("https://agent.test/channels/mano/turn");
    expect(turn.body.turnId).toMatch(/^[0-9a-f]{64}:0:w1$/);
    expect(turn.body.texts).toEqual(["Hi"]);
    const list = await handleApi(new Request(`https://web.test/api/persons/${personId}/conversation`, { headers: { authorization: `Bearer ${token}` } }), h.env);
    const { messages } = (await list.json()) as { messages: { role: string; text: string }[] };
    expect(messages.map((m) => [m.role, m.text])).toEqual([["user", "Hi"], ["agent", "Hello from Mano."]]);
  });

  it("answers a retry of the same send from the record, without a second turn", async () => {
    const h = harness();
    const { token, personId } = await signIn(h);
    const send = () => handleApi(post(`/api/persons/${personId}/chat`, { message: "Hi", clientOpId: "op-1" }, token), h.env);
    await send();
    const again = await send();
    expect(((await again.json()) as { reply: string }).reply).toBe("Hello from Mano.");
    expect(h.agentCalls).toHaveLength(1);
  });

  it("says plainly when the agent cannot answer and retries under the same turn", async () => {
    const h = harness();
    const { token, personId } = await signIn(h);
    h.setAgent(() => Response.json({ status: "error", text: "" }, { status: 503 }));
    const send = () => handleApi(post(`/api/persons/${personId}/chat`, { message: "Hi", clientOpId: "op-1" }, token), h.env);
    expect((await send()).status).toBe(503);
    h.setAgent(() => Response.json({ status: "replied", text: "Back now." }));
    expect((await send()).status).toBe(200);
    expect(h.agentCalls.map((c) => c.body.turnId)).toEqual([h.agentCalls[0].body.turnId, h.agentCalls[0].body.turnId]);
  });

  it("reports a question shown word for word, and refuses one the guard would change", async () => {
    const h = harness();
    const { token, personId } = await signIn(h);
    const approval = "Send your renewal to Sample County? Reply YES or NO.";
    h.setAgent((url) =>
      url.endsWith("/turn") ? Response.json({ status: "waiting_approval", text: approval, approval, approvalId: "appr-1" }) : Response.json({ ok: true }),
    );
    await handleApi(post(`/api/persons/${personId}/chat`, { message: "Send it", clientOpId: "op-1" }, token), h.env);
    expect(h.agentCalls[1].url).toBe("https://agent.test/channels/mano/presented");
    expect(h.agentCalls[1].body.approvalId).toBe("appr-1");

    h.setAgent(() => Response.json({ status: "waiting_approval", text: "Reply YES", approval: "Something else https://x.test", approvalId: "appr-2" }));
    const res = await handleApi(post(`/api/persons/${personId}/chat`, { message: "Send it again", clientOpId: "op-2" }, token), h.env);
    expect(((await res.json()) as { reply: string }).reply).toContain("not asking you to approve it");
    expect(h.agentCalls).toHaveLength(3);
  });

  it("keeps people to their own routes and answers 501 for parts not on the web", async () => {
    const h = harness();
    const { token, personId } = await signIn(h);
    const other = `handle-${"a".repeat(64)}`;
    expect((await handleApi(post(`/api/persons/${other}/chat`, { message: "Hi" }, token), h.env)).status).toBe(403);
    expect((await handleApi(post(`/api/persons/${personId}/chat`, { message: "Hi" }), h.env)).status).toBe(401);
    expect((await handleApi(new Request(`https://web.test/api/persons/${personId}/approvals`, { headers: { authorization: `Bearer ${token}` } }), h.env)).status).toBe(501);
    const expired = await mintWebSession(GRANT, personId, h.clock.now - 48 * 3600_000);
    expect((await handleApi(post(`/api/persons/${personId}/chat`, { message: "Hi" }, expired.token), h.env)).status).toBe(401);
  });
});
