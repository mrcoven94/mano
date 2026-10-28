// Run both baselines on the development split only and print the report.
// Held-out households are never loaded here. Baselines receive only the
// baseline inputs (letter text, profile); the grader alone loads answers.
// Live Meta calls happen only when META_MODEL_API_KEY is set; otherwise the
// general agent prints "not run" instead of numbers.
import { readFile } from "node:fs/promises";
import { generateDevHouseholds } from "./generator.mjs";
import { toBaselineInputs, toAnswers } from "./inputs.mjs";
import { reminderBaseline, generalAgentBaseline } from "./baselines.mjs";
import { gradeAll, panelGrade, formatReport, formatPerScenario } from "./grader.mjs";

let inputs;
let answers;
try {
  inputs = JSON.parse(await readFile(new URL("../data/dev.json", import.meta.url), "utf8"));
  answers = JSON.parse(await readFile(new URL("../data/dev-answers.json", import.meta.url), "utf8"));
} catch {
  const dev = generateDevHouseholds();
  inputs = toBaselineInputs(dev);
  answers = toAnswers(dev);
}
const hasKey = Boolean(process.env.META_MODEL_API_KEY);
const mode = hasKey
  ? "live Meta (muse-spark-1.3-contributor, synthetic data)"
  : "offline (no META_MODEL_API_KEY)";

console.log("# Mano eval baselines: development split (20 households)");
console.log(`mode: ${mode}`);
console.log("");

// Baseline A: plain reminder tool, always runs.
{
  const t0 = Date.now();
  const outputs = inputs.map((h) => reminderBaseline(h));
  const elapsedMs = Date.now() - t0;
  for (const o of outputs) o.elapsedMs = elapsedMs / outputs.length;
  const graded = gradeAll(outputs, answers);
  console.log(formatReport("plain reminder tool", graded, { costUsd: 0, elapsedMs, mode: "deterministic" }));
  console.log(formatPerScenario(outputs));
  console.log("");
}

// Baseline B: general agent, real model run or honest not-run.
{
  const t0 = Date.now();
  const outputs = [];
  for (const h of inputs) {
    outputs.push(await generalAgentBaseline(h));
  }
  const elapsedMs = Date.now() - t0;
  const notRun = outputs.length > 0 && outputs.every((o) => o.status === "not run");
  if (notRun) {
    console.log("## general agent (one generic prompt)");
    console.log("status: not run (no META_MODEL_API_KEY)");
    console.log(`households: ${outputs.length}`);
    console.log(formatPerScenario(outputs));
  } else {
    const graded = gradeAll(outputs, answers);
    const costUsd = outputs.reduce((a, o) => a + (o.costUsd || 0), 0);
    console.log(formatReport("general agent (one generic prompt)", graded, { costUsd, elapsedMs, mode }));
    console.log(formatPerScenario(outputs));
  }
  console.log("");
}

const panel = await panelGrade([], answers);
console.log(`panel of non-Meta models: ${panel.status} (${panel.reason})`);
console.log("held-out: frozen, not run. See FROZEN.md.");
