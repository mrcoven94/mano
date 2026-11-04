// Run Mano and the baselines on the development split and print the report.
// Verifies frozen commitments first and aborts on mismatch. Held-out
// households are never loaded here. Each system under test runs as a
// separate process that receives only its inputs. Two tracks: text (all
// dev letters as text) and photo (photographed letters as images). The
// child is offline; model calls from Mano and the general agent travel
// through the parent broker, which holds the key. Without a key they print
// "not run" instead of numbers.
import { readFile } from "node:fs/promises";
import { readRecord, verifyCode, verifyDev, verifyPhotos } from "./verify.mjs";
import { photoTrackInput, sliceAnswers } from "./inputs.mjs";
import { photoFilesByLetter } from "./render.mjs";
import { modelRoute, routeLabel } from "./openrouter.mjs";
import { runTrack } from "./tracks.mjs";
import { panelGrade } from "./grader.mjs";

const record = await readRecord();
const checks = [
  ["code", await verifyCode(record)],
  ["dev", await verifyDev(record)],
  ["photos", await verifyPhotos(record)],
];
const bad = checks.filter(([, r]) => !r.ok);
if (bad.length > 0) {
  console.error(`ABORT: frozen commitments do not match (${bad.map(([n, r]) => `${n}: ${r.mismatches.join(",")}`).join("; ")}). Run verify for details.`);
  process.exit(1);
}

const inputs = JSON.parse(await readFile(new URL("../data/dev.json", import.meta.url), "utf8"));
const answers = JSON.parse(await readFile(new URL("../data/dev-answers.json", import.meta.url), "utf8"));
const label = routeLabel(modelRoute());

console.log("# Mano eval: development split");
console.log(`mode: ${label}`);
console.log("");

await runTrack("text track", inputs, answers, { label, perScenario: true });

// Photo track: photographed letters only, same assets for every system.
const photoDir = new URL("../data/photos/", import.meta.url).pathname;
const photoMap = await photoFilesByLetter(photoDir);
const photoInputs = inputs
  .map((h) => photoTrackInput(h, photoMap))
  .filter((h) => h.letters.length > 0);
const keepByHousehold = Object.fromEntries(photoInputs.map((h) => [h.householdId, h.letters.map((l) => l.letterId)]));
const photoAnswers = sliceAnswers(answers, keepByHousehold);
await runTrack("photo track", photoInputs, photoAnswers, { label, perScenario: true });

const panel = await panelGrade([], answers);
console.log(`panel of non-Meta models: ${panel.status} (${panel.reason})`);
console.log("held-out: not run here. See cli-heldout.mjs and eval/data/heldout-hashes.json.");
