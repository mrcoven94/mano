import { TRY_HANDLE_PREFIX } from "@mano/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BudgetExceeded, SegmentationSkipped } from "@mano/mail";

import { identityOf, tracedFillDeps, tracedMailModel, tryStepTrace } from "../agent/lib/try-trace.js";
import { BACKUP_ANSWERED } from "../agent/lib/muse.js";
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

  const step = (trace: ReturnType<typeof tryStepTrace>, modelId = "openrouter/meta/muse-spark-open") => {
    trace.observe({ type: "step.started", meta: { at: at(0) }, data: { modelId } } as never);
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
      { handleHash: DEMO, model: { model: "meta/muse-spark-open", where: "OpenRouter, zero retention", state: "live", purpose: "Mano's turn", ms: 1500, status: "ok" } },
    ]);
  });

  it("never holds a fill up for a report, and closing waits for what is on its way", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      await held;
      reports.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    });
    let closed = false;
    const computer = { screenshot: async () => new Uint8Array([9]), close: async () => { closed = true; } } as never;
    const deps = tracedFillDeps({ computer, model: {}, modelId: "m", deadlineMs: 1, draftToken: "t" } as unknown as FillDeps, `handle-${DEMO}`) as FillDeps;
    await deps.computer.screenshot();
    expect(reports).toHaveLength(0);
    const closing = deps.computer.close();
    // A stalled report does not keep the computer open.
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(reports).toHaveLength(0);
    release();
    await closing;
    expect(reports).toHaveLength(1);
  });

  it("names whichever route the step itself used", async () => {
    const trace = tryStepTrace(DEMO, { observe: () => undefined });
    step(trace, "modal/meta-models/Muse-Spark-Open-816B-A42B");
    await trace.flush();
    expect(reports[0]!.model).toMatchObject({ model: "meta-models/Muse-Spark-Open-816B-A42B", where: "Modal", state: "live" });
  });

  it("names OpenRouter when the backup answered a step that started under Modal's name", async () => {
    const trace = tryStepTrace(DEMO, { observe: () => undefined });
    trace.observe({ type: "step.started", meta: { at: at(0) }, data: { modelId: "modal/meta-models/Muse-Spark-Open-816B-A42B" } } as never);
    trace.observe({ type: "message.appended", meta: { at: at(1500) } });
    trace.observe({ type: "step.completed", meta: { at: at(9000) }, data: { providerMetadata: { gateway: { generationId: BACKUP_ANSWERED } } } } as never);
    await trace.flush();
    expect(reports[0]!.model).toMatchObject({ model: "meta/muse-spark-open", where: "OpenRouter, zero retention", status: "ok" });
  });

  it("says stand-in when no model was called", async () => {
    const trace = tryStepTrace(DEMO, { observe: () => undefined });
    step(trace, "mano/stand-in");
    await trace.flush();
    expect(reports[0]!.model).toMatchObject({ model: "stand-in", where: "No model called", state: "stand-in" });
  });

  it("knows each route from the ID alone", () => {
    expect(identityOf("meta/muse-spark-1.3")).toEqual({ model: "muse-spark-1.3", where: "Meta's API", state: "live" });
    expect(identityOf("muse-spark-1.3")).toEqual({ model: "muse-spark-1.3", where: "Meta's API", state: "live" });
    expect(identityOf("meta/muse-spark-open").where).toBe("OpenRouter, zero retention");
    expect(identityOf("meta-models/Muse-Spark-Open-816B-A42B").where).toBe("Modal");
    expect(identityOf("something-new").where).toBe("Not known");
  });

  it("names the model that answered a read, not the one Mail asked for", async () => {
    const client = { live: true, responses: async () => ({ text: "", model: "meta/muse-spark-open" }) } as never;
    await tracedMailModel(client, DEMO).responses({ model: "muse-spark-1.3" } as never);
    expect(reports[0]!.model).toMatchObject({ model: "meta/muse-spark-open", where: "OpenRouter, zero retention", state: "live", status: "ok" });
  });

  it("marks a skipped call skipped, with no time and no failure", async () => {
    const skip = { live: true, responses: async () => { throw new SegmentationSkipped(); } } as never;
    await expect(tracedMailModel(skip, DEMO).responses({ model: "sam-3.1" } as never)).rejects.toThrow(SegmentationSkipped);
    expect(reports[0]!.model).toEqual({ model: "sam-3.1", where: "Not called", purpose: "Finding the letter in the photo", ms: 0, status: "skipped", state: "skipped" });
    const budget = { live: true, responses: async () => { throw new BudgetExceeded(); } } as never;
    await expect(tracedMailModel(budget, DEMO).responses({ model: "muse-spark-1.3" } as never)).rejects.toThrow(BudgetExceeded);
    expect(reports[1]!.model).toMatchObject({ state: "skipped", status: "skipped" });
  });

  it("names the route on a failed read, since a failure has no answer to read", async () => {
    const client = { live: true, responses: async () => { throw new Error("402"); } } as never;
    await expect(tracedMailModel(client, DEMO).responses({ model: "muse-spark-1.3" } as never)).rejects.toThrow("402");
    expect(reports[0]!.model).toMatchObject({ model: "meta/muse-spark-open", where: "OpenRouter, zero retention", state: "live", status: "failed", purpose: "Reading the letter" });
  });

  it("marks a read with no model as a stand-in", async () => {
    const client = { live: false, responses: async () => { throw new Error("nothing recorded"); } } as never;
    await expect(tracedMailModel(client, DEMO).responses({ model: "muse-spark-1.3" } as never)).rejects.toThrow();
    expect(reports[0]!.model).toMatchObject({ model: "stand-in", where: "No model called", state: "stand-in" });
  });

  it("reports each new screen once, and only the model call's own status", async () => {
    const shots = [new Uint8Array([1]), new Uint8Array([1]), new Uint8Array([2])];
    const computer = { screenshot: async () => shots.shift()!, close: async () => undefined } as never;
    const model = { createResponse: async () => ({ id: "r", status: "completed", output: [] }) };
    const deps = tracedFillDeps({ computer, model, modelId: "m", deadlineMs: 1, draftToken: "t" } as unknown as FillDeps, `handle-${DEMO}`) as FillDeps;
    await deps.computer.screenshot();
    await deps.computer.screenshot();
    await deps.computer.screenshot();
    await deps.model.createResponse({ model: "muse-spark-1.3" } as never);
    await deps.computer.close();
    expect(reports.filter((r) => r.screenB64)).toHaveLength(2);
    expect(reports.at(-1)!.model).toMatchObject({ model: "muse-spark-1.3", where: "Meta's API", purpose: "Mano's computer", status: "completed", state: "live" });
  });
});
