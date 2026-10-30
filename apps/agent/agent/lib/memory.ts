// Person memory: durable facts Mano remembers across turns (household,
// county, deadlines, what the person asked for). Engine owns it, on the
// person's own record; the agent reads it at the start of each turn and
// writes through the remember and forget tools. Nothing is cached here.
import type { PersonEngine } from "./engine.js";

export const MAX_RECALLED_FACTS = 50;
export const MAX_FACT_CHARS = 500;

export function normalizeFact(fact: string): string {
  return fact.trim().replace(/\s+/g, " ").slice(0, MAX_FACT_CHARS);
}

function sameFact(a: string, b: string): boolean {
  return normalizeFact(a).toLowerCase() === normalizeFact(b).toLowerCase();
}

export async function recallFacts(engine: PersonEngine): Promise<string[]> {
  const rows = await engine.listMemory();
  return rows.map((r) => r.content).slice(-MAX_RECALLED_FACTS);
}

// The time left before deadlineAt for one Engine call, or null when too
// little is left to start one.
const MIN_CALL_MS = 1_500;
export function timeLeft(deadlineAt: number | undefined): number | null | undefined {
  if (deadlineAt === undefined) return undefined;
  const left = deadlineAt - Date.now();
  return left >= MIN_CALL_MS ? left : null;
}

// deadlineAt: when the caller's turn must be done. A call that does not
// fit is skipped, and the fact is not saved.
export async function rememberFact(engine: PersonEngine, fact: string, deadlineAt?: number): Promise<{ saved: boolean }> {
  const clean = normalizeFact(fact);
  if (!clean) return { saved: false };
  const listTime = timeLeft(deadlineAt);
  if (listTime === null) return { saved: false };
  const rows = await engine.listMemory(listTime);
  if (rows.some((r) => sameFact(r.content, clean))) return { saved: true };
  const addTime = timeLeft(deadlineAt);
  if (addTime === null) return { saved: false };
  await engine.addMemory(clean, addTime);
  return { saved: true };
}

export type ForgetOutcome = { removed: true } | { removed: false; reason: "not_found" };

export async function forgetFact(engine: PersonEngine, fact: string): Promise<ForgetOutcome> {
  const matches = (await engine.listMemory()).filter((r) => sameFact(r.content, fact));
  if (matches.length === 0) return { removed: false, reason: "not_found" };
  for (const row of matches) await engine.deleteMemory(row.id);
  return { removed: true };
}

// Renders the memory block the model sees at the start of each turn.
// Empty memory renders nothing, so new people pay no context for it.
export function renderMemory(facts: string[]): string | null {
  if (facts.length === 0) return null;
  return ["What you remember about this person:", ...facts.map((f) => `- ${f}`)].join("\n");
}
