// One synchronous turn from Channels, without the Eve wiring (which
// lives in channels/mano.ts and arrives here as runAgent).
//
// Order: authenticate the signed body, claim its turn ID in the ledger
// (replays get the stored answer), then either answer a waiting approval
// question or run the agent. A plain YES or NO while a question waits is
// the person's decision on that exact Engine approval and never goes to
// the model; anything else is an ordinary turn. When a turn proposes an
// action, its reply ends with the question rendered from the request
// Engine froze.
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "./auth.js";
import { CRISIS_LINE, detectCrisis } from "./crisis.js";
import { parseDecision } from "./decision.js";
import { EngineError, personIdFor, type EngineClient, type EngineResult } from "./engine.js";
import { claimTurn, finishTurn, releaseTurn, type TurnResponse } from "./ledger.js";
import { clearPending, loadPending, type PendingApproval } from "./pending.js";
import { SettleTimeout, type SettleResult } from "./settle.js";
import type { KeyValue } from "./storage.js";

const MAX_TEXTS = 10;
const MAX_TEXT_CHARS = 4000;
const TURN_ID = /^[A-Za-z0-9_.:-]{8,200}$/;

export interface AgentTurnInput {
  handleHash: string;
  turnId: string;
  turnAtMs: number;
  message: string;
  context: string[];
}

export interface TurnDeps {
  secret: string | undefined;
  kv: KeyValue | null;
  engine: EngineClient | null;
  runAgent(input: AgentTurnInput): Promise<SettleResult>;
  now?: () => number;
}

interface TurnBody {
  turnId: string;
  handleHash: string;
  texts: string[];
  attachmentCount: number;
}

function parseBody(value: unknown): TurnBody | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.turnId !== "string" || !TURN_ID.test(body.turnId)) return null;
  if (typeof body.handleHash !== "string" || !/^[0-9a-f]{16,128}$/.test(body.handleHash)) return null;
  if (!Array.isArray(body.texts)) return null;
  const texts = body.texts.filter((t): t is string => typeof t === "string").slice(0, MAX_TEXTS);
  if (texts.some((t) => t.length > MAX_TEXT_CHARS)) return null;
  const attachmentCount =
    typeof body.attachmentCount === "number" && Number.isInteger(body.attachmentCount) && body.attachmentCount >= 0
      ? Math.min(body.attachmentCount, 10)
      : 0;
  if (texts.length === 0 && attachmentCount === 0) return null;
  return { turnId: body.turnId, handleHash: body.handleHash, texts, attachmentCount };
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

function outcomeText(pending: PendingApproval, result: EngineResult): { text: string; settled: boolean } {
  switch (result.status) {
    case "completed":
    case "reconciled": {
      const receipt = result.receipt;
      const label = receipt?.simulated ? " This was a simulated filing." : "";
      const confirmation = receipt ? ` Confirmation ${receipt.externalId}.` : "";
      return { text: `Done. Sent: ${pending.purpose}.${confirmation}${label}`, settled: true };
    }
    case "in_progress":
      return { text: "It is being sent now. Reply YES again in a few minutes and I will check on it.", settled: false };
    case "stale":
      return { text: "That changed after you saw it, so nothing was sent. Want me to prepare it again?", settled: true };
    default:
      return { text: "That approval can no longer be used, so nothing was sent. Want me to prepare it again?", settled: true };
  }
}

async function decide(
  deps: TurnDeps & { kv: KeyValue },
  pending: PendingApproval,
  decision: "yes" | "no",
): Promise<TurnResponse> {
  if (decision === "no") {
    await clearPending(deps.kv, pending.personId);
    return reply("Okay, I did not send it. Nothing left Mano.");
  }
  if (!deps.engine) return reply("I cannot send that right now, and nothing was sent. Please try again later.");
  try {
    const result = await deps.engine.approve(pending.personId, pending.approvalId);
    const { text, settled } = outcomeText(pending, result);
    if (settled) await clearPending(deps.kv, pending.personId);
    return reply(text);
  } catch (err) {
    console.warn(JSON.stringify({ type: "mano_approve_failed", status: err instanceof EngineError ? err.status : null }));
    return reply("I could not confirm that went through. Reply YES again to retry; it will not be sent twice.");
  }
}

async function runTurn(deps: TurnDeps & { kv: KeyValue }, body: TurnBody, turnAtMs: number): Promise<TurnResponse> {
  const personId = personIdFor(body.handleHash);
  const message = turnText(body);
  const waiting = await loadPending(deps.kv, personId);
  const decision = waiting && body.attachmentCount === 0 ? parseDecision(body.texts.join(" ")) : null;
  if (waiting && decision) return decide(deps, waiting, decision);

  const context: string[] = [];
  if (body.texts.some(detectCrisis)) context.push(CRISIS_LINE);
  if (waiting) {
    context.push(
      `A yes-or-no approval question is waiting for this person:\n${waiting.question}\nA plain YES or NO answers it automatically. If they ask about it, answer briefly.`,
    );
  }
  let settled: SettleResult;
  try {
    settled = await deps.runAgent({ handleHash: body.handleHash, turnId: body.turnId, turnAtMs, message, context });
  } catch (err) {
    if (err instanceof SettleTimeout) return failure(504, "timeout");
    throw err;
  }
  const proposed = await loadPending(deps.kv, personId);
  const question = proposed && proposed.turnId === body.turnId ? proposed.question : null;
  const text = [settled.status === "failed" ? "" : settled.text, question ?? ""].filter(Boolean).join("\n\n");
  if (!text) return failure(502, "failed", settled.reason);
  return reply(text, question ? "waiting_approval" : settled.status);
}

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
  const { kv } = deps;
  if (!kv) {
    console.warn(JSON.stringify({ type: "mano_turn_refused", reason: "storage" }));
    return Response.json({ status: "error", text: "", reason: "storage" }, { status: 503 });
  }

  const claim = await claimTurn(kv, body.turnId, body.handleHash, receivedMs);
  if (claim.kind === "replay") return Response.json(claim.response.body, { status: claim.response.httpStatus });
  if (claim.kind !== "run") {
    return Response.json({ status: claim.kind === "busy" ? "in_progress" : "conflict", text: "" }, { status: 409 });
  }

  let response: TurnResponse;
  try {
    response = await runTurn({ ...deps, kv }, body, claim.receivedAtMs);
  } catch (err) {
    console.warn(JSON.stringify({ type: "mano_turn_error", handle: body.handleHash, err: err instanceof Error ? err.name : "unknown" }));
    response = failure(502, "error");
  }
  if (response.httpStatus === 200) await finishTurn(kv, body.turnId, body.handleHash, claim.receivedAtMs, response);
  else if (response.httpStatus !== 504) await releaseTurn(kv, body.turnId);
  console.log(
    JSON.stringify({
      type: "mano_turn",
      handle: body.handleHash,
      status: response.body.status,
      attempt: claim.attempt,
      latencyMs: now() - receivedMs,
    }),
  );
  return Response.json(response.body, { status: response.httpStatus });
}
