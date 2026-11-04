// Answer paths: which code answers each bench case. Text cases go through the
// real text line (textline.ts: SparkResponder, Mano's persona and the send
// pipeline) on a Meta model whenever META_MODEL_API_KEY and
// MANO_MODEL_BENCH_ID are set. Letters and photos go through the mail reader
// (packages/mail qualityAnswerPath: readMail and the reply the text line sends)
// whenever META_MODEL_API_KEY is set. Without a key every case falls back to
// the reference stand-in. Every report names the path of every case.

import type { BenchCase } from "./suites/types.ts";

export interface BenchAction {
  kind: string;
  detail?: string;
}

export interface BenchAnswer {
  text: string;
  bubbles?: string[];
  actions: BenchAction[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  // Text line only: time to the first text the person sees, the route the
  // turn took, and the voice-guard rules that had to change the reply.
  firstTextMs?: number;
  route?: "fast" | "deep";
  guardChanges?: string[];
  // Everything else the person was sent on the way: heads-ups and earlier
  // turns' replies. Safety checks read these as well as the answer.
  earlier?: string[];
  // Through the agent path: whether the agent answered every turn, or the
  // plain fallback answered at least one.
  servedBy?: "agent" | "fallback" | "mixed" | "plain" | "worker";
}

export interface AnswerPath {
  name: string;
  live: boolean;
  // False when the path answers without the program catalog the case's facts
  // come from (the text line today). Checks that need the catalog do not run.
  knowsCatalog: boolean;
  answer(c: BenchCase): Promise<BenchAnswer>;
}

// Stand-in that returns the reference answer. A green run on this path proves
// the checks accept good answers; it says nothing about the model.
export class ReferencePath implements AnswerPath {
  readonly name = "reference-standin";
  readonly live = false;
  readonly knowsCatalog = true;

  async answer(c: BenchCase): Promise<BenchAnswer> {
    return { text: c.reference, bubbles: c.referenceBubbles, actions: [], latencyMs: 0, inputTokens: 10, outputTokens: 10 };
  }
}

// Stand-in that breaks every gate on purpose: an invented phone and link, a
// promise of approval, and an outside action. Used by the offline gate tests.
export class BrokenPath implements AnswerPath {
  readonly name = "broken-standin";
  readonly live = false;
  readonly knowsCatalog = true;

  async answer(c: BenchCase): Promise<BenchAnswer> {
    const poison = " You are approved, guaranteed. Call (555) 999-0000 or visit http://secure-login-benefits.example/verify-now to finish.";
    return {
      text: `${c.reference}${poison}`,
      bubbles: c.referenceBubbles ? [...c.referenceBubbles, poison] : undefined,
      actions: [{ kind: "outside-action", detail: "broken stand-in acts" }],
      latencyMs: 0,
      inputTokens: 10,
      outputTokens: 10,
    };
  }
}

// The exact text that is sent: the bubbles joined, or the plain text when the
// path sends no bubbles. Checks and judges read this, never a summary field.
export function sentText(answer: Pick<BenchAnswer, "text" | "bubbles">): string {
  return (answer.bubbles ?? [answer.text]).join("\n");
}

export interface LoadedPath {
  path: AnswerPath;
  standin: boolean;
  detail: string;
}

export interface PathSet {
  forCase(c: BenchCase): LoadedPath;
  textLineModel: string | null;
}

// A case whose answer depends on reading a letter or photo: the mail reader
// answers it, as it answers a photo texted to the line.
export function needsMailReader(c: BenchCase): boolean {
  return c.suite === "letters" || (c.input.images?.length ?? 0) > 0;
}

async function mailPath(env: NodeJS.ProcessEnv): Promise<LoadedPath> {
  if (!env.META_MODEL_API_KEY) {
    return { path: new ReferencePath(), standin: true, detail: "no META_MODEL_API_KEY; reference stand-in" };
  }
  try {
    const mod = (await import("@mano/mail" as string)) as { qualityAnswerPath?: AnswerPath };
    if (mod.qualityAnswerPath && typeof mod.qualityAnswerPath.answer === "function") {
      return { path: mod.qualityAnswerPath, standin: false, detail: "packages/mail qualityAnswerPath" };
    }
    return { path: new ReferencePath(), standin: true, detail: "packages/mail exports no qualityAnswerPath; reference stand-in" };
  } catch {
    return { path: new ReferencePath(), standin: true, detail: "packages/mail did not load; reference stand-in" };
  }
}

// Text cases through Mano's agent (agent.ts); letters and photos still go to
// the mail reader. Null when no agent is configured.
export async function loadAgentPaths(env: NodeJS.ProcessEnv = process.env): Promise<PathSet | null> {
  const { agentPathFromEnv } = await import("./agent.ts");
  const agent = agentPathFromEnv(env);
  if (!agent) return null;
  const mail = await mailPath(env);
  const loaded: LoadedPath = { path: agent, standin: false, detail: "Mano's agent, with the plain answer as its fallback, and the send pipeline" };
  return { forCase: (c) => (needsMailReader(c) ? mail : loaded), textLineModel: env.MANO_MODEL_BENCH_ID ?? null };
}

export async function loadPaths(env: NodeJS.ProcessEnv = process.env, broken = false): Promise<PathSet> {
  if (broken) {
    const forced: LoadedPath = { path: new BrokenPath(), standin: true, detail: "breaking stand-in forced for the gate test" };
    return { forCase: () => forced, textLineModel: null };
  }
  const mail = await mailPath(env);
  const { TextLinePath, textLineFromEnv } = await import("./textline.ts");
  const line = textLineFromEnv(env);
  const text: LoadedPath = line
    ? { path: new TextLinePath(line), standin: false, detail: "the text line: the production responder, persona voice and send pipeline" }
    : { path: new ReferencePath(), standin: true, detail: "no META_MODEL_API_KEY or MANO_MODEL_BENCH_ID; reference stand-in" };
  return { forCase: (c) => (needsMailReader(c) ? mail : text), textLineModel: line?.model ?? null };
}
