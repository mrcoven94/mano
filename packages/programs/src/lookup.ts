import { CATALOG } from "./catalog.js";
import type { ProgramEntry, ProgramId, StateCode } from "./types.js";
import { PROGRAMS, STATES } from "./types.js";

const STATE_NAMES: Record<StateCode, string[]> = {
  CA: ["california"],
  TX: ["texas"],
  NY: ["new york", "nueva york"],
  FL: ["florida"],
  IL: ["illinois"],
  WA: ["washington", "washington state"],
  AZ: ["arizona"],
  OH: ["ohio"],
};

// Common names a person or the model uses for each program. The state's own
// names (CalFresh, Medi-Cal, CEAP) also match through the catalog itself.
const PROGRAM_NAMES: Record<ProgramId, string[]> = {
  snap: ["snap", "food stamps", "food stamp", "food assistance", "food benefits", "food help", "nutrition assistance", "basic food", "cupones de alimentos", "estampillas de comida"],
  medicaid: ["medicaid", "medical assistance", "health coverage", "medicaid health coverage"],
  liheap: ["liheap", "heap", "ceap", "energy assistance", "energy help", "utility help", "help with utility bills", "home energy assistance"],
};

const norm = (s: string) => s.toLowerCase().normalize("NFC").replace(/[^a-z0-9ñ]+/g, " ").trim();

export function parseState(input: string): StateCode | null {
  const s = norm(input);
  return STATES.find((code) => s === code.toLowerCase() || STATE_NAMES[code].includes(s)) ?? null;
}

function aliasesOf(entry: ProgramEntry): string[] {
  const name = entry.name?.value ?? "";
  // "Comprehensive Energy Assistance Program (CEAP)" answers to both its
  // long name and the short one in parentheses.
  const short = name.match(/\(([^)]+)\)/)?.[1];
  return [name, name.replace(/\s*\([^)]*\)/, ""), ...(short ? [short] : [])].map(norm).filter(Boolean);
}

export function parseProgram(input: string, state: StateCode): ProgramId | null {
  const s = norm(input);
  return PROGRAMS.find((p) => PROGRAM_NAMES[p].includes(s) || aliasesOf(CATALOG[state].programs[p]).includes(s)) ?? null;
}

// One program in one state, by code or name for either. Null when the
// catalog does not have it: the caller says so, never guesses.
export function lookupProgram(query: { state: string; program: string }): ProgramEntry | null {
  const state = parseState(query.state);
  if (!state) return null;
  const program = parseProgram(query.program, state);
  return program ? CATALOG[state].programs[program] : null;
}

export function listPrograms(state: string): ProgramEntry[] {
  const code = parseState(state);
  return code ? PROGRAMS.map((p) => CATALOG[code].programs[p]) : [];
}
