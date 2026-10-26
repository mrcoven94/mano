// Generate dev split (committed) and held-out hashes (frozen).
// Held-out plaintext stays out of git: regenerate it from the seed and
// verify against FROZEN.md hashes. Run: pnpm --filter ./eval run generate
import { mkdir, writeFile } from "node:fs/promises";
import { generateHouseholds, splitHouseholds } from "./generator.mjs";
import { renderText, renderPhoto, photoHouseholdIds } from "./render.mjs";
import { contentHash } from "./render.mjs";

const { dev, heldout } = splitHouseholds(generateHouseholds());
await mkdir(new URL("../data/photos", import.meta.url), { recursive: true });
await mkdir(new URL("../data/photos-heldout", import.meta.url), { recursive: true });
const photoIds = photoHouseholdIds([...dev, ...heldout]);
let photoCount = 0;
for (const h of [...dev, ...heldout]) {
  if (h.split === "dev") for (const letter of h.letters) letter.textRender = renderText(letter);
  if (photoIds.has(h.householdId)) {
    for (const letter of h.letters.slice(0, 1)) {
      const photo = await renderPhoto(letter, h.householdId);
      if (photo.svg) {
        const dir = h.split === "dev" ? "photos" : "photos-heldout";
        await writeFile(new URL(`../data/${dir}/${letter.letterId}.svg`, import.meta.url), photo.svg);
        photoCount++;
      }
    }
  }
}
await writeFile(new URL("../data/dev.json", import.meta.url), JSON.stringify(dev, null, 2) + "\n");
const hashes = heldout.map((h) => ({ householdId: h.householdId, sha256: contentHash(h) }));
await writeFile(new URL("../data/heldout-hashes.json", import.meta.url), JSON.stringify(hashes, null, 2) + "\n");
console.log(`dev households: ${dev.length}, held-out households: ${heldout.length}, photos rendered: ${photoCount}`);
console.log("held-out plaintext not written; hashes in data/heldout-hashes.json and FROZEN.md (run freeze)");
