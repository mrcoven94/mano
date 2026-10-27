// Verify frozen commitments before any baseline or Mano run.
// Checks three things: the code files hash to the values in FROZEN.md,
// regenerated dev inputs and answers match the committed files, and (when
// MANO_EVAL_HELDOUT_SEED is present) regenerated held-out households match
// the frozen hashes. Any mismatch fails loudly: a changed generator must
// never silently change the test.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { generateDevHouseholds, generateHeldoutHouseholds } from "./generator.mjs";
import { toBaselineInputs, toAnswers } from "./inputs.mjs";

export const CODE_FILES = ["src/generator.mjs", "src/rng.mjs", "src/render.mjs", "src/grader.mjs"];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export async function currentFileHashes() {
  const out = {};
  for (const f of CODE_FILES) {
    out[f] = sha256(await readFile(new URL(`./${f.split("/")[1]}`, import.meta.url), "utf8"));
  }
  return out;
}

export function parseFrozen(md) {
  const manifest = md.match(/Manifest SHA-256: `([0-9a-f]+)`/)?.[1] || null;
  const seedCommitment = md.match(/Seed commitment \(SHA-256 of MANO_EVAL_HELDOUT_SEED\): `([0-9a-f]+)`/)?.[1] || null;
  const code = {};
  const codeSection = md.split("## Code hashes")[1]?.split("## ")[0] || "";
  for (const m of codeSection.matchAll(/\| (src\/[a-z]+\.mjs) \| ([0-9a-f]+) \|/g)) {
    code[m[1]] = m[2];
  }
  const households = {};
  const tableSection = md.split("| household | sha256 |")[1] || "";
  for (const m of tableSection.matchAll(/\| (hh-\d+) \| ([0-9a-f]+) \|/g)) {
    households[m[1]] = m[2];
  }
  return { manifest, seedCommitment, code, households };
}

export async function verifyCode() {
  const frozen = parseFrozen(await readFile(new URL("../FROZEN.md", import.meta.url), "utf8"));
  const current = await currentFileHashes();
  const mismatches = CODE_FILES.filter((f) => frozen.code[f] !== current[f]);
  return { ok: mismatches.length === 0, mismatches, current };
}

export async function verifyDev() {
  const dev = generateDevHouseholds();
  const wantInputs = JSON.stringify(toBaselineInputs(dev), null, 2) + "\n";
  const wantAnswers = JSON.stringify(toAnswers(dev), null, 2) + "\n";
  const haveInputs = await readFile(new URL("../data/dev.json", import.meta.url), "utf8");
  const haveAnswers = await readFile(new URL("../data/dev-answers.json", import.meta.url), "utf8");
  const mismatches = [];
  if (sha256(wantInputs) !== sha256(haveInputs)) mismatches.push("data/dev.json");
  if (sha256(wantAnswers) !== sha256(haveAnswers)) mismatches.push("data/dev-answers.json");
  // Photos must exist for the first two letters of every photo household.
  return { ok: mismatches.length === 0, mismatches };
}

export async function verifyHeldout(seed) {
  const frozen = parseFrozen(await readFile(new URL("../FROZEN.md", import.meta.url), "utf8"));
  const heldout = generateHeldoutHouseholds(seed);
  const lines = heldout.map((h) => `| ${h.householdId} | ${sha256(JSON.stringify(h))} |`);
  const manifest = sha256(lines.join("\n"));
  const mismatches = [];
  if (manifest !== frozen.manifest) mismatches.push("manifest");
  const ids = Object.keys(frozen.households);
  if (ids.length !== heldout.length) mismatches.push(`count ${heldout.length} vs frozen ${ids.length}`);
  for (const h of heldout) {
    if (frozen.households[h.householdId] !== sha256(JSON.stringify(h))) {
      mismatches.push(h.householdId);
      if (mismatches.length > 5) break;
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

export function verifySeedCommitment(seed, frozen) {
  return sha256(seed) === frozen.seedCommitment;
}
