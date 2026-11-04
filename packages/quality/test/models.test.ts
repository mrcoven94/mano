// A1: the model client reads the repo's Meta key, and the judge model ID must
// differ from the serving model ID.

import assert from "node:assert/strict";
import test from "node:test";
import { OPEN_WEIGHT_JUDGE_ID, OPEN_WEIGHT_MODEL_ID, OpenRouterModelClient, assertJudgeServingDiffer, judgeClientFromEnv, openRouterKey } from "../src/models.ts";

test("model client uses META_MODEL_API_KEY and stays fake without it", () => {
  const live = judgeClientFromEnv({ META_MODEL_API_KEY: "k", MANO_MODEL_BASE_URL: "https://models.test", MANO_MODEL_JUDGE_ID: "judge-1" });
  assert.equal(live.live, true);
  assert.equal(live.id, "judge-1");
  const fake = judgeClientFromEnv({});
  assert.equal(fake.live, false);
  const oldNameIgnored = judgeClientFromEnv({ MANO_MODEL_API_KEY: "k", MANO_MODEL_BASE_URL: "https://models.test" });
  assert.equal(oldNameIgnored.live, false);
});

test("model base URL defaults instead of silently standing in", () => {
  const live = judgeClientFromEnv({ META_MODEL_API_KEY: "k" });
  assert.equal(live.live, true);
  assert.equal(live.id, "muse-spark-1.3");
});

test("judge and serving model IDs must differ", () => {
  assert.throws(
    () => assertJudgeServingDiffer({ MANO_MODEL_JUDGE_ID: "same-id", MANO_MODEL_BENCH_ID: "same-id" }),
    /must differ/,
  );
  assert.throws(
    () => assertJudgeServingDiffer({ MANO_MODEL_BENCH_ID: "muse-spark-1.3" }),
    /must differ/,
  );
  assert.doesNotThrow(() => assertJudgeServingDiffer({ MANO_MODEL_JUDGE_ID: "judge-1", MANO_MODEL_BENCH_ID: "serve-1" }));
  assert.doesNotThrow(() => assertJudgeServingDiffer({}));
});

const SWITCH = { MANO_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" };

test("the switch needs its key, as the agent's does", () => {
  assert.equal(openRouterKey({ MANO_MODEL_PROVIDER: "openrouter" }), null);
  assert.equal(openRouterKey({ OPENROUTER_API_KEY: "k" }), null);
  assert.equal(judgeClientFromEnv({ MANO_MODEL_PROVIDER: "openrouter", META_MODEL_API_KEY: "k" }).id, "muse-spark-1.3");
  assert.equal(judgeClientFromEnv({ MANO_MODEL_PROVIDER: "openrouter" }).live, false);
});

test("with the switch on, the judge is a different Meta model from the writer", () => {
  const judge = judgeClientFromEnv({ ...SWITCH, META_MODEL_API_KEY: "other" });
  assert.ok(judge instanceof OpenRouterModelClient);
  assert.equal(judge.id, OPEN_WEIGHT_JUDGE_ID);
  assert.notEqual(judge.id, OPEN_WEIGHT_MODEL_ID);
  assert.doesNotThrow(() => assertJudgeServingDiffer(SWITCH));
  assert.throws(() => assertJudgeServingDiffer({ ...SWITCH, MANO_MODEL_JUDGE_ID: OPEN_WEIGHT_MODEL_ID }), /must differ/);
});

test("only Meta models run through OpenRouter", () => {
  assert.throws(() => new OpenRouterModelClient("openai/gpt-5", "k"), /only Meta models/);
  assert.throws(() => judgeClientFromEnv({ ...SWITCH, MANO_MODEL_JUDGE_ID: "openai/gpt-5" }), /only Meta models/);
});

test("every OpenRouter request is pinned to zero retention and goes to OpenRouter", async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
  }) as unknown as typeof fetch;
  const client = new OpenRouterModelClient(OPEN_WEIGHT_MODEL_ID, "k", fetchFn);
  const out = await client.complete([{ role: "user", content: "synthetic" }], { maxTokens: 10 });
  assert.deepEqual(out, { text: "ok", inputTokens: 3, outputTokens: 2 });
  assert.equal(sent[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(sent[0]!.body.provider, { zdr: true, data_collection: "deny" });
  assert.equal(sent[0]!.body.model, OPEN_WEIGHT_MODEL_ID);
});

test("a refused OpenRouter call throws its status", async () => {
  const fetchFn = (async () => new Response("", { status: 402 })) as unknown as typeof fetch;
  await assert.rejects(new OpenRouterModelClient(OPEN_WEIGHT_MODEL_ID, "k", fetchFn).complete([]), /model call failed: 402/);
});
