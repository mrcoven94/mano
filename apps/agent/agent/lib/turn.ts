// One synchronous turn from Channels, without the Eve wiring (which
// lives in channels/mano.ts and arrives here as runAgent).
//
// Order: authenticate the signed body, record the turn in Engine's
// ledger (which keeps the first receive time, so a retried turn derives
// the same reminder and timing), warm Guardian when a conversation
// starts, then either answer the approval question Engine holds as
// answerable or run the agent. A plain YES or NO to that question is the
// person's decision on that exact Engine approval and never goes to the
// model. When a turn proposes an action, its reply carries the question
// rendered from the request Engine froze, and the question travels on its
// own too so Channels can check it goes out word for word and report it.
// When the draft came from a fill, a line after the question links to the
// page that replays it, whenever the question is shown.
//
// A retried turn runs again: every mutation it makes is keyed by the turn
// (reminders, memory) or held by Engine (approvals), so a rerun converges
// instead of doing anything twice.
import { createHash } from "node:crypto";

import { createModelClient, type ModelClient } from "@mano/mail";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "./auth.js";
import { CRISIS_LINE, detectCrisis } from "./crisis.js";
import { profileContext } from "./profile.js";
import { parseDecision } from "./decision.js";
import { EngineError, type Engine, type EngineApproval, type EngineTurn, type PersonEngine } from "./engine.js";
import { LETTER_RULES, documentsContext, letterBlock, readTextedPhotos, type LetterReply, type TextedPhoto } from "./letters.js";
import { closeReplaced, isShare, presentable, presentationHash, proposalsOf, renderQuestion, replayLine, shareDone, waitingFrom, waitingProposals } from "./pending.js";
import { answerRequestWithPhoto } from "./sharing.js";
import type { HoldResult } from "./propose.js";
import { SettleTimeout, type SettleResult } from "./settle.js";
import { TurnClock } from "./timings.js";

const MAX_TEXTS = 10;
const MAX_TEXT_CHARS = 4000;
const MAX_PHOTOS = 10;
// One deadline for the whole turn (downloads, reading, deadline writes
// and the model), under Channels' 100-second wait for the agent.
export const TURN_BUDGET_MS = 95_000;
// Below this much time left after a reading, the reading is the reply.
const MODEL_MIN_MS = 15_000;
// The reading and its deadline writes end this long before the turn does.
const READ_MARGIN_MS = 3_000;
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,200}$/;
// Engine's identity rule for turn IDs.
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/;
// A person quiet this long is starting a new conversation.
const CONVERSATION_GAP_MS = 15 * 60_000;
// The replay link is optional; asking Engine for it never holds the reply long.
const REPLAY_LINK_MS = 5_000;

export interface AgentTurnInput {
  handleHash: string;
  turnId: string;
  turnAtMs: number;
  generation: number;
  grant: string;
  message: string;
  context: string[];
  // When the model must be done (epoch ms): the turn's one deadline,
  // under Channels' wait for the agent.
  deadlineMs: number;
  // Where the run records its own step timings (lib/timings.ts).
  timings: Record<string, number>;
}

export interface TurnDeps {
  secret: string | undefined;
  engine: Engine | null;
  runAgent(input: AgentTurnInput): Promise<SettleResult>;
  // Starts Guardian ahead of the conversation's first check; runs in the
  // background and never affects the turn.
  warmGuardian?: () => Promise<unknown>;
  background?: (work: Promise<unknown>) => void;
  now?: () => number;
  // Reads texted photos (SAM 3.1 and Muse Spark through @mano/mail), and
  // how long a reading may take before the turn says it could not finish.
  mailModel?: ModelClient;
  // The whole turn's budget from its arrival; under Channels' 100-second
  // wait. Default TURN_BUDGET_MS.
  turnBudgetMs?: number;
  // The model this deployment sends turns, letter reads and fills to. It goes
  // back to the signed caller for the record and never reaches the person.
  modelId?: string;
}

export interface TurnResponse {
  httpStatus: number;
  body: { status: string; text: string; reason?: string; approval?: string; approvalId?: string };
}

interface TurnBody {
  turnId: string;
  // When Channels received the person's message, from its own clock and
  // signed in the turn: what "before" and "after" mean for this turn.
  receivedAtMs: number;
  generation: number;
  grant: string;
  handleHash: string;
  texts: string[];
  // Photos the person sent; documents are the ones Channels stored in
  // Engine, by ID.
  attachmentCount: number;
  documents: TextedPhoto[];
  // The words came from a voice note, as Mano heard them.
  spoken: boolean;
}

