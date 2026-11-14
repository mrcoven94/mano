import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GUARDIAN_PROMPT, HostedGuardianChecker, parseVerdict } from "../src/hosted.js";
import type { CheckInput } from "../src/types.js";

const ACTION: CheckInput = {
  action: { type: "submit", recipient: "portal:sandbox", purpose: "renewal", payload: { fullName: "Maria Testcase", householdSize: 3 }, documentHash: null },
  sources: [],
  consents: [],
  origin: "person",
};

function openRouter(content: string, finish = "stop", status = 200) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { role: "assistant", content } }] }), { status });
  }) as unknown as typeof fetch;
  return { sent, checker: new HostedGuardianChecker({ apiKey: "test-key-not-real", model: "anthropic/claude-haiku-5.5", fetchImpl }) };
}

describe("Guardian on a hosted model", () => {
  it("asks with the Modal server's prompt word for word", () => {
    const python = readFileSync(new URL("../modal/app.py", import.meta.url), "utf8");
    const block = python.slice(python.indexOf("SYSTEM_PROMPT = "), python.indexOf("\n)\n", python.indexOf("SYSTEM_PROMPT = ")));
    const lines = [...block.matchAll(/^\s+"((?:[^"\\]|\\.)*)",?$/gm)].map((m) => m[1]!.replace(/\\"/g, '"'));
    expect(lines.length).toBeGreaterThan(20);
    expect(GUARDIAN_PROMPT).toBe(lines.join("\n"));
  });

  it("sends the action under the zero-retention pin and passes on a clean pass", async () => {
    const { sent, checker } = openRouter(JSON.stringify({ review: "Fits the renewal.", verdict: "pass", problems: [] }));
    expect(await checker.check(ACTION)).toEqual({ verdict: "pass", problems: [] });
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent[0]!.body).toMatchObject({ model: "anthropic/claude-haiku-5.5", provider: { zdr: true, data_collection: "deny" } });
    expect(JSON.parse(String((sent[0]!.body.messages as { content: string }[])[1]!.content))).toMatchObject({ action: { recipient: "portal:sandbox" } });
  });

  it.each([
    ["a contradiction", JSON.stringify({ review: "ok", verdict: "pass", problems: ["x"] })],
    ["a missing review", JSON.stringify({ verdict: "pass", problems: [] })],
    ["an extra key", JSON.stringify({ review: "ok", verdict: "pass", problems: [], note: 1 })],
    ["a duplicated verdict", '{"review":"ok","verdict":"block","verdict":"pass","problems":[]}'],
    ["text that is not JSON", "pass"],
  ])("blocks on %s", async (_name, content) => {
    const { checker } = openRouter(content);
    expect((await checker.check(ACTION)).verdict).toBe("block");
  });

  it("blocks when the model is cut off or the call fails", async () => {
    expect((await openRouter(JSON.stringify({ review: "ok", verdict: "pass", problems: [] }), "length").checker.check(ACTION)).verdict).toBe("block");
    expect((await openRouter("", "stop", 402).checker.check(ACTION)).verdict).toBe("block");
  });

  it("is always warm, and refuses a model off its list", async () => {
    expect(await openRouter("").checker.warm()).toBe("ready");
    expect(() => new HostedGuardianChecker({ apiKey: "k", model: "openai/gpt-4o" })).toThrow();
    expect(parseVerdict(JSON.stringify({ review: "ok", verdict: "block", problems: ["p".repeat(241)] }))).toBeNull();
    expect(parseVerdict(JSON.stringify({ review: "ok", verdict: "block", problems: ["a", "b", "c", "d"] }))).toBeNull();
  });
});

