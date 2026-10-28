// Answer paths: the bench answers each case through the exact production
// prompts, tools and model client when those packages are merged, and through
// a stand-in otherwise. The report always says which path each suite used.
//
// Production contract (for Engine, Channels, Mail): export a `qualityAnswerPath`
// object with { name, answer(case) } from the package root. The bench imports
// it dynamically so quality/ never hard-depends on unmerged code.

import type { BenchCase, SuiteName } from "./suites/types.ts";

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
}

export interface AnswerPath {
  name: string;
  live: boolean;
  answer(c: BenchCase): Promise<BenchAnswer>;
}

// Stand-in that returns the reference answer. A green run on this path proves
// the checks accept good answers; it says nothing about the model.
export class ReferencePath implements AnswerPath {
  readonly name = "reference-standin";
  readonly live = false;

  async answer(c: BenchCase): Promise<BenchAnswer> {
    const start = Date.now();
    return {
      text: c.reference,
      bubbles: c.referenceBubbles,
      actions: [],
      latencyMs: Date.now() - start,
      inputTokens: 10,
      outputTokens: 10,
    };
  }
}

// Stand-in that breaks every gate on purpose: an invented phone and link, a
// promise of approval, and an outside action. The smoke gate must fail on it.
export class BrokenPath implements AnswerPath {
  readonly name = "broken-standin";
  readonly live = false;

  async answer(c: BenchCase): Promise<BenchAnswer> {
    const start = Date.now();
    const poison = " You are approved, guaranteed. Call (555) 999-0000 or visit http://secure-login-benefits.example/verify-now to finish.";
    return {
      text: `${c.reference}${poison}`,
      bubbles: c.referenceBubbles ? [...c.referenceBubbles, poison] : undefined,
      actions: [{ kind: "outside-action", detail: "broken stand-in acts" }],
      latencyMs: Date.now() - start,
      inputTokens: 10,
      outputTokens: 10,
    };
  }
}

const PACKAGE_FOR_SUITE: Record<SuiteName, string> = {
  chat: "@mano/engine",
  text: "@mano/channels",
  letters: "@mano/mail",
  safety: "@mano/engine",
  "safety-holdout": "@mano/engine",
};

export interface LoadedPath {
  path: AnswerPath;
  standin: boolean;
  detail: string;
}

async function tryImportQualityPath(packageName: string): Promise<AnswerPath | null> {
  try {
    const mod = (await import(packageName)) as Record<string, unknown>;
    const candidate = mod.qualityAnswerPath as AnswerPath | undefined;
    if (candidate && typeof candidate.answer === "function") return candidate;
    return null;
  } catch {
    return null;
  }
}

export async function loadAnswerPath(suite: SuiteName, broken = false): Promise<LoadedPath> {
  // MANO_QUALITY_BROKEN=1 forces the breaking path, for the gate-failure demo.
  if (broken || process.env.MANO_QUALITY_BROKEN === "1") {
    return { path: new BrokenPath(), standin: true, detail: "breaking stand-in forced for the gate demo" };
  }
  const packageName = PACKAGE_FOR_SUITE[suite];
  const live = await tryImportQualityPath(packageName);
  if (live) return { path: live, standin: false, detail: `${packageName} qualityAnswerPath` };
  return { path: new ReferencePath(), standin: true, detail: `${packageName} is not merged yet; reference stand-in` };
}

export async function loadAllAnswerPaths(broken = false): Promise<Record<SuiteName, LoadedPath>> {
  const suites: SuiteName[] = ["chat", "text", "letters", "safety"];
  const entries = await Promise.all(suites.map(async (s) => [s, await loadAnswerPath(s, broken)] as const));
  return Object.fromEntries(entries) as Record<SuiteName, LoadedPath>;
}
