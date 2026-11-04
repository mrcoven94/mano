// Holds one prepared filing for the person's yes. The draft goes to
// Engine only, which freezes the exact request, hashes it (with the
// document's bytes) and holds it pending. The turn's reply then carries
// the question rendered from that frozen request; once Channels reports
// it reached the person word for word, Engine's pointer makes it
// answerable. Nothing leaves Mano until the person texts YES to it.
import type { ActionProposal, EngineApproval, PersonEngine } from "./engine.js";
import { closeReplaced, holdBack, presentsExactly, proposalKey, proposalsOf, renderQuestion, waitingFrom } from "./pending.js";
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

// True when the approval froze exactly this draft's values and document.
export function sameDraft(a: EngineApproval, draft: Draft): boolean {
  try {
    const frozen = JSON.parse(a.requestJson) as { payload?: Record<string, unknown>; documentId?: string };
    return canonical(frozen.payload ?? {}) === canonical(draft.payload) && (frozen.documentId ?? null) === (draft.documentId ?? null);
  } catch {
    return false;
  }
}

export async function holdForYes(
  engine: PersonEngine,
  ctx: { session: { turn?: { id: string } | null } },
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
    // A replay finds the approval its first attempt made. The same content:
    // still waiting, it is answered again; closed, nothing new is proposed.
    // Different content was replaced by this call: it is closed, or held
    // back if Engine will not close it, and the new version takes the next
    // place, so an old value is never shown for a corrected one.
    if (holder) {
      if (sameDraft(holder, draft)) {
        if (holder.status === "pending") approval = holder;
        else outcome = { status: holder.status, reason: "This draft was already answered or closed." };
        break;
      }
      if (holder.status === "pending" && !(await rejected(engine, holder.id))) {
        holdBack({ approvalId: holder.id });
        console.warn(JSON.stringify({ type: "mano_close_failed", count: 1 }));
        return { held: false, status: "not_closed", note: NOT_CLOSED_NOTE };
      }
      continue;
    }
    const result = await engine.proposeAction({ ...draft, idempotencyKey: key }, turn.turnId);
    if (result.status === "needs_approval" && result.approval) approval = result.approval;
    else outcome = { status: result.status, reason: result.reason ?? "Engine did not hold it for approval." };
  }
  if (!approval) return { held: false, ...(outcome ?? { status: "blocked", reason: "Too many drafts in one message." }) };
  // One question waits at a time: Engine's latest proposal, the draft of
  // the newest turn. A slow turn whose draft lands after a newer turn's
  // is not the latest; Engine never approves it, and it is closed here.
  // Closing changes only approval statuses, never the pointer or the
  // latest proposal, so both run at once.
  const [, { pointer: shown, latest }] = await Promise.all([closeReplaced(engine), engine.getPending()]);
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
    return await rejected(engine, approval.id);
  } catch {
    console.warn(JSON.stringify({ type: "mano_close_failed" }));
    return false;
  }
}

// Closes this turn's own drafts to the recipient that still wait. A later
// call in the same turn that asks a question instead of holding a new
// version leaves none of them for the reply to show, so a YES never files
// what the person just corrected. closeEarlier leaves this turn's drafts
// alone, since a replayed call must find its own. Fails closed: a draft
// Engine does not confirm closed, after one retry, is held back so the
// reply never shows it, and when Engine cannot list them at all the whole
// turn's drafts are. False tells the tool to say nothing will be sent.
export async function closeThisTurn(engine: PersonEngine, turnId: string, recipient: string): Promise<boolean> {
  return closeDrafts(engine, turnId, await waitingIds(engine, turnId, recipient));
}

// This turn's drafts to the recipient that still wait, or null when
// Engine could not list them.
async function waitingIds(engine: PersonEngine, turnId: string, recipient: string): Promise<string[] | null> {
  try {
    return waitingFrom(await engine.listApprovals(), engine.generation, turnId)
      .filter((a) => a.recipient === recipient)
      .map((a) => a.id);
  } catch {
    return null;
  }
}

async function closeDrafts(engine: PersonEngine, turnId: string, ids: string[] | null): Promise<boolean> {
  if (ids === null) {
    holdBack({ turnId });
    console.warn(JSON.stringify({ type: "mano_close_failed" }));
    return false;
  }
  let closed = true;
  for (const id of ids) {
    if (await rejected(engine, id)) continue;
    holdBack({ approvalId: id });
    console.warn(JSON.stringify({ type: "mano_close_failed", count: 1 }));
    closed = false;
  }
  return closed;
}

// Runs one call that may prepare a new version of a form. However it ends
// without holding one (a question, an error result, or a throw), this
// turn's earlier drafts for the form are closed or held back before it
// returns, so the reply never shows the version it was correcting. On a
// throw that is the drafts waiting when the call began, since one it held
// before failing is its own new version; when they could not be listed,
// the whole turn's drafts are held back. A throw still throws. Null: a
// draft could not be confirmed closed, so the caller says nothing will be
// sent.
// Calls within one turn run one at a time, so a slower earlier call never
// holds its draft after a later correction has closed the turn's drafts.
// Each call first fences the form in Engine for its turn, durably, before
// it asks anything: a draft from an older turn still running elsewhere is
// then refused, so it can never become the latest after this correction.
// "not_fenced" when Engine could not record that; nothing is prepared.
export async function correcting<T extends { status: string }>(
  engine: PersonEngine,
  turnId: string,
  recipient: string,
  run: () => Promise<T>,
): Promise<T | null | "not_fenced"> {
  return oneAtATime(turnId, () => correctingNow(engine, turnId, recipient, run));
}

