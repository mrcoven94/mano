// Offline outbox for a cheap phone on a slow connection. Messages and
// photos the person sends while offline wait in persistent storage and
// go out in order when the app can reach the engine again. The queue
// never drops an item silently: a failed flush keeps everything.

import type { NewAttachment } from "./api/types";
import type { KeyValue } from "./storage";

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: NewAttachment[];
  createdAt: string;
  attempts: number;
}

export interface FlushReport {
  sent: string[];
  kept: string[];
}

const OUTBOX_KEY = "outbox:v1";
const MAX_ITEMS = 20;

function randomId(): string {
  return `q-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class Outbox {
  private store: KeyValue;

  constructor(store: KeyValue) {
    this.store = store;
  }

  async list(): Promise<QueuedMessage[]> {
    const raw = await this.store.get(OUTBOX_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as QueuedMessage[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async save(items: QueuedMessage[]): Promise<void> {
    await this.store.set(OUTBOX_KEY, JSON.stringify(items));
  }

  async enqueue(text: string, attachments: NewAttachment[]): Promise<QueuedMessage> {
    const items = await this.list();
    if (items.length >= MAX_ITEMS) {
      throw new Error("The outbox is full. Reconnect and let queued messages send first.");
    }
    const item: QueuedMessage = {
      id: randomId(),
      text,
      attachments,
      createdAt: new Date().toISOString(),
      attempts: 0,
    };
    items.push(item);
    await this.save(items);
    return item;
  }

  async remove(id: string): Promise<void> {
    const items = await this.list();
    await this.save(items.filter((i) => i.id !== id));
  }

  // Sends every queued item in order. The first failure stops the flush
  // and keeps the rest; the caller surfaces the error with a retry.
  async flush(send: (item: QueuedMessage) => Promise<void>): Promise<FlushReport> {
    const items = await this.list();
    const sent: string[] = [];
    for (const item of items) {
      try {
        await send(item);
      } catch {
        // Sent items stay sent; the failed item and everything after it
        // wait for the next flush.
        const kept = items.filter((i) => !sent.includes(i.id));
        await this.save(kept.map((i) => (i.id === item.id ? { ...i, attempts: i.attempts + 1 } : i)));
        return { sent, kept: kept.map((i) => i.id) };
      }
      sent.push(item.id);
      await this.save(items.filter((i) => !sent.includes(i.id)));
    }
    return { sent, kept: [] };
  }
}
