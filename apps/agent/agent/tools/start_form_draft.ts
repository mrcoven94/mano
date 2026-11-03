// Prepares a benefits renewal for the person's yes. The draft goes to
// Engine only, which freezes the exact request, hashes it with the proof
// document's bytes and holds it pending. The turn's reply then carries
// the question rendered from that frozen request; once Channels reports
// it reached the person word for word, Engine's pointer makes it
// answerable. Nothing leaves Mano until the person texts YES to it.
//
// The portal takes a renewal only with one document attached, so without
// a document on file that Engine says its executor could file (by kind
// and size), this asks for one and drafts nothing. The question names the
// attached document by its label, which the draft freezes, so the person
// sees what their yes sends.
import { defineTool } from "eve/tools";
import { z } from "zod";

import type { EngineDocument, PersonEngine } from "../lib/engine.js";
import { FORMS } from "../lib/forms.js";
import { ATTACHMENT } from "../lib/pending.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { holdForYes } from "../lib/propose.js";

const inputSchema = z.object({
  fullName: z.string().min(1).max(200),
  dateOfBirth: z.string().min(1).max(40),
  address: z.string().min(1).max(300),
  phone: z.string().min(1).max(40),
  householdSize: z.number().int().min(1).max(30),
  monthlyIncome: z.number().min(0),
});

const RENEWAL = FORMS["food-renewal"];

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
async function proofOnFile(engine: PersonEngine): Promise<{ proof: EngineDocument | null; newest: EngineDocument | null }> {
  const [profile, documents] = await Promise.all([engine.getProfile(), engine.listDocuments()]);
  const fileable = documents.filter((d) => d.filing === "fileable");
  const fromProfile = profile ? RENEWAL.proof.fromProfile(profile) : null;
  return { proof: fileable.find((d) => d.id === fromProfile) ?? fileable[0] ?? null, newest: documents[0] ?? null };
}

export default defineTool({
  description:
    "Prepare the person's benefits renewal with their household details, only when fill_form says it is unavailable. Call it once you have every field; ask for what is missing first. It either returns one question to ask (a photo to attach) or holds the exact version for the person's YES. It sends nothing.",
  inputSchema,
  label: {
    start: () => "Prepare the renewal",
  },
  async execute(input, ctx) {
    const turn = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Preparing forms is not available right now. Say so and offer to collect the answers.");
    const { proof, newest } = await proofOnFile(engine);
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
      payload: { ...input, [ATTACHMENT]: proof.label },
      documentId: proof.id,
    });
    if (!held.held) return { status: held.status, note: held.note, reason: held.reason, sent: false };
    return {
      approvalId: held.approval.id,
      status: "waiting_for_yes",
      sent: false,
      note: `The exact approval question goes to the person with your reply. Do not ask it yourself; say in one short sentence that it is ready for their yes, with ${proof.label} attached.`,
    };
  },
});
