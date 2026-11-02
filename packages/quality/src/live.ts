// Live quality hooks. The engine and channels call afterAnswer after each
// answer, classifyConversation once per conversation, and recordFeedback on
// votes. Only scores and counts are stored; answer text is checked, possibly
// sampled, then discarded. Wire behind a flag in each caller after their
// packages merge; this file is the whole interface they import.

import { runHardChecks } from "./checks.ts";
import { needsCrisisResponse } from "./crisis.ts";
import { dnsFromEnv, type DnsClient } from "./links.ts";
import { FakeJudge, type JudgeClient } from "./judge.ts";
import { DEFAULT_JUDGE_MODEL_ID } from "./models.ts";
import { sentText } from "./paths.ts";
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
  // The resident's inbound message, for crisis detection only. Never stored.
  inboundText?: string;
  // Outside actions the answer path took. Normally empty; any action blocks.
  actions?: { kind: string; detail?: string }[];
}

export interface LiveAnswerResult {
  blocked: boolean;
  failedChecks: string[];
  sampled: boolean;
  judgeMean: number | null;
}

// Every check in this set blocks the answer before it is sent.
export const LIVE_BLOCKING_CHECKS = ["facts-grounded", "links-ok", "no-promise", "crisis-ok", "no-action"] as const;

// Masking removes personal details before the 5% in-place grading. It works by
// narrow patterns (emails, phones, SSNs, digit runs, addresses, case numbers,
// name introductions) so danger words pass through untouched; the mask test
// proves both halves.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\d{3}-\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const LONG_ID_RE = /\b\d{9,}\b/g;
const ADDRESS_RE = /\b\d{1,5}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,3}\s+(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b\.?/gi;
const CASE_NO_RE = /\b(case|claim|member|id)\s*(#|number|no\.?)?\s*:?\s*[A-Z0-9-]{4,}\b/gi;
const NAME_INTRO_RE = /\b([Mm]y name is|[Tt]his is|[Ss]oy|[Mm]e llamo)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g;
const GREETING_NAME_RE = /\b([Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Tt]hanks|[Tt]hank you|[Ss]incerely|[Rr]egards|[Bb]est|[Gg]racias)[, ]+([Ii]'m|[Ii] am|[Tt]his is)?\s*([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)/g;
// Words that follow a greeting but are never names. "Hi there" stays.
const GREETING_NON_NAMES = new Set(["there", "all", "everyone", "everybody", "team", "teams", "folks", "friend", "friends", "again", "here", "for", "the", "your", "you", "me", "this", "that", "it", "my", "our", "so", "very"]);

function maskGreeting(match: string, _greeting: string, _intro: string | undefined, name: string): string {
  const first = (name.split(/\s+/)[0] ?? "").toLowerCase();
  if (GREETING_NON_NAMES.has(first)) return match;
  return "[greeting]";
}
const TOKEN_URL_RE = /\bhttps?:\/\/[^\s]*[?&](token|key|auth|signature|sig)=[^\s]*/gi;

export function maskText(text: string): string {
  // Case numbers mask before digit runs: the [id-number] label would otherwise
  // re-trigger the case pattern and double-mask.
  return text
    .replace(EMAIL_RE, "[email]")
    .replace(TOKEN_URL_RE, "[link]")
    .replace(PHONE_RE, "[phone]")
    .replace(CASE_NO_RE, "[case-number]")
    .replace(SSN_RE, "[ssn]")
    .replace(LONG_ID_RE, "[id-number]")
    .replace(ADDRESS_RE, "[address]")
    .replace(NAME_INTRO_RE, "[name]")
    .replace(GREETING_NAME_RE, maskGreeting as (match: string, ...args: unknown[]) => string);
}

// The whole grading payload is masked, facts included: fixture facts carry
// phone numbers and links that must never reach the judge raw.
export function gradingPayload(answerText: string, factsText: string): { answer: string; facts: string } {
  return { answer: maskText(answerText), facts: maskText(factsText) };
}

// Inbound crisis detection shares the bench's detector (crisis.ts), tested on
// every crisis fixture and look-alike.
export function inboundNeedsCrisis(text: string | undefined): boolean {
  return needsCrisisResponse(text);
}

export interface LiveHooksDeps {
  store: LiveStore;
  dns?: DnsClient;
  judge?: JudgeClient;
  // The exact live judge identity required, `judge:<model id>`. Defaults to
  // the configured judge model ID. Only this ID may grade real content.
  judgeId?: string;
  env?: NodeJS.ProcessEnv;
}

export function expectedJudgeId(deps: Pick<LiveHooksDeps, "judgeId" | "env">): string {
  const env = deps.env ?? process.env;
  const model = deps.judgeId ?? env.MANO_MODEL_JUDGE_ID ?? DEFAULT_JUDGE_MODEL_ID;
  return model.startsWith("judge:") ? model : `judge:${model}`;
}

export class LiveQuality {
  private store: LiveStore;
  private dns: DnsClient;
  private judge: JudgeClient;

  constructor(deps: LiveHooksDeps) {
    // Live grading touches real content, so it accepts only the exact
    // configured judge identity. Anything else, contributor or unknown, is
    // refused. The fake judge is allowed because it never calls a model.
    // A -contributor ID is never allowed on real content, whatever the
    // configuration says, so the suffix check comes before the identity check.
    if (deps.judge?.live && /-contributor$/i.test(deps.judge.id)) {
      throw new Error("live grading refuses -contributor model IDs; real content goes to a Standard ID only");
    }
    if (deps.judge?.live && deps.judge.id !== expectedJudgeId(deps)) {
      throw new Error(`live grading requires judge ${expectedJudgeId(deps)}, not ${deps.judge.id}`);
    }
    this.store = deps.store;
    this.dns = deps.dns ?? dnsFromEnv();
    this.judge = deps.judge ?? new FakeJudge();
  }

  // Runs the safety checks in the request path. Any safety failure blocks the
  // answer before it is sent. Records counts only.
  async afterAnswer(input: LiveAnswerInput): Promise<LiveAnswerResult> {
    const crisisInbound = inboundNeedsCrisis(input.inboundText);
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
      expect: {
        ...(input.textChannel ? { maxBubbles: 3, maxBubbleChars: 320 } : {}),
        ...(crisisInbound ? { crisis: true } : {}),
        noAction: true,
      },
      seed: 0,
    };
    const checks = await runHardChecks(
      pseudoCase,
      { text: input.text, bubbles: input.bubbles, actions: input.actions ?? [], latencyMs: input.latencyMs, inputTokens: input.inputTokens, outputTokens: input.outputTokens },
      this.dns,
    );
    const failed = checks.filter((c) => !c.pass).map((c) => c.id);
    const blocking = new Set<string>(LIVE_BLOCKING_CHECKS);
    const blocked = checks.some((c) => !c.pass && blocking.has(c.id));
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
      const payload = gradingPayload(sentText(input), factsLine(input.facts));
      const scores = await this.judge.score([{ answer: payload.answer, facts: payload.facts, reference: "(no reference on live answers)" }]);
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
    this.store.incrementCounter({
      state: input.state,
      week: input.week,
      kind: input.kind,
      urgency: input.urgency,
      helped: input.helped,
    });
  }

  // A thumbs vote or YES/NO reply. Stores the answer and the category only.
  // Callers enforce the pacing: at most once per person per week on text, and
  // only after a completed task.
  recordFeedback(input: { category: string; channel: "web" | "text"; helpful: boolean; week: string }): void {
    this.store.recordFeedback({
      category: input.category,
      channel: input.channel,
      helpful: input.helpful,
      week: input.week,
    });
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

// Any count under 10 is hidden, and the total is withheld whenever any cell
// is suppressed: otherwise the hidden cells can be recovered by subtraction.
export function displayTotal(hiddenCells: number, total: number | null): number | null {
  if (hiddenCells > 0) return null;
  if (total === null || total < 10) return null;
  return total;
}

export function suppressCounts(counts: { label: string; n: number }[], total: number): SuppressedCounts {
  const shown = counts.filter((c) => c.n >= 10);
  const hiddenCells = counts.length - shown.length;
  return { shown, hiddenCells, total: displayTotal(hiddenCells, total) };
}
