// Fills out a form for the person. It reads their profile from Engine,
// asks for what is missing one question at a time, types the values into
// the real form on the person's own computer, and holds the exact filled
// version in Engine for their YES, bound to its content hash and the
// document's bytes. It files nothing: on YES, Engine files it through the
// action gateway and the reply carries the confirmation number.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { fillDepsFromEnv, fillOnComputer, type FillDeps } from "../lib/computer-fill.js";
import { FORMS, fillFrom, resolveForm } from "../lib/forms.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { holdForYes } from "../lib/propose.js";

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

export default defineTool({
  description:
    "Fill out a form for the person: their food benefits renewal (form food-renewal) or a form on the sandbox portal. Call it as soon as they ask. It returns either one question to ask (ask exactly that, then call again with their answer added to answers) or the filled form, which it holds for their YES. It sends nothing.",
  inputSchema,
  label: {
    start: () => "Fill out the form",
  },
  async execute(input, ctx) {
    const turn = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Filling forms is not available right now. Say so and offer to collect the answers.");
    const portalUrl = process.env.MANO_PORTAL_URL ?? null;
    const form = resolveForm(input.form, portalUrl);
    if (!form) {
      return { status: "unknown_form", sent: false, note: "Mano cannot fill that form yet. Say so plainly and offer to help another way." };
    }
    if (!portalUrl) {
      return { status: "unavailable", sent: false, note: "Filling forms is not set up here. Say so and offer to collect the answers." };
    }
    const profile = await engine.getProfile();
    const filled = fillFrom(form, profile, input.answers ?? {});
    const bad = filled.invalid[0];
    if (bad) {
      return { status: "needs_answer", field: bad.name, question: bad.question, sent: false, note: `That answer does not fit "${bad.label}". Ask this one question again, and nothing else.` };
    }
    if (filled.missing) {
      const note =
        filled.missing.name === "proof"
          ? "The form needs a proof of income document and Mano has none on file yet. Ask this one question, and nothing else."
          : "Ask this one question, and nothing else. Then call fill_form again with the answer added under this field name.";
      return { status: "needs_answer", field: filled.missing.name, question: filled.missing.question, profileAvailable: profile !== null, sent: false, note };
    }

    const deps = depsForTests ? depsForTests(engine.personId) : fillDepsFromEnv(engine.personId);
    if ("unavailable" in deps) {
      console.warn(JSON.stringify({ type: "mano_fill_unavailable", reason: deps.unavailable }));
      return { status: "unavailable", sent: false, note: "Mano's computer is not available right now, so the form was not filled. Say so and offer to try again soon." };
    }
    const fill = await fillOnComputer(form, filled.values, portalUrl, deps);
    console.log(
      JSON.stringify({ type: "mano_fill", status: fill.status, reason: "reason" in fill ? fill.reason : null, ms: "ms" in fill ? fill.ms : 0, steps: "steps" in fill ? fill.steps : 0 }),
    );
    if (fill.status === "rejected") {
      return { status: "form_refused", sent: false, formSays: fill.message, note: "The form refused these values. Tell the person what the form said in one sentence and ask the one question that fixes it." };
    }
    if (fill.status !== "filled") {
      return { status: "fill_failed", sent: false, note: "Mano could not finish filling the form on its computer, so nothing was prepared or sent. Say so and offer to try again." };
    }

    const held = await holdForYes(engine, ctx, turn, {
      type: "submit",
      recipient: form.recipient,
      purpose: form.purpose,
      payload: filled.values,
      ...(filled.documentId ? { documentId: filled.documentId } : {}),
    });
    if (!held.held) return { status: held.status, note: held.note, reason: held.reason, sent: false };
    return {
      status: "waiting_for_yes",
      approvalId: held.approval.id,
      filled: form.fields.map((f) => ({ field: f.label, value: filled.values[f.name] })),
      sent: false,
      note: "The form is filled out on Mano's computer and the exact version goes to the person with your reply. In one short sentence, say you filled it out and it is ready for their yes. Do not repeat the fields or ask the question yourself.",
    };
  },
});
