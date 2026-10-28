// Key-value primitives with no native dependencies: safe key rules,
// the in-memory store, the injectable secure store and the web cookie
// jar. Platform singletons live in storage.ts; tests import this file.

export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

// Dots, never colons: SecureStore rejects keys with colons.
export function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`Unsafe storage key: ${key}`);
}

export const STORE_PREFIX = "mano.";

export class MemoryStore implements KeyValue {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    assertSafeKey(key);
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    assertSafeKey(key);
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    this.map.delete(key);
  }
}

export interface SecureBackend {
  isAvailable(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class SecureTokenStore implements KeyValue {
  private backend: SecureBackend;
  constructor(backend: SecureBackend) {
    this.backend = backend;
  }
  private name(key: string): string {
    assertSafeKey(key);
    return `${STORE_PREFIX}${key}`;
  }
  async get(key: string): Promise<string | null> {
    if (!(await this.backend.isAvailable())) return null;
    return this.backend.get(this.name(key));
  }
  async set(key: string, value: string): Promise<void> {
    if (!(await this.backend.isAvailable())) return;
    await this.backend.set(this.name(key), value);
  }
  async remove(key: string): Promise<void> {
    if (!(await this.backend.isAvailable())) return;
    await this.backend.remove(this.name(key));
  }
}

export interface CookieJar {
  cookie: string;
}

function defaultJar(): CookieJar {
  if (typeof document === "undefined") return { cookie: "" };
  return document;
}

function cookieSecure(): boolean {
  if (typeof location === "undefined") return true;
  return !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
}

// Web session jar. One cookie per key, Secure (except localhost) and
// SameSite=Lax. Only the session uses this store.
export class CookieStore implements KeyValue {
  private jar: CookieJar;
  constructor(jar: CookieJar = defaultJar()) {
    this.jar = jar;
  }
  private name(key: string): string {
    assertSafeKey(key);
    return `${STORE_PREFIX}${key}`;
  }
  async get(key: string): Promise<string | null> {
    const name = this.name(key);
    const parts = this.jar.cookie.split(";");
    for (const part of parts) {
      const [rawName, ...rest] = part.trim().split("=");
      if (rawName === name) {
        const value = rest.join("=");
        if (!value) return null;
        try {
          return decodeURIComponent(value);
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  async set(key: string, value: string): Promise<void> {
    const attrs = ["Path=/", "Max-Age=86400", "SameSite=Lax"];
    if (cookieSecure()) attrs.push("Secure");
    this.jar.cookie = `${this.name(key)}=${encodeURIComponent(value)}; ${attrs.join("; ")}`;
  }
  async remove(key: string): Promise<void> {
    this.jar.cookie = `${this.name(key)}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}
