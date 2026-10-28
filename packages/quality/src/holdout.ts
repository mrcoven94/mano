// Safety holdout loader. The 20 holdout cases live outside the repo: the
// architect writes the file, the vault keeps it as MANO_QUALITY_HOLDOUT, and
// the repo commits only its SHA-256. The runner verifies the hash before use
// and never tunes prompts against the holdout. Run with:
// MANO_QUALITY_HOLDOUT_PATH=/path/to/holdout.json node src/bin/bench.ts --suite safety-holdout

import { readFileSync } from "node:fs";
import { sha256Hex } from "./prng.ts";
import type { BenchCase } from "./suites/types.ts";

// Committed pin of the holdout file. Null until the architect delivers the
// file; set it to the file's SHA-256 in the same change that first uses it.
export const HOLDOUT_SHA256_PIN: string | null = null;
export const HOLDOUT_VERSION = 1;
export const HOLDOUT_CASE_COUNT = 20;

export interface HoldoutLoad {
  configured: boolean;
  version?: number;
  cases?: BenchCase[];
  sha256?: string;
  pinMatch?: boolean;
  reason?: string;
}

function isBenchCase(v: unknown): v is BenchCase {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    c.suite === "safety" &&
    typeof c.locale === "string" &&
    typeof c.state === "string" &&
    typeof c.input === "object" && c.input !== null &&
    Array.isArray((c.input as { turns?: unknown }).turns) &&
    typeof c.facts === "object" && c.facts !== null &&
    typeof c.reference === "string" &&
    typeof c.expect === "object" && c.expect !== null &&
    typeof c.seed === "number"
  );
}

export function loadHoldout(path: string | undefined, expectedSha: string | undefined): HoldoutLoad {
  if (!path) return { configured: false, reason: "MANO_QUALITY_HOLDOUT_PATH is not set" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { configured: false, reason: `cannot read holdout file at ${path}` };
  }
  const sha256 = sha256Hex(raw);
  if (!expectedSha) return { configured: false, reason: "MANO_QUALITY_HOLDOUT_SHA256 is not set; refusing to run an unverified holdout", sha256 };
  if (sha256 !== expectedSha) {
    return { configured: false, reason: "holdout SHA-256 does not match; refusing to run", sha256, pinMatch: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { configured: false, reason: "holdout file is not JSON", sha256, pinMatch: true };
  }
  const doc = parsed as { version?: unknown; cases?: unknown };
  if (doc.version !== HOLDOUT_VERSION || !Array.isArray(doc.cases) || doc.cases.length !== HOLDOUT_CASE_COUNT) {
    return { configured: false, reason: `holdout must be version ${HOLDOUT_VERSION} with ${HOLDOUT_CASE_COUNT} cases`, sha256, pinMatch: true };
  }
  if (!doc.cases.every(isBenchCase)) {
    return { configured: false, reason: "holdout holds a malformed case", sha256, pinMatch: true };
  }
  const pinMatch = HOLDOUT_SHA256_PIN === null ? true : HOLDOUT_SHA256_PIN === sha256;
  return { configured: true, version: HOLDOUT_VERSION, cases: doc.cases as BenchCase[], sha256, pinMatch };
}
