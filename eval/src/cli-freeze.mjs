// Write FROZEN.md: SHA-256 of each held-out household plus the manifest.
// The held-out seed comes only from MANO_EVAL_HELDOUT_SEED and is never
// printed or committed. FROZEN.md carries only the seed commitment
// (SHA-256 of the seed) and the per-household hashes. Regenerate and
// re-freeze only with the secret seed present.
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { generateHeldoutHouseholds } from "./generator.mjs";

const seed = process.env.MANO_EVAL_HELDOUT_SEED;
if (!seed) {
  console.error("MANO_EVAL_HELDOUT_SEED is not set. Run with ws keys run.");
  process.exit(1);
}
const heldout = generateHeldoutHouseholds(seed);
const lines = heldout.map((h) => {
  const sha = createHash("sha256").update(JSON.stringify(h)).digest("hex");
  return `| ${h.householdId} | ${sha} |`;
});
const manifestSha = createHash("sha256").update(lines.join("\n")).digest("hex");
const seedCommitment = createHash("sha256").update(seed).digest("hex");
const today = new Date().toISOString().slice(0, 10);
const md = `# Frozen held-out set\n\nFrozen: ${today}\nSeed commitment (SHA-256 of MANO_EVAL_HELDOUT_SEED): \`${seedCommitment}\`\nHouseholds: ${heldout.length} held out, 20 development. Nobody looks at held-out cases while tuning.\nManifest SHA-256: \`${manifestSha}\`\n\nThe held-out seed is secret. Scenarios are generated at run time from MANO_EVAL_HELDOUT_SEED and never committed. Only hashes are committed here.\n\n| household | sha256 |\n|---|---|\n${lines.join("\n")}\n`;
await writeFile(new URL("../FROZEN.md", import.meta.url), md);
console.log(`FROZEN.md written: ${heldout.length} held-out households, manifest ${manifestSha.slice(0, 16)}...`);
