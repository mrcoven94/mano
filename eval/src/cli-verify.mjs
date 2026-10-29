// Verify frozen commitments. Fails loudly on any mismatch.
// Run: pnpm --filter ./eval run verify
// With MANO_EVAL_HELDOUT_SEED and MANO_EVAL_TEMPLATE_PACK (via ws keys
// run) this also checks the held-out hashes and the private pack hash;
// without them the held-out check is loudly skipped.
import { readRecord, verifyCode, verifyDev, verifyPhotos, verifyHeldout, verifySeedCommitment } from "./verify.mjs";

const record = await readRecord();
let failed = false;
const show = (name, r) => {
  console.log(`${name}: ${r.ok ? "match" : "MISMATCH " + r.mismatches.join(", ")}`);
  if (!r.ok) failed = true;
};
show("code hashes", await verifyCode(record));
show("dev split", await verifyDev(record));
show("photos and tracks", await verifyPhotos(record));

const seed = process.env.MANO_EVAL_HELDOUT_SEED;
const packPath = process.env.MANO_EVAL_TEMPLATE_PACK;
if (seed && packPath) {
  const commitment = verifySeedCommitment(seed, record);
  console.log(`seed commitment: ${commitment ? "match" : "MISMATCH (wrong seed for this freeze)"}`);
  if (!commitment) failed = true;
  show("held-out set", await verifyHeldout(record, seed));
} else {
  console.log("held-out set: SKIPPED (needs MANO_EVAL_HELDOUT_SEED and MANO_EVAL_TEMPLATE_PACK; run with ws keys run for the full check)");
}

if (failed) {
  console.error("VERIFY FAILED: frozen commitments do not match. Do not run baselines or Mano on this tree.");
  process.exit(1);
}
console.log("verify: ok");
