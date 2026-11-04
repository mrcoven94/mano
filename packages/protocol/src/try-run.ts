// The judge demo at withmano.com/try runs each press on a fresh synthetic
// handle. This prefix marks those handles, so the agent and Engine report a
// run's model calls and screens only for them, and no real person's turn
// costs even a lookup. A hashed phone number that happened to start this way
// finds no run and its report is dropped.
export const TRY_HANDLE_PREFIX = "7e57da7a";
export const isTryHandle = (handleHash: string): boolean => handleHash.startsWith(TRY_HANDLE_PREFIX);
export const isTryPerson = (personId: string): boolean => personId.startsWith(`handle-${TRY_HANDLE_PREFIX}`);

export const TRY_SCENARIOS = ["maria", "scam", "planted"] as const;
export type TryScenario = (typeof TRY_SCENARIOS)[number];

// live: a request went to that model. skipped: the path has no such call, so
// no request was made. stand-in: no model was involved at all.
export const TRY_CALL_STATES = ["live", "skipped", "stand-in"] as const;
export type TryCallState = (typeof TRY_CALL_STATES)[number];

// What one run shows, in the order it happened. The page renders only this
// log, live or from a recording.
export type TryEvent =
  | { kind: "sent"; letter?: string; text?: string }
  | { kind: "reply"; text: string }
  | { kind: "deadline"; dueDate: string; label: string }
  | { kind: "screen"; n: number }
  | { kind: "guardian"; verdict: string; ms: number; state: TryCallState }
  | { kind: "question"; text: string }
  | { kind: "filed"; confirmation: string }
  | { kind: "model"; model: string; where: string; purpose: string; ms: number; status: string; state: TryCallState }
  | { kind: "note"; text: string }
  | { kind: "outcome"; ok: boolean; text: string };

export type TryLogged = TryEvent & { seq: number; at: number };
