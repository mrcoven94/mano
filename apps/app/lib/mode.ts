// Engine selection, with no silent stand-in. A configured engine URL
// always wins; otherwise the stand-in runs only with the explicit demo
// flag. Anything else fails at start instead of demoing by accident.

export type EngineDecision = { mode: "live" } | { mode: "stand-in" } | { error: "missing-engine" };

export function decideEngineMode(opts: { engineUrl: string | null; demo: boolean }): EngineDecision {
  if (opts.engineUrl) return { mode: "live" };
  if (opts.demo) return { mode: "stand-in" };
  return { error: "missing-engine" };
}
