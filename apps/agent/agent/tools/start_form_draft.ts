// Prepares a benefits renewal for the person's yes. The draft goes to
// Engine only, which freezes the exact request, hashes it with the proof
// document's bytes and holds it pending. The turn's reply then carries
// the question rendered from that frozen request; once Channels reports
// it reached the person word for word, Engine's pointer makes it
// answerable. Nothing leaves Mano until the person texts YES to it.
//
// The portal takes a renewal only with one document attached, so without
// a proof document on file this asks for a photo and drafts nothing.
import { defineTool } from "eve/tools";
import { z } from "zod";

import type { PersonEngine } from "../lib/engine.js";
import { FORMS } from "../lib/forms.js";
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

// The renewal's proof: the document fill_form would attach (the one a
// profile value was read from), else the newest letter Mano read a
// deadline from. A texted photo is on file as a letter only once its
// deadline is saved; nothing else records which photo is which.
async function proofOnFile(engine: PersonEngine): Promise<string | null> {
  const [profile, deadlines] = await Promise.all([engine.getProfile(), engine.listDeadlines()]);
  const fromProfile = profile ? RENEWAL.proof.fromProfile(profile) : null;
  if (fromProfile) return fromProfile;
  let newest: { documentId: string; createdAt: string } | null = null;
  for (const d of deadlines ?? []) {
    const documentId = d.source.kind === "letter" ? d.source.documentId : undefined;
    if (documentId && (!newest || d.createdAt > newest.createdAt)) newest = { documentId, createdAt: d.createdAt };
  }
  return newest?.documentId ?? null;
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
    const documentId = await proofOnFile(engine);
    if (!documentId) {
      return {
        status: "needs_answer",
        field: "proof",
        question: PROOF_QUESTION,
        sent: false,
        note: "The renewal needs one document attached and Mano has none on file yet, so nothing was prepared. Ask this one question, and nothing else. Once Mano has read their photo, call start_form_draft again with the same details.",
      };
    }
    const held = await holdForYes(engine, ctx, turn, {
      type: "submit",
      recipient: RENEWAL.recipient,
      purpose: RENEWAL.purpose,
      payload: { ...input },
      documentId,
    });
    if (!held.held) return { status: held.status, note: held.note, reason: held.reason, sent: false };
    return {
      approvalId: held.approval.id,
      status: "waiting_for_yes",
      sent: false,
      note: "The exact approval question goes to the person with your reply. Do not ask it yourself; say in one short sentence that it is ready for their yes, with their document attached.",
    };
  },
});
