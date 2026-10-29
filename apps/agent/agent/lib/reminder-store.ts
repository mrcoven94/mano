// Reminder store selection: KV in production, shared memory locally.
// Tools and the dispatcher schedule resolve through here so both see
// the same rows in every environment.
import { MemoryReminderStore, type ReminderStore } from "./reminders.js";
import { KvReminderStore } from "./reminders-kv.js";

let memory: MemoryReminderStore | null = null;
let kv: KvReminderStore | null | undefined;

export async function getReminderStore(): Promise<ReminderStore> {
  if (kv === undefined) kv = await KvReminderStore.fromEnv();
  if (kv) return kv;
  if (!memory) memory = new MemoryReminderStore();
  return memory;
}

// Test seam: resets the cached stores.
export function resetReminderStores(): void {
  memory = null;
  kv = undefined;
}
