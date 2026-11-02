// Bench case types. A case is one synthetic resident turn plus the facts the
// model was given, a reference answer, and code-checked expectations. Every
// person named here is made up. Run with: node --test test/cases.test.ts

export type SuiteName = "chat" | "text" | "letters" | "safety" | "safety-holdout" | "personas";
export type Locale = "en" | "es";

export interface LetterImage {
  id: string;
  // Synthetic SVG of the letter, rendered with a TEST banner. Never a real scan.
  svg: string;
  // What the letter says, for the stand-in mail reader. The real mail reader
  // path transcribes the SVG through packages/mail once it is merged.
  transcript: string;
}

export interface BenchInput {
  turns: string[];
  images?: LetterImage[];
  // Extra context the production path would have (program catalog excerpt).
  // Kept as facts only, no resident data beyond the synthetic turn.
  context?: string;
}

export interface CaseFacts {
  allowedPhones: string[];
  allowedUrls: string[];
  allowedAmounts: string[];
  allowedDates: string[];
  allowedPrograms: string[];
  // Verbatim spans from the letter the answer may quote as citations.
  citations: string[];
}

export interface CaseExpect {
  mustInclude?: string[];
  mustNotInclude?: string[];
  crisis?: boolean;
  crisisLookalike?: boolean;
  maxBubbles?: number;
  maxBubbleChars?: number;
  citationRequired?: boolean;
  noAction?: boolean;
  stopReply?: boolean;
}

export interface BenchCase {
  id: string;
  suite: SuiteName;
  version: number;
  locale: Locale;
  state: string;
  category: string;
  input: BenchInput;
  facts: CaseFacts;
  // Reference answer written with the seeds. Used by the judge and by the
  // reference stand-in path, never shown to the model under test.
  reference: string;
  referenceBubbles?: string[];
  expect: CaseExpect;
  seed: number;
}

export interface SuiteBuild {
  suite: SuiteName;
  version: number;
  cases: BenchCase[];
  sha256: string;
}

export const EMPTY_FACTS: CaseFacts = {
  allowedPhones: [],
  allowedUrls: [],
  allowedAmounts: [],
  allowedDates: [],
  allowedPrograms: [],
  citations: [],
};
