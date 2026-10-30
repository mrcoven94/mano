// Holds one prepared filing for the person's yes. The draft goes to
// Engine only, which freezes the exact request, hashes it (with the
// document's bytes) and holds it pending. The turn's reply then carries
// the question rendered from that frozen request; once Channels reports
// it reached the person word for word, Engine's pointer makes it
// answerable. Nothing leaves Mano until the person texts YES to it.
import type { ToolContext } from "eve/tools";

import type { ActionProposal, EngineApproval, PersonEngine } from "./engine.js";
import { closeReplaced, presentsExactly, proposalKey, renderQuestion } from "./pending.js";
import { placeClaimId } from "./reminders.js";

// Drafts from one message.
const MAX_DRAFTS = 5;

export type Draft = Omit<ActionProposal, "idempotencyKey">;

export type HoldResult =
  | { held: true; approval: EngineApproval; question: string }
  // Not held: why, for the model, as status plus a note or Engine's reason.
  | { held: false; status: string; note?: string; reason?: string };

function canonical(v: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
}

function sameDraft(a: EngineApproval, draft: Draft): boolean {
  try {
    const frozen = JSON.parse(a.requestJson) as { payload?: Record<string, unknown>; documentId?: string };
    return canonical(frozen.payload ?? {}) === canonical(draft.payload) && (frozen.documentId ?? null) === (draft.documentId ?? null);
  } catch {
    return false;
  }
}

export async function holdForYes(
  engine: PersonEngine,
  ctx: Pick<ToolContext, "session">,
  turn: { turnId: string; turnAtMs: number },
  draft: Draft,
): Promise<HoldResult> {
  const pointer = await engine.getPointer();
  if (pointer) {
    const answerable = await engine.approval(pointer.approvalId);
    if (answerable?.status === "approved") {
      return {
        held: false,
        status: "waiting_on_previous",
        note: "An earlier submission is still being confirmed. Do not prepare another; tell the person you are checking on the first one and they can reply YES to check.",
      };
    }
  }
  // This draft's place among the turn's drafts, claimed per attempt like
  // a reminder's: a replayed turn claims its places again from 0.
  const attempt = ctx.session.turn?.id ?? "attempt";
  let approval: EngineApproval | null = null;
  let outcome: { status: string; reason: string } | null = null;
  for (let place = 0; place < MAX_DRAFTS && !approval && !outcome; place++) {
    const key = proposalKey(engine.generation, turn.turnId, place);
    const claim = await engine.putTurn(placeClaimId(`draft:${turn.turnId}`, attempt, place), new Date(turn.turnAtMs).toISOString());
    const holder = (await engine.listApprovals()).find((a) => a.idempotencyKey === key) ?? null;
    if (!claim.created) {
      // Another call of this attempt holds this place, unless Eve re-ran
      // this call's step: then the draft there is this one.
      if (holder && sameDraft(holder, draft)) {
        if (holder.status === "pending") approval = holder;
        else outcome = { status: holder.status, reason: "This draft was already answered or closed." };
      }
      continue;
    }
    // A replay finds the approval its first attempt made: still waiting,
    // it is answered again; closed, nothing new is proposed.
    if (holder) {
      if (holder.status === "pending") approval = holder;
      else outcome = { status: holder.status, reason: "This draft was already answered or closed." };
      break;
    }
    const result = await engine.proposeAction({ ...draft, idempotencyKey: key }, turn.turnId);
    if (result.status === "needs_approval" && result.approval) approval = result.approval;
    else outcome = { status: result.status, reason: result.reason ?? "Engine did not hold it for approval." };
  }
  if (!approval) return { held: false, ...(outcome ?? { status: "blocked", reason: "Too many drafts in one message." }) };
  // One question waits at a time: Engine's latest proposal, the draft of
  // the newest turn. A slow turn whose draft lands after a newer turn's
  // is not the latest; Engine never approves it, and it is closed here.
  await closeReplaced(engine);
  const { pointer: shown, latest } = await engine.getPending();
  if (latest?.approvalId !== approval.id) {
    return {
      held: false,
      status: "superseded",
      note: "A newer request from the person is already waiting for their yes, so this draft was closed and nothing was sent. Say so in one short sentence.",
    };
  }
  const question = renderQuestion(approval);
  if (!presentsExactly(question)) {
    try {
      await engine.reject(approval.id);
    } catch {
      console.warn(JSON.stringify({ type: "mano_close_failed", count: 1 }));
    }
    return {
      held: false,
      status: "cannot_show_exactly",
      note: "This draft cannot be shown word for word over text, so it was not put to a yes and nothing was sent. Tell the person plainly, without repeating the details, and offer to help another way.",
    };
  }
  // An earlier question still pointed at can no longer be answered.
  if (shown && shown.approvalId !== approval.id) await engine.clearPointer(shown.approvalId);
  return { held: true, approval, question };
}

// Closes the conversation's newest proposal to this recipient when it
// came from an earlier turn, before a new version is prepared, so a
// correction that then fails leaves no older version answerable. Engine
// never approves any proposal but the newest, so that one is the only one
// to close. A proposal of this turn or a later one stays: a replayed or
// slow older turn never closes a newer draft. False when Engine did not
// close it, and then nothing new may be prepared.
export async function closeEarlier(engine: PersonEngine, turnId: string, recipient: string): Promise<boolean> {
  try {
    const { latest } = await engine.getPending();
    if (!latest || latest.turnId === turnId) return true;
    const mine = await engine.getTurn(turnId);
    if (!mine) return false;
    // Engine's order: the turn's first receive time, then its ID.
    const place = (receivedAt: string, id: string) => `${new Date(Date.parse(receivedAt)).toISOString()} ${id}`;
    if (place(latest.receivedAt, latest.turnId) >= place(mine.firstReceivedAt, turnId)) return true;
    const approval = await engine.approval(latest.approvalId);
    if (approval?.status !== "pending" || approval.recipient !== recipient) return true;
    return (await engine.reject(approval.id)).status === "rejected";
  } catch {
    console.warn(JSON.stringify({ type: "mano_close_failed" }));
    return false;
  }
}
