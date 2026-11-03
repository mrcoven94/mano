// judge: runs Maria's renewal end to end on this machine (spine.ts) and
// labels every step real or simulated, with the Meta model behind it.
// Usage: pnpm judge [--out <dir>] [--photo <jpeg>], with META_MODEL_API_KEY
// set to run SAM 3.1 and Muse Spark 1.3 live; without it every model step
// uses its recording. --photo sends another letter photo, which only a live
// run can read: the recordings answer only spine-letter.jpg.
// Writes the letter photo, the portal's view of the filing and Maria's
// replay page to --out (a new temporary folder by default). Exits 1 when a
// step fails or a live model call failed and fell back to its recording.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runSpine } from "../spine.ts";

const i = process.argv.indexOf("--out");
const outDir = i === -1 ? mkdtempSync(join(tmpdir(), "mano-judge-")) : resolve(process.argv[i + 1]!);
mkdirSync(outDir, { recursive: true });
const p = process.argv.indexOf("--photo");
const photoPath = p === -1 ? undefined : resolve(process.argv[p + 1]!);

const print = (line: string) => console.log(line);
const keyed = Boolean(process.env.META_MODEL_API_KEY);
print("Mano judge run: Maria's food benefits renewal, end to end, on synthetic data.");
print(
  keyed
    ? "META_MODEL_API_KEY is set: SAM 3.1 and Muse Spark 1.3 run live on Meta's API. A failed call says why and its step uses the recorded response."
    : "No META_MODEL_API_KEY is set: every Meta model step uses its recorded response and is labeled simulated.",
);
print("real: ran in this run, as a live Meta model call or Mano's own code. simulated: a recorded model response, a local stand-in for a service that needs Mano's accounts, or a part of Mano this run leaves out; each says which.");
print("");

const run = await runSpine({ env: process.env, outDir, print, ...(photoPath ? { photoPath } : {}) });

const finished = run.steps.filter((s) => !s.failure).length;
const allParts = run.steps.flatMap((s) => s.parts);
const realModels = allParts.filter((p) => p.ran === "real" && p.model).length;
print("");
print(`Finished ${finished} of ${run.total} steps in ${(run.ms / 1000).toFixed(1)} s. Meta model parts run live: ${realModels}. Files are in ${outDir}`);
if (run.liveFailures.length > 0) {
  print(`Live Meta model calls that failed and used their recordings instead: ${run.liveFailures.join("; ")}`);
}
const failed = finished < run.total || run.liveFailures.length > 0;
print(failed ? "Result: FAILED" : "Result: passed");
process.exitCode = failed ? 1 : 0;
