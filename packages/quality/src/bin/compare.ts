// compare: print two stored runs side by side. Nothing switches automatically;
// a person merges the change. Usage: node src/bin/compare.ts <beforeDir> <afterDir> [beforeLabel] [afterLabel]

import { printSideBySide, readRun } from "../report.ts";

const [beforeDir, afterDir, beforeLabel = "before", afterLabel = "after"] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error("usage: node src/bin/compare.ts <beforeDir> <afterDir> [beforeLabel] [afterLabel]");
  process.exit(2);
}
const before = readRun(beforeDir).report;
const after = readRun(afterDir).report;
console.log(printSideBySide(before, after, beforeLabel, afterLabel));
