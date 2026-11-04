// Prepares a benefits renewal for the person's yes. The draft goes to
// Engine only, which freezes the exact request, hashes it with the proof
// document's bytes and holds it pending. The turn's reply then carries
// the question rendered from that frozen request; once Channels reports
// it reached the person word for word, Engine's pointer makes it
// answerable. Nothing leaves Mano until the person texts YES to it.
//
// Every value comes from the person's own answers or their profile,
// checked the way fill_form checks it. One that is missing or does not
// fit becomes one question, the most important first; nothing is guessed.
// A YES never files what the person has since corrected: a call from a
// later turn first closes the version already shown (or says plainly it
// still waits, when Engine will not close it); calls in one turn run one
// at a time, and one that holds no new version closes this turn's earlier
// drafts too. While a renewal the person already approved has no outcome
// yet, nothing new is prepared.
//
// The portal takes a renewal only with one document attached, so without
// a document on file that Engine says its executor could file (by kind
// and size), this asks for one and drafts nothing. The question names the
// attached document by its label, which the draft freezes, so the person
// sees what their yes sends.
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";

import type { EngineDocument, PersonEngine, Profile } from "../lib/engine.js";
import { FORMS, fillFrom } from "../lib/forms.js";
import { keepAnswers } from "../lib/form-answers.js";
import { ATTACHMENT, DECLARATION } from "../lib/pending.js";
import { personEngine, requireTurn, type TurnIdentity } from "../lib/person.js";
import { EARLIER_NOT_UPDATED_NOTE, EARLIER_UNRESOLVED_NOTE, NOT_CLOSED_NOTE, SHOWN_NOT_CLOSED_NOTE, closeEarlier, correcting, holdForYes, earlierFiling } from "../lib/propose.js";

const inputSchema = z.object({
  answers: z
    .record(z.string(), z.string().max(300))
    .optional()
    .describe("Answers the person gave in this conversation, keyed by the field name a previous call asked about. Pass every answer so far on each call."),
});

const RENEWAL = FORMS["food-renewal"];
const NO_PROFILE: Profile = { person: { address: {} }, household: [], income: [], programs: [] };

const PROOF_QUESTION = "Can you send me a photo of the letter about your renewal? It has to be attached to the renewal.";

// Why the newest document on file cannot go, said plainly with its label.
// One stored before Engine recorded sizes is simply asked for again.
function unfileableQuestion(newest: EngineDocument): string {
  const it = newest.label.charAt(0).toUpperCase() + newest.label.slice(1);
  switch (newest.filing) {
    case "too_large":
      return `${it} is too large for the renewal portal. Can you send a smaller photo or a screenshot of the letter?`;
    case "wrong_type":
      return `${it} is a kind of file the renewal portal does not take. Can you send a screenshot of the letter instead?`;
    default:
      return PROOF_QUESTION;
  }
}

// The renewal's proof among the person's documents, which Engine lists
// newest first: the one fill_form would attach (a profile value was read
// from it) if Engine could file it, else the newest it could file.
async function proofOnFile(engine: PersonEngine): Promise<{ proof: EngineDocument | null; newest: EngineDocument | null; profile: Profile | null }> {
  const [profile, documents] = await Promise.all([engine.getProfile(), engine.listDocuments()]);
  const fileable = documents.filter((d) => d.filing === "fileable");
  const fromProfile = profile ? RENEWAL.proof.fromProfile(profile) : null;
  return { proof: fileable.find((d) => d.id === fromProfile) ?? fileable[0] ?? null, newest: documents[0] ?? null, profile };
}

async function prepare(engine: PersonEngine, turn: TurnIdentity, ctx: ToolContext, answers: Record<string, string>) {
  const earlier = await earlierFiling(engine, RENEWAL.recipient);
  if (earlier === "checking") return { status: "earlier_filing_unresolved", sent: false, note: EARLIER_UNRESOLVED_NOTE };
  if (earlier === "failed") return { status: "draft_failed", sent: false, note: EARLIER_NOT_UPDATED_NOTE };
  if (!(await closeEarlier(engine, turn.turnId, RENEWAL.recipient))) {
    return { status: "draft_failed", sent: false, note: SHOWN_NOT_CLOSED_NOTE };
  }
  const { proof, newest, profile } = await proofOnFile(engine);
  const filled = fillFrom(RENEWAL, profile ?? NO_PROFILE, answers);
  if (profile) await keepAnswers(engine, turn.turnId, RENEWAL, profile, answers);
  const unfit = filled.invalid[0];
  if (unfit) {
    return { status: "needs_answer", field: unfit.name, question: unfit.question, sent: false, note: `That answer does not fit "${unfit.label}". Ask this one question again, and nothing else.` };
  }
  if (filled.missing && filled.missing.name !== "proof") {
    return {
      status: "needs_answer",
      field: filled.missing.name,
      question: filled.missing.question,
      sent: false,
      note: "Ask this one question, and nothing else. Then call start_form_draft again with the answer added under this field name.",
    };
  }
  if (!proof) {
    return {
      status: "needs_answer",
      field: "proof",
      question: newest ? unfileableQuestion(newest) : PROOF_QUESTION,
      sent: false,
      note: "The renewal needs one document attached and Mano has none on file the portal takes, so nothing was prepared. Ask this one question, and nothing else. Once they send it, call start_form_draft again with the same details.",
    };
  }
  const held = await holdForYes(engine, ctx, turn, {
    type: "submit",
    recipient: RENEWAL.recipient,
    purpose: RENEWAL.purpose,
    payload: { ...filled.values, [DECLARATION]: RENEWAL.declaration, [ATTACHMENT]: proof.label },
    documentId: proof.id,
    // The safety check holds a document with no cited source against the draft.
    sources: [{ kind: "document", id: proof.id }],
  });
  if (!held.held) return { status: held.status, note: held.note, reason: held.reason, sent: false };
  return {
    approvalId: held.approval.id,
    status: "waiting_for_yes",
    sent: false,
    note: `The exact approval question goes to the person with your reply. Do not ask it yourself; say in one short sentence that it is ready for their yes, with ${proof.label} attached.`,
  };
}

export default defineTool({
  description:
    "Prepare the person's benefits renewal, only when fill_form says it is unavailable. It either returns one question to ask (ask exactly that, then call again with their answer added to answers) or holds the exact version for the person's YES. It sends nothing.",
  inputSchema,
  label: {
    start: () => "Prepare the renewal",
  },
  async execute(input, ctx) {
    const turn = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Preparing forms is not available right now. Say so and offer to collect the answers.");
    const out = await correcting(engine, turn.turnId, RENEWAL.recipient, () => prepare(engine, turn, ctx, input.answers ?? {}));
    // The form and turn travel with the result: the turn's reply shows a
    // question only if this form's last call in this turn left one waiting.
    const stamp = { form: RENEWAL.id, turn: turn.turnId };
    if (out === "not_fenced") return { status: "draft_failed", sent: false, note: SHOWN_NOT_CLOSED_NOTE, ...stamp };
    return { ...(out ?? { status: "draft_failed", sent: false, note: NOT_CLOSED_NOTE }), ...stamp };
  },
});