function parseDocuments(value: unknown): TextedPhoto[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PHOTOS) return null;
  const out: TextedPhoto[] = [];
  for (const d of value) {
    const doc = d as { id?: unknown; mimeType?: unknown } | null;
    if (typeof doc?.id !== "string" || !DOCUMENT_ID.test(doc.id)) return null;
    if (typeof doc.mimeType !== "string" || doc.mimeType.length > 100) return null;
    out.push({ id: doc.id, mimeType: doc.mimeType });
  }
  return out;
}

function parseBody(value: unknown): TurnBody | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.turnId !== "string" || !TURN_ID.test(body.turnId)) return null;
  if (typeof body.receivedAt !== "number" || !Number.isFinite(body.receivedAt) || body.receivedAt <= 0) return null;
  if (typeof body.handleHash !== "string" || !/^[0-9a-f]{64}$/.test(body.handleHash)) return null;
  if (typeof body.generation !== "number" || !Number.isInteger(body.generation) || body.generation < 0) return null;
  if (typeof body.grant !== "string" || !body.grant || body.grant.length > 2000) return null;
  if (!Array.isArray(body.texts)) return null;
  const texts = body.texts.filter((t): t is string => typeof t === "string").slice(0, MAX_TEXTS);
  if (texts.some((t) => t.length > MAX_TEXT_CHARS)) return null;
  const attachmentCount =
    typeof body.attachmentCount === "number" && Number.isInteger(body.attachmentCount) && body.attachmentCount >= 0
      ? Math.min(body.attachmentCount, 10)
      : 0;
  const documents = parseDocuments(body.documents);
  if (!documents) return null;
  if (texts.length === 0 && attachmentCount === 0) return null;
  return {
    turnId: body.turnId,
    receivedAtMs: body.receivedAt,
    generation: body.generation,
    grant: body.grant,
    handleHash: body.handleHash,
    texts,
    attachmentCount: Math.max(attachmentCount, documents.length),
    documents,
    spoken: body.spoken === true,
  };
}

function turnText(body: TurnBody): string {
  const parts = [...body.texts];
  if (body.attachmentCount > 0) {
    parts.push(`(The person also sent ${body.attachmentCount === 1 ? "a photo" : `${body.attachmentCount} photos`}. What Mano read from it is in your instructions.)`);
  }
  return parts.join("\n");
}

// The fixed system rule for a voice note. Mano heard these words, and a
// transcript can be wrong.
const HEARD_RULES =
  "This message is a voice note, as Mano heard it, so a word may be wrong. If it holds a name, a date, a number or an address you will rely on, say back what you heard. A yes in a voice note approves nothing: if a yes or no question is waiting, ask them to text their answer.";

const reply = (text: string, status = "replied"): TurnResponse => ({ httpStatus: 200, body: { status, text } });

const failure = (httpStatus: number, status: string, reason?: string): TurnResponse => ({
  httpStatus,
  body: { status, text: "", ...(reason ? { reason } : {}) },
});

// Live readings use the Standard model ID with store: false, or Meta's
// open-weight model on zero-retention endpoints under the same setting as
// the agent's own model path (lib/muse.ts). Without a key the stand-in
// answers nothing, so the reply says it could not read.
let mailModel: ModelClient | null = null;
function defaultMailModel(): ModelClient {
  mailModel ??= createModelClient(process.env, { synthetic: false });
  return mailModel;
}

const CHECKING =
  "I'm checking whether it went through. It will not be sent twice. Reply YES in a few minutes and I will check again.";

// Engine keeps the approval waiting when the safety check could not
// answer, so the question stays open for the next YES.
const CHECK_STARTING =
  "The safety check is taking a moment, so nothing was sent yet. Reply YES again in a few minutes and I will send it.";

// A send that could not be confirmed is never sent again by a YES. The
// question closes, so a new one can be prepared and answered on its own.
const UNCONFIRMED =
  "I could not confirm that went through, so I will not send it again on my own. If you want it sent, ask me to prepare it again and you can approve the new one.";

