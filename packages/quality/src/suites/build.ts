// Assembles the versioned suites and hashes them. A changed case changes the
// hash, and the pins test refuses to run until the author bumps the suite
// version and re-pins on purpose. Run with: node src/bin/bench.ts --list

import { sha256Hex, stableStringify } from "../prng.ts";
import { buildChatCases, CHAT_SUITE_VERSION } from "./chat.ts";
import { buildLettersCases, LETTERS_SUITE_VERSION, type LettersVersion } from "./letters.ts";
import { buildPersonasCases, PERSONAS_SUITE_VERSION } from "./personas.ts";
import { buildSafetyCases, SAFETY_SUITE_VERSION } from "./safety.ts";
import { buildTextCases, TEXT_SUITE_VERSION } from "./text.ts";
import type { BenchCase, SuiteBuild, SuiteName } from "./types.ts";

export const SUITE_NAMES: SuiteName[] = ["chat", "text", "letters", "safety", "personas"];

export const SUITE_VERSIONS: Record<SuiteName, number> = {
  chat: CHAT_SUITE_VERSION,
  text: TEXT_SUITE_VERSION,
  letters: LETTERS_SUITE_VERSION,
  safety: SAFETY_SUITE_VERSION,
  "safety-holdout": 1,
  personas: PERSONAS_SUITE_VERSION,
};

// An older version of a suite that is kept runnable, for comparing against
// results recorded at that version.
export interface SuiteOptions {
  lettersVersion?: LettersVersion;
}

export function buildSuite(suite: SuiteName, opts: SuiteOptions = {}): SuiteBuild {
  const cases: BenchCase[] =
    suite === "chat" ? buildChatCases()
    : suite === "text" ? buildTextCases()
    : suite === "letters" ? buildLettersCases(opts.lettersVersion)
    : suite === "personas" ? buildPersonasCases()
    : buildSafetyCases();
  const version = suite === "letters" ? (opts.lettersVersion ?? LETTERS_SUITE_VERSION) : SUITE_VERSIONS[suite]!;
  return { suite, version, cases, sha256: sha256Hex(stableStringify(cases)) };
}

export function buildAllSuites(opts: SuiteOptions = {}): SuiteBuild[] {
  return SUITE_NAMES.map((s) => buildSuite(s, opts));
}
