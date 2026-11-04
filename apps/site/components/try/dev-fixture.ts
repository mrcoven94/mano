import type { TryEvent, TryLogged } from "@mano/protocol";

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
  [1200, { kind: "model", model: "muse-glimmer-30b", where: "Our GPU on Modal", purpose: "Guardian checks the action", ms: 4410, status: "200", state: "live" }],
  [200, { kind: "guardian", verdict: "pass", ms: 4430 }],
  [500, { kind: "reply", text: "I filled out your renewal. It is ready for your yes." }],
  [400, { kind: "question", text: "Send your food benefits renewal to the practice portal, not a real office? Reply YES or NO." }],
];
const AFTER_YES: [number, TryEvent][] = [
  [200, { kind: "sent", text: "YES" }],
  [1500, { kind: "model", model: "muse-glimmer-30b", where: "Our GPU on Modal", purpose: "Guardian checks the action", ms: 4120, status: "200", state: "live" }],
  [200, { kind: "guardian", verdict: "pass", ms: 4140 }],
  [800, { kind: "reply", text: "Done. Sent: Food benefits renewal. Confirmation SR-DEVFIXTURE." }],
  [200, { kind: "filed", confirmation: "SR-DEVFIXTURE" }],
  [200, { kind: "outcome", ok: true, text: "Filed on the sandbox portal after Maria's yes." }],
];

const log = (steps: [number, TryEvent][], startSeq: number): TryLogged[] => {
  let at = Date.now();
  return steps.map(([gap, e], i) => ({ ...e, seq: startSeq + i, at: (at += gap) }));
};

export const devBeforeYes = () => log(STEPS, 1);
export const devAfterYes = () => log(AFTER_YES, STEPS.length + 1);
