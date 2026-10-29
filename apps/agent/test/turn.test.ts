import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { EngineClient } from "../agent/lib/engine.js";
import { getKeyValue, resetKeyValue, type KeyValue } from "../agent/lib/storage.js";
import { handleTurn, type AgentTurnInput, type TurnDeps } from "../agent/lib/turn.js";
import startFormDraft from "../agent/tools/start_form_draft.js";
import { ENGINE_SECRET, ENGINE_URL, EngineDouble } from "./engine-double.js";

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

function turn(turnId: string, text: string, handleHash = HANDLE): Request {
  return signed({ turnId, handleHash, texts: [text], attachmentCount: 0 });
}

// Stands in for Eve: the model either answers plainly or, asked to file,
// calls the real draft tool with the same auth the channel passes.
async function fakeAgent(input: AgentTurnInput) {
  agentCalls.push(input);
  if (/renewal/i.test(input.message)) {
    const ctx = {
      session: {
        auth: {
          current: { principalId: input.handleHash, attributes: { turnId: input.turnId, turnAtMs: String(input.turnAtMs) } },
        },
      },
    } as never;
    await startFormDraft.execute(fields, ctx);
    return { status: "replied" as const, text: "Your renewal is ready for your yes.", reason: "stop" };
  }
  return { status: "replied" as const, text: `Answer ${agentCalls.length}`, reason: "stop" };
}

function deps(overrides: Partial<TurnDeps> = {}): TurnDeps {
  return {
    secret: SECRET,
    kv,
    engine: new EngineClient({ baseUrl: ENGINE_URL, sessionSecret: ENGINE_SECRET, fetchFn: engine.fetch }),
    runAgent: fakeAgent,
    ...overrides,
  };
}

async function send(request: Request, d = deps()) {
  const res = await handleTurn(request, d);
  return { status: res.status, body: (await res.json()) as { status: string; text: string } };
}

beforeEach(async () => {
  engine = new EngineDouble();
  agentCalls = [];
  vi.stubEnv("MANO_ENV", "development");
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("ENGINE_SESSION_SECRET", ENGINE_SECRET);
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
    expect(ask.body.text).toMatch(/Name: Rosa Testcase\nDate of birth: 1990-02-03\nAddress: 12 Sample Street, Testville/);
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

    await send(turn("turn_late_000002", "yes"));
    expect(engine.executor.calls).toHaveLength(0);
    expect(engine.approvals()[0].status).toBe("pending");
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
    const res = await send(signed({ handleHash: HANDLE, texts: ["hello"], attachmentCount: 0 }));
    expect(res.status).toBe(400);
    expect(agentCalls).toHaveLength(0);
  });

  it("refuses to run without durable storage", async () => {
    const res = await send(turn("turn_nokv000001", "hello"), deps({ kv: null }));
    expect(res.status).toBe(503);
    expect(agentCalls).toHaveLength(0);
  });
});
