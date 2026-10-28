// Write the freeze record to eval/data/heldout-hashes.json: freeze date,
// seed commitment, manifest, dev file hashes, every code file hash on the
// path from generator to grader, every committed photo hash, photo-track
// membership, and the held-out household hashes.
// The held-out seed comes only from MANO_EVAL_HELDOUT_SEED and is never
// printed or committed. Run generate first so dev files and photos exist.
import { writeFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { generateHeldoutHouseholds } from "./generator.mjs";
import { currentFileHashes, currentPhotoHashes, photoTrackLetters } from "./verify.mjs";

const seed = process.env.MANO_EVAL_HELDOUT_SEED;
if (!seed) {
  console.error("MANO_EVAL_HELDOUT_SEED is not set. Run with ws keys run.");
  process.exit(1);
}
const packPath = process.env.MANO_EVAL_TEMPLATE_PACK;
if (!packPath) {
  console.error("MANO_EVAL_TEMPLATE_PACK is not set. The architect holds the private pack.");
  process.exit(1);
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const heldout = generateHeldoutHouseholds(seed);
const lines = heldout.map((h) => `| ${h.householdId} | ${sha256(JSON.stringify(h))} |`);
const photos = await currentPhotoHashes();
// A pack inside the repo can only be the fake test fixture, never the
// architect's private pack: mark the freeze interim so nobody mistakes
// it for final. The final freeze refreezes with the vault pack.
const repoRoot = new URL("../../..", import.meta.url).pathname;
const packInsideRepo = !relative(await realpath(repoRoot), await realpath(resolve(packPath))).startsWith("..");
const record = {
  note: "Freeze record for the Mano held-out eval. Hashes only; the seed is secret and scenarios generate at run time. Verify with: pnpm --filter ./eval run verify",
  frozen: new Date().toISOString().slice(0, 10),
  ...(packInsideRepo ? { interim: "frozen against the in-repo fake test pack; refreeze with the architect's private pack before merge" } : {}),
  seedCommitment: sha256(seed),
  privatePack: sha256(await readFile(packPath, "utf8")),
  households: { heldout: heldout.length, dev: 20 },
  manifest: sha256(lines.join("\n")),
  dev: {
    inputs: sha256(await readFile(new URL("../data/dev.json", import.meta.url), "utf8")),
    answers: sha256(await readFile(new URL("../data/dev-answers.json", import.meta.url), "utf8")),
  },
  code: await currentFileHashes(),
  photos,
  tracks: { photo: photoTrackLetters(photos) },
  heldout: heldout.map((h) => ({ householdId: h.householdId, sha256: sha256(JSON.stringify(h)) })),
};
await writeFile(new URL("../data/heldout-hashes.json", import.meta.url), JSON.stringify(record, null, 2) + "\n");
console.log(`freeze record written: ${heldout.length} held-out households, manifest ${record.manifest.slice(0, 16)}...`);
