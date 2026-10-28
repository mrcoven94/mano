// Generate dev split (committed) and held-out hashes (frozen).
// Dev inputs go to data/dev.json; answer keys go to data/dev-answers.json
// which only the grader loads. Held-out plaintext stays out of git:
// regenerate it from MANO_EVAL_HELDOUT_SEED and verify against FROZEN.md.
// Photos are real JPG pixels; SVG is only the text source.
// Run: pnpm --filter ./eval run generate
import { mkdir, writeFile, rm } from "node:fs/promises";
import { generateDevHouseholds, generateHeldoutHouseholds } from "./generator.mjs";
import { toBaselineInputs, toAnswers } from "./inputs.mjs";
import { renderPhoto, photoHouseholdIds, contentHash } from "./render.mjs";

const devFull = generateDevHouseholds();
let heldoutFull = [];
const hasHeldoutSeed = Boolean(process.env.MANO_EVAL_HELDOUT_SEED);
if (hasHeldoutSeed) {
  heldoutFull = generateHeldoutHouseholds();
} else {
  console.log("MANO_EVAL_HELDOUT_SEED not set; generating dev split only.");
}

await mkdir(new URL("../data/photos", import.meta.url), { recursive: true });
await mkdir(new URL("../data/photos-heldout", import.meta.url), { recursive: true });
// Remove legacy SVG photos; committed photos are JPG pixels now.
await rm(new URL("../data/photos", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("../data/photos", import.meta.url), { recursive: true });

const all = [...devFull, ...heldoutFull];
const photoIds = photoHouseholdIds(all);
let photoCount = 0;
for (const h of all) {
  if (!photoIds.has(h.householdId)) continue;
  for (const letter of h.letters.slice(0, 1)) {
    const photo = await renderPhoto(letter, h.householdId);
    const dir = h.split === "dev" ? "photos" : "photos-heldout";
    for (const f of photo.files) {
      await writeFile(new URL(`../data/${dir}/${f.filename}`, import.meta.url), f.buffer);
      photoCount++;
    }
  }
}

await writeFile(new URL("../data/dev.json", import.meta.url), JSON.stringify(toBaselineInputs(devFull), null, 2) + "\n");
await writeFile(new URL("../data/dev-answers.json", import.meta.url), JSON.stringify(toAnswers(devFull), null, 2) + "\n");
if (heldoutFull.length > 0) {
  const hashes = heldoutFull.map((h) => ({ householdId: h.householdId, sha256: contentHash(h) }));
  await writeFile(new URL("../data/heldout-hashes.json", import.meta.url), JSON.stringify(hashes, null, 2) + "\n");
}
console.log(`dev households: ${devFull.length}, held-out households: ${heldoutFull.length}, photos rendered: ${photoCount}`);
console.log("held-out plaintext not written; hashes in data/heldout-hashes.json and FROZEN.md (run freeze)");
