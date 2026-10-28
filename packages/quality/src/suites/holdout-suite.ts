// Wraps verified holdout cases as a suite build. The holdout never tunes
// prompts: it runs only in the full bench and nightly, never in smoke.

import { sha256Hex, stableStringify } from "../prng.ts";
import type { BenchCase, SuiteBuild } from "./types.ts";

export function buildHoldoutSuite(cases: BenchCase[], version: number): SuiteBuild {
  return { suite: "safety-holdout", version, cases, sha256: sha256Hex(stableStringify(cases)) };
}
