// Run both baselines on the development split only and print the report.
// Held-out households are never loaded here. Live Meta calls happen only
// when META_MODEL_API_KEY is set; otherwise deterministic offline mode.
import { readFile } from "node:fs/promises";
import { generateHouseholds, splitHouseholds } from "./generator.mjs";
import { reminderBaseline, generalAgentBaseline } from "./baselines.mjs";
import { gradeAll, panelGrade, formatReport } from "./grader.mjs";

let dev;
try {
  dev = JSON.parse(await readFile(new URL("../data/dev.json", import.meta.url), "utf8"));
} catch {
  dev = splitHouseholds(generateHouseholds()).dev;
}
const mode = process.env.META_MODEL_API_KEY ? "live Meta (contributor IDs, synthetic data)" : "offline deterministic (no META_MODEL_API_KEY)";

async function run(name, fn) {
  const t0 = Date.now();
  const outputs = dev.map((h) => fn(h));
  const elapsedMs = Date.now() - t0;
  const graded = gradeAll(outputs, dev);
  console.log(formatReport(name, graded, { costUsd: 0, elapsedMs, mode }));
  console.log("");
  return graded;
}
console.log("# Mano eval baselines: development split (20 households)");
console.log(`mode: ${mode}`);
console.log("");
await run("plain reminder tool", reminderBaseline);
await run("general agent (one generic prompt)", generalAgentBaseline);
const panel = await panelGrade([], dev);
console.log(`panel of non-Meta models: ${panel.status} (${panel.reason})`);
console.log("held-out: frozen, not run. See FROZEN.md.");
