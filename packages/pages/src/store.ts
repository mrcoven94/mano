// Storage behind a small interface. Production uses R2 (see r2.ts); local
// runs use memory. Objects are opaque bytes: encryption happens above.

export interface PageStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export function pageObjectKey(storageId: string): string {
  return `pages/v1/${storageId}.bin`;
}

export function idempotencyObjectKey(clientKeyHash: string): string {
  return `pages/v1/idem/${clientKeyHash}.json`;
}

export class MemoryPageStore implements PageStore {
  private objects = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(data));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const found = this.objects.get(key);
    return found === undefined ? null : new Uint8Array(found);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
