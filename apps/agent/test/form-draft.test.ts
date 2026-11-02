import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import startFormDraft from "../agent/tools/start_form_draft.js";
import { engineFrom } from "../agent/lib/engine.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const HANDLE = "d".repeat(64);
const fields = {
  fullName: "Rosa Testcase",
  dateOfBirth: "1990-02-03",
  address: "12 Sample Street, Testville",
  phone: "555-0100",
  householdSize: 3,
  monthlyIncome: 1800,
};

let engine: EngineDouble;
let outside: string[];
let grant: string;

// The turn handler records each turn in Engine's ledger before the model
// runs; a draft names its turn, and Engine orders drafts by it.
async function ctx(turnId: string, turnAtMs = Date.now()) {
  await engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!
    .forHandle(HANDLE, grant, 0)
    .putTurn(turnId, new Date(turnAtMs).toISOString());
  return toolCtx({ handleHash: HANDLE, turnId, grant, turnAtMs });
}

beforeEach(async () => {
  grant = await grantFor(HANDLE);
  engine = new EngineDouble();
  outside = [];
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubEnv("MANO_PORTAL_URL", "http://portal.test");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(ENGINE_URL)) return engine.fetch(input, init);
    outside.push(url);
    return new Response("Not found", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("starting a form draft", () => {
  it("sends nothing outside Mano: Engine freezes the exact draft and waits for the person's yes", async () => {
    const out = (await startFormDraft.execute(fields, await ctx("turn_form000001"))) as Record<string, unknown>;
    expect(outside).toEqual([]);
    expect(engine.executor.calls).toHaveLength(0);
    const approvals = engine.approvals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe("pending");
    expect(approvals[0].actionType).toBe("submit");
    expect(JSON.parse(approvals[0].requestJson).payload).toMatchObject(fields);
    expect(out.approvalId).toBe(approvals[0].id);
  });

  it("a newer draft closes the one before it", async () => {
    await startFormDraft.execute(fields, await ctx("turn_form000003"));
    await startFormDraft.execute({ ...fields, householdSize: 4 }, await ctx("turn_form000004", Date.now() + 10));
    expect(engine.approvals().map((a) => a.status).sort()).toEqual(["pending", "rejected"]);
  });

  it("refuses when Engine is not configured, and still sends nothing", async () => {
    const c = await ctx("turn_form000002");
    vi.stubEnv("ENGINE_URL", "");
    await expect(startFormDraft.execute(fields, c)).rejects.toThrow(/not available/i);
    expect(outside).toEqual([]);
  });
});
