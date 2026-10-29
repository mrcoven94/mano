// Who the current turn serves, and which turn it is. The Mano channel
// authenticates every turn with the hashed handle as the principal ID and
// passes the signed turn ID and its first receive time as attributes, so
// tools scope rows to the right person and derive their mutation keys
// from the turn without ever seeing a phone number.
import type { ToolContext } from "eve/tools";

type Ctx = Pick<ToolContext, "session">;

export interface TurnIdentity {
  handleHash: string;
  turnId: string;
  // When the turn first arrived; relative times ("in 2 minutes") resolve
  // against it so a recovered turn computes the same due time.
  turnAtMs: number;
}

export function requireHandleHash(ctx: Ctx): string {
  const handleHash = ctx.session.auth.current?.principalId;
  if (!handleHash) throw new Error("This turn has no authenticated person; the channel must pass the hashed handle.");
  return handleHash;
}

export function requireTurn(ctx: Ctx): TurnIdentity {
  const handleHash = requireHandleHash(ctx);
  const attributes = ctx.session.auth.current?.attributes ?? {};
  const turnId = attributes.turnId;
  if (typeof turnId !== "string" || !turnId) throw new Error("This turn has no turn ID; the channel must pass it.");
  const turnAtMs = Number(attributes.turnAtMs);
  return { handleHash, turnId, turnAtMs: Number.isFinite(turnAtMs) && turnAtMs > 0 ? turnAtMs : Date.now() };
}
