import { afterEach, describe, expect, it, vi } from "vitest";

import { PersonEngine } from "../agent/lib/engine.js";

describe("how long the agent waits on Engine", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits longer on a yes than on any other call, since a yes checks and then files", async () => {
    const waits: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      waits.push(ms);
      return real(ms);
    });
    const fetchFn = (async () => Response.json({ status: "completed" })) as unknown as typeof fetch;
    const engine = new PersonEngine({ baseUrl: "https://engine.test", agentToken: "t", fetchFn }, "a".repeat(64), "grant", 0);
    await engine.approve("appr-1");
    await engine.approval("appr-1").catch(() => undefined);
    await engine.approve("appr-1", 12_000);
    await engine.approve("appr-1", 60_000);
    expect(waits).toEqual([30_000, 15_000, 12_000, 30_000]);
  });
});
