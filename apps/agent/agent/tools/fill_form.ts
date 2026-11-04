// Fills out a form for the person. It reads their profile from Engine,
// asks for what is missing one question at a time, closes any earlier
// version still waiting for their YES, types the values into a fresh
// draft of the real form on the person's own computer, reads the draft
// back from the portal, and holds exactly what the portal saved in Engine
// for their YES, bound to its content hash and the document's bytes. The
// screens of the fill go to Engine with that approval, so the question
// links to a page that replays each step. It files nothing: on YES,
// Engine files it through the action gateway and the reply carries the
// confirmation number.
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";

import { fillDepsFromEnv, fillOnComputer, type FillDeps, type ReplayStep } from "../lib/computer-fill.js";
import { EngineError, type PersonEngine } from "../lib/engine.js";
import { FORMS, fillFrom, layoutOf, resolveForm, type FormSpec } from "../lib/forms.js";
import { keepAnswers } from "../lib/form-answers.js";
import { ATTACHMENT, DECLARATION } from "../lib/pending.js";
import { tracedFillDeps } from "../lib/try-trace.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { EARLIER_NOT_UPDATED_NOTE, EARLIER_UNRESOLVED_NOTE, NOT_CLOSED_NOTE, SHOWN_NOT_CLOSED_NOTE, closeEarlier, correcting, holdForYes, sameDraft, earlierFiling, type Draft } from "../lib/propose.js";

const inputSchema = z.object({
  form: z
    .string()
    .min(1)
    .max(500)
    .describe(`The form: one of ${Object.keys(FORMS).join(", ")}, or its address on the sandbox portal.`),
  answers: z
    .record(z.string(), z.string().max(300))
    .optional()
    .describe("Answers the person gave in this conversation, keyed by the field name a previous call asked about. Pass every answer so far on each call."),
});

// Test seam: tests drive the fill with a scripted computer and model.
let depsForTests: ((personId: string) => FillDeps | { unavailable: string }) | null = null;
export function setFillDepsForTests(factory: typeof depsForTests): void {
  depsForTests = factory;
}

// The approval already waits when the screens go up, so storing them
// never holds the turn's reply long.
const REPLAY_BIND_MS = 8_000;

// Binds the fill's screens to the approval it produced. The question
// works without them, so a failure is logged and nothing else changes.
async function shareReplay(engine: PersonEngine, approvalId: string, form: FormSpec, steps: ReplayStep[]): Promise<void> {
  if (steps.length === 0) return;
  try {
    const labels = { ...Object.fromEntries(form.fields.map((f) => [f.name, f.label])), [DECLARATION]: "Declaration only you can make" };
    if (!(await engine.bindReplay(approvalId, { labels, steps }, REPLAY_BIND_MS))) console.warn(JSON.stringify({ type: "mano_replay_refused" }));
  } catch (err) {
    console.warn(JSON.stringify({ type: "mano_replay_failed", status: err instanceof EngineError ? err.status : null }));
  }
}

// Ways a fill ends that say nothing about the form or what it saved.
const COMPUTER_STOPPED = new Set(["error", "deadline", "step_budget", "refused"]);

