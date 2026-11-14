/// <reference types="node" />
import { readFileSync } from "node:fs";
import { HOSTED_GUARDIAN_MODELS } from "@mano/guardian";
import { describe, expect, it } from "vitest";
import { checkerSetting } from "../src/gateway/guardian.js";

// Guardian as production runs it since November 14, 2026: the hosted model
// apps/engine/wrangler.toml names, through OpenRouter, with the key the
// Engine deploy puts on the Worker. The Modal server is stopped.
function vars(path: string): Record<string, string> {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  const section = text.split(/^\[vars\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  return Object.fromEntries([...section.matchAll(/^(\w+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1], m[2]]));
}

const engine = vars("../wrangler.toml");
const channels = vars("../../channels/wrangler.toml");
const KEY = "test-key-not-real";

describe("Guardian as deployed", () => {
  it("runs on an allowed hosted model through OpenRouter", () => {
    expect(engine.MANO_MODEL_PROVIDER).toBe("openrouter");
    expect(HOSTED_GUARDIAN_MODELS).toContain(engine.MANO_GUARDIAN_MODEL);
    expect(checkerSetting({ ...engine, OPENROUTER_API_KEY: KEY })).toEqual({ kind: "hosted-guardian", model: engine.MANO_GUARDIAN_MODEL, apiKey: KEY });
  });

  it("is a different model from the agent's and the text line's", () => {
    expect(engine.MANO_AGENT_MODEL).toBeTruthy();
    expect(engine.MANO_GUARDIAN_MODEL).not.toBe(engine.MANO_AGENT_MODEL);
    expect(engine.MANO_GUARDIAN_MODEL).not.toBe(channels.MANO_OPEN_WEIGHT_MODEL);
  });

  it("names no Modal server beside it, and without the key every action blocks", () => {
    for (const name of ["MANO_GUARDIAN_URL", "MANO_GUARDIAN_TOKEN", "MANO_GUARDIAN_KEY_ID", "MANO_GUARDIAN_KEY_SECRET"]) expect(engine[name]).toBeUndefined();
    expect(checkerSetting({ ...engine, OPENROUTER_API_KEY: KEY, MANO_GUARDIAN_URL: "https://guardian.test/check" })).toEqual({ kind: "guardian-misconfigured" });
    expect(checkerSetting(engine)).toEqual({ kind: "guardian-misconfigured" });
  });
});
