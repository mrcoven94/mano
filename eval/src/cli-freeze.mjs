// Write FROZEN.md: SHA-256 of each held-out household plus the manifest.
// Frozen 2026-10-26 (run date). Nobody tunes against held-out cases.
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { generateHouseholds, splitHouseholds, SEED } from "./generator.mjs";

const { heldout } = splitHouseholds(generateHouseholds());
const lines = heldout.map((h) => {
  const sha = createHash("sha256").update(JSON.stringify(h)).digest("hex");
  return `| ${h.householdId} | ${sha} |`;
});
const manifestSha = createHash("sha256").update(lines.join("\n")).digest("hex");
const today = new Date().toISOString().slice(0, 10);
const md = `# Frozen held-out set\n\nFrozen: ${today}\nSeed: \`${SEED}\`\nHouseholds: ${heldout.length} held out, 20 development. Nobody looks at held-out cases while tuning.\nManifest SHA-256: \`${manifestSha}\`\n\n| household | sha256 |\n|---|---|\n${lines.join("\n")}\n`;
await writeFile(new URL("../FROZEN.md", import.meta.url), md);
console.log(`FROZEN.md written: ${heldout.length} held-out households, manifest ${manifestSha.slice(0, 16)}...`);
