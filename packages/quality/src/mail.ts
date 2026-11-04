// Mail's published-deadline accuracy: for each synthetic letter in the
// letters suite, does the deadline the mail reader publishes match the one
// the letter sets (none for a scam or a letter with two dates)? The real
// reader is packages/mail qualityDeadlineReader, used whenever
// META_MODEL_API_KEY is set, or the same reader from its transcript stage under
// MANO_MODEL_PROVIDER=openrouter; without a key a stand-in reads the letter's
// transcript and every report says so.

import { extractDates } from "./checks.ts";
import { openRouterKey } from "./models.ts";
import { buildLettersCases, letterDeadline } from "./suites/letters.ts";
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
  const deadline = letterDeadline(c);
  return deadline?.kind === "one" ? deadline.date : null;
}

// The date a letter was printed, alone on its line above the greeting, says
// when it was sent, not when to act; the mail reader sets it aside too.
function withoutPrintedDate(transcript: string): string {
  const lines = transcript.split("\n");
  const greeting = lines.findIndex((l) => /^\s*dear\b/i.test(l));
  return lines.filter((l, i) => !(i < greeting && extractDates(l)[0] === l.trim())).join("\n");
}

// Reads the transcript the letter was drawn from: one date publishes when a
// plain sentence states it. Two or more dates, a scam marker, a date set by
// a condition ("if", "unless") or a date outside a sentence (a table row)
// publish none.
export class TranscriptDeadlineReader implements DeadlineReader {
  readonly name = "transcript-standin";
  readonly live = false;

  async readDeadline(letter: LetterImage): Promise<string | null> {
    if (/\b(?:URGENT|verify now)\b/i.test(letter.transcript)) return null;
    const text = withoutPrintedDate(letter.transcript);
    const dates = [...new Set(extractDates(text))];
    if (dates.length !== 1) return null;
    const sentence = text.split(/\n|(?<=\.)\s+/).find((s) => s.includes(dates[0]!))!;
    return sentence.trim().endsWith(".") && !/\b(?:if|unless)\b/i.test(sentence) ? dates[0]! : null;
  }
}

export async function loadDeadlineReader(env: NodeJS.ProcessEnv = process.env): Promise<{ reader: DeadlineReader; detail: string }> {
  const openRouter = openRouterKey(env);
  if (openRouter) {
    // Not a typed import, as in paths.ts mailPath.
    const mod = (await import("./mail-transcript.ts" as string)) as { transcriptDeadlineReader(key: string): DeadlineReader; TRANSCRIPT_STAGE_DETAIL: string };
    return { reader: mod.transcriptDeadlineReader(openRouter), detail: mod.TRANSCRIPT_STAGE_DETAIL };
  }
  if (!env.META_MODEL_API_KEY) return { reader: new TranscriptDeadlineReader(), detail: "stand-in: no META_MODEL_API_KEY" };
  try {
    const mod = (await import("@mano/mail" as string)) as { qualityDeadlineReader?: DeadlineReader };
    if (mod.qualityDeadlineReader && typeof mod.qualityDeadlineReader.readDeadline === "function") {
      return { reader: mod.qualityDeadlineReader, detail: "packages/mail qualityDeadlineReader" };
    }
    return { reader: new TranscriptDeadlineReader(), detail: "stand-in: packages/mail exports no qualityDeadlineReader" };
  } catch {
    return { reader: new TranscriptDeadlineReader(), detail: "stand-in: packages/mail did not load" };
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
