import type { TryLogged, TryScenario } from "@mano/protocol";

/* The checklist beside a run. Each scenario lays out the checks it will face before anything runs, and each check
   is settled only by an event from the run's log. A check no event settled says it did not run. Model calls are
   placed under the check they worked for. Pure, so the page can rebuild it on every event. */

export type CheckState = "waiting" | "active" | "pass" | "stop" | "warn" | "attack" | "skipped";
type Model = Extract<TryLogged, { kind: "model" }>;
type Settled = { state: CheckState; detail?: string; problems?: string[]; seq: number };

type Key = "read" | "date" | "fill" | "guard" | "ask" | "tamper" | "yes" | "guard2" | "file" | "refuse" | "answer" | "nothing";

export type Check = { key: Key; title: string; state: CheckState; detail?: string; problems?: string[]; calls: Model[] };

export type Outcome = { ok: boolean; text: string; confirmation?: string };

const TITLES: Record<Key, string> = {
  read: "Read the letter",
  date: "Hold the deadline",
  fill: "Fill the renewal on the portal",
  guard: "Guardian checks the filing",
  ask: "Ask Maria yes or no",
  tamper: "The demo changes the document",
  yes: "Maria says yes",
  guard2: "Guardian checks again at the yes",
  file: "File on the portal",
  refuse: "Refuse the yes on a changed document",
  answer: "Answer Maria",
  nothing: "File nothing, send nothing",
};

const FILING: Key[] = ["read", "date", "fill", "guard", "ask", "yes", "guard2", "file"];
const ANSWER: Key[] = ["read", "answer", "nothing"];
const PLANS: Record<TryScenario, Key[]> = {
  maria: FILING,
  scramble: FILING,
  changed: ["read", "date", "fill", "guard", "ask", "tamper", "yes", "guard2", "refuse"],
  scam: ANSWER,
  planted: ANSWER,
  stub: ANSWER,
  bill: ANSWER,
  wrong: ANSWER,
  blurry: ANSWER,
  datecheck: ANSWER,
};
/* Hidden when nothing settled them, since a run may never need them. */
const OPTIONAL = new Set<Key>(["guard2"]);

const GUARDIAN = /guardian/i;
export const OK_STATUS = new Set(["ok", "200", "completed"]);
const READING = /read/i;
const NO_DATE = /did not hold a date/i;
const NOT_FILLED = /did not fill/i;
const CHANGED = /changed one byte/i;
const SAM = /^sam-/i;
const PRECISION = /-FP8.*$/i;
const ACTIVE_PARAMS = /-A\d+B$/i;
const DASHES = /-/g;
const isGuardianCall = (e: Model) => GUARDIAN.test(e.purpose);
const dateWords = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

function verdict(e: Extract<TryLogged, { kind: "guardian" }>): Omit<Settled, "seq"> {
  const standIn = e.state === "stand-in";
  if (e.verdict === "pass") return { state: standIn ? "warn" : "pass", detail: standIn ? "A stand-in for Guardian passed it" : "Pass", problems: e.problems };
  if (e.verdict === "block") return { state: "stop", detail: standIn ? "A stand-in for Guardian blocked it" : "Blocked", problems: e.problems };
  return { state: "warn", detail: `${standIn ? "A stand-in for Guardian" : "Guardian"} said ${e.verdict}`, problems: e.problems };
}

/* What one event settles for one check, given the checks already settled. */
function settle(key: Key, e: TryLogged, done: Map<Key, Settled>, scenario: TryScenario): Omit<Settled, "seq"> | null {
  switch (key) {
    case "read":
      // state says where a call ran, not whether it worked; the status says that.
      if (e.kind === "model" && READING.test(e.purpose) && e.state !== "skipped") {
        if (e.state === "stand-in") return { state: "warn", detail: "A stand-in read it" };
        return OK_STATUS.has(e.status) ? { state: "pass" } : { state: "stop", detail: `The reading call ended with ${e.status}` };
      }
      // A reply alone is no proof of a reading: Mano also replies to say it could not read the page.
      return null;
    case "date":
      if (e.kind === "deadline") return { state: "pass", detail: `Holding ${dateWords(e.dueDate)}` };
      if (e.kind === "note" && NO_DATE.test(e.text)) return { state: "warn", detail: "No date held from this letter" };
      return null;
    case "fill":
      if (e.kind !== "fill") return null;
      if (e.newLayout) return { state: "pass", detail: "Filled a layout the portal built for this run alone" };
      if (scenario === "scramble" || NOT_FILLED.test(e.text)) return { state: "warn", detail: e.text };
      return { state: "pass", detail: "The portal saved what Mano will file" };
    case "guard":
    case "guard2":
      return e.kind === "guardian" ? verdict(e) : null;
    case "ask":
      return e.kind === "question" ? { state: "pass", detail: "Her yes covers this exact document and nothing else" } : null;
    case "tamper":
      return e.kind === "note" && CHANGED.test(e.text) ? { state: "attack", detail: "One byte changed after Maria saw the question" } : null;
    case "yes":
      return e.kind === "sent" && e.text?.trim().toUpperCase() === "YES" ? { state: "pass", detail: "Maria pressed YES" } : null;
    case "file":
      if (e.kind === "filed") return { state: "pass", detail: `Confirmation ${e.confirmation}` };
      if (e.kind === "outcome") return { state: e.ok ? "pass" : "stop", detail: e.text };
      return null;
    case "refuse":
      if (e.kind === "filed") return { state: "stop", detail: `It filed anyway: ${e.confirmation}` };
      if (e.kind === "outcome") return { state: e.ok ? "pass" : "stop", detail: e.ok ? "Engine refused the stale yes. Nothing was filed." : e.text };
      return null;
    case "answer":
      return e.kind === "reply" ? { state: "pass" } : null;
    case "nothing":
      return e.kind === "outcome" ? { state: e.ok ? "pass" : "stop", detail: e.text } : null;
  }
}