async function fillAndHold(input: z.infer<typeof inputSchema>, ctx: ToolContext) {
  const turn = requireTurn(ctx);
  const engine = personEngine(ctx);
  if (!engine) throw new Error("Filling forms is not available right now. Say so and offer to collect the answers.");
  const portalUrl = process.env.MANO_PORTAL_URL ?? null;
  const form = resolveForm(input.form, portalUrl);
  if (!form) {
    return { status: "unknown_form", sent: false, note: "Mano cannot fill that form yet. Say so plainly and offer to help another way." };
  }
  // A new version replaces the one shown, even when it only asks a
  // question first or cannot be filled here: a YES to the old one must not
  // file what was corrected.
  const earlier = await earlierFiling(engine, form.recipient);
  if (earlier === "checking") return { status: "earlier_filing_unresolved", sent: false, note: EARLIER_UNRESOLVED_NOTE };
  if (earlier === "failed") return { status: "fill_failed", sent: false, note: EARLIER_NOT_UPDATED_NOTE };
  if (!(await closeEarlier(engine, turn.turnId, form.recipient))) {
    return { status: "fill_failed", sent: false, note: SHOWN_NOT_CLOSED_NOTE };
  }
  if (!portalUrl) {
    return { status: "unavailable", sent: false, note: "Filling forms on Mano's computer is not set up here. Prepare the renewal with start_form_draft from the person's answers instead." };
  }
  // The proof document comes only from the profile, so without one the
  // form cannot be completed here.
  const profile = await engine.getProfile();
  if (!profile) {
    return { status: "unavailable", sent: false, note: "Mano cannot read this person's saved details yet. Prepare the renewal with start_form_draft from the person's answers instead." };
  }
  const filled = fillFrom(form, profile, input.answers ?? {});
  // Hearing that benefits are ending is not asking for a form. A renewal
  // starts from a document: with none on file and nothing answered yet, in
  // this call or saved from an earlier one, the model asks for the letter
  // instead of the form's first question.
  const starting = form === FORMS["food-renewal"] && Object.keys(filled.values).length === 0 && filled.invalid.length === 0 && !filled.documentId && filled.missing?.name !== "proof";
  if (starting && (await engine.listDocuments()).length === 0) {
    return {
      status: "needs_letter",
      sent: false,
      note: "No form was started. Ask for a photo of their letter, since it has the deadline and Mano reads it right away, and nothing else. If they have no letter, ask for a photo of their most recent pay stub.",
    };
  }
  await keepAnswers(engine, turn.turnId, form, profile, input.answers ?? {});
  const bad = filled.invalid[0];
  if (bad) {
    return { status: "needs_answer", field: bad.name, question: bad.question, sent: false, note: `That answer does not fit "${bad.label}". Ask this one question again, and nothing else.` };
  }
  // A renewal goes with the document the profile names, else the newest one
  // on file the portal takes, as start_form_draft attaches it.
  const onFile =
    filled.missing?.name === "proof" && form === FORMS["food-renewal"] ? ((await engine.listDocuments()).find((d) => d.filing === "fileable") ?? null) : null;
  if (filled.missing && !onFile) {
    const note =
      filled.missing.name === "proof"
        ? "The form needs a proof of income document and Mano has none on file yet. Ask this one question, and nothing else."
        : "Ask this one question, and nothing else. Then call fill_form again with the answer added under this field name.";
    return { status: "needs_answer", field: filled.missing.name, question: filled.missing.question, sent: false, note };
  }

  const deps = tracedFillDeps(depsForTests ? depsForTests(engine.personId) : fillDepsFromEnv(engine.personId), engine.personId);
  if ("unavailable" in deps) {
    console.warn(JSON.stringify({ type: "mano_fill_unavailable", reason: deps.unavailable }));
    return { status: "unavailable", sent: false, note: "Mano's computer is not available right now, so the form was not filled. Prepare the renewal with start_form_draft from the person's answers instead." };
  }
  const fill = await fillOnComputer(form, filled.values, portalUrl, deps, layoutOf(input.form, portalUrl));
  console.log(
    JSON.stringify({
      type: "mano_fill",
      status: fill.status,
      reason: "reason" in fill ? fill.reason : null,
      codes: "codes" in fill ? fill.codes : null,
      ms: fill.ms,
      steps: "steps" in fill ? fill.steps : 0,
    }),
  );
  if (fill.status === "rejected") {
    return { status: "form_refused", sent: false, formSays: fill.message, note: "The form refused these values. Tell the person what the form said in one sentence and ask the one question that fixes it." };
  }
  if (fill.status === "safety_check") {
    return {
      status: "needs_go_ahead",
      sent: false,
      note: "Mano's computer stopped before filling the form because it needs the person's go-ahead, so nothing was filled or sent. Say so in one short sentence. Do not ask them to reply YES: a yes cannot continue this fill yet.",
    };
  }
  if (fill.status !== "filled") {
    // The computer or its model stopped, which says nothing about the form,
    // so the renewal can still be prepared without them. Offering to try again
    // here can leave a person asking forever and never reach their yes.
    if (COMPUTER_STOPPED.has(fill.reason) && form === FORMS["food-renewal"]) {
      return { status: "unavailable", sent: false, note: "Mano's computer is not available right now, so the form was not filled. Prepare the renewal with start_form_draft from the person's answers instead." };
    }
    return { status: "fill_failed", sent: false, note: "Mano could not finish filling the form on its computer, so nothing was prepared or sent. Say so and offer to try again." };
  }

  const documentId = filled.documentId ?? onFile?.id;
  const draft: Draft = {
    type: "submit",
    recipient: form.recipient,
    purpose: form.purpose,
    payload: { ...fill.saved, [DECLARATION]: form.declaration, ...(onFile ? { [ATTACHMENT]: onFile.label } : {}) },
    // The safety check holds a document with no cited source against the draft.
    ...(documentId ? { documentId, sources: [{ kind: "document" as const, id: documentId }] } : {}),
  };
  const held = await holdForYes(engine, ctx, turn, draft);
  if (!held.held) return { status: held.status, note: held.note, reason: held.reason, sent: false };
  // A retried turn gets back the approval its first attempt froze. Only
  // screens of those same values may stand beside its question.
  if (sameDraft(held.approval, draft)) await shareReplay(engine, held.approval.id, form, fill.replay);
  return {
    status: "waiting_for_yes",
    approvalId: held.approval.id,
    filled: form.fields.map((f) => ({ field: f.label, value: fill.saved[f.name] })),
    sent: false,
    note: "The form is filled out on Mano's computer and the exact version goes to the person with your reply. In one short sentence, say you filled it out and it is ready for their yes. Do not repeat the fields or ask the question yourself.",
  };
}

export default defineTool({
  description:
    "Fill out a form for the person: their food benefits renewal (form food-renewal) or a form on the sandbox portal. Call it once they have sent their letter or ask you to fill out the form; saying benefits are ending is not asking. It returns either one question to ask (ask exactly that, then call again with their answer added to answers) or the filled form, which it holds for their YES. It sends nothing.",
  inputSchema,
  label: {
    start: () => "Fill out the form",
  },
  async execute(input, ctx) {
    const form = resolveForm(input.form, process.env.MANO_PORTAL_URL ?? null);
    const engine = personEngine(ctx);
    if (!form || !engine) return fillAndHold(input, ctx);
    const turnId = requireTurn(ctx).turnId;
    const out = await correcting(engine, turnId, form.recipient, () => fillAndHold(input, ctx));
    // The form and turn travel with the result: the turn's reply shows a
    // question only if this form's last call in this turn left one waiting.
    const stamp = { form: form.id, turn: turnId };
    if (out === "not_fenced") return { status: "fill_failed", sent: false, note: SHOWN_NOT_CLOSED_NOTE, ...stamp };
    return { ...(out ?? { status: "fill_failed", sent: false, note: NOT_CLOSED_NOTE }), ...stamp };
  },
});