function doneText(purpose: string, receipt: { externalId: string; simulated: boolean } | null | undefined): string {
  const label = receipt?.simulated ? " This was a simulated filing." : "";
  const confirmation = receipt ? ` Confirmation ${receipt.externalId}.` : "";
  return `Done. Sent: ${purpose}.${confirmation}${label}`;
}

async function answerYes(engine: PersonEngine, approvalId: string): Promise<string> {
  const result = await engine.approve(approvalId);
  switch (result.status) {
    case "completed":
    case "reconciled": {
      await engine.clearPointer(approvalId);
      const approval = result.approval ?? (await engine.approval(approvalId));
      const shared = approval ? shareDone(approval) : null;
      return shared ?? doneText(approval?.purpose ?? "your request", result.receipt);
    }
    case "stale":
      await engine.clearPointer(approvalId);
      return "That changed after you saw it, so nothing was sent. Want me to prepare it again?";
    case "in_progress":
      return CHECKING;
    default: {
      if (result.retryable) return CHECK_STARTING;
      if (result.unconfirmed) {
        await engine.clearPointer(approvalId);
        return UNCONFIRMED;
      }
      if (result.superseded) {
        await engine.clearPointer(approvalId);
        return `${UPDATED} Ask me to show the latest.`;
      }
      // Not a definite outcome: Engine's own record decides. A consumed
      // approval whose attempt settled carries its receipt; one still
      // unknown keeps the pointer until Engine reconciles it.
      const approval = await engine.approval(approvalId);
      // A receipt is read first, whatever the status: it went through.
      if (approval?.outcome?.receipt) {
        await engine.clearPointer(approvalId);
        return doneText(approval.purpose, approval.outcome.receipt);
      }
      // A share the organization refused for good: nothing to wait for.
      if (approval && isShare(approval) && approval.outcome?.attempt === "failed") {
        await engine.clearPointer(approvalId);
        return "That did not go through, so nothing was sent.";
      }
      if (approval?.status === "approved") return CHECKING;
      console.warn(JSON.stringify({ type: "mano_yes_refused", status: result.status, approval: approval?.status ?? null }));
      await engine.clearPointer(approvalId);
      return "That approval can no longer be used, so nothing was sent. Want me to prepare it again?";
    }
  }
}

async function answerNo(engine: PersonEngine, approval: EngineApproval | null, approvalId: string): Promise<string> {
  const sent = await alreadySent(engine, approval, approvalId);
  if (sent) return sent;
  if (approval?.status === "approved") {
    return "That one was already approved, so I cannot cancel it. I'm checking whether it went through. Reply YES and I will check again.";
  }
  const result = await engine.reject(approvalId);
  if (result.status === "rejected") {
    await engine.clearPointer(approvalId);
    return "Okay, I did not send it. Nothing left Mano.";
  }
  // Read again: the filing may have been recorded since the first read.
  const fresh = await engine.approval(approvalId);
  const sentSince = await alreadySent(engine, fresh, approvalId);
  if (sentSince) return sentSince;
  if (fresh?.status === "approved") {
    return "That one was already approved, so I cannot cancel it. I'm checking whether it went through. Reply YES and I will check again.";
  }
  await engine.clearPointer(approvalId);
  return "That request had already expired or changed, so nothing was sent.";
}

// A receipt is read before any status: the filing went through, so a NO
// cannot cancel it and Mano never says nothing was sent.
async function alreadySent(engine: PersonEngine, approval: EngineApproval | null, approvalId: string): Promise<string | null> {
  const receipt = approval?.outcome?.receipt;
  if (!receipt) return null;
  await engine.clearPointer(approvalId);
  return `That one was already sent, so I cannot cancel it. Confirmation ${receipt.externalId}.`;
}

async function decide(engine: PersonEngine, approvalId: string, decision: "yes" | "no"): Promise<TurnResponse> {
  try {
    if (decision === "yes") return reply(await answerYes(engine, approvalId));
    return reply(await answerNo(engine, await engine.approval(approvalId), approvalId));
  } catch (err) {
    console.warn(JSON.stringify({ type: "mano_decision_failed", decision, status: err instanceof EngineError ? err.status : null }));
    if (decision === "no") return reply("I could not confirm that just now, so reply NO again to cancel it.");
    return reply("I could not confirm that just now. Reply YES again to retry; it will not be sent twice.");
  }
}

// A YES with no answerable question: proposals not yet shown are never
// approved.
const UNSHOWN = reply("I haven't shown you that one yet, so nothing was approved and nothing was sent. Ask me to show it again.");

