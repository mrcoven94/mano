// Reply speed against a running agent: signed synthetic turns, spaced so it is
// not a load test, with health checks over the run. Each round a fresh made-up
// person, a random handle hash never tied to a phone number, sends a greeting,
// a SNAP question and a YES with nothing waiting. It signs and sends through
// Channels' own AgentResponder and times that call, so it measures the agent,
// Engine and the model, and not Channels, the carrier or the phone. A turn the
// agent did not answer counts as an error, never as a time.

import { randomBytes } from "node:crypto";
import { AgentResponder, type Responder } from "@mano/channels";

export const SPEED_TURNS = [
  { kind: "greeting", text: "Hi, I just heard about Mano." },
  { kind: "snap", text: "What does SNAP pay for, and how do I apply?" },
  { kind: "yes", text: "YES" },
] as const;

export type TurnKind = (typeof SPEED_TURNS)[number]["kind"];

export interface TurnSample {
  kind: TurnKind;
  round: number;
  ms: number;
  answered: boolean;
}

export interface HealthSample {
  url: string;
  status: number | null;
  ms: number;
}

export interface TurnStats {
  turns: number;
  errors: number;
  medianMs: number;
  p90Ms: number;
  minMs: number;
  maxMs: number;
}

export interface HealthStats {
  url: string;
  checks: number;
  ok: number;
  medianMs: number;
}

// The nearest-rank percentile of the answered turns.
function rank(sorted: number[], p: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export function turnStats(samples: TurnSample[], kind: TurnKind): TurnStats {
  const rows = samples.filter((s) => s.kind === kind);
  const times = rows.filter((s) => s.answered).map((s) => s.ms).sort((a, b) => a - b);
  return {
    turns: rows.length,
    errors: rows.length - times.length,
    medianMs: rank(times, 50),
    p90Ms: rank(times, 90),
    minMs: times[0] ?? 0,
    maxMs: times[times.length - 1] ?? 0,
  };
}

export function healthStats(samples: HealthSample[], url: string): HealthStats {
  const rows = samples.filter((s) => s.url === url);
  return {
    url,
    checks: rows.length,
    ok: rows.filter((s) => s.status === 200).length,
    medianMs: rank(rows.map((s) => s.ms).sort((a, b) => a - b), 50),
  };
}

export interface SpeedOptions {
  agentUrl: string;
  agentSecret: string;
  grantSecret: string;
  rounds: number;
  gapMs: number;
  healthUrls: string[];
  healthEveryMs: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onTurn?: (sample: TurnSample) => void;
}

// In production Channels answers from its plain responder when the agent
// fails. Here that is the measured failure, so nothing stands in.
const NO_FALLBACK: Responder = {
  name: "none",
  maxAttempts: 0,
  inputSlackChars: 0,
  maxOutputChars: 0,
  async respond() {
    throw new Error("the agent did not answer");
  },
};

async function checkHealth(url: string, fetchFn: typeof fetch): Promise<HealthSample> {
  const started = performance.now();
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    return { url, status: res.status, ms: Math.round(performance.now() - started) };
  } catch {
    return { url, status: null, ms: Math.round(performance.now() - started) };
  }
}

export async function runSpeed(opts: SpeedOptions): Promise<{ turns: TurnSample[]; health: HealthSample[] }> {
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const turns: TurnSample[] = [];
  const health: HealthSample[] = [];
  const pending = new Set<Promise<unknown>>();
  const sweep = () => {
    for (const url of opts.healthUrls) {
      const check: Promise<unknown> = checkHealth(url, fetchFn).then((h) => {
        health.push(h);
        pending.delete(check);
      });
      pending.add(check);
    }
  };
  sweep();
  const timer = setInterval(sweep, opts.healthEveryMs);
  try {
    for (let round = 1; round <= opts.rounds; round++) {
      const responder = new AgentResponder({
        agentUrl: opts.agentUrl,
        secret: opts.agentSecret,
        grantSecret: opts.grantSecret,
        handleHash: randomBytes(32).toString("hex"),
        fallback: NO_FALLBACK,
        fetchFn,
      });
      const history: { role: "person" | "mano"; text: string }[] = [];
      for (const [i, turn] of SPEED_TURNS.entries()) {
        const started = performance.now();
        let reply = "";
        try {
          const result = await responder.respond({
            texts: [turn.text],
            attachmentCount: 0,
            history: [...history],
            turnKey: { generation: 0, turn: i + 1 },
            receivedAtMs: Date.now(),
          });
          reply = result.text.trim();
        } catch {
          // Counted as an error below.
        }
        const sample: TurnSample = { kind: turn.kind, round, ms: Math.round(performance.now() - started), answered: reply.length > 0 };
        turns.push(sample);
        opts.onTurn?.(sample);
        history.push({ role: "person", text: turn.text }, { role: "mano", text: reply });
        if (round < opts.rounds || i < SPEED_TURNS.length - 1) await sleep(opts.gapMs);
      }
    }
  } finally {
    clearInterval(timer);
  }
  sweep();
  await Promise.all(pending);
  return { turns, health };
}