async function correctingNow<T extends { status: string }>(
  engine: PersonEngine,
  turnId: string,
  recipient: string,
  run: () => Promise<T>,
): Promise<T | null | "not_fenced"> {
  try {
    await engine.fence(recipient, turnId);
  } catch {
    // Every exit that holds no new version cleans up: this turn's earlier
    // drafts for the form are closed, or held back so the reply never
    // shows them.
    console.warn(JSON.stringify({ type: "mano_fence_failed" }));
    await closeThisTurn(engine, turnId, recipient);
    return "not_fenced";
  }
  const earlier = await waitingIds(engine, turnId, recipient);
  let out: T;
  try {
    out = await run();
  } catch (err) {
    await closeDrafts(engine, turnId, earlier);
    throw err;
  }
  if (out.status === "waiting_for_yes") return out;
  return (await closeThisTurn(engine, turnId, recipient)) ? out : null;
}

// The form calls of each turn still running in this process, chained.
const TURN_QUEUES = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(turnId: string, run: () => Promise<T>): Promise<T> {
  const mine = (TURN_QUEUES.get(turnId) ?? Promise.resolve()).then(run, run);
  const tail = mine.then(
    () => undefined,
    () => undefined,
  );
  TURN_QUEUES.set(turnId, tail);
  try {
    return await mine;
  } finally {
    if (TURN_QUEUES.get(turnId) === tail) TURN_QUEUES.delete(turnId);
  }
}

async function rejected(engine: PersonEngine, approvalId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if ((await engine.reject(approvalId)).status === "rejected") return true;
    } catch {
      // Answered below by the retry, or by holding the draft back.
    }
  }
  return false;
}

// What the model is told when a corrected draft could not be closed.
export const NOT_CLOSED_NOTE =
  "Mano could not set aside the version it prepared earlier in this message, so it will not show it and nothing will be sent. Tell the person plainly that you could not update the renewal just now, that nothing was sent, and to ask again in a moment.";

// What the model is told when the version the person was shown in an
// earlier message could not be closed. It still waits, so a YES to it
// would send it unchanged; the next form call tries to close it again.
export const SHOWN_NOT_CLOSED_NOTE =
  "Mano could not set aside the version the person was already shown, so nothing new was prepared. Tell them plainly that the earlier version is still waiting, that a YES would send it as it was, and that they should send their correction again in a moment.";

// What the model is told while an earlier approved filing is unresolved.
export const EARLIER_UNRESOLVED_NOTE =
  "The renewal the person already approved is still being checked with the office, so nothing new was prepared. Tell them plainly that their earlier renewal is still being checked with the office, that it will not be sent twice, and that they can change it once it settles. Do not ask for anything else now.";

// What the model is told when an earlier approved filing could not be retired.
export const EARLIER_NOT_UPDATED_NOTE =
  "Mano could not update the renewal the person approved earlier, so nothing new was prepared. Tell them plainly that their earlier renewal could not be updated yet, that nothing new was prepared, and to try again in a moment.";

// Before any new version of a form, the person's approved filings to the
// same recipient that have no receipt are settled:
// - one still unanswered or in flight: "checking", nothing new is prepared;
// - one that failed: retired in Engine, so it is never run again, however
//   the person's correction then ends (even as a question);
// - once all are settled (filed, retired or failed), a pointer to the
//   question of any of them is cleared;
// - "failed" when Engine could not be asked or would not retire it; the
//   caller prepares nothing.
export async function earlierFiling(engine: PersonEngine, recipient: string): Promise<"clear" | "checking" | "failed"> {
  try {
    const filings = proposalsOf(await engine.listApprovals(), engine.generation).filter(
      (a) => a.recipient === recipient && (a.status === "approved" || a.status === "retired"),
    );
    // A receipt is read first: that filing went through and is settled.
    const open = filings.filter((a) => a.status === "approved" && !a.outcome?.receipt);
    if (open.some((a) => a.outcome?.attempt !== "failed")) return "checking";
    for (const a of open) {
      const out = await engine.retire(a.id);
      if (out.status === "in_progress") return "checking";
      // Completed: it went through after all, and stands.
      if (out.status !== "rejected" && out.status !== "completed") return "failed";
    }
    // Every filing to this form is settled now (filed, retired or failed),
    // so a question still pointing at one no longer waits on a YES: cleared,
    // the correction goes ahead as a new filing.
    const { pointer } = await engine.getPending();
    if (pointer && filings.some((a) => a.id === pointer.approvalId)) await engine.clearPointer(pointer.approvalId);
    return "clear";
  } catch {
    console.warn(JSON.stringify({ type: "mano_earlier_filing_unknown" }));
    return "failed";
  }
}
