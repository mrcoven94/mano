// A deleted conversation, as Channels reports it after wiping its own
// store and asking Engine to remove this person's agent state (reminders,
// turn ledger, approval pointer, pending approvals and memory, in one
// Engine transaction). What is left is the agent's own Eve session
// history for the handle, which this retires. Channels signs the notice
// like a turn.
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "./auth.js";

export interface DeletionDeps {
  secret: string | undefined;
  resetSession(handleHash: string): Promise<unknown>;
}

export async function handleDeleted(request: Request, deps: DeletionDeps): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const check = verifyRequest(deps.secret, request.headers.get(TIMESTAMP_HEADER), request.headers.get(SIGNATURE_HEADER), raw);
  if (!check.ok) return new Response("Unauthorized.", { status: 401 });
  let body: { handleHash?: unknown; generation?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return Response.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }
  const { handleHash, generation } = body;
  if (typeof handleHash !== "string" || !/^[0-9a-f]{64}$/.test(handleHash) || typeof generation !== "number") {
    return Response.json({ ok: false, reason: "bad_notice" }, { status: 400 });
  }
  try {
    await deps.resetSession(handleHash);
  } catch (err) {
    console.warn(JSON.stringify({ type: "mano_delete_failed", handle: handleHash, err: err instanceof Error ? err.name : "unknown" }));
    return Response.json({ ok: false, reason: "failed" }, { status: 502 });
  }
  console.log(JSON.stringify({ type: "mano_conversation_deleted", handle: handleHash, generation }));
  return Response.json({ ok: true, sessionReset: true });
}
