// Live stores keep scores and counts only, never text. The engine and channels
// call the hooks in live.ts; the stores below are the in-memory and JSON-file
// implementations behind the LiveStore interface.

export interface AnswerOutcome {
  category: string;
  failedChecks: string[];
  blocked: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  week: string;
}

export interface JudgeSample {
  category: string;
  helpful: number;
  accurate: number;
  plain: number;
  warm: number;
  pass: boolean;
  week: string;
}

export interface CounterKey {
  state: string;
  week: string;
  kind: string;
  urgency: "routine" | "urgent";
  helped: boolean;
}

export interface FeedbackRow {
  category: string;
  channel: "web" | "text";
  helpful: boolean;
  week: string;
}

export interface LiveStore {
  recordAnswerOutcome(r: AnswerOutcome): void;
  recordJudgeSample(r: JudgeSample): void;
  incrementCounter(k: CounterKey): void;
  recordFeedback(r: FeedbackRow): void;
  // Reads for the staff page and alerts. Every read returns counts only.
  answerOutcomes(): AnswerOutcome[];
  judgeSamples(): JudgeSample[];
  counters(): { key: CounterKey; n: number }[];
  feedback(): { row: Omit<FeedbackRow, "week">; week: string; n: number }[];
  snapshot(): string;
}

function counterKey(k: CounterKey): string {
  return `${k.state}|${k.week}|${k.kind}|${k.urgency}|${k.helped ? "helped" : "unhelped"}`;
}

export class MemoryLiveStore implements LiveStore {
  private outcomes: AnswerOutcome[] = [];
  private samples: JudgeSample[] = [];
  private counts = new Map<string, { key: CounterKey; n: number }>();
  private votes = new Map<string, { row: Omit<FeedbackRow, "week">; week: string; n: number }>();

  recordAnswerOutcome(r: AnswerOutcome): void {
    // Approved fields only, copied one by one. A spread would persist any
    // extra field the caller attached, including text.
    this.outcomes.push({
      category: r.category,
      failedChecks: [...r.failedChecks],
      blocked: r.blocked,
      latencyMs: r.latencyMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      week: r.week,
    });
  }

  recordJudgeSample(r: JudgeSample): void {
    this.samples.push({
      category: r.category,
      helpful: r.helpful,
      accurate: r.accurate,
      plain: r.plain,
      warm: r.warm,
      pass: r.pass,
      week: r.week,
    });
  }

  incrementCounter(k: CounterKey): void {
    const clean: CounterKey = { state: k.state, week: k.week, kind: k.kind, urgency: k.urgency, helped: k.helped };
    const key = counterKey(clean);
    const found = this.counts.get(key);
    if (found) found.n++;
    else this.counts.set(key, { key: clean, n: 1 });
  }

  recordFeedback(r: FeedbackRow): void {
    const key = `${r.category}|${r.channel}|${r.helpful}|${r.week}`;
    const found = this.votes.get(key);
    if (found) found.n++;
    else this.votes.set(key, { row: { category: r.category, channel: r.channel, helpful: r.helpful }, week: r.week, n: 1 });
  }

  answerOutcomes(): AnswerOutcome[] {
    return this.outcomes.map((o) => ({ ...o, failedChecks: [...o.failedChecks] }));
  }

  judgeSamples(): JudgeSample[] {
    return this.samples.map((s) => ({ ...s }));
  }

  counters(): { key: CounterKey; n: number }[] {
    return [...this.counts.values()].map((c) => ({ key: { ...c.key }, n: c.n }));
  }

  feedback(): { row: Omit<FeedbackRow, "week">; week: string; n: number }[] {
    return [...this.votes.values()].map((v) => ({ row: { ...v.row }, week: v.week, n: v.n }));
  }

  // Everything the store would persist, as one string. The no-text test
  // searches this for the synthetic message and must not find it.
  snapshot(): string {
    return JSON.stringify({
      outcomes: this.outcomes,
      samples: this.samples,
      counters: this.counters(),
      feedback: this.feedback(),
    });
  }
}
