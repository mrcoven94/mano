// Person memory: durable facts Mano remembers across turns (household,
// county, deadlines, what the person asked for). Today this is an Eve
// session-state slot, read at the start of each turn through a dynamic
// instruction. When Engine (LAP-500) merges its person memory API, this
// module's store swaps to Engine's API behind the same interface and
// nothing else changes.
import { defineState } from "eve/context";

export interface PersonMemory {
  facts: string[];
  updatedAt: string | null;
}

export const initialPersonMemory = (): PersonMemory => ({ facts: [], updatedAt: null });

export const personMemory = defineState<PersonMemory>("mano.person", initialPersonMemory);

export const MAX_FACTS = 50;
export const MAX_FACT_CHARS = 500;

export function addFact(memory: PersonMemory, fact: string, now: string = new Date().toISOString()): PersonMemory {
  const clean = fact.trim().replace(/\s+/g, " ");
  if (!clean) return memory;
  const facts = memory.facts.filter((f) => f.toLowerCase() !== clean.toLowerCase());
  facts.push(clean.slice(0, MAX_FACT_CHARS));
  return { facts: facts.slice(-MAX_FACTS), updatedAt: now };
}

export function removeFact(memory: PersonMemory, fact: string, now: string = new Date().toISOString()): PersonMemory {
  const want = fact.trim().toLowerCase();
  const facts = memory.facts.filter((f) => f.toLowerCase() !== want);
  return facts.length === memory.facts.length ? memory : { facts, updatedAt: now };
}

// Renders the memory block the model sees at the start of each turn.
// Empty memory renders nothing, so new people pay no context for it.
export function renderMemory(memory: PersonMemory): string | null {
  if (memory.facts.length === 0) return null;
  return ["What you remember about this person:", ...memory.facts.map((f) => `- ${f}`)].join("\n");
}
