import { describe, expect, it } from "vitest";
import { trackCacheFile } from "../lib/cache-files";
import { MemoryStore, type KeyValue } from "../lib/kv";
import { Outbox } from "../lib/queue";
import { signOutStored, type StoredSignoutDeps } from "../lib/signout";

function setup(): {
  deps: StoredSignoutDeps;
  tokenStore: MemoryStore;
  personStore: MemoryStore;
  deleted: string[];
  forgotten: string[];
  cancelled: { count: number };
} {
  const tokenStore = new MemoryStore();
  const personStore = new MemoryStore();
  const deleted: string[] = [];
  const forgotten: string[] = [];
  const cancelled = { count: 0 };
  const deps: StoredSignoutDeps = {
    tokenStore,
    buildOutbox: (_personId: string): { outbox: Outbox; personStore: KeyValue } => ({
      outbox: new Outbox(personStore),
      personStore,
    }),
    forgetPerson: async (id: string) => {
      forgotten.push(id);
    },
    deleteFile: async (uri: string) => {
      deleted.push(uri);
    },
    cancelReminders: async () => {
      cancelled.count += 1;
    },
  };
  return { deps, tokenStore, personStore, deleted, forgotten, cancelled };
}

describe("signOutStored", () => {
  it("wipes the stored resident without any in-memory state", async () => {
    const { deps, tokenStore, personStore, deleted, forgotten, cancelled } = setup();
    await tokenStore.set("person", "alice");
    await tokenStore.set("session", JSON.stringify({ token: "t", personId: "alice", expiresAt: "2020-01-01T00:00:00.000Z" }));
    const outbox = new Outbox(personStore);
    await outbox.enqueue("alice", "queued mail", []);
    await trackCacheFile(personStore, "file:///share.pdf");
    const errors = await signOutStored(deps);
    expect(errors).toEqual([]);
    expect(await outbox.list()).toHaveLength(0);
    expect(deleted).toEqual(["file:///share.pdf"]);
    expect(forgotten).toEqual(["alice"]);
    expect(cancelled.count).toBe(1);
    expect(await tokenStore.get("session")).toBeNull();
    expect(await tokenStore.get("person")).toBeNull();
  });

  it("falls back to the session when the person key is missing", async () => {
    const { deps, tokenStore, forgotten } = setup();
    await tokenStore.set("session", JSON.stringify({ token: "t", personId: "beto" }));
    const errors = await signOutStored(deps);
    expect(errors).toEqual([]);
    expect(forgotten).toEqual(["beto"]);
    expect(await tokenStore.get("session")).toBeNull();
  });

  it("still drops keys and reminders when nothing is attributable", async () => {
    const { deps, tokenStore, cancelled, forgotten } = setup();
    await tokenStore.set("session", "corrupt{{");
    const errors = await signOutStored(deps);
    expect(errors).toEqual([]);
    expect(forgotten).toHaveLength(0);
    expect(cancelled.count).toBe(1);
    expect(await tokenStore.get("session")).toBeNull();
  });
});
