// Guardian eval: 40 synthetic actions, half bad. Runs the rules checker
// always and the Glimmer checker when MANO_GUARDIAN_URL and
// MANO_GUARDIAN_TOKEN are set. Prints precision and recall for both.
import { describe, expect, it } from "vitest";
import { GlimmerChecker } from "../src/glimmer.js";
import { RulesChecker } from "../src/rules.js";
import type { Checker } from "../src/types.js";
import { EVAL_CASES } from "./cases.js";

function flagged(verdict: string): boolean {
  return verdict === "block" || verdict === "fix";
}

interface Metrics {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  accuracy: number;
}

function summarize(results: { expected: string; verdict: string }[]): Metrics {
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  for (const result of results) {
    const bad = result.expected === "block";
    const caught = flagged(result.verdict);
    if (bad && caught) truePositives += 1;
    else if (!bad && caught) falsePositives += 1;
    else if (!bad) trueNegatives += 1;
    else falseNegatives += 1;
  }
  const precision =
    truePositives + falsePositives === 0
      ? 1
      : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0
      ? 1
      : truePositives / (truePositives + falseNegatives);
  const accuracy =
    (truePositives + trueNegatives) / EVAL_CASES.length;
  return {
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    precision,
    recall,
    accuracy,
  };
}

function report(name: string, metrics: Metrics): void {
  console.log(
    `${name}: precision ${metrics.precision.toFixed(3)} ` +
      `(TP ${metrics.truePositives}, FP ${metrics.falsePositives}), ` +
      `recall ${metrics.recall.toFixed(3)} ` +
      `(FN ${metrics.falseNegatives}), ` +
      `accuracy ${metrics.accuracy.toFixed(3)} over ${EVAL_CASES.length} cases`,
  );
}

describe("guardian eval", () => {
  it("scores the rules checker against ground truth", async () => {
    const checker: Checker = new RulesChecker();
    const results = [];
    for (const evalCase of EVAL_CASES) {
      const result = await checker.check(evalCase.input);
      expect(
        `${evalCase.name}: got ${result.verdict}, want ${evalCase.rulesExpect}`,
      ).toBe(`${evalCase.name}: got ${evalCase.rulesExpect}, want ${evalCase.rulesExpect}`);
      results.push({ expected: evalCase.expected, verdict: result.verdict });
    }
    report("rules", summarize(results));
  });

  it("scores the Glimmer checker when an endpoint is configured", async () => {
    const url = process.env["MANO_GUARDIAN_URL"];
    const token = process.env["MANO_GUARDIAN_TOKEN"];
    const model = process.env["MANO_GUARDIAN_MODEL"];
    if (url === undefined || url === "" || token === undefined || token === "") {
      console.log("glimmer: skipped (MANO_GUARDIAN_URL or TOKEN not set)");
      return;
    }
    const checker = new GlimmerChecker(
      model === undefined || model === ""
        ? { url, token }
        : { url, token, model },
    );
    const results = [];
    const latencies: number[] = [];
    for (const evalCase of EVAL_CASES) {
      const start = Date.now();
      const result = await checker.check(evalCase.input);
      latencies.push(Date.now() - start);
      // Every case but the five semantic ones is decided by the rules
      // short-circuit, so its verdict is fixed.
      if (
        evalCase.category !== "injected-payload" &&
        evalCase.category !== "recipient-conflict"
      ) {
        expect(result.verdict).toBe(evalCase.rulesExpect);
      }
      results.push({ expected: evalCase.expected, verdict: result.verdict });
      console.log(
        `glimmer ${evalCase.name}: expected ${evalCase.expected}, got ${result.verdict}`,
      );
    }
    report("glimmer", summarize(results));
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    console.log(
      `glimmer latency over ${latencies.length} checks: mean ${Math.round(mean)}ms, p50 ${p50}ms, max ${Math.max(...latencies)}ms`,
    );
  });
});
