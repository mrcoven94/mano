// Storage-driven sign-out. The resident to wipe comes from storage
// itself (the person key, falling back to the stored session), never
// from in-memory state, so expired, corrupt or never-restored sessions
// still wipe their outbox, files, key, session and reminders.

import type { KeyValue } from "./kv";
import type { Outbox } from "./queue";
import { wipeResidentData } from "./wipe";

export interface StoredSignoutDeps {
  tokenStore: KeyValue;
  buildOutbox: (personId: string) => { outbox: Outbox; personStore: KeyValue };
  forgetPerson: (personId: string) => Promise<void>;
  deleteFile: (uri: string) => Promise<void>;
  cancelReminders: () => Promise<void>;
}

async function storedPersonId(tokenStore: KeyValue): Promise<string | null> {
  try {
    const person = await tokenStore.get("person");
    if (person) return person;
  } catch {
    // Fall through to the session.
  }
  try {
    const raw = await tokenStore.get("session");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { personId?: unknown };
    return typeof parsed.personId === "string" && parsed.personId ? parsed.personId : null;
  } catch {
    return null;
  }
}

export async function signOutStored(deps: StoredSignoutDeps): Promise<string[]> {
  const personId = await storedPersonId(deps.tokenStore);
  if (!personId) {
    const errors: string[] = [];
    try {
      await deps.tokenStore.remove("session");
    } catch (err) {
      errors.push(`remove session: ${(err as Error).message}`);
    }
    try {
      await deps.tokenStore.remove("person");
    } catch (err) {
      errors.push(`remove person: ${(err as Error).message}`);
    }
    try {
      await deps.cancelReminders();
    } catch (err) {
      errors.push(`cancel reminders: ${(err as Error).message}`);
    }
    return errors;
  }
  const { outbox, personStore } = deps.buildOutbox(personId);
  const errors = await wipeResidentData(personId, {
    outbox,
    personStore,
    tokenStore: deps.tokenStore,
    forgetPerson: deps.forgetPerson,
    deleteFile: deps.deleteFile,
    cancelReminders: deps.cancelReminders,
  });
  try {
    await deps.tokenStore.remove("person");
  } catch (err) {
    errors.push(`remove person: ${(err as Error).message}`);
  }
  return errors;
}
