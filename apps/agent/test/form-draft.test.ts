import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import startFormDraft from "../agent/tools/start_form_draft.js";
import { resetKeyValue } from "../agent/lib/storage.js";
import { ENGINE_SECRET, ENGINE_URL, EngineDouble } from "./engine-double.js";

const HANDLE = "d".repeat(64);
const fields = {
  fullName: "Rosa Testcase",
  dateOfBirth: "1990-02-03",
  address: "12 Sample Street, Testville",
  phone: "555-0100",
  householdSize: 3,
  monthlyIncome: 1800,
};

function ctx(turnId: string) {
  return { session: { auth: { current: { principalId: HANDLE, attributes: { turnId } } } } } as never;
}

let engine: EngineDouble;
let outside: string[];

beforeEach(() => {
  resetKeyValue();
  engine = new EngineDouble();
  outside = [];
  vi.stubEnv("MANO_ENV", "development");
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("ENGINE_SESSION_SECRET", ENGINE_SECRET);
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
  resetKeyValue();
});

describe("starting a form draft", () => {
  it("sends nothing outside Mano: Engine freezes the exact draft and waits for the person's yes", async () => {
    const out = (await startFormDraft.execute(fields, ctx("turn_form000001"))) as Record<string, unknown>;
    expect(outside).toEqual([]);
    expect(engine.executor.calls).toHaveLength(0);
    const approvals = engine.approvals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe("pending");
    expect(approvals[0].actionType).toBe("submit");
    expect(JSON.parse(approvals[0].requestJson).payload).toMatchObject(fields);
    expect(out.approvalId).toBe(approvals[0].id);
  });

  it("refuses when Engine is not configured, and still sends nothing", async () => {
    vi.stubEnv("ENGINE_URL", "");
    await expect(startFormDraft.execute(fields, ctx("turn_form000002"))).rejects.toThrow(/not available/i);
    expect(outside).toEqual([]);
  });
});
