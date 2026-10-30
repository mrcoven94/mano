import { describe, expect, it, vi } from "vitest";
import { CRISIS_CHECK_INSTRUCTIONS, decideCrisis } from "@mano/persona";
import { ModelCrisisCheck } from "../src/crisis-check.js";
import { SparkResponder } from "../src/responder.js";

const answer = (text: string) => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] }), { status: 200 });

describe("ModelCrisisCheck", () => {
  it("asks one question on a Standard model ID with store: false, and returns the answer", async () => {
    const fetchFn = vi.fn(async () => answer("no"));
    const check = new ModelCrisisCheck({ apiKey: "test-key-not-real", model: "muse-spark-1.3", fetchFn: fetchFn as typeof fetch, collectLogs: false });
    const decision = await decideCrisis("Should I stop taking my blood pressure pills?", check);
    expect(decision).toMatchObject({ crisis: false, reason: "model-no" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.meta.ai/v1/responses");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "muse-spark-1.3", instructions: CRISIS_CHECK_INSTRUCTIONS, store: false });
    expect(body.input).toEqual([{ role: "user", content: "Should I stop taking my blood pressure pills?" }]);
    expect(new Headers(init.headers).get("cf-aig-collect-log")).toBe("false");
  });

  it("refuses a -contributor model ID", () => {
    expect(() => new ModelCrisisCheck({ apiKey: "k", model: "muse-spark-1.3-contributor" })).toThrow(/Standard/);
  });

  it("is a crisis when the model call fails", async () => {
    const check = new ModelCrisisCheck({ apiKey: "k", model: "muse-spark-1.3", fetchFn: (async () => new Response("{}", { status: 503 })) as typeof fetch });
    expect(await decideCrisis("Should I stop taking my blood pressure pills?", check)).toMatchObject({ crisis: true, reason: "check-error" });
  });
});

describe("the responder uses the worker's crisis decision", () => {
  it("answers a health question as an ordinary turn when the worker decided no crisis", async () => {
    const fetchFn = vi.fn(async () => answer("don't stop them on your own. a doctor or pharmacist can tell you"));
    const responder = new SparkResponder({ apiKey: "k", model: "test-model-standard", fetchFn: fetchFn as typeof fetch });
    await responder.respond({ texts: ["Should I stop taking my blood pressure pills?"], attachmentCount: 0, crisis: false });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(JSON.parse(init.body as string).instructions)).not.toContain("Mano has already sent them this line");
  });
});
