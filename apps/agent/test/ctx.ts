// The tool context the Mano channel gives every tool: the hashed handle
// as principal plus the turn's signed attributes.
export function toolCtx(opts: { handleHash: string; turnId: string; grant?: string; generation?: number; turnAtMs?: number }) {
  const attributes: Record<string, string> = { turnId: opts.turnId, generation: String(opts.generation ?? 0) };
  if (opts.grant) attributes.grant = opts.grant;
  if (opts.turnAtMs) attributes.turnAtMs = String(opts.turnAtMs);
  return { session: { auth: { current: { principalId: opts.handleHash, attributes } } } } as never;
}
