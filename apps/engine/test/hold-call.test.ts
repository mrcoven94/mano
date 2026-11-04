import { SELF, env as testEnv, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import type { PersonAgent } from "../src/agents/person-agent.js";
import { endText, legDialed, looksLikeHuman, stepHoldCall, type EndReason, type HoldCall } from "../src/calls/hold-call.js";
import { HoldCalls, type HoldAudit, type HoldLimit } from "../src/calls/hold-calls.js";
import { createCallServices, parseCallConfig, setCallServicesForTests, type CallEvent, type CallProvider, type CallServices, type PlaceCall } from "../src/calls/provider.js";
import { DefiniteFailureError, TimeoutError, setExecutorFactoryForTests, type ActionRequest } from "../src/gateway/index.js";

// Hold for me through the real agent, gateway, worker route and timers, with
// a fake phone company and a fake transcriber. Nothing here proves a real
// call or a real transcription.

const AGENT_TOKEN = "test-agent-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const OFFICE = "+12065550100";
const PHONE = "+12065550199";

class FakeProvider implements CallProvider {
  readonly simulated = true;
  ops: string[] = [];
  placed: PlaceCall[] = [];
  failPlace: Error | null = null;
  failBridge = false;
  // While set, a dial stays pending. Polled rather than awaited, because a
  // test and the agent run in different request contexts.
  holdDial = false;
  failHangUp = false;
  holdHangUp = false;
  hangUpsTried = 0;

  async placeCall(call: PlaceCall) {
    this.placed.push(call);
    while (this.holdDial) await new Promise((r) => setTimeout(r, 5));
    if (this.failPlace) throw this.failPlace;
    this.ops.push(`place ${call.leg} ${call.to}`);
    return { providerCallId: `${call.leg}-leg` };
  }
  async sendDtmf(id: string, digits: string) {
    this.ops.push(`dtmf ${id} ${digits}`);
  }
  async startListening(id: string) {
    this.ops.push(`listen ${id}`);
  }
  async bridge(office: string, person: string) {
    if (this.failBridge) throw new Error("bridge failed");
    this.ops.push(`bridge ${office} ${person}`);
  }
  async hangUp(id: string) {
    this.hangUpsTried += 1;
    while (this.holdHangUp) await new Promise((r) => setTimeout(r, 5));
    if (this.failHangUp) throw new Error("hang up failed");
    this.ops.push(`hang_up ${id}`);
  }
  async parseWebhook(request: Request) {
    if (request.headers.get("x-signature") !== "good") return "reject" as const;
    return (await request.json()) as CallEvent | "ignore";
  }
}

function setup(over: Partial<CallServices["config"]> = {}, heard: () => Promise<string> = async () => "") {
  const handle = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const person = personIdForHandle(handle);
  const provider = new FakeProvider();
  const sent: { handleHash: string; key: string; text: string }[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    // The stub is global, so an earlier test's alarm can land here too.
    const body = JSON.parse(String(init?.body)) as (typeof sent)[number];
    if (body.handleHash === handle) sent.push(body);
    return Response.json({ sent: true });
  });
  setCallServicesForTests({
    provider,
    transcriber: { transcribe: heard },
    config: {
      allowedNumbers: new Set([OFFICE]),
      personId: person,
      personNumber: PHONE,
      holdLimitMs: 3_600_000,
      ringLimitMs: 45_000,
      ...over,
    },
  });
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName(person));
  const call = async (method: string, path: string, body?: unknown) =>
    SELF.fetch(`https://engine.test/api/persons/${person}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "x-mano-handle-grant": await mintHandleGrant(handle, GRANT_SECRET),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { handle, person, provider, sent, stub, agent: stub as unknown as PersonAgent, call };
}

type Harness = ReturnType<typeof setup>;

// The services are global, so a short timer this test leaves running would
// fire during a later test and hang up on that test's provider.
function useLongLimits(h: Harness) {
  setCallServicesForTests({
    provider: h.provider,
    transcriber: { transcribe: async () => "" },
    config: { allowedNumbers: new Set([OFFICE]), personId: h.person, personNumber: PHONE, holdLimitMs: 3_600_000, ringLimitMs: 45_000 },
  });
}

async function request(h: Harness, payload: Record<string, unknown> = { phoneNumber: OFFICE }, key = "call-1") {
  const res = await h.call("POST", "/action", {
    type: "call",
    recipient: "Sandbox Benefits Office",
    purpose: "ask why the renewal is late",
    payload,
    idempotencyKey: key,
    actor: "foreground",
    sources: [],
    origin: "person",
    generation: 0,
  });
  return (await res.json()) as { status: string; reason?: string; approval?: { id: string; recipient: string; purpose: string; requestJson: string } };
}

async function approve(h: Harness, payload?: Record<string, unknown>) {
  const asked = await request(h, payload);
  expect(asked.status).toBe("needs_approval");
  const res = await h.call("POST", `/approvals/${asked.approval!.id}/approve`);
  return (await res.json()) as { status: string; reason?: string; receipt?: { externalId: string; simulated: boolean } };
}

function holdCallId(h: Harness): string {
  return h.provider.placed[0]!.holdCallId;
}

async function webhook(h: Harness, leg: "office" | "person", kind: "answered" | "hung_up", eventId: string, signature = "good") {
  const event: CallEvent = { eventId, holdCallId: holdCallId(h), personId: h.person, leg, kind, providerCallId: `${leg}-leg` };
  return SELF.fetch("https://engine.test/webhooks/calls", {
    method: "POST",
    headers: { "x-signature": signature },
    body: JSON.stringify(event),
  });
}

async function hear(h: Harness) {
  await h.agent.holdCallAudio(holdCallId(h), new Uint8Array([1, 2, 3]));
}

// The one text the reminder alarm handed to Channels for this person.
async function textSent(h: Harness): Promise<string> {
  await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(0), { timeout: 8000, interval: 50 });
  expect(h.sent).toHaveLength(1);
  return h.sent[0]!.text;
}

async function nothingQueued(h: Harness) {
  const out = (await (await h.call("GET", "/reminders")).json()) as { reminders: unknown[] };
  expect(out.reminders).toEqual([]);
  expect(h.sent).toEqual([]);
}

// Runs the real alarm once the limit has passed, unless it already fired.
async function afterLimit(h: Harness, done: () => boolean) {
  await vi.waitFor(
    async () => {
      if (!done()) await runDurableObjectAlarm(h.stub);
      expect(done()).toBe(true);
    },
    { timeout: 8000, interval: 200 },
  );
}

afterEach(() => {
  setCallServicesForTests(null);
  setExecutorFactoryForTests(null);
  vi.unstubAllGlobals();
});

describe("hold for me through the real agent", () => {
  it("asks first, naming who and why, and places nothing until the yes", async () => {
    const h = setup();
    const asked = await request(h);
    expect(asked.status).toBe("needs_approval");
    expect(asked.approval!.recipient).toBe("Sandbox Benefits Office");
    expect(asked.approval!.purpose).toBe("ask why the renewal is late");
    expect(JSON.parse(asked.approval!.requestJson).payload.phoneNumber).toBe(OFFICE);
    expect(h.provider.ops).toEqual([]);
  });

  it("holds, hears a person, rings the phone and bridges, and plays nothing", async () => {
    const lines = ["", "your call is important to us, please stay on the line", "Hi, this is Sam, how can I help you?"];
    const h = setup({}, async () => lines.shift()!);
    const done = await approve(h, { phoneNumber: OFFICE, menu: "1WW2" });
    expect(done.status).toBe("completed");
    expect(done.receipt).toMatchObject({ externalId: "office-leg", simulated: true });

    await webhook(h, "office", "answered", "e1");
    await hear(h);
    await hear(h);
    expect(h.provider.ops).toEqual([`place office ${OFFICE}`, "dtmf office-leg 1WW2", "listen office-leg"]);

    await hear(h);
    await webhook(h, "person", "answered", "e2");
    expect(h.provider.ops).toEqual([
      `place office ${OFFICE}`,
      "dtmf office-leg 1WW2",
      "listen office-leg",
      `place person ${PHONE}`,
      "bridge office-leg person-leg",
    ]);
    await nothingQueued(h);

    await webhook(h, "person", "hung_up", "e3");
    expect(h.provider.ops.at(-1)).toBe("hang_up office-leg");
    await nothingQueued(h);
  });

  it("sends no menu keys unless they were given", async () => {
    const h = setup();
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    expect(h.provider.ops).toEqual([`place office ${OFFICE}`, "listen office-leg"]);
  });

  it("hangs up and texts when nobody picks up by the hold limit, on the real timer", async () => {
    // Timers fire on whole seconds, so a shorter limit can beat the webhook.
    const h = setup({ holdLimitMs: 2500 });
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    await afterLimit(h, () => h.provider.ops.includes("hang_up office-leg"));
    const text = await textSent(h);
    expect(text).toContain("nobody picked up");
    expect(text).toContain("Sandbox Benefits Office");
  });

  it("hangs up and texts when the person does not answer, on the real ring timer", async () => {
    const h = setup({ ringLimitMs: 300 }, async () => "hello, this is Sam");
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    await hear(h);
    await afterLimit(h, () => h.provider.ops.includes("hang_up office-leg"));
    expect(h.provider.ops).toContain("hang_up person-leg");
    expect(h.provider.ops.some((op) => op.startsWith("bridge"))).toBe(false);
    expect(await textSent(h)).toContain("could not reach you");
  });

  it("hangs up and texts when the person declines", async () => {
    const h = setup({}, async () => "hello, this is Sam");
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    await hear(h);
    await webhook(h, "person", "hung_up", "e2");
    expect(h.provider.ops).toContain("hang_up office-leg");
    expect(h.provider.ops).not.toContain("hang_up person-leg");
    expect(await textSent(h)).toContain("could not reach you");
  });

  it("acts once on a duplicate webhook", async () => {
    const h = setup({}, async () => "hello, this is Sam");
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    await webhook(h, "office", "answered", "e1");
    await hear(h);
    await hear(h);
    await webhook(h, "person", "answered", "e2");
    await webhook(h, "person", "answered", "e2");
    await webhook(h, "person", "answered", "e3");
    const count = (op: string) => h.provider.ops.filter((o) => o === op).length;
    expect(count("listen office-leg")).toBe(1);
    expect(count(`place person ${PHONE}`)).toBe(1);
    expect(count("bridge office-leg person-leg")).toBe(1);
  });

  it("refuses a webhook with a bad signature and changes nothing", async () => {
    const h = setup();
    await approve(h);
    const res = await webhook(h, "office", "answered", "e1", "forged");
    expect(res.status).toBe(401);
    expect(h.provider.ops).toEqual([`place office ${OFFICE}`]);
  });

  it("hangs up and says so when it cannot listen, instead of holding for an hour", async () => {
    const h = setup({}, async () => {
      throw new Error("402");
    });
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    await hear(h);
    await hear(h);
    expect(h.provider.ops).not.toContain("hang_up office-leg");
    await hear(h);
    expect(h.provider.ops).toContain("hang_up office-leg");
    expect(await textSent(h)).toContain("could not listen");
  });

  it("ends both legs and texts when the bridge fails", async () => {
    const h = setup({}, async () => "hello, this is Sam");
    h.provider.failBridge = true;
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    await hear(h);
    await webhook(h, "person", "answered", "e2");
    expect(h.provider.ops).toEqual(expect.arrayContaining(["hang_up office-leg", "hang_up person-leg"]));
    expect(await textSent(h)).toContain("Something went wrong");
  });

  it("hangs up the live call when the conversation is deleted", async () => {
    const h = setup();
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    await h.agent.deleteConversation(h.person, { generation: 1 });
    expect(h.provider.ops).toContain("hang_up office-leg");
  });
});

describe("only our own numbers and the one person", () => {
  it("refuses a number off the list before asking and never dials it", async () => {
    const h = setup();
    const asked = await request(h, { phoneNumber: "+12065550111" });
    expect(asked.status).toBe("blocked");
    expect(asked.reason).toContain("test numbers");
    expect(h.provider.placed).toEqual([]);
  });

  it("refuses a number written another way", async () => {
    const h = setup();
    for (const phoneNumber of ["2065550100", "+1 206 555 0100", 12065550100, undefined]) {
      expect((await request(h, { phoneNumber }, `k-${String(phoneNumber)}`)).status).toBe("blocked");
    }
    expect(h.provider.placed).toEqual([]);
  });

  it("refuses anyone but the configured person", async () => {
    const h = setup();
    const other = setup();
    setCallServicesForTests({
      provider: other.provider,
      transcriber: { transcribe: async () => "" },
      config: { allowedNumbers: new Set([OFFICE]), personId: h.person, personNumber: PHONE, holdLimitMs: 1000, ringLimitMs: 1000 },
    });
    expect((await request(other)).status).toBe("blocked");
    expect(other.provider.placed).toEqual([]);
  });

  it("refuses at dial time when the number left the list after the yes", async () => {
    const h = setup();
    const asked = await request(h);
    setCallServicesForTests({
      provider: h.provider,
      transcriber: { transcribe: async () => "" },
      config: { allowedNumbers: new Set(["+12065550101"]), personId: h.person, personNumber: PHONE, holdLimitMs: 1000, ringLimitMs: 1000 },
    });
    const res = (await (await h.call("POST", `/approvals/${asked.approval!.id}/approve`)).json()) as { status: string };
    expect(res.status).toBe("blocked");
    expect(h.provider.placed).toEqual([]);
  });

  it("refuses menu steps that are not phone keys", async () => {
    const h = setup();
    expect((await request(h, { phoneNumber: OFFICE, menu: "1; hang up" })).status).toBe("blocked");
  });

  it("allows one call at a time", async () => {
    const h = setup();
    await approve(h);
    const second = await request(h, { phoneNumber: OFFICE }, "call-2");
    const res = (await (await h.call("POST", `/approvals/${second.approval!.id}/approve`)).json()) as { status: string; reason: string };
    expect(res.status).toBe("blocked");
    expect(res.reason).toContain("already on a call");
    expect(h.provider.placed).toHaveLength(1);
  });
});

describe("a dial with an unknown outcome", () => {
  it("stays blocked with no second dial, and reconciles once a webhook proves the call", async () => {
    const h = setup();
    h.provider.failPlace = new TimeoutError();
    const first = await approve(h);
    expect(first.status).toBe("blocked");

    await new Promise((r) => setTimeout(r, 5));
    expect((await h.agent.recoverStrandedAttempts(0)).recovered.map((r) => r.status)).toEqual(["blocked"]);
    expect(h.provider.placed).toHaveLength(1);

    await webhook(h, "office", "answered", "e1");
    expect((await h.agent.recoverStrandedAttempts(0)).recovered.map((r) => r.status)).toEqual(["reconciled"]);
    expect(h.provider.placed).toHaveLength(1);
    expect(h.provider.ops).toEqual(["listen office-leg"]);
  });

  it("allows a clean retry after the provider refused the dial", async () => {
    const h = setup();
    h.provider.failPlace = new DefiniteFailureError("refused");
    const asked = await request(h);
    const first = (await (await h.call("POST", `/approvals/${asked.approval!.id}/approve`)).json()) as { status: string };
    expect(first.status).toBe("blocked");
    h.provider.failPlace = null;
    const retried = (await (await h.call("POST", `/approvals/${asked.approval!.id}/approve`)).json()) as { status: string };
    expect(retried.status).toBe("completed");
    expect(h.provider.ops).toEqual([`place office ${OFFICE}`]);
  });
});

describe("deleting the conversation while a dial is pending", () => {
  async function deleteDuringDial(h: Harness) {
    h.provider.holdDial = true;
    const asked = await request(h);
    const approving = h.call("POST", `/approvals/${asked.approval!.id}/approve`);
    await vi.waitFor(() => expect(h.provider.placed).toHaveLength(1), { timeout: 5000, interval: 10 });
    await h.agent.deleteConversation(h.person, { generation: 1 });
    return { approving };
  }

  it("hangs up the leg the dial returns", async () => {
    const h = setup();
    const { approving } = await deleteDuringDial(h);
    expect(h.provider.ops).not.toContain("hang_up office-leg");
    h.provider.holdDial = false;
    await approving;
    expect(h.provider.ops).toContain("hang_up office-leg");
  });

  it("hangs up a leg a late webhook names, once, and when the dial returns it does not hang up again", async () => {
    const h = setup();
    const { approving } = await deleteDuringDial(h);
    await webhook(h, "office", "answered", "late");
    expect(h.provider.ops.filter((op) => op === "hang_up office-leg")).toHaveLength(1);
    h.provider.holdDial = false;
    await approving;
    expect(h.provider.ops.filter((op) => op === "hang_up office-leg")).toHaveLength(1);
  });

  it("keeps nothing about who was called", async () => {
    const h = setup();
    const { approving } = await deleteDuringDial(h);
    h.provider.holdDial = false;
    await approving;
    const rows = await runInDurableObject(h.stub, (_agent, state) => state.storage.sql.exec("SELECT call_json FROM hold_calls").toArray());
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("Sandbox Benefits Office");
    expect(JSON.stringify(rows)).not.toContain(OFFICE);
  });
});

// A HoldCalls on the agent's own storage whose timers and audit log can be
// paused at one point, so an event can land between a step and its effects.
function paused(h: Harness, state: DurableObjectState, at: { limit?: HoldLimit["kind"]; audit?: HoldAudit; failing?: boolean }) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen = { reached: false };
  const stop = async () => {
    if (at.failing) throw new Error("storage failed");
    seen.reached = true;
    await gate;
  };
  const conversation = { generation: 0 };
  const limits: HoldLimit[] = [];
  const calls = new HoldCalls({
    sql: state.storage.sql,
    transaction: (fn) => state.storage.transactionSync(fn),
    services: createCallServices,
    generation: () => conversation.generation,
    schedule: async (_at, limit) => {
      limits.push(limit);
      if (limit.kind === at.limit) await stop();
    },
    text: async () => {},
    audit: async (event) => {
      if (event === at.audit) await stop();
    },
  });
  const req: ActionRequest = {
    type: "call",
    recipient: "Sandbox Benefits Office",
    purpose: "ask why the renewal is late",
    payload: { phoneNumber: OFFICE },
    idempotencyKey: "paused-1",
    actor: "foreground",
    personId: h.person,
  };
  const event = (leg: "office" | "person", kind: "answered" | "hung_up", eventId: string) =>
    calls.onEvent({ eventId, holdCallId: holdCallId(h), personId: h.person, leg, kind, providerCallId: `${leg}-leg` });
  const reached = async () => {
    while (!seen.reached) await new Promise((r) => setTimeout(r, 1));
  };
  const deleteConversation = () => {
    conversation.generation += 1;
    return calls.conversationDeleted();
  };
  return { calls, req, event, reached, release, deleteConversation, limits };
}

describe("effects that wait while the call moves on", () => {
  const heardPerson = async () => "hello, this is Sam";

  it.each([
    ["the ring limit is being armed", { limit: "ring_limit" as const }],
    ["the audit log is being written", { audit: "hold_call.ringing_person" as const }],
  ])("does not dial the person when the office hung up while %s", async (_name, at) => {
    const h = setup({}, heardPerson);
    await runInDurableObject(h.stub, async (_agent, state) => {
      const p = paused(h, state, at);
      await p.calls.begin(p.req);
      await p.event("office", "answered", "e1");
      const hearing = p.calls.onAudio(holdCallId(h), new Uint8Array([1]));
      await p.reached();
      await p.event("office", "hung_up", "e2");
      p.release();
      await hearing;
    });
    expect(h.provider.ops.filter((op) => op.startsWith("place person"))).toEqual([]);
  });

  it("does not bridge when the office hung up while the audit log was being written", async () => {
    const h = setup({}, heardPerson);
    await runInDurableObject(h.stub, async (_agent, state) => {
      const p = paused(h, state, { audit: "hold_call.bridged" });
      await p.calls.begin(p.req);
      await p.event("office", "answered", "e1");
      await p.calls.onAudio(holdCallId(h), new Uint8Array([1]));
      const answering = p.event("person", "answered", "e2");
      await p.reached();
      await p.event("office", "hung_up", "e3");
      p.release();
      await answering;
    });
    expect(h.provider.ops.filter((op) => op.startsWith("bridge"))).toEqual([]);
    expect(h.provider.ops).toContain("hang_up person-leg");
  });
});

describe("the first dial, around every await before it", () => {
  const rowCount = (state: DurableObjectState) => state.storage.sql.exec("SELECT id FROM hold_calls").toArray().length;
  const named = (name: string) => expect.objectContaining({ name });

  it("does not dial or keep a row when the conversation is deleted while the ID is hashed", async () => {
    const h = setup();
    await runInDurableObject(h.stub, async (_agent, state) => {
      const p = paused(h, state, {});
      const beginning = p.calls.begin(p.req);
      await p.deleteConversation();
      await expect(beginning).rejects.toEqual(named("DefiniteFailureError"));
      expect(rowCount(state)).toBe(0);
    });
    expect(h.provider.placed).toEqual([]);
  });

  it.each([
    ["the hold limit is armed", { limit: "hold_limit" as const }],
    ["the dial is logged", { audit: "hold_call.dialing" as const }],
  ])("does not dial or keep a row when the conversation is deleted while %s", async (_name, at) => {
    const h = setup();
    await runInDurableObject(h.stub, async (_agent, state) => {
      const p = paused(h, state, at);
      const beginning = p.calls.begin(p.req);
      await p.reached();
      await p.deleteConversation();
      p.release();
      await expect(beginning).rejects.toEqual(named("DefiniteFailureError"));
      expect(rowCount(state)).toBe(0);
    });
    expect(h.provider.placed).toEqual([]);
  });

  it.each([
    ["arming the hold limit", { limit: "hold_limit" as const, failing: true }],
    ["logging the dial", { audit: "hold_call.dialing" as const, failing: true }],
  ])("leaves nothing behind when %s fails, so the next call can go", async (_name, at) => {
    const h = setup();
    await runInDurableObject(h.stub, async (_agent, state) => {
      const p = paused(h, state, at);
      await expect(p.calls.begin(p.req)).rejects.toEqual(named("DefiniteFailureError"));
      expect(rowCount(state)).toBe(0);
      await expect(p.calls.check(p.req.idempotencyKey, h.person)).resolves.toEqual({ found: false });
      expect(h.provider.placed).toEqual([]);

      const next = paused(h, state, {});
      await next.calls.begin({ ...next.req, idempotencyKey: "paused-2" });
    });
    expect(h.provider.placed).toHaveLength(1);
  });

  it("does not dial when the hold limit passed before the dial could start", async () => {
    const h = setup({ holdLimitMs: 1 });
    await runInDurableObject(h.stub, async (_agent, state) => {
      const p = paused(h, state, { audit: "hold_call.dialing" });
      const beginning = p.calls.begin(p.req);
      await p.reached();
      await new Promise((r) => setTimeout(r, 5));
      p.release();
      await expect(beginning).rejects.toEqual(named("DefiniteFailureError"));
    });
    expect(h.provider.placed).toEqual([]);
  });

  it("dials once when two calls reach the dial together", async () => {
    const h = setup();
    await runInDurableObject(h.stub, async (_agent, state) => {
      const p = paused(h, state, {});
      const results = await Promise.allSettled([p.calls.begin(p.req), p.calls.begin({ ...p.req, idempotencyKey: "paused-2" })]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    });
    expect(h.provider.placed).toHaveLength(1);
  });
});

describe("a call stays in the way until every leg is confirmed down", () => {
  const humanLine = async () => "hello, this is Sam";

  async function approveAnother(h: Harness) {
    const asked = await request(h, { phoneNumber: OFFICE }, "call-2");
    return (await (await h.call("POST", `/approvals/${asked.approval!.id}/approve`)).json()) as { status: string; reason?: string };
  }

  // The office answers and the real hold limit ends the call.
  async function answeredThenLimit() {
    const h = setup({ holdLimitMs: 2000 });
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    return h;
  }

  it("blocks a replacement while the hang up has failed, until a webhook confirms the leg is down", async () => {
    const h = await answeredThenLimit();
    h.provider.failHangUp = true;
    await afterLimit(h, () => h.provider.hangUpsTried > 0);
    useLongLimits(h);
    const second = await approveAnother(h);
    expect(second.status).toBe("blocked");
    expect(second.reason).toContain("already on a call");
    expect(h.provider.placed).toHaveLength(1);

    await webhook(h, "office", "hung_up", "e2");
    const third = await request(h, { phoneNumber: OFFICE }, "call-3");
    const res = (await (await h.call("POST", `/approvals/${third.approval!.id}/approve`)).json()) as { status: string };
    expect(res.status).toBe("completed");
  });

  it("blocks a replacement while the hang up is still pending", async () => {
    const h = setup();
    await runInDurableObject(h.stub, async (_agent, state) => {
      const p = paused(h, state, {});
      await p.calls.begin(p.req);
      await p.event("office", "answered", "e1");
      h.provider.holdHangUp = true;
      const ending = p.calls.onLimit(p.limits[0]!);
      while (h.provider.hangUpsTried === 0) await new Promise((r) => setTimeout(r, 1));
      await expect(p.calls.begin({ ...p.req, idempotencyKey: "paused-2" })).rejects.toThrow("already on a call");
      h.provider.holdHangUp = false;
      await ending;
      await p.calls.begin({ ...p.req, idempotencyKey: "paused-3" });
    });
    expect(h.provider.placed).toHaveLength(2);
  });

  it("clears the block as soon as the hang up succeeds", async () => {
    const h = await answeredThenLimit();
    await afterLimit(h, () => h.provider.ops.includes("hang_up office-leg"));
    useLongLimits(h);
    expect((await approveAnother(h)).status).toBe("completed");
  });

  it("keeps blocking past the office leg's cap while a later person leg can still be up", async () => {
    const h = setup({}, humanLine);
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    // The clock cannot be moved in here, so only the office leg's stored time
    // is moved: its cap is a minute away when the person's phone is dialed.
    await runInDurableObject(h.stub, (_agent, state) => {
      const row = state.storage.sql.exec("SELECT id, call_json FROM hold_calls").toArray()[0] as { id: string; call_json: string };
      const call = { ...JSON.parse(row.call_json), liveUntilMs: Date.now() + 60_000 };
      state.storage.sql.exec("UPDATE hold_calls SET call_json = ?, blocks_until_ms = ? WHERE id = ?", JSON.stringify(call), call.liveUntilMs, row.id);
    });
    const before = Date.now();
    await hear(h);
    const blocksUntil = await runInDurableObject(h.stub, (_agent, state) => (state.storage.sql.exec("SELECT blocks_until_ms AS b FROM hold_calls").toArray()[0] as { b: number }).b);
    expect(blocksUntil).toBeGreaterThanOrEqual(before + h.provider.placed[1]!.maxSeconds * 1000);
  });

  it("never shortens the time a call blocks when a leg is dialed", () => {
    const call = { liveUntilMs: 5000, legs: { office: "open", person: "none" } } as unknown as HoldCall;
    expect(legDialed(call, "person", 4000).liveUntilMs).toBe(5000);
    expect(legDialed(call, "person", 6000).liveUntilMs).toBe(6000);
    expect(legDialed(call, "person", 4000).legs.person).toBe("open");
  });
});

describe("the person's dial follows the same rules as the office's", () => {
  const humanLine = async () => "hello, this is Sam";

  async function ringWithDialHeld() {
    const h = setup({}, humanLine);
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    h.provider.holdDial = true;
    const hearing = hear(h);
    await vi.waitFor(() => expect(h.provider.placed).toHaveLength(2), { timeout: 5000, interval: 10 });
    return { h, hearing };
  }

  async function anotherStatus(h: Harness, key = "call-2") {
    const asked = await request(h, { phoneNumber: OFFICE }, key);
    return ((await (await h.call("POST", `/approvals/${asked.approval!.id}/approve`)).json()) as { status: string }).status;
  }

  it.each([
    ["timed out", () => new TimeoutError()],
    ["was refused", () => new DefiniteFailureError("refused")],
  ])("keeps a connected call when the person's dial %s after a webhook proved the leg", async (_name, failure) => {
    const { h, hearing } = await ringWithDialHeld();
    await webhook(h, "person", "answered", "e2");
    expect(h.provider.ops).toContain("bridge office-leg person-leg");
    h.provider.failPlace = failure();
    h.provider.holdDial = false;
    await hearing;
    expect(h.provider.ops.filter((op) => op.startsWith("hang_up"))).toEqual([]);
    await nothingQueued(h);
  });

  it("blocks a replacement after a person's dial with an unknown outcome, and a late answer is hung up and clears it", async () => {
    const { h, hearing } = await ringWithDialHeld();
    h.provider.failPlace = new TimeoutError();
    h.provider.holdDial = false;
    await hearing;
    expect(h.provider.ops).toContain("hang_up office-leg");
    expect(await textSent(h)).toContain("Something went wrong");
    h.provider.failPlace = null;
    expect(await anotherStatus(h)).toBe("blocked");

    await webhook(h, "person", "answered", "late");
    expect(h.provider.ops).toContain("hang_up person-leg");
    expect(h.provider.ops.filter((op) => op.startsWith("bridge"))).toEqual([]);
    expect(await anotherStatus(h, "call-3")).toBe("completed");
  });

  it("does not block a replacement after the provider refused the person's dial", async () => {
    const { h, hearing } = await ringWithDialHeld();
    h.provider.failPlace = new DefiniteFailureError("refused");
    h.provider.holdDial = false;
    await hearing;
    expect(h.provider.ops).toContain("hang_up office-leg");
    h.provider.failPlace = null;
    expect(await anotherStatus(h)).toBe("completed");
  });

  it("gives both legs the same cap and a key for their own leg", async () => {
    const h = setup({}, humanLine);
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    await hear(h);
    const [office, person] = h.provider.placed;
    expect(person!.maxSeconds).toBe(office!.maxSeconds);
    expect(person!.idempotencyKey).not.toBe(office!.idempotencyKey);
  });
});

describe("a dial that fails after a webhook proved the call", () => {
  it.each([
    ["refused", () => new DefiniteFailureError("refused")],
    ["timed out", () => new TimeoutError()],
  ])("keeps the call and answers with its leg when the dial %s", async (_name, failure) => {
    const h = setup();
    h.provider.holdDial = true;
    const asked = await request(h);
    const approving = h.call("POST", `/approvals/${asked.approval!.id}/approve`);
    await vi.waitFor(() => expect(h.provider.placed).toHaveLength(1), { timeout: 5000, interval: 10 });
    await webhook(h, "office", "answered", "e1");
    h.provider.failPlace = failure();
    h.provider.holdDial = false;
    const done = (await (await approving).json()) as { status: string; receipt?: { externalId: string } };
    expect(done.status).toBe("completed");
    expect(done.receipt?.externalId).toBe("office-leg");
    await webhook(h, "office", "hung_up", "e2");
    expect(h.provider.ops).toEqual(["listen office-leg"]);
    await expect(request(h, { phoneNumber: OFFICE }, "call-2")).resolves.toMatchObject({ status: "needs_approval" });
  });
});

describe("a dial the provider may have accepted but never named", () => {
  // Times the dial out, then lets the real hold limit end the call.
  async function unknownThenLimit() {
    // Timers fire on whole seconds, so a shorter limit can beat the dial's row.
    const h = setup({ holdLimitMs: 2000 });
    h.provider.failPlace = new TimeoutError();
    const asked = await request(h);
    await h.call("POST", `/approvals/${asked.approval!.id}/approve`);
    await afterLimit(h, () => h.sent.length > 0);
    expect(await textSent(h)).toContain("could not get through");
    h.provider.failPlace = null;
    useLongLimits(h);
    return h;
  }

  async function approveAnother(h: Harness) {
    const asked = await request(h, { phoneNumber: OFFICE }, "call-2");
    return (await (await h.call("POST", `/approvals/${asked.approval!.id}/approve`)).json()) as { status: string; reason?: string };
  }

  it("blocks a replacement after the hold limit, since the first may still be up", async () => {
    const h = await unknownThenLimit();
    const second = await approveAnother(h);
    expect(second.status).toBe("blocked");
    expect(second.reason).toContain("already on a call");
    expect(h.provider.placed).toHaveLength(1);
  });

  it("records a late hung_up as proof, with no hang up, and reconciles", async () => {
    const h = await unknownThenLimit();
    await webhook(h, "office", "hung_up", "late");
    expect(h.provider.ops).toEqual([]);
    expect((await h.agent.recoverStrandedAttempts(0)).recovered.map((r) => r.status)).toEqual(["reconciled"]);
    expect((await approveAnother(h)).status).toBe("completed");
  });

  it("hangs up a late answer and then allows a replacement", async () => {
    const h = await unknownThenLimit();
    await webhook(h, "office", "answered", "late");
    expect(h.provider.ops).toEqual(["hang_up office-leg"]);
    expect((await approveAnother(h)).status).toBe("completed");
  });

  it("stops blocking and reads as absent once the provider's cap has certainly passed", async () => {
    const h = await unknownThenLimit();
    // The cap is hours away and the clock cannot be moved in here, so only
    // the stored time is moved.
    await runInDurableObject(h.stub, (_agent, state) => {
      const row = state.storage.sql.exec("SELECT id, call_json FROM hold_calls").toArray()[0] as { id: string; call_json: string };
      const call = { ...JSON.parse(row.call_json), liveUntilMs: Date.now() - 1 };
      state.storage.sql.exec("UPDATE hold_calls SET call_json = ?, blocks_until_ms = ? WHERE id = ?", JSON.stringify(call), call.liveUntilMs, row.id);
    });
    const swept = await h.agent.recoverStrandedAttempts(0);
    expect(swept.recovered.map((r) => r.status)).toEqual(["blocked"]);
    expect(h.provider.placed).toHaveLength(1);
    expect((await h.agent.recoverStrandedAttempts(0)).recovered).toEqual([]);
    expect((await approveAnother(h)).status).toBe("completed");
  });

  it("does not let a bridged call whose end was never reported block forever", async () => {
    const h = setup({}, async () => "hello, this is Sam");
    await approve(h);
    await webhook(h, "office", "answered", "e1");
    await hear(h);
    await webhook(h, "person", "answered", "e2");
    await runInDurableObject(h.stub, (_agent, state) => {
      const row = state.storage.sql.exec("SELECT id, call_json FROM hold_calls").toArray()[0] as { id: string; call_json: string };
      const call = { ...JSON.parse(row.call_json), liveUntilMs: Date.now() - 1 };
      state.storage.sql.exec("UPDATE hold_calls SET call_json = ?, blocks_until_ms = ? WHERE id = ?", JSON.stringify(call), call.liveUntilMs, row.id);
    });
    expect((await approveAnother(h)).status).toBe("completed");
  });
});

describe("a retry after the provider refused the dial", () => {
  it("is not ended by the failed attempt's timer", async () => {
    const h = setup({ holdLimitMs: 1500 });
    h.provider.failPlace = new DefiniteFailureError("refused");
    const asked = await request(h);
    await h.call("POST", `/approvals/${asked.approval!.id}/approve`);
    h.provider.failPlace = null;
    useLongLimits(h);
    const retried = (await (await h.call("POST", `/approvals/${asked.approval!.id}/approve`)).json()) as { status: string };
    expect(retried.status).toBe("completed");

    await new Promise((r) => setTimeout(r, 2600));
    await runDurableObjectAlarm(h.stub);
    expect(h.provider.ops).not.toContain("hang_up office-leg");
    await webhook(h, "office", "answered", "e1");
    expect(h.provider.ops).toContain("listen office-leg");
  });

  it("gives the provider a new command key, so a refused dial is not replayed", async () => {
    const h = setup();
    h.provider.failPlace = new DefiniteFailureError("refused");
    const asked = await request(h);
    await h.call("POST", `/approvals/${asked.approval!.id}/approve`);
    h.provider.failPlace = null;
    await h.call("POST", `/approvals/${asked.approval!.id}/approve`);
    const [first, second] = h.provider.placed;
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });
});

describe("a reconciled call's receipt", () => {
  function unknownDial() {
    const h = setup();
    // A real filing executor underneath: only the call provider is a stand-in.
    setExecutorFactoryForTests(() => ({
      simulated: false,
      async execute() {
        throw new Error("a call must not reach the filing executor");
      },
      async check() {
        throw new Error("a call must not reconcile against the filing executor");
      },
    }));
    h.provider.failPlace = new TimeoutError();
    return h;
  }

  it("says simulated when a stand-in provider placed the call, after a recovery sweep", async () => {
    const h = unknownDial();
    const asked = await request(h);
    await h.call("POST", `/approvals/${asked.approval!.id}/approve`);
    await webhook(h, "office", "answered", "e1");
    await new Promise((r) => setTimeout(r, 5));
    expect((await h.agent.recoverStrandedAttempts(0)).recovered.map((r) => r.status)).toEqual(["reconciled"]);
    const list = (await (await h.call("GET", "/approvals")).json()) as { approvals: { id: string; outcome: { receipt: { simulated: boolean } | null } }[] };
    expect(list.approvals.find((a) => a.id === asked.approval!.id)?.outcome.receipt?.simulated).toBe(true);
  });

  it("says simulated when a stand-in provider placed the call, after a second yes", async () => {
    const h = unknownDial();
    const asked = await request(h);
    await h.call("POST", `/approvals/${asked.approval!.id}/approve`);
    await webhook(h, "office", "answered", "e1");
    const again = (await (await h.call("POST", `/approvals/${asked.approval!.id}/approve`)).json()) as { status: string; receipt?: { simulated: boolean } };
    expect(again.status).toBe("reconciled");
    expect(again.receipt?.simulated).toBe(true);
  });
});

describe("with no provider set up", () => {
  it("has no webhook route and reports calls off", async () => {
    expect((await SELF.fetch("https://engine.test/webhooks/calls", { method: "POST", body: "{}" })).status).toBe(404);
    const health = (await (await SELF.fetch("https://engine.test/health")).json()) as { live: { calls: string } };
    expect(health.live.calls).toBe("off");
  });
});

describe("the state machine's late events", () => {
  const dialing: HoldCall = {
    id: "c",
    personId: "p",
    officeName: "Office",
    officeNumber: OFFICE,
    menu: null,
    generation: 0,
    startedAtMs: 0,
    attempt: "a",
    simulated: true,
    liveUntilMs: 0,
    legs: { office: "open", person: "none" },
    state: "dialing",
    officeCallId: null,
  };

  it("hangs up a leg whose ID arrives after the call ended", () => {
    const ended = stepHoldCall(dialing, { kind: "hold_limit" }).call;
    const late = stepHoldCall(ended, { kind: "placed", leg: "office", providerCallId: "o" });
    expect(late.effects).toEqual([{ do: "hang_up", leg: "office", callId: "o" }]);
    expect(stepHoldCall(late.call, { kind: "answered", leg: "office", providerCallId: "o" }).effects).toEqual([]);
  });

  it("ignores old timers once bridged, and an event about another leg", () => {
    const holding = stepHoldCall(dialing, { kind: "answered", leg: "office", providerCallId: "o" }).call;
    const ringing = stepHoldCall(holding, { kind: "heard", human: true }).call;
    const bridged = stepHoldCall(ringing, { kind: "answered", leg: "person", providerCallId: "m" }).call;
    expect(bridged.state).toBe("bridged");
    for (const kind of ["hold_limit", "ring_limit", "listen_failed"] as const) {
      expect(stepHoldCall(bridged, { kind }).effects).toEqual([]);
    }
    expect(stepHoldCall(bridged, { kind: "hung_up", leg: "office", providerCallId: "other" }).call.state).toBe("bridged");
  });

  it("records a late hung_up's ID with no hang up, and hangs up only a leg still up", () => {
    const ended = stepHoldCall(dialing, { kind: "hold_limit" }).call;
    const down = stepHoldCall(ended, { kind: "hung_up", leg: "office", providerCallId: "o" });
    expect(down.effects).toEqual([]);
    expect(down.call.officeCallId).toBe("o");
    const stray = stepHoldCall(down.call, { kind: "answered", leg: "office", providerCallId: "other" });
    expect(stray.effects).toEqual([{ do: "hang_up", leg: "office", callId: "other" }]);
    expect(stray.call.officeCallId).toBe("o");
  });

  it("hangs up the person's leg when the office hangs up while it rings", () => {
    const holding = stepHoldCall(dialing, { kind: "answered", leg: "office", providerCallId: "o" }).call;
    const ringing = stepHoldCall(holding, { kind: "heard", human: true }).call;
    const placed = stepHoldCall(ringing, { kind: "placed", leg: "person", providerCallId: "m" }).call;
    const out = stepHoldCall(placed, { kind: "hung_up", leg: "office", providerCallId: "o" });
    expect(out.effects).toEqual([{ do: "hang_up", leg: "person", callId: "m" }, { do: "text", reason: "office_hung_up" }]);
  });

  it("texts for every ending but a connected call or a deleted conversation", () => {
    const silent: EndReason[] = ["completed", "deleted"];
    const told: EndReason[] = ["no_human", "person_no_answer", "office_hung_up", "office_no_answer", "listen_failed", "provider_failed"];
    for (const reason of silent) expect(endText(reason, "Office", 5)).toBeNull();
    for (const reason of told) expect(endText(reason, "Office", 5)).toContain("Office");
  });
});

describe("telling a person from a recording", () => {
  it.each([
    ["Thanks for holding, this is Dana.", true],
    ["Thank you for calling, how may I help you?", true],
    ["Hello? Is anyone there?", true],
    ["Benefits office, Marcus speaking.", true],
    ["Gracias por esperar, mi nombre es Ana.", true],
    ["", false],
    ["music", false],
    ["Your call is important to us. Please stay on the line.", false],
    ["Hello, thank you for calling. For English, press 1.", false],
    ["Your estimated wait time is 20 minutes.", false],
    ["This call may be recorded. This is the benefits office.", false],
    ["Su llamada es importante, permanezca en la linea.", false],
  ])("%s", (line, human) => {
    expect(looksLikeHuman(line)).toBe(human);
  });
});

describe("call config", () => {
  const good = { MANO_CALL_ALLOWED_NUMBERS: `${OFFICE}, +12065550101`, MANO_CALL_PERSON_ID: "p", MANO_CALL_PERSON_NUMBER: PHONE };

  it("reads our numbers and the limits' defaults", () => {
    const config = parseCallConfig(good);
    expect([...config.allowedNumbers]).toEqual([OFFICE, "+12065550101"]);
    expect(config.holdLimitMs).toBe(3_600_000);
    expect(config.ringLimitMs).toBe(45_000);
  });

  it("fails loud on an empty list, a bad number, or a missing person", () => {
    expect(() => parseCallConfig({ ...good, MANO_CALL_ALLOWED_NUMBERS: "" })).toThrow(/ALLOWED_NUMBERS/);
    expect(() => parseCallConfig({ ...good, MANO_CALL_ALLOWED_NUMBERS: "2065550100" })).toThrow(/E.164/);
    expect(() => parseCallConfig({ ...good, MANO_CALL_PERSON_ID: undefined })).toThrow(/PERSON_ID/);
    expect(() => parseCallConfig({ ...good, MANO_CALL_PERSON_NUMBER: "x" })).toThrow(/PERSON_NUMBER/);
  });
});