const UPDATED = "I just updated that, so nothing was approved and nothing was sent.";

// The answer to a YES or NO aimed at a question that has since been
// replaced. The newer draft is never shown here: only a question that went
// out with the reply of the turn that prepared it, and that Channels then
// reported, can be answered, so a draft that was corrected away (and held
// back only in some process's memory) can never surface on its own.
const CHANGED = reply("The question you answered changed since you saw it, so nothing was sent. Tell me what you want to send.");

// A YES or NO turn is bound, in Engine's turn ledger, to what its first
// attempt decided: one ledger row per approval it acted on, or one row
// saying it acted on none, written before it acts. Every later attempt of
// the same turn re-applies exactly that decision (Engine's approve and
// reject are idempotent for the same person) and never reads the current
// pointer, so a replayed YES can never approve a draft presented after it.
function bindingId(turnId: string, target: string): string {
  return `d-${createHash("sha256").update(turnId).digest("hex").slice(0, 40)}-${target}`;
}

// What a decision turn's first attempt decided: the approvals it acted
// on, that nothing waiting had been shown ("unshown"), or that there was
// nothing to decide and the model answered ("model").
type Binding = { kind: "unshown" } | { kind: "model" } | { kind: "approvals"; ids: string[] };

async function boundDecision(engine: PersonEngine, turnId: string, approvals: EngineApproval[]): Promise<Binding | null> {
  if (await engine.getTurn(bindingId(turnId, "unshown"))) return { kind: "unshown" };
  if (await engine.getTurn(bindingId(turnId, "model"))) return { kind: "model" };
  const candidates = proposalsOf(approvals, engine.generation);
  const found = await Promise.all(candidates.map(async (a) => ((await engine.getTurn(bindingId(turnId, a.id))) ? a.id : null)));
  const ids = found.filter((id): id is string => id !== null);
  return ids.length > 0 ? { kind: "approvals", ids } : null;
}

async function bind(engine: PersonEngine, turnId: string, receivedAt: string, targets: string[]): Promise<void> {
  for (const target of targets) await engine.putTurn(bindingId(turnId, target), receivedAt);
}

// A NO to several approvals at once (the ones a turn bound) answers with
// the first outcome that is not a confirmed cancellation, so the person
// never hears "nothing left Mano" unless Engine rejected every one.
async function declineAll(engine: PersonEngine, ids: string[]): Promise<TurnResponse> {
  let answer: TurnResponse | null = null;
  for (const id of ids) {
    const one = await decide(engine, id, "no");
    if (!answer || !/^Okay, I did not send it/.test(one.body.text)) answer = one;
  }
  return answer ?? reply("Okay, I did not send it. Nothing left Mano.");
}

async function decideTurn(
  engine: PersonEngine,
  body: TurnBody,
  turn: { firstReceivedAt: string; created: boolean },
  decision: "yes" | "no",
): Promise<TurnResponse | null> {
  const approvals = await engine.listApprovals();
  const bound = turn.created ? null : await boundDecision(engine, body.turnId, approvals);
  if (bound?.kind === "model") return null;
  if (bound?.kind === "unshown") return UNSHOWN;
  if (bound?.kind === "approvals") {
    if (decision === "yes") return decide(engine, bound.ids[0], "yes");
    return declineAll(engine, bound.ids);
  }
  // First attempt (or a retry whose first attempt bound nothing): only
  // Engine's latest proposal can be answered, and only once its question
  // was shown strictly before Channels received this message. A pointer to
  // anything older means the person last saw a question that has since
  // been replaced: nothing is approved, and nothing new is shown.
  const arrived = Date.parse(turn.firstReceivedAt);
  const { pointer, latest } = await engine.getPending();
  if (pointer && pointer.approvalId !== latest?.approvalId) {
    await bind(engine, body.turnId, turn.firstReceivedAt, ["unshown"]);
    return CHANGED;
  }
  const answerable = pointer && Date.parse(pointer.setAt) < arrived ? pointer : null;
  if (pointer && !answerable) {
    await bind(engine, body.turnId, turn.firstReceivedAt, ["unshown"]);
    return UNSHOWN;
  }
  if (answerable) {
    await bind(engine, body.turnId, turn.firstReceivedAt, [answerable.approvalId]);
    return decide(engine, answerable.approvalId, decision);
  }
  const waiting = waitingProposals(approvals, engine.generation).filter((a) => Date.parse(a.createdAt) < arrived);
  if (waiting.length === 0) {
    await bind(engine, body.turnId, turn.firstReceivedAt, ["model"]);
    return null;
  }
  if (decision === "no") {
    await bind(engine, body.turnId, turn.firstReceivedAt, waiting.map((a) => a.id));
    return declineAll(engine, waiting.map((a) => a.id));
  }
  await bind(engine, body.turnId, turn.firstReceivedAt, ["unshown"]);
  return UNSHOWN;
}

