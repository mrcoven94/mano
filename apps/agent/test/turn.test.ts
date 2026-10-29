import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { engineFrom } from "../agent/lib/engine.js";
import { getKeyValue, resetKeyValue, type KeyValue } from "../agent/lib/storage.js";
import { handlePresented, handleTurn, type AgentTurnInput, type TurnDeps } from "../agent/lib/turn.js";
import { presentationHash } from "../agent/lib/pending.js";

const PRESENTATION_VECTOR = "33f67fe9f135d7efc24d4fbe91c1ed3c8bc540adde738809768ff2c8cbdb1245";
import startFormDraft from "../agent/tools/start_form_draft.js";
import remind from "../agent/tools/remind.js";
import { getReminderStore, resetReminderStores } from "../agent/lib/reminder-store.js";
import { guardReply } from "@mano/persona";

import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const SECRET = "turn-test-secret";
const HANDLE = "e".repeat(64);
const fields = {
  fullName: "Rosa Testcase",
  dateOfBirth: "1990-02-03",
  address: "12 Sample Street, Testville",
  phone: "555-0100",
  householdSize: 3,
  monthlyIncome: 1800,
};

let engine: EngineDouble;
let kv: KeyValue;
let agentCalls: AgentTurnInput[];

function signed(body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  return new Request("http://agent.test/channels/mano/turn", {
    method: "POST",
    headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(SECRET, ts, raw) },
    body: raw,
  });
}

const grants = new Map<string, string>();

function turn(turnId: string, text: string, handleHash = HANDLE, generation = 0): Request {
  return signed({ turnId, generation, handleHash, grant: grants.get(handleHash), texts: [text], attachmentCount: 0 });
}

// Stands in for Eve: the model either answers plainly or, asked to file,
// calls the real draft tool with the same auth the channel passes.
async function fakeAgent(input: AgentTurnInput) {
  agentCalls.push(input);
  if (/renewal/i.test(input.message)) {
    const ctx = toolCtx({
      handleHash: input.handleHash,
      turnId: input.turnId,
      grant: input.grant,
      generation: input.generation,
      turnAtMs: input.turnAtMs,
    });
    const name = /Claude Testcase/.test(input.message) ? "Claude Testcase" : fields.fullName;
    await startFormDraft.execute({ ...fields, fullName: name }, ctx);
    return { status: "replied" as const, text: "Your renewal is ready for your yes.", reason: "stop" };
  }
  return { status: "replied" as const, text: `Answer ${agentCalls.length}`, reason: "stop" };
}

function deps(overrides: Partial<TurnDeps> = {}): TurnDeps {
  return {
    secret: SECRET,
    kv,
    engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch }),
    runAgent: fakeAgent,
    ...overrides,
  };
}

function presentedRequest(body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  return new Request("http://agent.test/channels/mano/presented", {
    method: "POST",
    headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(SECRET, ts, raw) },
    body: raw,
  });
}

// Plays Channels: after a reply carrying an approval question goes out,
// Channels reports the approval ID and the hash of the question it sent.
async function send(request: Request, d = deps(), opts: { present?: boolean } = {}) {
  const copy = request.clone();
  const res = await handleTurn(request, d);
  const body = (await res.json()) as { status: string; text: string; approval?: string; approvalId?: string };
  if (body.status === "waiting_approval" && opts.present !== false) {
    const handleHash = JSON.parse(await copy.text()).handleHash;
    await handlePresented(
      presentedRequest({ handleHash, approvalId: body.approvalId, textHash: presentationHash(body.approval!) }),
      { secret: SECRET, kv },
    );
  }
  return { status: res.status, body };
}

