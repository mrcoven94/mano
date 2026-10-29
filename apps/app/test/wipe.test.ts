import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../lib/kv";
import { Outbox } from "../lib/queue";
import { clearCacheFiles, listCacheFiles, trackCacheFile } from "../lib/cache-files";
import { wipeResidentData, type WipeDeps } from "../lib/wipe";

function depsFor(outbox: Outbox, personStore: MemoryStore, overrides: Partial<WipeDeps> = {}): WipeDeps {
  return {
    outbox,
    personStore,
    tokenStore: new MemoryStore(),
    forgetPerson: async () => {},
    deleteFile: async () => {},
    cancelReminders: async () => {},
    ...overrides,
  };
}

describe("cache manifest", () => {
  it("tracks, lists and clears files", async () => {
    const store = new MemoryStore();
    expect(await listCacheFiles(store)).toEqual([]);
    await trackCacheFile(store, "file:///a.pdf");
    await trackCacheFile(store, "file:///a.pdf");
    await trackCacheFile(store, "file:///b.m4a");
    expect(await listCacheFiles(store)).toEqual(["file:///a.pdf", "file:///b.m4a"]);
    await clearCacheFiles(store);
    expect(await listCacheFiles(store)).toEqual([]);
  });
});

describe("wipeResidentData", () => {
  it("deletes cache files, clears the outbox and manifest, forgets the key, removes the session and cancels reminders", async () => {
    const personStore = new MemoryStore();
    const tokenStore = new MemoryStore();
    await tokenStore.set("session", "token");
    const outbox = new Outbox(personStore);
    await outbox.enqueue("alice", "queued", []);
    await trackCacheFile(personStore, "file:///share.pdf");
    const deleted: string[] = [];
    const forgotten: string[] = [];
    let remindersCancelled = false;
    const deps = depsFor(outbox, personStore, {
      tokenStore,
      deleteFile: async (uri) => {
        deleted.push(uri);
      },
      forgetPerson: async (id) => {
        forgotten.push(id);
      },
      cancelReminders: async () => {
        remindersCancelled = true;
      },
    });
    const errors = await wipeResidentData("alice", deps);
    expect(errors).toEqual([]);
    expect(deleted).toEqual(["file:///share.pdf"]);
    expect(forgotten).toEqual(["alice"]);
    expect(remindersCancelled).toBe(true);
    expect(await tokenStore.get("session")).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
    expect(await listCacheFiles(personStore)).toHaveLength(0);
  });

  it("still clears the session, outbox and key when a file delete fails", async () => {
    const personStore = new MemoryStore();
    const tokenStore = new MemoryStore();
    await tokenStore.set("session", "token");
    const outbox = new Outbox(personStore);
    await outbox.enqueue("alice", "queued", []);
    await trackCacheFile(personStore, "file:///stuck.pdf");
    const forgotten: string[] = [];
    const deps = depsFor(outbox, personStore, {
      tokenStore,
      deleteFile: async () => {
        throw new Error("locked");
      },
      forgetPerson: async (id) => {
        forgotten.push(id);
      },
    });
    const errors = await wipeResidentData("alice", deps);
    expect(errors).toHaveLength(1);
    expect(forgotten).toEqual(["alice"]);
    expect(await tokenStore.get("session")).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
  });

  it("wipes nothing shared when there is no resident data", async () => {
    const personStore = new MemoryStore();
    const deleteFile = vi.fn(async (_uri: string) => {});
    const errors = await wipeResidentData("alice", depsFor(new Outbox(personStore), personStore, { deleteFile }));
    expect(errors).toEqual([]);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
