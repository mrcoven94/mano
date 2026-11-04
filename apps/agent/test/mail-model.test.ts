import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { engineFrom, personIdFor } from "../agent/lib/engine.js";
import { RENEWAL_PAGE, letterPhoto } from "../../../packages/mail/test/letter-fixture.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

// The agent's own Mail client, from the environment, on a texted photo:
// nothing here passes mailModel. Only OpenRouter's HTTP answer is stubbed.
const SECRET = "mail-model-test-secret";
const HANDLE = "d".repeat(64);
const PERSON = personIdFor(HANDLE);
const DOC = "g0t1i0-0123456789ab";

let engine: EngineDouble;
let modelBodies: { url: string; body: Record<string, unknown> }[];

async function photoTurn(turnId: string) {
  const raw = JSON.stringify({
    turnId,
    generation: 0,
    handleHash: HANDLE,
    grant: await grantFor(HANDLE),
    receivedAt: Date.now(),
    texts: [],
    attachmentCount: 1,
    documents: [{ id: DOC, mimeType: "image/jpeg" }],
  });
  const ts = Math.floor(Date.now() / 1000);
  return new Request("http://agent.test/channels/mano/turn", {
    method: "POST",
    headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(SECRET, ts, raw) },
    body: raw,
  });
}

async function sendPhoto(turnId: string) {
  vi.resetModules();
  const { handleTurn } = await import("../agent/lib/turn.js");
  const res = await handleTurn(await photoTurn(turnId), {
    secret: SECRET,
    engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch }),
    runAgent: async () => ({ status: "replied" as const, text: "unused", reason: "stop" }),
  });
  return (await res.json()) as { status: string; text: string };
}

beforeEach(async () => {
  engine = new EngineDouble();
  modelBodies = [];
  engine.putDocument(PERSON, DOC, new Uint8Array(await letterPhoto()));
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://openrouter.ai/") && !url.startsWith("https://api.meta.ai/")) return engine.fetch(input, init);
    modelBodies.push({ url, body: JSON.parse(init?.body as string) as Record<string, unknown> });
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: RENEWAL_PAGE } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200 },
    );
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a texted photo under MANO_MODEL_PROVIDER=openrouter", () => {
  it("is read by the pinned open-weight model and held through the gate, and SAM is skipped with its reason logged", async () => {
    vi.stubEnv("MANO_MODEL_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("META_MODEL_API_KEY", "test-meta-key");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void logs.push(String(line)));

    const { text } = await sendPhoto("turn_mailmodel01");

    expect(modelBodies.map((m) => [m.url, m.body.model])).toEqual([["https://openrouter.ai/api/v1/chat/completions", "meta/muse-spark-open"]]);
    expect(modelBodies[0]!.body.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(JSON.stringify(modelBodies[0]!.body.messages)).toContain("data:image/jpeg;base64,");
    expect(text).toMatch(/It is due November 20, 2026\./);
    expect(text).toContain("I saved November 20, 2026 to your deadlines.");
    expect(engine.deadlineCalls[0]!.body).toMatchObject({ dueDate: "2026-11-20" });
    const fallback = JSON.parse(logs.find((l) => l.includes("mano_letters_segmentation_fallback"))!) as { why: string };
    expect(fallback.why).toMatch(/SAM 3\.1 was not called/);
  });
});

describe("a texted photo without the setting", () => {
  it("stays on the Meta Model API, SAM included", async () => {
    vi.stubEnv("MANO_MODEL_PROVIDER", "");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("META_MODEL_API_KEY", "test-meta-key");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await sendPhoto("turn_mailmodel02");

    expect(modelBodies.every((m) => m.url === "https://api.meta.ai/v1/responses")).toBe(true);
    expect(modelBodies[0]!.body).toMatchObject({ model: "sam-3.1", store: false });
  });
});