/* "idle" lays the plan out, "live" marks the first open check as running, "ended" says which never ran. */
export function buildChecks(scenario: TryScenario, events: TryLogged[], mode: "idle" | "live" | "ended"): { checks: Check[]; outcome: Outcome | null } {
  const base = PLANS[scenario];
  // A plan with no Guardian row still shows a verdict its run logged, before its last check.
  const plan: Key[] = base.includes("guard") || !events.some((e) => e.kind === "guardian") ? base : [...base.slice(0, -1), "guard", base[base.length - 1]!];
  const done = new Map<Key, Settled>();
  let outcome: Outcome | null = null;
  let confirmation: string | undefined;

  for (const e of events) {
    if (e.kind === "filed") confirmation = e.confirmation;
    if (e.kind === "outcome") outcome = { ok: e.ok, text: e.text, confirmation };
    // A verdict belongs to the check before or after Maria's yes, and a later verdict (a retry after warming)
    // replaces an earlier one there.
    if (e.kind === "guardian") {
      const key: Key = done.has("yes") && plan.includes("guard2") ? "guard2" : "guard";
      if (plan.includes(key)) done.set(key, { ...verdict(e), seq: e.seq });
      continue;
    }
    for (const key of plan) {
      // The last reading call says how the reading went, so a retry updates it either way.
      if (done.has(key) && !(key === "read" && e.kind === "model")) continue;
      const result = settle(key, e, done, scenario);
      if (!result) continue;
      done.set(key, { ...result, seq: e.seq });
    }
  }

  /* Each model call goes under the check it worked for: Guardian's under the check before or after Maria's yes, the
     others under the first check still open when the call finished. */
  const calls = new Map<Key, Model[]>(plan.map((k) => [k, []]));
  const yesAt = events.find((e) => e.kind === "sent" && e.text?.trim().toUpperCase() === "YES")?.seq ?? Infinity;
  const others = plan.filter((k) => k !== "guard" && k !== "guard2");
  for (const e of events) {
    if (e.kind !== "model") continue;
    let home: Key;
    if (isGuardianCall(e) && plan.includes("guard")) home = e.seq > yesAt && plan.includes("guard2") ? "guard2" : "guard";
    else home = others.find((k) => !done.has(k) || done.get(k)!.seq >= e.seq) ?? others[others.length - 1]!;
    calls.get(home)!.push(e);
  }

  const firstOpen = plan.find((k) => !done.has(k));
  const checks: Check[] = [];
  for (const key of plan) {
    const settled = done.get(key);
    const worked = calls.get(key)!;
    if (!settled && OPTIONAL.has(key) && mode === "ended" && worked.length === 0) continue;
    // Calls with no result logged: the check ran, and the page says its result is missing rather than hiding them.
    const unreported = !settled && mode === "ended" && worked.some((c) => c.state !== "skipped");
    const state: CheckState = settled ? settled.state : unreported ? "warn" : mode === "ended" ? "skipped" : mode === "live" && key === firstOpen ? "active" : "waiting";
    const detail = settled?.detail ?? (unreported ? "It ran, but no result was logged" : undefined);
    checks.push({ key, title: TITLES[key], state, detail, problems: settled?.problems, calls: worked });
  }
  return { checks, outcome };
}

/* A model ID as a person reads it; the full ID stays on hover. */
export function modelName(id: string): string {
  const base = id.split("/").pop() ?? id;
  if (SAM.test(base)) return base.replace(SAM, "SAM ");
  return base.replace(PRECISION, "").replace(ACTIVE_PARAMS, "").replace(DASHES, " ");
}
