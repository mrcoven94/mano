// System entry: plain reminder tool. Reads baseline inputs, writes outputs.
// Usage: node reminder.mjs --input <json> --out <json>
import { readFile, writeFile } from "node:fs/promises";
import { reminderBaseline } from "../baselines.mjs";

const args = process.argv.slice(2);
const inputPath = args[args.indexOf("--input") + 1];
const outPath = args[args.indexOf("--out") + 1];
const inputs = JSON.parse(await readFile(inputPath, "utf8"));
const t0 = Date.now();
const outputs = inputs.map((h) => reminderBaseline(h));
const per = (Date.now() - t0) / Math.max(1, outputs.length);
for (const o of outputs) o.elapsedMs = per;
await writeFile(outPath, JSON.stringify(outputs));
