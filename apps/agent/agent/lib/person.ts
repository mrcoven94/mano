// Who the current turn serves, and which turn it is. The Mano channel
// authenticates every turn with the hashed handle as the principal ID and
// passes, as attributes, the signed turn ID, its first receive time, the
// Channels deletion generation, and the handle grant for Engine. Tools
// scope rows to the right person, derive their mutation keys from the
// turn, and reach Engine only as that person, without ever seeing a
// phone number.
import type { ToolContext } from "eve/tools";

import { engineFromEnv, type PersonEngine } from "./engine.js";

// Tools and dynamic resolvers both carry the session auth.
type Ctx = { readonly session: { readonly auth: Pick<ToolContext["session"]["auth"], "current"> } };

export interface TurnIdentity {
  handleHash: string;
  turnId: string;
  // When the turn first arrived; relative times ("in 2 minutes") resolve
  // against it so a recovered turn computes the same due time.
  turnAtMs: number;
  // Channels' deletion generation for this conversation. Anything the
  // turn schedules carries it, so a deletion cancels it.
  generation: number;
}

function attribute(ctx: Ctx, name: string): string | null {
  const value = ctx.session.auth.current?.attributes?.[name];
  return typeof value === "string" && value ? value : null;
}

export function requireHandleHash(ctx: Ctx): string {
  const handleHash = ctx.session.auth.current?.principalId;
  if (!handleHash) throw new Error("This turn has no authenticated person; the channel must pass the hashed handle.");
  return handleHash;
}

export function requireTurn(ctx: Ctx): TurnIdentity {
  const handleHash = requireHandleHash(ctx);
  const turnId = attribute(ctx, "turnId");
  if (!turnId) throw new Error("This turn has no turn ID; the channel must pass it.");
  const turnAtMs = Number(attribute(ctx, "turnAtMs"));
  const generation = Number(attribute(ctx, "generation"));
  if (!Number.isInteger(generation) || generation < 0) throw new Error("This turn has no deletion generation.");
  return { handleHash, turnId, turnAtMs: Number.isFinite(turnAtMs) && turnAtMs > 0 ? turnAtMs : Date.now(), generation };
}

// Engine for the person behind this turn, or null when Engine is not
// configured or the turn carries no grant.
export function personEngine(ctx: Ctx): PersonEngine | null {
  const engine = engineFromEnv();
  const grant = attribute(ctx, "grant");
  if (!engine || !grant) return null;
  return engine.forHandle(requireHandleHash(ctx), grant);
}