async function runTurn(
  deps: TurnDeps,
  engine: PersonEngine,
  body: TurnBody,
  turn: { firstReceivedAt: string; created: boolean },
  deadlineMs: number,
  clock: TurnClock,
): Promise<TurnResponse> {
  let message = turnText(body);
  const turnAtMs = Date.parse(turn.firstReceivedAt);
  // Words Mano heard can be wrong, and a yes files something, so a voice
  // note never answers an approval: only a typed YES or NO does.
  const decision = body.attachmentCount === 0 && !body.spoken ? parseDecision(body.texts.join(" ")) : null;
  // The profile, as data and never instructions (lib/profile.ts), is read
  // while the turn closes drafts, decides and reads photos, and is given
  // up before it could cut into the model's minimum. A decision answered
  // without the model never uses it.
  const profileRead = body.attachmentCount > 0 && body.texts.length === 0 ? null : profileContext(engine, deadlineMs - MODEL_MIN_MS - Date.now());
  // Closing replaced drafts is retried at every turn until it lands.
  await clock.time("close", () => closeReplaced(engine));
  if (decision) {
    const decided = await clock.time("decide", () => decideTurn(engine, body, turn, decision));
    if (decided) return decided;
  }

  // A crisis is never answered with a document question.
  const crisis = body.texts.some(detectCrisis);
  if (body.documents.length > 0 && !crisis) {
    const answered = await clock.time("share", () =>
      answerRequestWithPhoto(engine, { turnId: body.turnId, turnAtMs }, body.documents.map((d) => d.id), body.attachmentCount),
    );
    if (answered) return answerShown(answered);
  }

  const context: string[] = [];
  if (crisis) context.push(CRISIS_LINE);
  if (body.spoken) context.push(HEARD_RULES);
  // A texted photo is read first and answered in this same reply. With no
  // words that answer is the whole reply; the crisis line still leads
  // through Channels' finalize when the turn is a crisis.
  // The reading reaches the model only as data in the person's own turn.
  let letter: LetterReply | null = null;
  if (body.attachmentCount > 0) {
    letter = await readTextedPhotos(engine, body.documents, deps.mailModel ?? defaultMailModel(), turn.firstReceivedAt, deadlineMs - READ_MARGIN_MS);
    if (body.texts.length === 0 || deadlineMs - Date.now() < MODEL_MIN_MS) return reply(letter.text);
    context.push(LETTER_RULES);
    message = `${message}\n\n${letterBlock(letter)}`;
  }
  // Read after the photos, so a letter this turn just read is marked.
  const [profile, documents] = await clock.time("profile", () => Promise.all([profileRead, documentsContext(engine, deadlineMs - MODEL_MIN_MS - Date.now())]));
  if (profile) context.push(profile);
  if (documents) context.push(documents);
  // Where earlier requests stand (instructions/requests.ts) reaches the
  // model as a system instruction, never as part of the person's message.
  let settled: SettleResult;
  try {
    settled = await clock.time("agent", () => deps.runAgent({
      handleHash: body.handleHash,
      turnId: body.turnId,
      turnAtMs,
      generation: body.generation,
      grant: body.grant,
      message,
      context,
      deadlineMs,
      timings: clock.agent,
    }));
  } catch (err) {
    // A reading already made is the answer even when the model is not.
    if (err instanceof SettleTimeout) return letter ? reply(letter.text) : failure(504, "timeout");
    throw err;
  }
  const after = await engine.listApprovals();
  // Only a draft this turn proposed and its last form call left waiting is
  // shown; Engine's listing only confirms it still waits.
  const heldNow = new Set(settled.held ?? []);
  const own = waitingFrom(after, body.generation, body.turnId).find((a) => heldNow.has(a.id)) ?? null;
  // Only Engine's latest proposal is ever shown: never a draft a newer
  // turn replaced, whether this turn is a replay or just slow.
  const [pending, link] = own ? await Promise.all([engine.getPending(), replayLinkOf(engine, own.id)]) : [null, null];
  const latest = pending?.latest ?? null;
  const question = own && latest?.approvalId === own.id ? presentable(own) : null;
  const proposed = question ? own : null;
  const text = [letter?.text ?? "", settled.status === "failed" ? "" : settled.text, question ?? "", question && link ? replayLine(link) : ""]
    .filter(Boolean)
    .join("\n\n");
  if (!text) return failure(502, "failed", settled.reason);
  if (!proposed || !question) return reply(text, letter ? "replied" : settled.status);
  return { httpStatus: 200, body: { status: "waiting_approval", text, approval: question, approvalId: proposed.id } };
}

