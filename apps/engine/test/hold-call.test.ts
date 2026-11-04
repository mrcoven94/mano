import { SELF, env as testEnv, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import type { PersonAgent } from "../src/agents/person-agent.js";
import { endText, looksLikeHuman, stepHoldCall, type EndReason, type HoldCall } from "../src/calls/hold-call.js";
import { parseCallConfig, setCallServicesForTests, type CallEvent, type CallProvider, type CallServices, type PlaceCall } from "../src/calls/provider.js";
import { DefiniteFailureError, TimeoutError } from "../src/gateway/index.js";

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

  async placeCall(call: PlaceCall) {
    this.placed.push(call);
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
    sent.push(JSON.parse(String(init?.body)));
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
  expect(h.sent[0]!.handleHash).toBe(h.handle);
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
    state: "dialing",
    officeCallId: null,
  };

  it("hangs up a leg whose ID arrives after the call ended", () => {
    const ended = stepHoldCall(dialing, { kind: "hold_limit" }).call;
    const late = stepHoldCall(ended, { kind: "placed", leg: "office", providerCallId: "o" });
    expect(late.effects).toEqual([{ do: "hang_up", callId: "o" }]);
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

  it("hangs up the person's leg when the office hangs up while it rings", () => {
    const holding = stepHoldCall(dialing, { kind: "answered", leg: "office", providerCallId: "o" }).call;
    const ringing = stepHoldCall(holding, { kind: "heard", human: true }).call;
    const placed = stepHoldCall(ringing, { kind: "placed", leg: "person", providerCallId: "m" }).call;
    const out = stepHoldCall(placed, { kind: "hung_up", leg: "office", providerCallId: "o" });
    expect(out.effects).toEqual([{ do: "hang_up", callId: "m" }, { do: "text", reason: "office_hung_up" }]);
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
