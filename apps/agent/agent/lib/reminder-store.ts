// Reminder store selection: Redis when configured, shared process memory
// only in explicit local development, and none otherwise. With none,
// the tools refuse and the dispatcher waits; a reminder is never
// accepted into memory a restart or another instance would lose.
import { MemoryReminderStore, type ReminderStore } from "./reminders.js";
import { KvReminderStore } from "./reminders-kv.js";
import { redisClient, storageMode } from "./storage.js";

let memory: MemoryReminderStore | null = null;

export async function getReminderStore(): Promise<ReminderStore | null> {
  const mode = storageMode();
  if (mode === "redis") return new KvReminderStore(await redisClient());
  if (mode === "memory") {
    memory ??= new MemoryReminderStore();
    return memory;
  }
  return null;
}

// Test seam: resets the in-memory store.
export function resetReminderStores(): void {
  memory = null;
}
