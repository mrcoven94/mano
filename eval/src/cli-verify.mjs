// Verify frozen commitments. Fails loudly on any mismatch.
// Run: pnpm --filter ./eval run verify
// With MANO_EVAL_HELDOUT_SEED (via ws keys run) this also checks the
// held-out hashes; without it the held-out check is loudly skipped.
import { readFile } from "node:fs/promises";
import { parseFrozen, verifyCode, verifyDev, verifyHeldout, verifySeedCommitment } from "./verify.mjs";

let failed = false;
const code = await verifyCode();
console.log(`code hashes: ${code.ok ? "match" : "MISMATCH " + code.mismatches.join(", ")}`);
if (!code.ok) failed = true;

const dev = await verifyDev();
console.log(`dev split: ${dev.ok ? "match" : "MISMATCH " + dev.mismatches.join(", ")}`);
if (!dev.ok) failed = true;

const seed = process.env.MANO_EVAL_HELDOUT_SEED;
if (seed) {
  const frozen = parseFrozen(await readFile(new URL("../FROZEN.md", import.meta.url), "utf8"));
  const commitment = verifySeedCommitment(seed, frozen);
  console.log(`seed commitment: ${commitment ? "match" : "MISMATCH (wrong seed for this freeze)"}`);
  if (!commitment) failed = true;
  const heldout = await verifyHeldout(seed);
  console.log(`held-out set: ${heldout.ok ? "match (100 households)" : "MISMATCH " + heldout.mismatches.join(", ")}`);
  if (!heldout.ok) failed = true;
} else {
  console.log("held-out set: SKIPPED (no MANO_EVAL_HELDOUT_SEED; run with ws keys run for the full check)");
}

if (failed) {
  console.error("VERIFY FAILED: frozen commitments do not match. Do not run baselines or Mano on this tree.");
  process.exit(1);
}
console.log("verify: ok");
