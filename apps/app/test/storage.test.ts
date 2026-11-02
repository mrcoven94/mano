import { describe, expect, it } from "vitest";
import { CookieStore, MemoryStore, SecureTokenStore, type SecureBackend } from "../lib/kv";

class FakeSecure implements SecureBackend {
  available = true;
  seen: string[] = [];
  private map = new Map<string, string>();
  async isAvailable(): Promise<boolean> {
    return this.available;
  }
  async get(key: string): Promise<string | null> {
    this.seen.push(key);
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.seen.push(key);
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.seen.push(key);
    this.map.delete(key);
  }
}

describe("SecureTokenStore", () => {
  it("uses dot keys with no colons on the real adapter", async () => {
    const backend = new FakeSecure();
    const store = new SecureTokenStore(backend);
    await store.set("session", "token");
    expect(await store.get("session")).toBe("token");
    await store.remove("session");
    expect(await store.get("session")).toBeNull();
    expect(backend.seen.length).toBeGreaterThan(0);
    for (const key of backend.seen) {
      expect(key).not.toContain(":");
      expect(key.startsWith("mano.")).toBe(true);
    }
  });

  it("fails closed when secure storage is unavailable", async () => {
    const backend = new FakeSecure();
    backend.available = false;
    const store = new SecureTokenStore(backend);
    expect(await store.get("session")).toBeNull();
    await store.set("session", "token");
    await store.remove("session");
    expect(backend.seen).toHaveLength(0);
  });
});

describe("CookieStore", () => {
  it("round-trips a session through a Secure SameSite cookie", async () => {
    const jar = { cookie: "" };
    const store = new CookieStore(jar);
    await store.set("session", JSON.stringify({ token: "abc;def" }));
    expect(jar.cookie).toContain("mano.session=");
    expect(jar.cookie).toContain("SameSite=Lax");
    expect(await store.get("session")).toBe(JSON.stringify({ token: "abc;def" }));
    await store.remove("session");
    expect(await store.get("session")).toBeNull();
  });
});

describe("MemoryStore", () => {
  it("round-trips", async () => {
    const store = new MemoryStore();
    await store.set("k", "v");
    expect(await store.get("k")).toBe("v");
    await store.remove("k");
    expect(await store.get("k")).toBeNull();
  });
});
