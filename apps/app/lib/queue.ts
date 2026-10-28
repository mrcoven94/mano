// Offline outbox for a cheap phone on a slow connection. Messages and
// photos the person sends while offline wait in encrypted storage and
// go out in order when the app can reach the engine again.
//
// Every item is bound to its resident: a flush under another session
// drops foreign items instead of sending them, and an auth failure
// drops the failed item and rethrows so the caller signs out. All
// mutations run through one lock, so a flush can neither overwrite an
// item enqueued meanwhile nor send one twice.

import { AuthError, type NewAttachment, type Session } from "./api/types";
import type { KeyValue } from "./kv";

export interface QueuedMessage {
  // Stable operation ID, assigned before the first attempt.
  id: string;
  personId: string;
  text: string;
  attachments: NewAttachment[];
  createdAt: string;
  attempts: number;
}

export interface FlushReport {
  sent: string[];
  kept: string[];
  droppedForeign: string[];
}

const OUTBOX_KEY = "outbox.v2";
const MAX_ITEMS = 20;

function randomId(): string {
  return `q-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class Outbox {
  private store: KeyValue;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(store: KeyValue) {
    this.store = store;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async read(): Promise<QueuedMessage[]> {
    const raw = await this.store.get(OUTBOX_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as QueuedMessage[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((i) => typeof i?.id === "string" && typeof i?.personId === "string");
    } catch {
      return [];
    }
  }

  async list(): Promise<QueuedMessage[]> {
    return this.locked(() => this.read());
  }

  async enqueue(personId: string, text: string, attachments: NewAttachment[]): Promise<QueuedMessage> {
    return this.locked(async () => {
      const items = await this.read();
      if (items.length >= MAX_ITEMS) {
        throw new Error("The outbox is full. Reconnect and let queued messages send first.");
      }
      const item: QueuedMessage = {
        id: randomId(),
        personId,
        text,
        attachments,
        createdAt: new Date().toISOString(),
        attempts: 0,
      };
      items.push(item);
      await this.store.set(OUTBOX_KEY, JSON.stringify(items));
      return item;
    });
  }

  async remove(id: string): Promise<void> {
    return this.locked(async () => {
      const items = await this.read();
      await this.store.set(OUTBOX_KEY, JSON.stringify(items.filter((i) => i.id !== id)));
    });
  }

  async clear(): Promise<void> {
    return this.locked(async () => {
      await this.store.remove(OUTBOX_KEY);
    });
  }

  // Sends owned items in order. The first failure stops the flush and
  // keeps the rest; foreign items are dropped without sending; an auth
  // failure drops the failed item and rethrows.
  async flush(session: Session, send: (item: QueuedMessage) => Promise<unknown>): Promise<FlushReport> {
    return this.locked(async () => {
      const items = await this.read();
      const droppedForeign = items.filter((i) => i.personId !== session.personId).map((i) => i.id);
      const own = items.filter((i) => i.personId === session.personId);
      if (droppedForeign.length > 0) {
        await this.store.set(OUTBOX_KEY, JSON.stringify(own));
      }
      const sent: string[] = [];
      for (const item of own) {
        try {
          await send(item);
        } catch (err) {
          if (err instanceof AuthError) {
            const rest = own.filter((i) => i.id !== item.id && !sent.includes(i.id));
            await this.store.set(OUTBOX_KEY, JSON.stringify(rest));
            throw err;
          }
          const kept = own.filter((i) => !sent.includes(i.id));
          await this.store.set(
            OUTBOX_KEY,
            JSON.stringify(kept.map((i) => (i.id === item.id ? { ...i, attempts: i.attempts + 1 } : i))),
          );
          return { sent, kept: kept.map((i) => i.id), droppedForeign };
        }
        sent.push(item.id);
        await this.store.set(OUTBOX_KEY, JSON.stringify(own.filter((i) => !sent.includes(i.id))));
      }
      return { sent, kept: [], droppedForeign };
    });
  }
}
