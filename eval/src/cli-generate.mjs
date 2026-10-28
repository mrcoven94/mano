// Generate the dev split (committed) and held-out hashes (frozen).
// Dev inputs go to data/dev.json; answer keys go to data/dev-answers.json
// which only the grader loads. Dev photos (first two letters of each photo
// household, so hard cases are photographed) go to data/photos.
// Held-out plaintext and photos are NEVER written inside the repo: hashes
// go to data/heldout-hashes.json, and held-out photos materialize only at
// run time into a temp dir outside the repo (see renderHouseholdPhotos),
// which the runner deletes afterwards.
// Run: pnpm --filter ./eval run generate
import { mkdir, writeFile, rm } from "node:fs/promises";
import { generateDevHouseholds, generateHeldoutHouseholds } from "./generator.mjs";
import { toBaselineInputs, toAnswers } from "./inputs.mjs";
import { photoHouseholdIds, renderHouseholdPhotos, contentHash } from "./render.mjs";

const devFull = generateDevHouseholds();
let heldoutFull = [];
const hasHeldoutSeed = Boolean(process.env.MANO_EVAL_HELDOUT_SEED);
const hasPack = Boolean(process.env.MANO_EVAL_TEMPLATE_PACK);
if (hasHeldoutSeed && hasPack) {
  heldoutFull = generateHeldoutHouseholds();
} else if (hasHeldoutSeed) {
  console.log("MANO_EVAL_TEMPLATE_PACK not set; generating dev split only. The architect holds the private pack.");
} else {
  console.log("MANO_EVAL_HELDOUT_SEED not set; generating dev split only.");
}

// Dev photos live in the repo; the legacy held-out photo dir must not exist.
await rm(new URL("../data/photos-heldout", import.meta.url), { recursive: true, force: true });
await rm(new URL("../data/photos", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("../data/photos", import.meta.url), { recursive: true });

const photoIds = photoHouseholdIds([...devFull, ...heldoutFull]);
const photoDev = devFull.filter((h) => photoIds.has(h.householdId));
const photoCount = await renderHouseholdPhotos(photoDev, new URL("../data/photos/", import.meta.url), 2);

await writeFile(new URL("../data/dev.json", import.meta.url), JSON.stringify(toBaselineInputs(devFull), null, 2) + "\n");
await writeFile(new URL("../data/dev-answers.json", import.meta.url), JSON.stringify(toAnswers(devFull), null, 2) + "\n");
if (heldoutFull.length > 0) {
  const hashes = heldoutFull.map((h) => ({ householdId: h.householdId, sha256: contentHash(h) }));
  await writeFile(new URL("../data/heldout-hashes.json", import.meta.url), JSON.stringify(hashes, null, 2) + "\n");
}
console.log(`dev households: ${devFull.length}, held-out households: ${heldoutFull.length}, dev photos rendered: ${photoCount}`);
console.log("held-out plaintext and photos never touch the repo; run freeze to write the freeze record");
