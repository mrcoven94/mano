// A deleted conversation, as Channels reports it after wiping its own
// store. Channels signs the notice like a turn and includes the new
// deletion generation plus a handle grant. The agent then, for that
// handle: raises the generation floor (older turns are refused), closes
// the waiting approval in Engine, cancels the reminders, deletes the
// person's Engine memory, and retires the Eve session so its history is
// gone. Each step converges, so a repeated notice is safe; the session
// is retired once per generation, so a late duplicate cannot end a newer
// conversation.
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "./auth.js";
import { EngineError, type Engine } from "./engine.js";
import { clearPending, loadPending } from "./pending.js";
import type { ReminderStore } from "./reminders.js";
import type { KeyValue } from "./storage.js";

const RECORD_TTL_MS = 400 * 24 * 3600_000;

export interface DeletionDeps {
  secret: string | undefined;
  kv: KeyValue | null;
  engine: Engine | null;
  reminders: ReminderStore | null;
  resetSession(handleHash: string): Promise<unknown>;
}

export function generationFloorKey(handleHash: string): string {
  return `mano:generation:${handleHash}`;
}

export async function raiseGenerationFloor(kv: KeyValue, handleHash: string, generation: number): Promise<number> {
  const floor = (await kv.get<number>(generationFloorKey(handleHash))) ?? 0;
  if (generation > floor) await kv.put(generationFloorKey(handleHash), generation, RECORD_TTL_MS);
  return Math.max(floor, generation);
}

export async function handleDeleted(request: Request, deps: DeletionDeps): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const check = verifyRequest(deps.secret, request.headers.get(TIMESTAMP_HEADER), request.headers.get(SIGNATURE_HEADER), raw);
  if (!check.ok) return new Response("Unauthorized.", { status: 401 });
  let body: { handleHash?: unknown; generation?: unknown; grant?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return Response.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }
  const { handleHash, generation, grant } = body;
  if (
    typeof handleHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(handleHash) ||
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    typeof grant !== "string" ||
    !grant
  ) {
    return Response.json({ ok: false, reason: "bad_notice" }, { status: 400 });
  }
  const { kv, reminders } = deps;
  if (!kv || !reminders) return Response.json({ ok: false, reason: "storage" }, { status: 503 });
  const engine = deps.engine?.forHandle(handleHash, grant) ?? null;
  if (!engine) return Response.json({ ok: false, reason: "engine" }, { status: 503 });

  try {
    await raiseGenerationFloor(kv, handleHash, generation);
    let approvalRejected = false;
    const pending = await loadPending(kv, engine.personId);
    if (pending && pending.state !== "checking") {
      approvalRejected = (await engine.reject(pending.approvalId)).status === "rejected";
    }
    if (pending) await clearPending(kv, engine.personId);
    let remindersCancelled = 0;
    for (const reminder of await reminders.listForHandle(handleHash)) {
      if ((await reminders.cancel(reminder.id, handleHash)) !== "not_found") remindersCancelled += 1;
    }
    let memoryDeleted = 0;
    for (const row of await engine.listMemory()) {
      await engine.deleteMemory(row.id);
      memoryDeleted += 1;
    }
    let sessionReset = false;
    if (await kv.putIfAbsent(`mano:deleted:${handleHash}:${generation}`, true, RECORD_TTL_MS)) {
      await deps.resetSession(handleHash);
      sessionReset = true;
    }
    console.log(
      JSON.stringify({ type: "mano_conversation_deleted", handle: handleHash, generation, approvalRejected, remindersCancelled, memoryDeleted, sessionReset }),
    );
    return Response.json({ ok: true, approvalRejected, remindersCancelled, memoryDeleted, sessionReset });
  } catch (err) {
    console.warn(
      JSON.stringify({ type: "mano_delete_failed", handle: handleHash, status: err instanceof EngineError ? err.status : null }),
    );
    return Response.json({ ok: false, reason: "failed" }, { status: 502 });
  }
}
