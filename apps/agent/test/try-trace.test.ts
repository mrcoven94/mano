import { TRY_HANDLE_PREFIX } from "@mano/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tracedFillDeps, tracedMailModel, tryStepTrace } from "../agent/lib/try-trace.js";
import type { FillDeps } from "../agent/lib/computer-fill.js";

const DEMO = `${TRY_HANDLE_PREFIX}${"a".repeat(56)}`;
const REAL = "b".repeat(64);
const at = (ms: number) => new Date(Date.UTC(2026, 10, 4, 12) + ms).toISOString();

describe("reports for the judge demo", () => {
  let reports: Record<string, unknown>[];

  beforeEach(() => {
    reports = [];
    vi.stubEnv("ENGINE_URL", "https://engine.test");
    vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", "test-token-not-real");
    vi.stubEnv("MANO_MODEL_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key-not-real");
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      reports.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const step = (trace: ReturnType<typeof tryStepTrace>) => {
    trace.observe({ type: "step.started", meta: { at: at(0) } });
    trace.observe({ type: "message.appended", meta: { at: at(1500) } });
    trace.observe({ type: "step.completed", meta: { at: at(9000) } });
  };

  it("sends nothing for a real person", async () => {
    const seen: string[] = [];
    const trace = tryStepTrace(REAL, { observe: (e) => seen.push(e.type) });
    step(trace);
    await trace.flush();
    const mail = { live: true, responses: vi.fn(async () => ({})) } as never;
    expect(tracedMailModel(mail, REAL)).toBe(mail);
    const deps = { computer: {}, model: {} } as unknown as FillDeps;
    expect(tracedFillDeps(deps, `handle-${REAL}`)).toBe(deps);
    expect(seen).toHaveLength(3);
    expect(reports).toEqual([]);
  });

  it("times a step's model call to its last output, not its tools", async () => {
    const trace = tryStepTrace(DEMO, { observe: () => undefined });
    step(trace);
    await trace.flush();
    expect(reports).toEqual([
      { handleHash: DEMO, model: { model: "meta/muse-spark-open", where: "OpenRouter, zero retention", purpose: "Mano's turn", ms: 1500, status: "ok" } },
    ]);
  });

  it("says stand-in when no model was called", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("MANO_MODEL_PROVIDER", "");
    vi.stubEnv("META_MODEL_API_KEY", "");
    const trace = tryStepTrace(DEMO, { observe: () => undefined });
    step(trace);
    await trace.flush();
    expect((reports[0]!.model as { model: string }).model).toBe("stand-in, no model called");
  });

  it("reports a failed letter read and still throws", async () => {
    const client = { live: true, responses: async () => { throw new Error("402"); } } as never;
    await expect(tracedMailModel(client, DEMO).responses({ model: "meta/muse-spark-open" } as never)).rejects.toThrow("402");
    expect((reports[0]!.model as { status: string; purpose: string })).toMatchObject({ status: "failed", purpose: "Reading the letter" });
  });

  it("reports each new screen once, and only the model call's own status", async () => {
    const shots = [new Uint8Array([1]), new Uint8Array([1]), new Uint8Array([2])];
    const computer = { screenshot: async () => shots.shift()! } as never;
    const model = { createResponse: async () => ({ id: "r", status: "completed", output: [] }) };
    const deps = tracedFillDeps({ computer, model, modelId: "m", deadlineMs: 1, draftToken: "t" } as unknown as FillDeps, `handle-${DEMO}`) as FillDeps;
    await deps.computer.screenshot();
    await deps.computer.screenshot();
    await deps.computer.screenshot();
    expect(reports.filter((r) => r.screenB64)).toHaveLength(2);
    await deps.model.createResponse({ model: "muse-spark-1.3" } as never);
    expect(reports.at(-1)!.model).toMatchObject({ model: "muse-spark-1.3", where: "Meta's API", purpose: "Mano's computer", status: "completed" });
  });
});
