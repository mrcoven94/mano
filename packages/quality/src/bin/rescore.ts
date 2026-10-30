// rescore: re-grade a stored run after a check changes. No model calls.
// Usage: node src/bin/rescore.ts <inDir> <outDir>

import { rescoreRun } from "../rescore.ts";

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) {
  console.error("usage: node src/bin/rescore.ts <inDir> <outDir>");
  process.exit(2);
}
const report = await rescoreRun(inDir, outDir);
for (const s of Object.values(report.suites)) {
  console.log(`${s.suite}: hard ${(s.hardCheckPassRate * 100).toFixed(1)}% judge ${s.judgeMean.toFixed(2)} gate ${s.gateFailed ? "FAIL" : "pass"}`);
}
console.log(`wrote ${outDir} (no model calls)`);
