// Mail's published-deadline accuracy: for each synthetic letter in the
// letters suite, does the deadline the mail reader publishes match the one
// the letter sets (none for a scam or a letter with two dates)? The real
// reader is packages/mail, which has no quality adapter yet; until it exports
// qualityDeadlineReader, a stand-in reads the letter's transcript and every
// report says so.

import { stateByCode } from "./facts.ts";
import { extractDates } from "./checks.ts";
import { buildLettersCases } from "./suites/letters.ts";
import type { BenchCase, LetterImage } from "./suites/types.ts";

export interface DeadlineReader {
  name: string;
  live: boolean;
  // The one deadline the reader would publish for this letter, as written
  // on it ("November 15, 2026"), or null when it publishes none.
  readDeadline(letter: LetterImage): Promise<string | null>;
}

export interface MailSummary {
  live: boolean;
  detail: string;
  letters: number;
  correct: number;
  accuracy: number;
  misses: { caseId: string; expected: string | null; published: string | null }[];
}

// The deadline a letter sets, from how the suite built it.
export function expectedDeadline(c: BenchCase): string | null {
  if (c.category === "scam" || c.category === "conflict") return null;
  return stateByCode(c.state).renewalDate;
}

// Reads the transcript the letter was drawn from: one date publishes, two or
// more dates or a scam marker publish none.
export class TranscriptDeadlineReader implements DeadlineReader {
  readonly name = "transcript-standin";
  readonly live = false;

  async readDeadline(letter: LetterImage): Promise<string | null> {
    if (/\b(?:URGENT|verify now)\b/i.test(letter.transcript)) return null;
    const dates = [...new Set(extractDates(letter.transcript))];
    return dates.length === 1 ? dates[0]! : null;
  }
}

export async function loadDeadlineReader(): Promise<{ reader: DeadlineReader; detail: string }> {
  try {
    const mod = (await import("@mano/mail" as string)) as { qualityDeadlineReader?: DeadlineReader };
    if (mod.qualityDeadlineReader && typeof mod.qualityDeadlineReader.readDeadline === "function") {
      return { reader: mod.qualityDeadlineReader, detail: "packages/mail qualityDeadlineReader" };
    }
    return { reader: new TranscriptDeadlineReader(), detail: "stand-in: packages/mail exports no qualityDeadlineReader yet" };
  } catch {
    return { reader: new TranscriptDeadlineReader(), detail: "stand-in: packages/mail exports no qualityDeadlineReader yet" };
  }
}

export async function scoreMailDeadlines(reader?: DeadlineReader, detail?: string): Promise<MailSummary> {
  const loaded = reader ? { reader, detail: detail ?? reader.name } : await loadDeadlineReader();
  const misses: MailSummary["misses"] = [];
  const letters = buildLettersCases();
  let correct = 0;
  for (const c of letters) {
    const expected = expectedDeadline(c);
    const published = await loaded.reader.readDeadline(c.input.images![0]!);
    if ((published ?? null) === expected) correct += 1;
    else misses.push({ caseId: c.id, expected, published });
  }
  return {
    live: loaded.reader.live,
    detail: loaded.detail,
    letters: letters.length,
    correct,
    accuracy: letters.length === 0 ? 0 : correct / letters.length,
    misses,
  };
}
