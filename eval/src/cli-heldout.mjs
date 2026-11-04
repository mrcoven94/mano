// Run Mano and every baseline on the 100 held-out households and print
// aggregates only: no letter text, household detail, pack or seed.
// Refuses to start unless the seed, the private pack, the code, the dev split
// and the photos all match the freeze record and that record is final.
// Held-out letters and answers stay in memory. Held-out photos go to a temp dir
// outside the repo, removed when the run ends. Answers never reach a system.
// Run: MANO_EVAL_HELDOUT_SEED and MANO_EVAL_TEMPLATE_PACK set, plus either
// MANO_MODEL_PROVIDER=openrouter with OPENROUTER_API_KEY, or META_MODEL_API_KEY:
// pnpm --filter ./eval run heldout
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateDevHouseholds, generateHeldoutHouseholds } from "./generator.mjs";
import { photoTrackInput, sliceAnswers, toAnswers, toBaselineInputs } from "./inputs.mjs";
import { modelRoute, preflight, routeLabel } from "./openrouter.mjs";
import { photoFilesByLetter, photoHouseholdIds, renderHouseholdPhotos } from "./render.mjs";
import { runTrack } from "./tracks.mjs";
import { readRecord, verifyCode, verifyDev, verifyHeldout, verifyPhotos, verifySeedCommitment } from "./verify.mjs";

function abort(message) {
  console.error(`ABORT: ${message}`);
  process.exit(1);
}

const seed = process.env.MANO_EVAL_HELDOUT_SEED;
if (!seed || !process.env.MANO_EVAL_TEMPLATE_PACK) abort("needs MANO_EVAL_HELDOUT_SEED and MANO_EVAL_TEMPLATE_PACK");
// With no model key, Mano and the general agent report "not run" and the
// deterministic baselines still score, at no cost.
const route = modelRoute();
const check = await preflight(route);
if (!check.ok) abort(`the model provider refused a test call (status ${check.status ?? "none"}); nothing was scored`);

const record = await readRecord();
if (record.interim) abort("the freeze record is interim; run the final freeze first");
if (!verifySeedCommitment(seed, record)) abort("the seed does not match the freeze record");
const checks = [
  ["code", await verifyCode(record)],
  ["dev", await verifyDev(record)],
  ["photos", await verifyPhotos(record)],
  ["held-out", await verifyHeldout(record, seed)],
];
const bad = checks.filter(([, r]) => !r.ok).map(([name]) => name);
if (bad.length > 0) abort(`frozen commitments do not match: ${bad.join(", ")}`);

const households = generateHeldoutHouseholds(seed);
const inputs = toBaselineInputs(households);
const answers = toAnswers(households);
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
if (dirty) abort("the working tree has changes; run from a clean commit");
const label = routeLabel(route);

console.log("# Mano held-out eval");
console.log(`model: ${label}`);
console.log(`code: ${head}, freeze ${record.frozen}, manifest ${record.manifest.slice(0, 16)}`);
if (route === "openrouter") console.log("not run: SAM 3.1 page segmentation (Meta Model API only); Mano used its on-device page detection");
console.log("not run: Guardian (the reading path takes no action for it to check)");
console.log("");

await runTrack("text track", inputs, answers, { label });

const dir = await realpath(await mkdtemp(join(tmpdir(), "mano-eval-heldout-")));
try {
  // The photo set follows the whole-cohort rule the freeze used.
  const photoIds = photoHouseholdIds([...generateDevHouseholds(), ...households]);
  const photographed = households.filter((h) => photoIds.has(h.householdId));
  await renderHouseholdPhotos(photographed, `${dir}/`, 2);
  const photoMap = await photoFilesByLetter(`${dir}/`);
  const photoInputs = inputs.map((h) => photoTrackInput(h, photoMap)).filter((h) => h.letters.length > 0);
  const keep = Object.fromEntries(photoInputs.map((h) => [h.householdId, h.letters.map((l) => l.letterId)]));
  await runTrack("photo track", photoInputs, sliceAnswers(answers, keep), { label });
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log("held-out: done");
