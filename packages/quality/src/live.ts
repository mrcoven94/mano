// Live quality hooks. The engine and channels call afterAnswer after each
// answer, classifyConversation once per conversation, and recordFeedback on
// votes. Only scores and counts are stored; answer text is checked, possibly
// sampled, then discarded. Wire behind a flag in each caller after their
// packages merge; this file is the whole interface they import.

import { runHardChecks } from "./checks.ts";
import { dnsFromEnv, type DnsClient } from "./links.ts";
import { FakeJudge, judgeMean, type JudgeClient } from "./judge.ts";
import { calibrationFacts } from "./calibration.ts";
import type { LiveStore } from "./live-store.ts";
import type { BenchCase, CaseFacts } from "./suites/types.ts";

// One in twenty answers is graded in place. The sampler hashes the answer id
// so sampling is stable and needs no stored state.
export const JUDGE_SAMPLE_RATE = 1 / 20;

export function sampleForJudge(answerId: string): boolean {
  let hash = 0x811c9dc5;
  for (let i = 0; i < answerId.length; i++) {
    hash ^= answerId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 20 === 0;
}

export interface LiveAnswerInput {
  answerId: string;
  text: string;
  bubbles?: string[];
  category: string;
  locale: "en" | "es";
  state: string;
  week: string;
  facts: CaseFacts;
  textChannel: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LiveAnswerResult {
  blocked: boolean;
  failedChecks: string[];
  sampled: boolean;
  judgeMean: number | null;
}

// Masking removes personal details before the 5% in-place grading. It works by
// narrow patterns (emails, phones, digit runs, addresses, case numbers) so
// danger words pass through untouched; the mask test proves both halves.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\d{3}-\d{4}\b/g;
const ADDRESS_RE = /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b\.?/g;
const CASE_NO_RE = /\b(case|claim|member|id)\s*(#|number|no\.?)?\s*:?\s*[A-Z0-9-]{4,}\b/gi;
const NAME_INTRO_RE = /\b([Mm]y name is|[Tt]his is|[Ss]oy|[Mm]e llamo)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g;

export function maskText(text: string): string {
  return text
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, "[phone]")
    .replace(ADDRESS_RE, "[address]")
    .replace(CASE_NO_RE, "[case-number]")
    .replace(NAME_INTRO_RE, "[name]");
}

export interface LiveHooksDeps {
  store: LiveStore;
  dns?: DnsClient;
  judge?: JudgeClient;
}

export class LiveQuality {
  private store: LiveStore;
  private dns: DnsClient;
  private judge: JudgeClient;

  constructor(deps: LiveHooksDeps) {
    this.store = deps.store;
    this.dns = deps.dns ?? dnsFromEnv();
    this.judge = deps.judge ?? new FakeJudge();
  }

  // Runs the hard checks in the request path. An invented fact or an unsafe
  // link blocks the answer before it is sent. Records counts only.
  async afterAnswer(input: LiveAnswerInput): Promise<LiveAnswerResult> {
    const pseudoCase: BenchCase = {
      id: `live-${input.answerId}`,
      suite: input.textChannel ? "text" : "chat",
      version: 0,
      locale: input.locale,
      state: input.state,
      category: input.category,
      input: { turns: [] },
      facts: input.facts,
      reference: "",
      expect: input.textChannel ? { maxBubbles: 3, maxBubbleChars: 320 } : {},
      seed: 0,
    };
    const checks = await runHardChecks(
      pseudoCase,
      { text: input.text, bubbles: input.bubbles, actions: [], latencyMs: input.latencyMs, inputTokens: input.inputTokens, outputTokens: input.outputTokens },
      this.dns,
    );
    const failed = checks.filter((c) => !c.pass).map((c) => c.id);
    const blocked = checks.some((c) => !c.pass && (c.id === "facts-grounded" || c.id === "links-ok"));
    this.store.recordAnswerOutcome({
      category: input.category,
      failedChecks: failed,
      blocked,
      latencyMs: input.latencyMs,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      week: input.week,
    });

    let sampled = false;
    let mean: number | null = null;
    if (!blocked && sampleForJudge(input.answerId)) {
      sampled = true;
      const masked = maskText(input.text);
      const scores = await this.judge.score([{ answer: masked, facts: factsLine(input.facts), reference: "(no reference on live answers)" }]);
      const s = scores[0]!;
      mean = (s.helpful + s.accurate + s.plain + s.warm) / 4;
      this.store.recordJudgeSample({
        category: input.category,
        helpful: s.helpful, accurate: s.accurate, plain: s.plain, warm: s.warm,
        pass: s.pass, week: input.week,
      });
    }
    return { blocked, failedChecks: failed, sampled, judgeMean: mean };
  }

  // One classification per conversation. Increments a counter keyed by state,
  // week and kind. No per-question rows. "Could not help" counts feed the
  // program request list downstream.
  classifyConversation(input: { state: string; week: string; kind: string; urgency: "routine" | "urgent"; helped: boolean }): void {
    this.store.incrementCounter(input);
  }

  // A thumbs vote or YES/NO reply. Stores the answer and the category only.
  // Callers enforce the pacing: at most once per person per week on text, and
  // only after a completed task.
  recordFeedback(input: { category: string; channel: "web" | "text"; helpful: boolean; week: string }): void {
    this.store.recordFeedback(input);
  }
}

function factsLine(f: CaseFacts): string {
  return calibrationFacts({
    id: "", suite: "chat", version: 0, locale: "en", state: "", category: "",
    input: { turns: [] }, facts: f, reference: "", expect: {}, seed: 0,
  });
}

export interface SuppressedCounts {
  shown: { label: string; n: number }[];
  hiddenCells: number;
  total: number | null;
}

// Any count under 10 is hidden, including totals that would reveal a hidden
// cell. Callers pass the per-label counts and the true total.
export function suppressCounts(counts: { label: string; n: number }[], total: number): SuppressedCounts {
  const shown = counts.filter((c) => c.n >= 10);
  const hiddenCells = counts.length - shown.length;
  const shownSum = shown.reduce((s, c) => s + c.n, 0);
  const remainder = total - shownSum;
  const totalShown = total >= 10 && (hiddenCells === 0 || remainder === 0 || remainder >= 10) ? total : null;
  return { shown, hiddenCells, total: totalShown };
}
