import { describe, expect, it } from "vitest";
import { DecryptError, EncryptedStore, type CipherFactory } from "../lib/cipher";
import { MemoryStore, assertSafeKey } from "../lib/kv";
import { nodeCipher } from "./cipher-node";

function factoryFor(keys: Map<string, Uint8Array>): CipherFactory {
  return {
    async forPerson(personId: string) {
      const key = keys.get(personId);
      if (!key) throw new Error(`No key for ${personId}.`);
      return nodeCipher(key);
    },
    async forgetPerson(personId: string) {
      keys.delete(personId);
    },
  };
}

const ALICE = new Uint8Array(32).fill(1);
const BETO = new Uint8Array(32).fill(2);

describe("EncryptedStore", () => {
  it("round-trips through ciphertext that hides the plaintext", async () => {
    const inner = new MemoryStore();
    const store = new EncryptedStore(inner, factoryFor(new Map([["alice", ALICE]])), "alice");
    await store.set("outbox", "Maria wrote hello");
    const raw = await inner.get("outbox");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("Maria");
    expect(await store.get("outbox")).toBe("Maria wrote hello");
  });

  it("refuses tampered values instead of returning garbage", async () => {
    const inner = new MemoryStore();
    const store = new EncryptedStore(inner, factoryFor(new Map([["alice", ALICE]])), "alice");
    await store.set("outbox", "secret");
    const raw = (await inner.get("outbox")) as string;
    const parsed = JSON.parse(raw) as { iv: string; data: string };
    const tampered = { ...parsed, data: `${parsed.data.slice(0, -4)}AAAA` };
    await inner.set("outbox", JSON.stringify(tampered));
    await expect(store.get("outbox")).rejects.toBeInstanceOf(DecryptError);
  });

  it("cannot be read with another person's key", async () => {
    const inner = new MemoryStore();
    const alice = new EncryptedStore(inner, factoryFor(new Map([["alice", ALICE]])), "alice");
    await alice.set("outbox", "alice secret");
    const beto = new EncryptedStore(inner, factoryFor(new Map([["alice", BETO]])), "alice");
    await expect(beto.get("outbox")).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects legacy plaintext values", async () => {
    const inner = new MemoryStore();
    await inner.set("outbox", "plain old json");
    const store = new EncryptedStore(inner, factoryFor(new Map([["alice", ALICE]])), "alice");
    await expect(store.get("outbox")).rejects.toBeInstanceOf(DecryptError);
  });

  it("returns null for missing keys and removes cleanly", async () => {
    const inner = new MemoryStore();
    const store = new EncryptedStore(inner, factoryFor(new Map([["alice", ALICE]])), "alice");
    expect(await store.get("missing")).toBeNull();
    await store.set("k", "v");
    await store.remove("k");
    expect(await store.get("k")).toBeNull();
  });
});

describe("assertSafeKey", () => {
  it("rejects colons and blanks", () => {
    expect(() => assertSafeKey("mano:session")).toThrow("Unsafe storage key");
    expect(() => assertSafeKey("")).toThrow("Unsafe storage key");
    expect(() => assertSafeKey("a b")).toThrow("Unsafe storage key");
    expect(() => assertSafeKey("mano.session")).not.toThrow();
    expect(() => assertSafeKey("dkey.maria-001")).not.toThrow();
  });
});
