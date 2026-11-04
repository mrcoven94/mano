import type { TryEvent, TryLogged, TryScenario } from "@mano/protocol";

/* Made-up responses for `next dev` with NEXT_PUBLIC_TRY_DEV_RECORDED=1, so the page can be built while the model
   account is down. Not a real run, and the page says so. A production build never loads this file. */
const STEPS: [gapMs: number, TryEvent][] = [
  [200, { kind: "sent", letter: "maria" }],
  [400, { kind: "model", model: "sam-3.1", where: "Not called", purpose: "Finding the letter in the photo", ms: 0, status: "skipped", state: "skipped" }],
  [1500, { kind: "model", model: "meta/muse-spark-open", where: "OpenRouter, zero retention", purpose: "Reading the letter", ms: 3120, status: "ok", state: "live" }],
  [500, { kind: "reply", text: "Your letter says “Your renewal is due November 14, 2026.” I'm holding November 14. I'll text you before it." }],
  [400, { kind: "deadline", dueDate: "2026-11-14", label: "Food benefits renewal" }],
  [600, { kind: "sent", text: "Please fill out my renewal now. Case number R-1042. Full legal name Maria Torres." }],
  [1400, { kind: "model", model: "meta/muse-spark-open", where: "OpenRouter, zero retention", purpose: "Mano's turn", ms: 1840, status: "ok", state: "live" }],
  [1000, { kind: "model", model: "meta/muse-spark-open", where: "OpenRouter, zero retention", purpose: "Mano's computer", ms: 2260, status: "completed", state: "live" }],
  [1200, { kind: "model", model: "RedHatAI/Muse-Glimmer-30B-FP8-block", where: "Our GPU on Modal", purpose: "Guardian checks the action", ms: 4410, status: "200", state: "live" }],
  [200, { kind: "guardian", verdict: "pass", ms: 4430, state: "live", problems: [] }],
  [500, { kind: "reply", text: "I filled out your renewal. It is ready for your yes." }],
  [400, { kind: "question", text: "Send your food benefits renewal to the practice portal, not a real office? Reply YES or NO." }],
];
const AFTER_YES: [number, TryEvent][] = [
  [200, { kind: "sent", text: "YES" }],
  [1500, { kind: "model", model: "RedHatAI/Muse-Glimmer-30B-FP8-block", where: "Our GPU on Modal", purpose: "Guardian checks the action", ms: 4120, status: "200", state: "live" }],
  [200, { kind: "guardian", verdict: "pass", ms: 4140, state: "live", problems: [] }],
  [800, { kind: "reply", text: "Done. Sent: Food benefits renewal. Confirmation SR-DEVFIXTURE." }],
  [200, { kind: "filed", confirmation: "SR-DEVFIXTURE" }],
  [200, { kind: "outcome", ok: true, text: "Filed on the sandbox portal after Maria's yes." }],
];

const CHANGED_AFTER_YES: [number, TryEvent][] = [
  [600, { kind: "note", text: "The demo changed one byte of the document Mano prepared, after Maria saw the question." }],
  [200, { kind: "sent", text: "YES" }],
  [1400, { kind: "reply", text: "That document changed after I asked you, so I did not send it. I will show you the new version first." }],
  [300, { kind: "outcome", ok: true, text: "Engine refused the yes because the document changed after the question. Nothing was filed." }],
];
const SCAM: [number, TryEvent][] = [
  [200, { kind: "sent", letter: "scam", text: "Is this real? Should I do what it says?" }],
  [400, { kind: "model", model: "sam-3.1", where: "Not called", purpose: "Finding the letter in the photo", ms: 0, status: "skipped", state: "skipped" }],
  [1800, { kind: "model", model: "meta/muse-spark-open", where: "OpenRouter, zero retention", purpose: "Reading the letter", ms: 6120, status: "ok", state: "live" }],
  [600, { kind: "reply", text: "Do not send your Social Security number or EBT PIN to that link. A benefits office never asks for your PIN. This looks like a scam." }],
  [500, { kind: "outcome", ok: true, text: "Filings: 0. Waiting for a yes: 0. Dates held: none." }],
];
const BLOCKED: [number, TryEvent][] = [
  ...STEPS.slice(0, 8),
  [1200, { kind: "model", model: "RedHatAI/Muse-Glimmer-30B-FP8-block", where: "Our GPU on Modal", purpose: "Guardian checks the action", ms: 3980, status: "200", state: "live" }],
  [200, { kind: "guardian", verdict: "block", ms: 4000, state: "live", problems: ["The form sends the renewal to an address that is not the office named on the letter."] }],
  [400, { kind: "outcome", ok: false, text: "Guardian blocked the filing, so nothing was sent." }],
];

const log = (steps: [number, TryEvent][], startSeq: number): TryLogged[] => {
  let at = Date.now();
  return steps.map(([gap, e], i) => ({ ...e, seq: startSeq + i, at: (at += gap) }));
};

/* `planted` plays a Guardian block, so the page's stopped state can be seen in dev. */
export function devBeforeYes(scenario: TryScenario): { events: TryLogged[]; asks: boolean } {
  if (scenario === "scam") return { events: log(SCAM, 1), asks: false };
  if (scenario === "planted") return { events: log(BLOCKED, 1), asks: false };
  return { events: log(STEPS, 1), asks: true };
}
export const devAfterYes = (scenario: TryScenario) => log(scenario === "changed" ? CHANGED_AFTER_YES : AFTER_YES, STEPS.length + 1);
