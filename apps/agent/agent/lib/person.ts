// Who the current turn serves. The Mano channel authenticates every
// turn with the hashed handle as the principal ID, so tools scope rows
// to the right person without ever seeing a phone number.
import type { ToolContext } from "eve/tools";

export function handleHashFrom(ctx: Pick<ToolContext, "session">): string | null {
  return ctx.session.auth.current?.principalId ?? null;
}

export function requireHandleHash(ctx: Pick<ToolContext, "session">): string {
  const handleHash = handleHashFrom(ctx);
  if (!handleHash) throw new Error("This turn has no authenticated person; the channel must pass the hashed handle.");
  return handleHash;
}
