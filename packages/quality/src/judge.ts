// The judge: scores answers 1 to 5 on helpful, accurate, plain, warm, with the
// facts and a reference answer in view. Batches hold up to 8 answers, shuffled
// and unlabeled, never told which version wrote them. The judge only stays if
// it agrees with the hand-labeled set on 80% of pass/fail calls.

import type { ModelClient } from "./models.ts";
import { containsPromise, extractAmounts, extractDates, extractPhones, extractUrls } from "./checks.ts";
import { mulberry32, shuffle } from "./prng.ts";

export const JUDGE_BATCH_SIZE = 8;
export const JUDGE_AGREEMENT_MIN = 0.8;

export interface JudgeItem {
  answer: string;
  facts: string;
  reference: string;
}

export interface JudgeScore {
  helpful: number;
  accurate: number;
  plain: number;
  warm: number;
  pass: boolean;
  reason: string;
}

export interface JudgeClient {
  id: string;
  live: boolean;
  score(batch: JudgeItem[]): Promise<JudgeScore[]>;
}

export const JUDGE_RUBRIC = [
  "Score each answer 1 to 5 on four traits: helpful (moves the resident forward),",
  "accurate (every fact matches the given facts or the reference; invented facts fail),",
  "plain (short words, short sentences, no jargon), warm (kind, patient, never rushed).",
  "Mark pass true only when accurate is at least 4 and no invented fact appears.",
  "Reply with a JSON array, one object per answer in order:",
  '[{"helpful":5,"accurate":5,"plain":4,"warm":5,"pass":true,"reason":"..."}]',
].join(" ");

export function judgePrompt(batch: JudgeItem[]): string {
  const parts = batch.map((item, i) => (
    `--- answer ${i + 1} ---\nFacts given to the writer:\n${item.facts}\nReference answer:\n${item.reference}\nAnswer to score:\n${item.answer}`
  ));
  return `${JUDGE_RUBRIC}\n\n${parts.join("\n\n")}`;
}

function clampScore(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 3;
  return Math.min(5, Math.max(1, v));
}

export function parseJudgeScores(text: string, count: number): JudgeScore[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("judge did not return a JSON array");
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== count) throw new Error(`judge returned ${Array.isArray(parsed) ? parsed.length : "?"} scores for ${count} answers`);
  return (parsed as Record<string, unknown>[]).map((s) => ({
    helpful: clampScore(s.helpful),
    accurate: clampScore(s.accurate),
    plain: clampScore(s.plain),
    warm: clampScore(s.warm),
    pass: s.pass === true,
    reason: typeof s.reason === "string" ? s.reason.slice(0, 280) : "",
  }));
}

export class MetaJudge implements JudgeClient {
  readonly live = true;
  readonly id: string;
  private model: ModelClient;

  constructor(model: ModelClient) {
    this.model = model;
    this.id = `judge:${model.id}`;
  }

  async score(batch: JudgeItem[]): Promise<JudgeScore[]> {
    if (batch.length === 0 || batch.length > JUDGE_BATCH_SIZE) {
      throw new Error(`judge batch must hold 1 to ${JUDGE_BATCH_SIZE} answers`);
    }
    const result = await this.model.complete(
      [{ role: "user", content: judgePrompt(batch) }],
      { maxTokens: 2000 },
    );
    return parseJudgeScores(result.text, batch.length);
  }
}

// Deterministic stand-in for tests and offline runs. It passes answers that
// track the reference and fails the rest; it never calls a model.
export class FakeJudge implements JudgeClient {
  readonly live = false;
  readonly id = "fake-judge";

  async score(batch: JudgeItem[]): Promise<JudgeScore[]> {
    if (batch.length === 0 || batch.length > JUDGE_BATCH_SIZE) {
      throw new Error(`judge batch must hold 1 to ${JUDGE_BATCH_SIZE} answers`);
    }
    return batch.map((item) => scoreByOverlap(item));
  }
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9áéíóúñü\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
}

export function scoreByOverlap(item: JudgeItem): JudgeScore {
  // Grounding first: any phone, link, amount or date the facts and reference
  // do not hold fails, exactly like the hard check.
  const given = `${item.facts}\n${item.reference}`;
  const givenDigits = given.replace(/\D/g, " ");
  const invented = [
    ...extractPhones(item.answer).filter((p) => !given.includes(p) && !givenDigits.includes(p.replace(/\D/g, ""))),
    ...extractUrls(item.answer).filter((u) => !given.includes(u)),
    ...extractAmounts(item.answer).filter((a) => !given.includes(a)),
    ...extractDates(item.answer).filter((d) => !given.toLowerCase().includes(d.toLowerCase())),
  ];
  if (invented.length > 0) {
    return { helpful: 2, accurate: 1, plain: 3, warm: 3, pass: false, reason: `invented fact: ${invented[0]}` };
  }
  if (containsPromise(item.answer) && !containsPromise(item.reference)) {
    return { helpful: 2, accurate: 1, plain: 3, warm: 3, pass: false, reason: "promises eligibility the reference does not promise" };
  }
  if (/\[letter\s+\d+\]/i.test(item.reference) && !/\[letter\s+\d+\]/i.test(item.answer)) {
    return { helpful: 3, accurate: 2, plain: 4, warm: 4, pass: false, reason: "drops the letter citation" };
  }
  const a = words(item.answer);
  const r = words(item.reference);
  let shared = 0;
  for (const w of r) if (a.has(w)) shared++;
  const ratio = r.size === 0 ? 0 : shared / r.size;
  const pass = ratio >= 0.5;
  const base = pass ? 5 : 2;
  return {
    helpful: base, accurate: pass ? 5 : 2, plain: 4, warm: 4,
    pass,
    reason: pass ? `tracks the reference (${shared}/${r.size} content words)` : `drifts from the reference (${shared}/${r.size} content words)`,
  };
}

export function judgeMean(scores: JudgeScore[]): number {
  if (scores.length === 0) return 0;
  const total = scores.reduce((sum, s) => sum + (s.helpful + s.accurate + s.plain + s.warm) / 4, 0);
  return total / scores.length;
}

// Scores items in shuffled batches of 8 without version labels, then restores
// the input order. The judge sees answers, facts and references only.
export async function judgeAll(items: JudgeItem[], judge: JudgeClient, seed = 7): Promise<JudgeScore[]> {
  const rand = mulberry32(seed);
  const order = shuffle(items.map((_, i) => i), rand);
  const out: JudgeScore[] = new Array(items.length);
  for (let start = 0; start < order.length; start += JUDGE_BATCH_SIZE) {
    const idx = order.slice(start, start + JUDGE_BATCH_SIZE);
    const batch = idx.map((i) => items[i]!);
    const scores = await judge.score(batch);
    idx.forEach((original, k) => {
      out[original] = scores[k]!;
    });
  }
  return out;
}
