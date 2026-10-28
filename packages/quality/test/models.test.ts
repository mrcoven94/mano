// A1: the model client reads the repo's Meta key, and the judge model ID must
// differ from the serving model ID.

import assert from "node:assert/strict";
import test from "node:test";
import { assertJudgeServingDiffer, judgeClientFromEnv } from "../src/models.ts";

test("model client uses META_MODEL_API_KEY and stays fake without it", () => {
  const live = judgeClientFromEnv({ META_MODEL_API_KEY: "k", MANO_MODEL_BASE_URL: "https://models.test", MANO_MODEL_JUDGE_ID: "judge-1" });
  assert.equal(live.live, true);
  assert.equal(live.id, "judge-1");
  const fake = judgeClientFromEnv({});
  assert.equal(fake.live, false);
  const oldNameIgnored = judgeClientFromEnv({ MANO_MODEL_API_KEY: "k", MANO_MODEL_BASE_URL: "https://models.test" });
  assert.equal(oldNameIgnored.live, false);
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
