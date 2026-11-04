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
        store = new WebStore(sqlite(), () => clock.now);
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

const QUESTION = "Send your renewal to Sample County? Reply YES or NO.";
const PRESENTED = "https://agent.test/channels/mano/presented";

function asking(h: Harness, text = QUESTION, approval = QUESTION, approvalId = "appr-1"): void {
  h.setAgent((url) => (url.endsWith("/turn") ? Response.json({ status: "waiting_approval", text, approval, approvalId }) : Response.json({ ok: true })));
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const presentedCalls = (h: Harness) => h.agentCalls.filter((c) => c.url === PRESENTED);

interface ChatJson {
  id: string;
  reply: string;
  ask?: { approvalId: string };
}

async function chatJson(h: Harness, s: { token: string; personId: string }, message: string, op: string): Promise<ChatJson> {
  const res = await handleApi(post(`/api/persons/${s.personId}/chat`, { message, clientOpId: op }, s.token), h.env);
  expect(res.status).toBe(200);
  return (await res.json()) as ChatJson;
}

const shown = (h: Harness, s: { token: string; personId: string }, approvalId: string, messageId: string, token = s.token) =>
  handleApi(post(`/api/persons/${s.personId}/approvals/${approvalId}/shown`, { messageId }, token), h.env);

describe("an approval question reaches the person whole", () => {
  it("does not arm a question the bubble cap removed, and says it was not asked", async () => {
    const h = harness();
    const s = await signIn(h);
    asking(h, `${"Okay. ".repeat(500)}${QUESTION}`);
    const out = await chatJson(h, s, "Send it", "op-1");
    expect(out.reply).not.toContain(QUESTION);
    expect(out.reply).toContain("not asking you to approve it");
    expect(out.ask).toBeUndefined();
    expect(presentedCalls(h)).toHaveLength(0);
    const list = await handleApi(new Request(`https://web.test/api/persons/${s.personId}/conversation`, { headers: auth(s.token) }), h.env);
    const { messages } = (await list.json()) as { messages: { ask?: unknown; text: string }[] };
    expect(messages.every((m) => m.ask === undefined)).toBe(true);
  });

  it("refuses a question the guard would change, with no report", async () => {
    const h = harness();
    const s = await signIn(h);
    asking(h, "Reply YES", "Something else https://x.test", "appr-2");
    const out = await chatJson(h, s, "Send it again", "op-2");
    expect(out.reply).toContain("not asking you to approve it");
    expect(out.ask).toBeUndefined();
    expect(presentedCalls(h)).toHaveLength(0);
  });
});

describe("a question counts as shown only when the browser says so", () => {
  it("reports nothing until the signed-in browser acknowledges that approval on that message", async () => {
    const h = harness();
    const s = await signIn(h);
    asking(h);
    const out = await chatJson(h, s, "Send it", "op-1");
    expect(out.reply).toContain(QUESTION);
    expect(out.ask).toEqual({ approvalId: "appr-1" });
    expect(presentedCalls(h)).toHaveLength(0);

    const res = await shown(h, s, "appr-1", out.id);
    expect(res.status).toBe(200);
    expect(presentedCalls(h)).toHaveLength(1);
    expect(presentedCalls(h)[0].body.approvalId).toBe("appr-1");
  });

  it("offers the question again from the conversation after a lost response, until acknowledged", async () => {
    const h = harness();
    const s = await signIn(h);
    asking(h);
    const out = await chatJson(h, s, "Send it", "op-1");
    const read = async () => {
      const list = await handleApi(new Request(`https://web.test/api/persons/${s.personId}/conversation`, { headers: auth(s.token) }), h.env);
      return ((await list.json()) as { messages: { id: string; ask?: { approvalId: string } }[] }).messages;
    };
    expect((await read()).find((m) => m.id === out.id)?.ask).toEqual({ approvalId: "appr-1" });
    expect(presentedCalls(h)).toHaveLength(0);
    await shown(h, s, "appr-1", out.id);
    expect((await read()).find((m) => m.id === out.id)?.ask).toBeUndefined();
    const replay = await chatJson(h, s, "Send it", "op-1");
    expect(replay.ask).toBeUndefined();
  });

  it("refuses another person, no session, an unknown approval and a different message", async () => {
    const h = harness();
    const s = await signIn(h);
    asking(h);
    const out = await chatJson(h, s, "Send it", "op-1");
    const otherPerson = `handle-${"b".repeat(64)}`;
    const otherToken = (await mintWebSession(GRANT, otherPerson, h.clock.now)).token;
    expect((await shown(h, s, "appr-1", out.id, otherToken)).status).toBe(403);
    expect((await handleApi(post(`/api/persons/${s.personId}/approvals/appr-1/shown`, { messageId: out.id }), h.env)).status).toBe(401);
    expect((await shown(h, s, "appr-9", out.id)).status).toBe(409);
    expect((await shown(h, s, "appr-1", "u-op-1")).status).toBe(409);
    expect(presentedCalls(h)).toHaveLength(0);
  });

  it("keeps the question open after an agent outage and closes it when the agent refuses", async () => {
    const h = harness();
    const s = await signIn(h);
    asking(h);
    const out = await chatJson(h, s, "Send it", "op-1");
    h.setAgent(() => Response.json({ ok: false }, { status: 503 }));
    expect((await shown(h, s, "appr-1", out.id)).status).toBe(503);
    h.setAgent(() => Response.json({ ok: false, reason: "mismatch" }, { status: 409 }));
    expect((await shown(h, s, "appr-1", out.id)).status).toBe(409);
    const calls = presentedCalls(h).length;
    expect((await shown(h, s, "appr-1", out.id)).status).toBe(409);
    expect(presentedCalls(h)).toHaveLength(calls);
  });
});

describe("crisis help is never behind a limit or a failure", () => {
  const CRISIS = "I want to kill myself";
  const hasLine = (text: string) => expect(text).toMatch(/988[\s\S]*911/);

  async function exhaust(h: Harness, s: { token: string; personId: string }): Promise<void> {
    for (let i = 0; i < 60; i++) await chatJson(h, s, "Hi", `fill-${i}`);
    expect((await handleApi(post(`/api/persons/${s.personId}/chat`, { message: "Hi", clientOpId: "over" }, s.token), h.env)).status).toBe(429);
  }

  it("answers past the turn limit, without the agent, and keeps it in the conversation", async () => {
    const h = harness();
    const s = await signIn(h);
    await exhaust(h, s);
    const calls = h.agentCalls.length;
    const out = await chatJson(h, s, CRISIS, "op-c");
    hasLine(out.reply);
    expect(h.agentCalls).toHaveLength(calls);
    const list = await handleApi(new Request(`https://web.test/api/persons/${s.personId}/conversation`, { headers: auth(s.token) }), h.env);
    const { messages } = (await list.json()) as { messages: { id: string; text: string }[] };
    expect(messages.at(-1)?.id).toBe(out.id);
    expect(messages.at(-2)?.text).toBe(CRISIS);
  });

  it("answers when the agent fails, throws, or the person's store is down", async () => {
    const h = harness();
    const s = await signIn(h);
    h.setAgent(() => Response.json({ status: "error", text: "" }, { status: 503 }));
    hasLine((await chatJson(h, s, CRISIS, "op-1")).reply);
    h.setAgent(() => {
      throw new Error("network");
    });
    hasLine((await chatJson(h, s, CRISIS, "op-2")).reply);
    h.env.stateFor = () => {
      throw new Error("store down");
    };
    hasLine((await chatJson(h, s, CRISIS, "op-3")).reply);
  });

  it("answers with no session, a bad session, too long a message and no configuration", async () => {
    const h = harness();
    const s = await signIn(h);
    const route = `/api/persons/${s.personId}/chat`;
    const read = async (req: Request) => {
      const res = await handleApi(req, h.env);
      expect(res.status).toBe(200);
      hasLine(((await res.json()) as ChatJson).reply);
    };
    await read(post(route, { message: CRISIS }));
    await read(post(route, { message: CRISIS }, "not-a-token"));
    await read(post(route, { message: `${CRISIS} ${"x".repeat(5_000)}` }, s.token));
    await read(post(route, { message: `${CRISIS} ${"x".repeat(50_000)}` }, s.token));
    h.env.MANO_AGENT_SECRET = undefined;
    await read(post(route, { message: CRISIS }, s.token));
  });

  it("puts the crisis line first on a normal turn and in Spanish when written in Spanish", async () => {
    const h = harness();
    const s = await signIn(h);
    const out = await chatJson(h, s, CRISIS, "op-1");
    expect(out.reply.startsWith("I'm really glad you told me")).toBe(true);
    h.setAgent(() => Response.json({ status: "error", text: "" }, { status: 503 }));
    const es = await chatJson(h, s, "quiero matarme", "op-2");
    expect(es.reply).toContain("988");
    expect(es.reply).toContain("llama");
  });

  it("still answers ordinary messages with the plain limit and failure errors", async () => {
    const h = harness();
    const s = await signIn(h);
    h.setAgent(() => Response.json({ status: "error", text: "" }, { status: 503 }));
    expect((await handleApi(post(`/api/persons/${s.personId}/chat`, { message: "Hi", clientOpId: "op-1" }, s.token), h.env)).status).toBe(503);
  });
});

describe("rate windows use the time of admission", () => {
  it("does not reset an exhausted counter when a body held from an earlier hour completes", async () => {
    const h = harness();
    const s = await signIn(h);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await held;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: "Late", clientOpId: "late" })));
        controller.close();
      },
    });
    const late = handleApi(
      new Request(`https://web.test/api/persons/${s.personId}/chat`, { method: "POST", headers: auth(s.token), body, duplex: "half" } as RequestInit),
      h.env,
    );
    h.clock.now += 3600_000;
    for (let i = 0; i < 60; i++) await chatJson(h, s, "Hi", `fill-${i}`);
    const calls = h.agentCalls.length;
    release?.();
    expect((await late).status).toBe(429);
    expect(h.agentCalls).toHaveLength(calls);
    expect((await handleApi(post(`/api/persons/${s.personId}/chat`, { message: "Hi", clientOpId: "after" }, s.token), h.env)).status).toBe(429);
  });

  it("never moves a window backward, even if the clock does", () => {
    let now = Date.parse("2026-11-03T12:30:00Z");
    const store = new WebStore(sqlite(), () => now);
    const allow = () => (store as unknown as { allow(key: string, limit: number, windowMs: number): boolean }).allow("k", 1, 3600_000);
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
    now -= 3600_000;
    expect(allow()).toBe(false);
    now += 2 * 3600_000;
    expect(allow()).toBe(true);
  });
});

