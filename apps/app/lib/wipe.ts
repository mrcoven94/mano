// Sign-out wipe: deletes the resident's cache files, clears the outbox
// and manifest, forgets the person's encryption key, removes the
// session and cancels reminders. Every step runs even when an earlier
// one fails, and failures come back as messages instead of throwing,
// so sign-out always completes.

import type { KeyValue } from "./kv";
import { clearCacheFiles, listCacheFiles } from "./cache-files";
import type { Outbox } from "./queue";

export interface WipeDeps {
  outbox: Outbox;
  personStore: KeyValue;
  tokenStore: KeyValue;
  forgetPerson: (personId: string) => Promise<void>;
  deleteFile: (uri: string) => Promise<void>;
  cancelReminders: () => Promise<void>;
}

export async function wipeResidentData(personId: string, deps: WipeDeps): Promise<string[]> {
  const errors: string[] = [];
  const attempt = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      errors.push(`${label}: ${(err as Error).message}`);
    }
  };
  let files: string[] = [];
  await attempt("list cache files", async () => {
    files = await listCacheFiles(deps.personStore);
  });
  for (const uri of files) {
    await attempt(`delete ${uri}`, () => deps.deleteFile(uri));
  }
  await attempt("clear cache manifest", () => clearCacheFiles(deps.personStore));
  await attempt("clear outbox", () => deps.outbox.clear());
  await attempt("forget encryption key", () => deps.forgetPerson(personId));
  await attempt("remove session", () => deps.tokenStore.remove("session"));
  await attempt("cancel reminders", () => deps.cancelReminders());
  return errors;
}