beforeEach(async () => {
  engine = new EngineDouble();
  agentCalls = [];
  vi.stubEnv("MANO_ENV", "development");
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  grants.set(HANDLE, await grantFor(HANDLE));
  grants.set("f".repeat(64), await grantFor("f".repeat(64)));
  vi.stubGlobal("fetch", engine.fetch);
  resetKeyValue();
  kv = (await getKeyValue())!;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("approval by text", () => {
  it("question, YES: the exact frozen approval is approved and the action runs once", async () => {
    const ask = await send(turn("turn_ask_000001", "Please file my renewal"));
    expect(ask.status).toBe(200);
    expect(ask.body.text).toContain("Reply YES");
    expect(ask.body.text).toContain("Name: Rosa Testcase; Date of birth: 1990-02-03; Address: 12 Sample Street, Testville;");
    const [approval] = engine.approvals();
    expect(approval.status).toBe("pending");
    expect(engine.executor.calls).toHaveLength(0);

    const yes = await send(turn("turn_yes_000001", "YES"));
    expect(yes.status).toBe(200);
    expect(agentCalls).toHaveLength(1);
    expect(engine.approvals()[0].status).toBe("approved");
    expect(engine.executor.calls).toHaveLength(1);
    expect(engine.executor.calls[0].payload).toMatchObject(fields);
    expect(yes.body.text).toMatch(/simulated/i);
  });

  it("question, NO: nothing is sent, and a later YES approves nothing", async () => {
    await send(turn("turn_ask_000002", "Please file my renewal"));
    const no = await send(turn("turn_no_0000002", "no"));
    expect(no.status).toBe(200);
    expect(no.body.text).toMatch(/not send|nothing/i);
    expect(agentCalls).toHaveLength(1);
    expect(engine.executor.calls).toHaveLength(0);
    expect(engine.approvals()[0].status).toBe("rejected");

    await send(turn("turn_late_000002", "yes"));
    expect(engine.executor.calls).toHaveLength(0);
    expect(engine.approvals()[0].status).toBe("rejected");
    expect(agentCalls).toHaveLength(2);
  });

  it("a YES from a different person never touches someone else's approval", async () => {
    await send(turn("turn_ask_000003", "Please file my renewal"));
    await send(turn("turn_other00003", "YES", "f".repeat(64)));
    expect(engine.executor.calls).toHaveLength(0);
    expect(engine.approvals()[0].status).toBe("pending");
  });

  it("anything other than a plain yes or no goes to the model and leaves the approval pending", async () => {
    await send(turn("turn_ask_000004", "Please file my renewal"));
    const unclear = await send(turn("turn_what00004", "wait, which address did you use?"));
    expect(unclear.status).toBe(200);
    expect(agentCalls).toHaveLength(2);
    expect(engine.executor.calls).toHaveLength(0);
    const yes = await send(turn("turn_yes_000004", "yes"));
    expect(yes.status).toBe(200);
    expect(engine.executor.calls).toHaveLength(1);
  });
});

describe("a YES needs a question Channels confirmed it showed", () => {
  it("a YES before Channels reports the question as shown approves nothing", async () => {
    await send(turn("turn_unshown001", "Please file my renewal"), deps(), { present: false });
    const yes = await send(turn("turn_unshown002", "YES"));
    expect(yes.body.text).toMatch(/haven't shown you/i);
    expect(engine.executor.calls).toHaveLength(0);
    expect(engine.approvals()[0].status).toBe("pending");
  });

  it("a report with a different text hash, or for another approval, does not count", async () => {
    const ask = await send(turn("turn_unshown003", "Please file my renewal"), deps(), { present: false });
    const forged = await handlePresented(
      presentedRequest({ handleHash: HANDLE, approvalId: ask.body.approvalId, textHash: presentationHash(`${ask.body.approval} changed`) }),
      { secret: SECRET, kv },
    );
    expect(forged.status).toBe(409);
    const other = await handlePresented(
      presentedRequest({ handleHash: HANDLE, approvalId: "another-approval", textHash: presentationHash(ask.body.approval!) }),
      { secret: SECRET, kv },
    );
    expect(other.status).toBe(409);
    await send(turn("turn_unshown004", "YES"));
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("the hash both sides compute is pinned", () => {
    // packages/channels/test/agent.test.ts pins the same vector.
    expect(presentationHash("Reply YES  to send\nexactly this.")).toBe(PRESENTATION_VECTOR);
  });
});

describe("the approval question reaches the person exactly", () => {
  it("the question survives the text line's voice guard word for word", async () => {
    const ask = await send(turn("turn_exact00001", "Please file my renewal"));
    const question = ask.body.text.slice(ask.body.text.indexOf("Ready to send:"));
    expect(question).toContain("Name: Rosa Testcase");
    expect(guardReply(ask.body.text).text).toContain(question);
  });

  it("a draft the text line would alter is never put to a YES", async () => {
    const ask = await send(turn("turn_exact00002", "Please file my renewal for Claude Testcase"));
    expect(ask.body.text).not.toContain("Reply YES");
    expect(engine.approvals()[0].status).toBe("rejected");
    await send(turn("turn_exact00003", "YES"));
    expect(engine.executor.calls).toHaveLength(0);
  });
});

describe("uncertain and refused outcomes", () => {
  it("an unknown filing outcome is never reported as nothing sent, and the same approval is reconciled", async () => {
    await send(turn("turn_ask_000010", "Please file my renewal"));
    engine.executor.failNextWithTimeout = true;
    const realCheck = engine.executor.check.bind(engine.executor);
    let checkDown = true;
    engine.executor.check = async (key, personId) => {
      if (checkDown) throw new Error("portal unreachable");
      return realCheck(key, personId);
    };
    const yes = await send(turn("turn_yes_000010", "YES"));
    expect(yes.body.text).toMatch(/checking/i);
    expect(yes.body.text).not.toMatch(/nothing was sent/i);
    await send(turn("turn_ask_000011", "Please file my renewal"));
    expect(engine.approvals()).toHaveLength(1);
    checkDown = false;
    const again = await send(turn("turn_yes_000011", "YES"));
    expect(again.body.text).toMatch(/^Done/);
    expect(engine.executor.calls).toHaveLength(1);
  });

  it("a NO is confirmed only when Engine rejects the approval", async () => {
    await send(turn("turn_ask_000012", "Please file my renewal"));
    const [approval] = engine.approvals();
    // The YES went through in Engine but its answer never reached Mano.
    await engine.gateway.approveAndExecute(approval.id, approval.personId);
    const no = await send(turn("turn_no_0000012", "no"));
    expect(no.body.text).not.toMatch(/did not send|nothing left/i);
    expect(no.body.text).toMatch(/already/i);
  });
});

describe("after a deletion", () => {
  it("a YES in the new conversation never approves a draft from before the deletion", async () => {
    await send(turn("turn_ask_000013", "Please file my renewal"));
    await send(turn("turn_yes_000013", "YES", HANDLE, 1));
    expect(engine.executor.calls).toHaveLength(0);
    expect(engine.approvals()[0].status).toBe("rejected");
  });
});

describe("turn replay and recovery", () => {
  it("the same signed turn runs once; a replay gets the stored answer", async () => {
    const request = () => turn("turn_once000001", "hello");
    const first = await send(request());
    const replay = await send(request());
    expect(agentCalls).toHaveLength(1);
    expect(replay).toEqual(first);
  });

  it("a replayed YES never approves twice or sends twice", async () => {
    await send(turn("turn_ask_000005", "Please file my renewal"));
    const first = await send(turn("turn_yes_000005", "YES"));
    const replay = await send(turn("turn_yes_000005", "YES"));
    expect(replay).toEqual(first);
    expect(engine.executor.calls).toHaveLength(1);
  });

  it("a turn ID reused by another handle is refused", async () => {
    await send(turn("turn_dupe000001", "hello"));
    const other = await send(turn("turn_dupe000001", "hello", "f".repeat(64)));
    expect(other.status).toBe(409);
    expect(agentCalls).toHaveLength(1);
  });

  it("a turn that failed after setting a reminder, retried later, still makes one reminder", async () => {
    resetReminderStores();
    let now = Date.parse("2026-10-30T15:00:00Z");
    let attempt = 0;
    const flaky = deps({
      now: () => now,
      runAgent: async (input) => {
        attempt += 1;
        const ctx = toolCtx({ handleHash: input.handleHash, turnId: input.turnId, grant: input.grant, turnAtMs: input.turnAtMs });
        await remind.execute({ text: "call the county office", when: "in 2 minutes" }, ctx);
        if (attempt === 1) throw new Error("model call failed after the tool ran");
        return { status: "replied", text: "Set.", reason: "stop" };
      },
    });
    const first = await send(turn("turn_flaky00001", "Remind me in 2 minutes to call the county office."), flaky);
    expect(first.status).toBe(502);
    now += 60_000;
    const retry = await send(turn("turn_flaky00001", "Remind me in 2 minutes to call the county office."), flaky);
    expect(retry.status).toBe(200);
    const store = await getReminderStore();
    expect(await store!.listForHandle(HANDLE)).toHaveLength(1);
  });

  it("a turn still running is not run a second time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = deps({
      runAgent: async (input) => {
        agentCalls.push(input);
        await gate;
        return { status: "replied", text: "late", reason: "stop" };
      },
    });
    const running = send(turn("turn_slow000001", "hello"), slow);
    await vi.waitFor(() => expect(agentCalls).toHaveLength(1));
    const second = await send(turn("turn_slow000001", "hello"), slow);
    expect(second.status).toBe(409);
    release();
    expect((await running).status).toBe(200);
    expect(agentCalls).toHaveLength(1);
  });

  it("a turn without a signed turn ID is rejected", async () => {
    const res = await send(signed({ handleHash: HANDLE, generation: 0, grant: grants.get(HANDLE), texts: ["hello"], attachmentCount: 0 }));
    expect(res.status).toBe(400);
    const noGrant = await send(signed({ turnId: "turn_nogrant0001", generation: 0, handleHash: HANDLE, texts: ["hello"], attachmentCount: 0 }));
    expect(noGrant.status).toBe(400);
    expect(agentCalls).toHaveLength(0);
  });

  it("refuses to run without durable storage", async () => {
    const res = await send(turn("turn_nokv000001", "hello"), deps({ kv: null }));
    expect(res.status).toBe(503);
    expect(agentCalls).toHaveLength(0);
  });
});

describe("Guardian warm-up", () => {
  it("warms Guardian when a conversation starts, not on every turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const warms: number[] = [];
      const d = deps({ warmGuardian: async () => warms.push(Date.now()) });
      await send(turn("turn_warm000001", "hello"), d);
      vi.setSystemTime(Date.now() + 60_000);
      await send(turn("turn_warm000002", "and another thing"), d);
      expect(warms).toHaveLength(1);
      vi.setSystemTime(Date.now() + 20 * 60_000);
      await send(turn("turn_warm000003", "back again"), d);
      expect(warms).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed warm-up never affects the turn", async () => {
    const d = deps({ warmGuardian: async () => Promise.reject(new Error("down")) });
    const res = await send(turn("turn_warm000004", "hello"), d);
    expect(res.status).toBe(200);
  });
});
