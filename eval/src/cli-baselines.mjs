// Run baselines on the development split and print the report.
// Verifies frozen commitments first and aborts on mismatch. Held-out
// households are never loaded here. Each system under test runs as a
// separate process that receives only its inputs. Two tracks: text (all
// dev letters as text) and photo (photographed letters as images).
// Live Meta calls happen only when META_MODEL_API_KEY is passed through;
// otherwise the general agent prints "not run" instead of numbers.
import { readFile } from "node:fs/promises";
import { verifyCode, verifyDev } from "./verify.mjs";
import { photoTrackInput, sliceAnswers } from "./inputs.mjs";
import { photoFilesByLetter } from "./render.mjs";
import { runSystem } from "./harness.mjs";
import { gradeAll, panelGrade, formatReport, formatPerScenario } from "./grader.mjs";

const code = await verifyCode();
const devCheck = await verifyDev();
if (!code.ok || !devCheck.ok) {
  console.error(`ABORT: frozen commitments do not match (code: ${code.mismatches.join(",") || "ok"}, dev: ${devCheck.mismatches.join(",") || "ok"}). Run verify for details.`);
  process.exit(1);
}

const inputs = JSON.parse(await readFile(new URL("../data/dev.json", import.meta.url), "utf8"));
const answers = JSON.parse(await readFile(new URL("../data/dev-answers.json", import.meta.url), "utf8"));
const hasKey = Boolean(process.env.META_MODEL_API_KEY);
const mode = hasKey
  ? "live Meta (muse-spark-1.3-contributor, synthetic data)"
  : "offline (no META_MODEL_API_KEY)";

const SYSTEMS = [
  { name: "plain reminder tool", entry: new URL("./systems/reminder.mjs", import.meta.url).pathname, envAllow: [] },
  { name: "date-regex extractor", entry: new URL("./systems/regex.mjs", import.meta.url).pathname, envAllow: [] },
  { name: "general agent (one generic prompt)", entry: new URL("./systems/general-agent.mjs", import.meta.url).pathname, envAllow: ["META_MODEL_API_KEY"] },
];

async function runTrack(trackName, trackInputs, trackAnswers, trackMode) {
  console.log(`# ${trackName} (${trackInputs.length} households)`);
  for (const sys of SYSTEMS) {
    const t0 = Date.now();
    const { outputs } = await runSystem(sys.entry, trackInputs, { envAllow: sys.envAllow });
    const elapsedMs = Date.now() - t0;
    const notRun = outputs.length > 0 && outputs.every((o) => o.status === "not run");
    if (notRun) {
      console.log(`## ${sys.name}`);
      console.log("status: not run (no META_MODEL_API_KEY)");
      console.log(`households: ${outputs.length}`);
      console.log(formatPerScenario(outputs));
    } else {
      const graded = gradeAll(outputs, trackAnswers);
      const costUsd = outputs.reduce((a, o) => a + (o.costUsd || 0), 0);
      const sysMode = sys.envAllow.length > 0 ? trackMode : "deterministic";
      console.log(formatReport(sys.name, graded, { costUsd, elapsedMs, mode: sysMode }));
      console.log(formatPerScenario(outputs));
    }
    console.log("");
  }
}

console.log("# Mano eval baselines: development split");
console.log(`mode: ${mode}`);
console.log("");

await runTrack("text track", inputs, answers, mode);

// Photo track: photographed letters only, same assets for every system.
const photoDir = new URL("../data/photos/", import.meta.url).pathname;
const photoMap = await photoFilesByLetter(photoDir);
const photoInputs = inputs
  .map((h) => photoTrackInput(h, photoMap))
  .filter((h) => h.letters.length > 0);
const keepByHousehold = Object.fromEntries(photoInputs.map((h) => [h.householdId, h.letters.map((l) => l.letterId)]));
const photoAnswers = sliceAnswers(answers, keepByHousehold);
await runTrack("photo track", photoInputs, photoAnswers, mode);

const panel = await panelGrade([], answers);
console.log(`panel of non-Meta models: ${panel.status} (${panel.reason})`);
console.log("held-out: frozen, not run. See FROZEN.md.");
