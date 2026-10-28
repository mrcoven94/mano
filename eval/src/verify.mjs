// Verify frozen commitments before any baseline or Mano run.
// The freeze record lives in eval/data/heldout-hashes.json: freeze date,
// seed commitment, manifest, dev file hashes, every code file hash on the
// path from generator to grader, every committed photo hash, photo-track
// membership, and the held-out household hashes. Any mismatch fails loudly.
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { generateDevHouseholds, generateHeldoutHouseholds } from "./generator.mjs";
import { toBaselineInputs, toAnswers } from "./inputs.mjs";

// Every file whose bytes can change a score, repo-root-relative.
export const CODE_FILES = [
  "eval/package.json",
  "eval/src/generator.mjs",
  "eval/src/rng.mjs",
  "eval/src/inputs.mjs",
  "eval/src/render.mjs",
  "eval/src/tools.mjs",
  "eval/src/baselines.mjs",
  "eval/src/harness.mjs",
  "eval/src/grader.mjs",
  "eval/src/verify.mjs",
  "eval/src/cli-generate.mjs",
  "eval/src/cli-baselines.mjs",
  "eval/src/cli-freeze.mjs",
  "eval/src/cli-verify.mjs",
  "eval/src/systems/reminder.mjs",
  "eval/src/systems/parser.mjs",
  "eval/src/systems/general-agent.mjs",
];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const rootUrl = (p) => new URL(`../../${p}`, import.meta.url);

export async function currentFileHashes() {
  const out = {};
  for (const f of CODE_FILES) {
    out[f] = sha256(await readFile(rootUrl(f), "utf8"));
  }
  return out;
}

export async function readRecord() {
  return JSON.parse(await readFile(new URL("../data/heldout-hashes.json", import.meta.url), "utf8"));
}

export async function currentPhotoHashes() {
  const out = {};
  const dir = new URL("../data/photos/", import.meta.url);
  for (const f of (await readdir(dir)).sort()) {
    if (!/\.(jpg|jpeg|png)$/.test(f)) continue;
    out[f] = sha256(await readFile(new URL(f, dir)));
  }
  return out;
}

export function photoTrackLetters(photoFiles) {
  const ids = new Set();
  for (const f of Object.keys(photoFiles)) ids.add(f.replace(/\.(jpg|jpeg|png)$/, "").replace(/-p\d+$/, ""));
  return [...ids].sort();
}

export async function verifyCode(record) {
  const current = await currentFileHashes();
  const mismatches = CODE_FILES.filter((f) => record.code[f] !== current[f]);
  return { ok: mismatches.length === 0, mismatches, current };
}

export async function verifyDev(record) {
  const mismatches = [];
  const dev = generateDevHouseholds();
  const wantInputs = JSON.stringify(toBaselineInputs(dev), null, 2) + "\n";
  const wantAnswers = JSON.stringify(toAnswers(dev), null, 2) + "\n";
  const haveInputs = await readFile(new URL("../data/dev.json", import.meta.url), "utf8");
  const haveAnswers = await readFile(new URL("../data/dev-answers.json", import.meta.url), "utf8");
  if (sha256(wantInputs) !== sha256(haveInputs)) mismatches.push("data/dev.json");
  if (sha256(wantAnswers) !== sha256(haveAnswers)) mismatches.push("data/dev-answers.json");
  if (record.dev.inputs !== sha256(haveInputs)) mismatches.push("record dev.inputs");
  if (record.dev.answers !== sha256(haveAnswers)) mismatches.push("record dev.answers");
  return { ok: mismatches.length === 0, mismatches };
}

export async function verifyPhotos(record) {
  const mismatches = [];
  const current = await currentPhotoHashes();
  const wantFiles = Object.keys(record.photos).sort();
  const haveFiles = Object.keys(current).sort();
  if (JSON.stringify(wantFiles) !== JSON.stringify(haveFiles)) {
    mismatches.push(`photo set differs (record ${wantFiles.length}, disk ${haveFiles.length})`);
  }
  for (const f of wantFiles) {
    if (record.photos[f] !== current[f]) {
      mismatches.push(f);
      if (mismatches.length > 5) break;
    }
  }
  const wantTrack = [...(record.tracks?.photo || [])].sort();
  const haveTrack = photoTrackLetters(current);
  if (JSON.stringify(wantTrack) !== JSON.stringify(haveTrack)) mismatches.push("photo track membership");
  return { ok: mismatches.length === 0, mismatches };
}

export async function verifyHeldout(record, seed) {
  const heldout = generateHeldoutHouseholds(seed);
  const lines = heldout.map((h) => `| ${h.householdId} | ${sha256(JSON.stringify(h))} |`);
  const manifest = sha256(lines.join("\n"));
  const mismatches = [];
  if (manifest !== record.manifest) mismatches.push("manifest");
  const frozen = new Map(record.heldout.map((h) => [h.householdId, h.sha256]));
  if (frozen.size !== heldout.length) mismatches.push(`count ${heldout.length} vs frozen ${frozen.size}`);
  for (const h of heldout) {
    if (frozen.get(h.householdId) !== sha256(JSON.stringify(h))) {
      mismatches.push(h.householdId);
      if (mismatches.length > 5) break;
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

export function verifySeedCommitment(seed, record) {
  return sha256(seed) === record.seedCommitment;
}