// The reply to a photo that answers a waiting request: the exact question,
// or plainly that nothing was sent.
function answerShown(held: HoldResult | { pickOne: string }): TurnResponse {
  if ("pickOne" in held) return reply(held.pickOne);
  if (!held.held) return reply("I could not get that ready to send just now, so nothing was sent. Try sending the photo again in a moment.");
  return { httpStatus: 200, body: { status: "waiting_approval", text: held.question, approval: held.question, approvalId: held.approval.id } };
}

// The replay page of a filled form, or null: a question without a link
// is still the whole question.
async function replayLinkOf(engine: PersonEngine, approvalId: string): Promise<string | null> {
  try {
    return await engine.replayLink(approvalId, REPLAY_LINK_MS);
  } catch (err) {
    console.warn(JSON.stringify({ type: "mano_replay_link_failed", status: err instanceof EngineError ? err.status : null }));
    return null;
  }
}

// Records the turn in Engine's ledger. Engine's generation fence answers
// 409 when the turn and Engine disagree on the conversation: a turn from
// before a deletion is stale (null); a turn from after one that Engine
// never heard of (Channels' own call failed) brings Engine forward, which
// removes the old conversation's state, and is recorded then.
async function recordTurn(
  engine: PersonEngine,
  turnId: string,
  receivedAt: string,
): Promise<{ turn: EngineTurn; created: boolean; previousReceivedAt: string | null } | null> {
  try {
    return await engine.putTurn(turnId, receivedAt);
  } catch (err) {
    if (!(err instanceof EngineError) || err.status !== 409) throw err;
    if ((await engine.getConversationGeneration()) >= engine.generation) return null;
    await engine.advanceConversation();
    console.log(JSON.stringify({ type: "mano_conversation_advanced", generation: engine.generation }));
    return engine.putTurn(turnId, receivedAt);
  }
}

// True for the first turn after a quiet stretch, read from Engine's turn
// ledger. A retried turn never counts: it was already warmed for.
function conversationStarts(recorded: { turn: EngineTurn; created: boolean; previousReceivedAt: string | null }): boolean {
  if (!recorded.created) return false;
  if (recorded.previousReceivedAt === null) return true;
  return Date.parse(recorded.turn.firstReceivedAt) - Date.parse(recorded.previousReceivedAt) > CONVERSATION_GAP_MS;
}

