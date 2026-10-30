// One synchronous turn from Channels, without the Eve wiring (which
// lives in channels/mano.ts and arrives here as runAgent).
//
// Order: authenticate the signed body, record the turn in Engine's
// ledger (which keeps the first receive time, so a retried turn derives
// the same reminder and timing), warm Guardian when a conversation
// starts, then either answer the approval question Engine holds as
// answerable or run the agent. A plain YES or NO to that question is the
// person's decision on that exact Engine approval and never goes to the
// model. When a turn proposes an action, its reply ends with the question
// rendered from the request Engine froze, and the question travels on its
// own too so Channels can check it goes out word for word and report it.
//
// A retried turn runs again: every mutation it makes is keyed by the turn
// (reminders, memory) or held by Engine (approvals), so a rerun converges
// instead of doing anything twice.
import { createHash } from "node:crypto";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "./auth.js";
import { CRISIS_LINE, detectCrisis } from "./crisis.js";
import { parseDecision } from "./decision.js";
import { EngineError, type Engine, type EngineApproval, type EngineTurn, type PersonEngine } from "./engine.js";
import { closeReplaced, presentationHash, presentsExactly, proposalsOf, proposedIn, renderQuestion, waitingProposals } from "./pending.js";
import { SettleTimeout, type SettleResult } from "./settle.js";

const MAX_TEXTS = 10;
const MAX_TEXT_CHARS = 4000;
// Engine's identity rule for turn IDs.
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/;
// A person quiet this long is starting a new conversation.
const CONVERSATION_GAP_MS = 15 * 60_000;

export interface AgentTurnInput {
  handleHash: string;
  turnId: string;
  turnAtMs: number;
  generation: number;
  grant: string;
  message: string;
  context: string[];
}

export interface TurnDeps {
  secret: string | undefined;
  engine: Engine | null;
  runAgent(input: AgentTurnInput): Promise<SettleResult>;
  // Starts Guardian ahead of the conversation's first check; runs in the
  // background and never affects the turn.
  warmGuardian?: () => Promise<unknown>;
  background?: (work: Promise<unknown>) => void;
  // Last turn time per handle in this process, for the warm-up gap. Best
  // effort: another instance may warm again, which costs one request.
  lastTurnAt?: Map<string, number>;
  now?: () => number;
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
  attachmentCount: number;
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
  if (texts.length === 0 && attachmentCount === 0) return null;
  return {
    turnId: body.turnId,
    receivedAtMs: body.receivedAt,
    generation: body.generation,
    grant: body.grant,
    handleHash: body.handleHash,
    texts,
    attachmentCount,
  };
}

function turnText(body: TurnBody): string {
  const parts = [...body.texts];
  if (body.attachmentCount > 0) {
    parts.push(
      `(The person also sent ${body.attachmentCount} photo${body.attachmentCount === 1 ? "" : "s"}; they are saved and will be read separately. Acknowledge briefly if you mention them.)`,
    );
  }
  return parts.join("\n");
}

const reply = (text: string, status = "replied"): TurnResponse => ({ httpStatus: 200, body: { status, text } });
const failure = (httpStatus: number, status: string, reason?: string): TurnResponse => ({
  httpStatus,
  body: { status, text: "", ...(reason ? { reason } : {}) },
});

const CHECKING =
  "I'm checking whether it went through. It will not be sent twice. Reply YES in a few minutes and I will check again.";

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
      const purpose = result.approval?.purpose ?? (await engine.approval(approvalId))?.purpose ?? "your request";
      return doneText(purpose, result.receipt);
    }
    case "stale":
      await engine.clearPointer(approvalId);
      return "That changed after you saw it, so nothing was sent. Want me to prepare it again?";
    case "in_progress":
      return CHECKING;
    default: {
      if (result.superseded) {
        await engine.clearPointer(approvalId);
        return `${UPDATED} Ask me to show the latest.`;
      }
      // Not a definite outcome: Engine's own record decides. A consumed
      // approval whose attempt settled carries its receipt; one still
      // unknown keeps the pointer until Engine reconciles it.
      const approval = await engine.approval(approvalId);
      if (approval?.status === "approved") {
        if (approval.outcome?.attempt === "done" && approval.outcome.receipt) {
          await engine.clearPointer(approvalId);
          return doneText(approval.purpose, approval.outcome.receipt);
        }
        return CHECKING;
      }
      await engine.clearPointer(approvalId);
      return "That approval can no longer be used, so nothing was sent. Want me to prepare it again?";
    }
  }
}