describe("an operation answers only for its own message", () => {
  const CRISIS = "I want to kill myself";
  const hasLine = (text: string) => expect(text).toMatch(/988[\s\S]*911/);

  it("does not carry an old question onto a crisis reply under the same operation", async () => {
    const h = harness();
    const s = await signIn(h);
    asking(h);
    const asked = await chatJson(h, s, "Send it", "x");
    expect(asked.ask).toEqual({ approvalId: "appr-1" });
    h.setAgent(() => Response.json({ status: "replied", text: "Hello from Mano." }));
    for (let i = 0; i < 59; i++) await chatJson(h, s, "Hi", `fill-${i}`);
    expect((await handleApi(post(`/api/persons/${s.personId}/chat`, { message: "Hi", clientOpId: "over" }, s.token), h.env)).status).toBe(429);

    const crisis = await chatJson(h, s, CRISIS, "x");
    hasLine(crisis.reply);
    expect(crisis.ask).toBeUndefined();
    expect((await shown(h, s, "appr-1", crisis.id)).status).toBe(409);
    expect(presentedCalls(h)).toHaveLength(0);
    const list = await handleApi(new Request(`https://web.test/api/persons/${s.personId}/conversation`, { headers: auth(s.token) }), h.env);
    const { messages } = (await list.json()) as { messages: { id: string; text: string; ask?: unknown }[] };
    expect(messages.find((m) => m.id === crisis.id)?.ask).toBeUndefined();
    expect(messages.find((m) => m.id === asked.id)?.text).toBe(QUESTION);
  });

  it("clears the question when a message's reply is replaced with none", () => {
    const store = new WebStore(sqlite(), () => Date.parse("2026-11-03T12:00:00Z"));
    store.beginTurn("x", "Send it");
    const first = store.finishTurn("x", QUESTION, { approvalId: "appr-1", textHash: "hash" });
    expect(first.ask).toEqual({ approvalId: "appr-1" });
    const second = store.finishTurn("x", "Something else.", null);
    expect(second.ask).toBeUndefined();
    expect(store.questionToReport("appr-1", first.id)).toBeNull();
    expect(store.listMessages().every((m) => m.ask === undefined)).toBe(true);
  });

  it("answers crisis wording under an operation already used for an ordinary message", async () => {
    const h = harness();
    const s = await signIn(h);
    await chatJson(h, s, "Hi", "same");
    const out = await chatJson(h, s, CRISIS, "same");
    hasLine(out.reply);
    expect(out.reply).not.toBe("Hello from Mano.");
  });

  it("runs a different ordinary message as its own turn and leaves the first reply alone", async () => {
    const h = harness();
    const s = await signIn(h);
    h.setAgent(() => Response.json({ status: "replied", text: "First." }));
    const first = await chatJson(h, s, "Hi", "same");
    h.setAgent(() => Response.json({ status: "replied", text: "Second." }));
    expect((await chatJson(h, s, "Something else", "same")).reply).toBe("Second.");
    const repeat = await chatJson(h, s, "Hi", "same");
    expect(repeat).toMatchObject({ id: first.id, reply: "First." });
    expect(h.agentCalls).toHaveLength(2);
  });

  it("answers a retry from the record at the limit, without spending a turn", async () => {
    const h = harness();
    const s = await signIn(h);
    await chatJson(h, s, "Hi", "first");
    for (let i = 0; i < 59; i++) await chatJson(h, s, "Hi", `fill-${i}`);
    const retry = await handleApi(post(`/api/persons/${s.personId}/chat`, { message: "Hi", clientOpId: "first" }, s.token), h.env);
    expect(retry.status).toBe(200);
  });
});

