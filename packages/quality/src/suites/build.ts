// Assembles the versioned suites and hashes them. A changed case changes the
// hash, and the pins test refuses to run until the author bumps the suite
// version and re-pins on purpose. Run with: node src/bin/bench.ts --list

import { sha256Hex, stableStringify } from "../prng.ts";
import { buildChatCases, CHAT_SUITE_VERSION } from "./chat.ts";
import { buildLettersCases, LETTERS_SUITE_VERSION } from "./letters.ts";
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

export function buildSuite(suite: SuiteName): SuiteBuild {
  const cases: BenchCase[] =
    suite === "chat" ? buildChatCases()
    : suite === "text" ? buildTextCases()
    : suite === "letters" ? buildLettersCases()
    : suite === "personas" ? buildPersonasCases()
    : buildSafetyCases();
  return { suite, version: SUITE_VERSIONS[suite]!, cases, sha256: sha256Hex(stableStringify(cases)) };
}

export function buildAllSuites(): SuiteBuild[] {
  return SUITE_NAMES.map(buildSuite);
}