async function answerNo(engine: PersonEngine, approval: EngineApproval | null, approvalId: string): Promise<string> {
  if (approval?.status === "approved") {
    return "That one was already approved, so I cannot cancel it. I'm checking whether it went through. Reply YES and I will check again.";
  }
  const result = await engine.reject(approvalId);
  if (result.status === "rejected") {
    await engine.clearPointer(approvalId);
    return "Okay, I did not send it. Nothing left Mano.";
  }
  if ((await engine.approval(approvalId))?.status === "approved") {
    return "That one was already approved, so I cannot cancel it. I'm checking whether it went through. Reply YES and I will check again.";
  }
  await engine.clearPointer(approvalId);
  return "That request had already expired or changed, so nothing was sent.";
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

// The answer to a YES or NO that was aimed at a replaced question: the
// latest one, shown now as a question of its own, when it still waits.
function updated(engine: PersonEngine, approvals: EngineApproval[], latest: { approvalId: string } | null): TurnResponse {
  const waiting = latest ? waitingProposals(approvals, engine.generation).find((a) => a.id === latest.approvalId) : undefined;
  const question = waiting ? renderQuestion(waiting) : null;
  if (!waiting || !question || !presentsExactly(question)) return reply(`${UPDATED} Ask me to show the latest.`);
  return {
    httpStatus: 200,
    body: { status: "waiting_approval", text: `${UPDATED} Here's the latest.\n\n${question}`, approval: question, approvalId: waiting.id },
  };
}

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
  // been replaced: nothing is approved, and they get the latest one.
  const arrived = Date.parse(turn.firstReceivedAt);
  const { pointer, latest } = await engine.getPending();
  if (pointer && pointer.approvalId !== latest?.approvalId) {
    await bind(engine, body.turnId, turn.firstReceivedAt, ["unshown"]);
    return updated(engine, approvals, latest);
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
): Promise<TurnResponse> {
  const message = turnText(body);
  const turnAtMs = Date.parse(turn.firstReceivedAt);
  const decision = body.attachmentCount === 0 ? parseDecision(body.texts.join(" ")) : null;
  // Closing replaced drafts is retried at every turn until it lands.
  await closeReplaced(engine);
  if (decision) {
    const decided = await decideTurn(engine, body, turn, decision);
    if (decided) return decided;
  }

  const context: string[] = [];
  if (body.texts.some(detectCrisis)) context.push(CRISIS_LINE);
  // Where earlier requests stand (instructions/requests.ts) reaches the
  // model as a system instruction, never as part of the person's message.
  let settled: SettleResult;
  try {
    settled = await deps.runAgent({
      handleHash: body.handleHash,
      turnId: body.turnId,
      turnAtMs,
      generation: body.generation,
      grant: body.grant,
      message,
      context,
    });
  } catch (err) {
    if (err instanceof SettleTimeout) return failure(504, "timeout");
    throw err;
  }
  const after = await engine.listApprovals();
  const own = proposedIn(after, body.generation, body.turnId);
  // Only Engine's latest proposal is ever shown: never a draft a newer
  // turn replaced, whether this turn is a replay or just slow.
  const latest = own ? (await engine.getPending()).latest : null;
  const proposed = own && latest?.approvalId === own.id && presentsExactly(renderQuestion(own)) ? own : null;
  const question = proposed ? renderQuestion(proposed) : null;
  const text = [settled.status === "failed" ? "" : settled.text, question ?? ""].filter(Boolean).join("\n\n");
  if (!text) return failure(502, "failed", settled.reason);
  if (!proposed || !question) return reply(text, settled.status);
  return { httpStatus: 200, body: { status: "waiting_approval", text, approval: question, approvalId: proposed.id } };
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
): Promise<{ turn: EngineTurn; created: boolean } | null> {
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

// True for the first turn after a quiet stretch, as far as this process
// has seen.
function conversationStarts(seen: Map<string, number>, handleHash: string, nowMs: number): boolean {
  const last = seen.get(handleHash);
  seen.set(handleHash, nowMs);
  return last === undefined || nowMs - last > CONVERSATION_GAP_MS;
}

const processTurns = new Map<string, number>();

export async function handleTurn(request: Request, deps: TurnDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const receivedMs = now();
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

  let turn: { firstReceivedAt: string; created: boolean };
  try {
    const recorded = await recordTurn(engine, body.turnId, new Date(body.receivedAtMs).toISOString());
    if (!recorded) return Response.json({ status: "stale", text: "" }, { status: 409 });
    turn = { firstReceivedAt: recorded.turn.firstReceivedAt, created: recorded.created };
  } catch (err) {
    const status = err instanceof EngineError ? err.status : null;
    console.warn(JSON.stringify({ type: "mano_turn_refused", reason: "ledger", status }));
    return Response.json({ status: "error", text: "", reason: "ledger" }, { status: 503 });
  }

  if (deps.warmGuardian && conversationStarts(deps.lastTurnAt ?? processTurns, body.handleHash, receivedMs)) {
    const warming = deps.warmGuardian().catch(() => undefined);
    if (deps.background) deps.background(warming);
  }

  let response: TurnResponse;
  try {
    response = await runTurn(deps, engine, body, turn);
  } catch (err) {
    console.warn(JSON.stringify({ type: "mano_turn_error", handle: body.handleHash, err: err instanceof Error ? err.name : "unknown" }));
    response = failure(502, "error");
  }
  if (response.httpStatus === 200) {
    await engine.completeTurn(body.turnId).catch(() => undefined);
  }
  console.log(
    JSON.stringify({ type: "mano_turn", handle: body.handleHash, status: response.body.status, latencyMs: now() - receivedMs }),
  );
  return Response.json(response.body, { status: response.httpStatus });
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