export async function handleTurn(request: Request, deps: TurnDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const receivedMs = now();
  const clock = new TurnClock(now);
  const raw = new Uint8Array(await request.arrayBuffer());
  const check = verifyRequest(deps.secret, request.headers.get(TIMESTAMP_HEADER), request.headers.get(SIGNATURE_HEADER), raw);
  if (!check.ok) {
    console.warn(JSON.stringify({ type: "mano_turn_rejected", reason: check.reason }));
    return new Response("Unauthorized.", { status: 401 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return Response.json({ status: "error", text: "", reason: "bad_json" }, { status: 400 });
  }
  const body = parseBody(parsed);
  if (!body) return Response.json({ status: "error", text: "", reason: "bad_turn" }, { status: 400 });
  const engine = deps.engine?.forHandle(body.handleHash, body.grant, body.generation);
  if (!engine) {
    console.warn(JSON.stringify({ type: "mano_turn_refused", reason: "engine" }));
    return Response.json({ status: "error", text: "", reason: "engine" }, { status: 503 });
  }
  engine.onCall = clock.engineCall;

  let turn: { firstReceivedAt: string; created: boolean };
  let starts: boolean;
  try {
    const recorded = await clock.time("ledger", () => recordTurn(engine, body.turnId, new Date(body.receivedAtMs).toISOString()));
    if (!recorded) return Response.json({ status: "stale", text: "" }, { status: 409 });
    turn = { firstReceivedAt: recorded.turn.firstReceivedAt, created: recorded.created };
    starts = conversationStarts(recorded);
  } catch (err) {
    const status = err instanceof EngineError ? err.status : null;
    console.warn(JSON.stringify({ type: "mano_turn_refused", reason: "ledger", status }));
    return Response.json({ status: "error", text: "", reason: "ledger" }, { status: 503 });
  }

  if (deps.warmGuardian && starts) {
    const warming = deps.warmGuardian().catch(() => undefined);
    if (deps.background) deps.background(warming);
  }

  let response: TurnResponse;
  try {
    response = await runTurn(deps, engine, body, turn, receivedMs + (deps.turnBudgetMs ?? TURN_BUDGET_MS), clock);
  } catch (err) {
    console.warn(JSON.stringify({ type: "mano_turn_error", handle: body.handleHash, err: err instanceof Error ? err.name : "unknown" }));
    response = failure(502, "error");
  }
  // Nothing reads a turn's completion before the reply, and its failure
  // is ignored, so the reply does not wait for it where it can run on.
  if (response.httpStatus === 200) {
    const completing = engine.completeTurn(body.turnId).catch(() => undefined);
    if (deps.background) deps.background(completing);
    else await completing;
  }
  console.log(
    JSON.stringify({
      type: "mano_turn",
      handle: body.handleHash,
      status: response.body.status,
      latencyMs: now() - receivedMs,
      steps: clock.steps,
      agent: clock.agent,
      engine: clock.engine,
    }),
  );
  return Response.json({ ...response.body, ...(deps.modelId ? { model: deps.modelId } : {}) }, { status: response.httpStatus });
}

// Channels' report that a reply carrying an approval question went out:
// the approval ID and the hash of the question text it sent, plus the
// generation and a grant. Signed like a turn. Only a report matching a
// waiting agent proposal, rendered now from what Engine froze, makes it
// answerable (Engine's pointer); anything else is 409 and changes
// nothing. Repeating a matching report is fine.
export async function handlePresented(request: Request, deps: { secret: string | undefined; engine: Engine | null }): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const check = verifyRequest(deps.secret, request.headers.get(TIMESTAMP_HEADER), request.headers.get(SIGNATURE_HEADER), raw);
  if (!check.ok) return new Response("Unauthorized.", { status: 401 });
  let body: { handleHash?: unknown; approvalId?: unknown; textHash?: unknown; generation?: unknown; grant?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return Response.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }
  const { handleHash, approvalId, textHash, generation, grant } = body;
  if (
    typeof handleHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(handleHash) ||
    typeof approvalId !== "string" ||
    typeof textHash !== "string" ||
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    generation < 0 ||
    typeof grant !== "string"
  ) {
    return Response.json({ ok: false, reason: "bad_report" }, { status: 400 });
  }
  const engine = deps.engine?.forHandle(handleHash, grant, generation);
  if (!engine) return Response.json({ ok: false, reason: "engine" }, { status: 503 });
  const approval = waitingProposals(await engine.listApprovals(), generation).find((a) => a.id === approvalId);
  if (!approval || presentationHash(renderQuestion(approval)) !== textHash) {
    console.warn(JSON.stringify({ type: "mano_presented_mismatch", handle: handleHash }));
    return Response.json({ ok: false, reason: "mismatch" }, { status: 409 });
  }
  // A draft held back after a correction is never made answerable, even
  // when Channels reports it from before: it is closed like a replaced one.
  if (!presentable(approval)) {
    await engine.reject(approval.id).catch(() => console.warn(JSON.stringify({ type: "mano_close_failed", count: 1 })));
    return Response.json({ ok: true, superseded: true });
  }
  const set = await engine.setPointer(approvalId);
  if (!set) return Response.json({ ok: false, reason: "mismatch" }, { status: 409 });
  if (set.superseded) {
    // Not Engine's latest proposal: the report changes nothing and Engine
    // will never approve this draft. Closing it is cleanup; a failure is
    // logged and retried at the next turn.
    await closeReplaced(engine);
    return Response.json({ ok: true, superseded: true });
  }
  return Response.json({ ok: true });
}