describe("the crisis check reads the whole message", () => {
  const route = (id: string) => `/api/persons/${id}/chat`;
  const hasLine = (text: string) => expect(text).toMatch(/988[\s\S]*911/);

  it("finds crisis wording past the first 16,384 characters", async () => {
    const h = harness();
    const s = await signIn(h);
    const res = await handleApi(post(route(s.personId), { message: `${"x".repeat(17_000)} I want to kill myself` }, s.token), h.env);
    expect(res.status).toBe(200);
    hasLine(((await res.json()) as { reply: string }).reply);
  });

  it("answers from what was read when a body passes the hard limit, and refuses the rest", async () => {
    const h = harness();
    const s = await signIn(h);
    const crisis = await handleApi(post(route(s.personId), { message: `${"x".repeat(100_000)} I want to kill myself ${"x".repeat(400_000)}` }, s.token), h.env);
    expect(crisis.status).toBe(200);
    hasLine(((await crisis.json()) as { reply: string }).reply);
    const plain = await handleApi(post(route(s.personId), { message: "x".repeat(400_000) }, s.token), h.env);
    expect(plain.status).toBe(400);
    expect(h.agentCalls).toHaveLength(0);
  });

  it("stops reading a body at the hard limit", async () => {
    const h = harness();
    const s = await signIn(h);
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await handleApi(
      new Request(`https://web.test${route(s.personId)}`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body, duplex: "half" } as RequestInit),
      h.env,
    );
    expect(res.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });
});
