// Node file append for the JSON lines sink. Import this module only
// from Node (CI, scripts, local runs); Workers import ./jsonl.js and
// ./analytics.js, which never touch the filesystem.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function nodeAppendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, "utf8");
}
