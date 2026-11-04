import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

const KEYS = ["MANO_MODEL_PROVIDER", "META_MODEL_API_KEY", "OPENROUTER_API_KEY", "MODAL_ENDPOINT_URL", "MODAL_PROXY_TOKEN"] as const;
const MODAL_URL = "https://example--ep-test-server.us-west.modal.direct";

async function startAgent(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const name of KEYS) vi.stubEnv(name, env[name] ?? "");
  const logs: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" "));
    });
  }
  vi.resetModules();
  const { default: agent } = await import("../agent/agent.js");
  const { modelId } = agent.model as { modelId: string };
  return { modelId, pathLogs: logs.filter((line) => line.startsWith("mano: model path")) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("model path at startup", () => {
  it("runs the open-weight model on OpenRouter with only an OpenRouter key", async () => {
    const { modelId, pathLogs } = await startAgent({ MANO_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-openrouter-key" });
    expect(modelId).toBe("meta/muse-spark-open");
    expect(pathLogs).toEqual(["mano: model path openrouter meta/muse-spark-open"]);
  });

  it("answers with the stand-in when OpenRouter is chosen and no key is set", async () => {
    const { modelId, pathLogs } = await startAgent({ MANO_MODEL_PROVIDER: "openrouter" });
    expect(modelId).toBe("stand-in");
    expect(pathLogs).toHaveLength(1);
    expect(pathLogs[0]).toMatch(/^mano: model path stand-in/);
  });

  it("falls back to the Meta Model API when OpenRouter is chosen without its key", async () => {
    const { modelId, pathLogs } = await startAgent({ MANO_MODEL_PROVIDER: "openrouter", META_MODEL_API_KEY: "test-meta-key" });
    expect(modelId).toBe("muse-spark-1.3");
    expect(pathLogs).toEqual(["mano: model path meta muse-spark-1.3"]);
  });

  it("runs the Standard model on the Meta Model API with a Meta key", async () => {
    const { modelId, pathLogs } = await startAgent({ META_MODEL_API_KEY: "test-meta-key" });
    expect(modelId).toBe("muse-spark-1.3");
    expect(pathLogs).toEqual(["mano: model path meta muse-spark-1.3"]);
  });

  it("answers with the stand-in on the Meta Model API without a Meta key", async () => {
    const { modelId, pathLogs } = await startAgent({ OPENROUTER_API_KEY: "test-openrouter-key" });
    expect(modelId).toBe("stand-in");
    expect(pathLogs).toHaveLength(1);
    expect(pathLogs[0]).toMatch(/^mano: model path stand-in/);
  });

  it("runs the open-weight model on Modal only when it is chosen with both settings", async () => {
    const { modelId, pathLogs } = await startAgent({ MANO_MODEL_PROVIDER: "modal", MODAL_ENDPOINT_URL: MODAL_URL, MODAL_PROXY_TOKEN: "test-modal-token" });
    expect(modelId).toBe("meta-models/Muse-Spark-Open-816B-A42B");
    expect(pathLogs).toEqual(["mano: model path modal meta-models/Muse-Spark-Open-816B-A42B"]);
  });

  it("is off by default: Modal settings alone change nothing", async () => {
    const { modelId, pathLogs } = await startAgent({ META_MODEL_API_KEY: "test-meta-key", MODAL_ENDPOINT_URL: MODAL_URL, MODAL_PROXY_TOKEN: "test-modal-token" });
    expect(modelId).toBe("muse-spark-1.3");
    expect(pathLogs).toEqual(["mano: model path meta muse-spark-1.3"]);
  });

  it.each([
    ["no token", { MODAL_ENDPOINT_URL: MODAL_URL }],
    ["no URL", { MODAL_PROXY_TOKEN: "test-modal-token" }],
    ["a URL off Modal's domain", { MODAL_ENDPOINT_URL: "https://example.com", MODAL_PROXY_TOKEN: "test-modal-token" }],
    ["a URL that only looks like Modal's domain", { MODAL_ENDPOINT_URL: "https://x.modal.direct.example.com", MODAL_PROXY_TOKEN: "test-modal-token" }],
    ["a plain http URL", { MODAL_ENDPOINT_URL: "http://example--ep-test-server.us-west.modal.direct", MODAL_PROXY_TOKEN: "test-modal-token" }],
    ["a URL that does not parse", { MODAL_ENDPOINT_URL: "not a url", MODAL_PROXY_TOKEN: "test-modal-token" }],
  ])("reaches no model when Modal is chosen with %s, even with other keys set", async (_name, settings) => {
    const { modelId, pathLogs } = await startAgent({ MANO_MODEL_PROVIDER: "modal", META_MODEL_API_KEY: "test-meta-key", OPENROUTER_API_KEY: "test-openrouter-key", ...settings });
    expect(modelId).toBe("stand-in");
    expect(pathLogs).toHaveLength(1);
    expect(pathLogs[0]).toMatch(/^mano: model path stand-in/);
  });

  it("never logs a key", async () => {
    const { pathLogs } = await startAgent({ MANO_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-openrouter-key", META_MODEL_API_KEY: "test-meta-key" });
    expect(pathLogs.join("\n")).not.toMatch(/test-(openrouter|meta)-key/);
  });
});
