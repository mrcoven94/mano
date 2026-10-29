// Where the agent keeps durable rows: reminders, the turn ledger and the
// pending approval pointer. Redis (Vercel KV) when configured; process
// memory only in explicit local development; otherwise nothing, and
// callers refuse the work instead of accepting rows a restart would lose.
export type StorageMode = "redis" | "memory" | "missing";

export function storageMode(env: NodeJS.ProcessEnv = process.env): StorageMode {
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return "redis";
  if (env.MANO_ENV === "development" && env.VERCEL_ENV !== "production") return "memory";
  return "missing";
}

export class StorageUnavailable extends Error {
  constructor(what: string) {
    super(`${what} is not available right now: durable storage is not configured. Say so plainly and do not promise it.`);
    this.name = "StorageUnavailable";
  }
}

// The subset of Redis the agent uses, satisfied by @vercel/kv.
export interface RedisLike {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { nx?: boolean; px?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  hset(key: string, value: Record<string, unknown>): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  zadd(key: string, ...args: Array<{ score: number; member: string }>): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
}

// JSON values by key with an optional TTL. putIfAbsent is the one atomic
// step callers build claims on.
export interface KeyValue {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttlMs: number): Promise<void>;
  putIfAbsent(key: string, value: unknown, ttlMs: number): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class MemoryKeyValue implements KeyValue {
  private rows = new Map<string, { value: string; expiresAtMs: number }>();
  constructor(private now: () => number = Date.now) {}

  private live(key: string) {
    const row = this.rows.get(key);
    if (row && row.expiresAtMs <= this.now()) {
      this.rows.delete(key);
      return undefined;
    }
    return row;
  }

  async get<T>(key: string): Promise<T | null> {
    const row = this.live(key);
    return row ? (JSON.parse(row.value) as T) : null;
  }

  async put(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.rows.set(key, { value: JSON.stringify(value), expiresAtMs: this.now() + ttlMs });
  }

  async putIfAbsent(key: string, value: unknown, ttlMs: number): Promise<boolean> {
    if (this.live(key)) return false;
    await this.put(key, value, ttlMs);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }
}

export class RedisKeyValue implements KeyValue {
  constructor(private redis: RedisLike) {}

  async get<T>(key: string): Promise<T | null> {
    return (await this.redis.get<T>(key)) ?? null;
  }

  async put(key: string, value: unknown, ttlMs: number): Promise<void> {
    await this.redis.set(key, value, { px: ttlMs });
  }

  async putIfAbsent(key: string, value: unknown, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(key, value, { nx: true, px: ttlMs })) !== null;
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

let redis: Promise<RedisLike> | null = null;
let memoryKv: MemoryKeyValue | null = null;
let warned = false;

// Imported lazily so local runs without KV configured never load it.
export function redisClient(): Promise<RedisLike> {
  redis ??= import("@vercel/kv").then((m) => m.kv as unknown as RedisLike);
  return redis;
}

export async function getKeyValue(): Promise<KeyValue | null> {
  const mode = storageMode();
  if (mode === "redis") return new RedisKeyValue(await redisClient());
  if (mode === "memory") {
    if (!warned) {
      warned = true;
      console.warn("mano: no KV configured; MANO_ENV=development keeps agent state in process memory.");
    }
    memoryKv ??= new MemoryKeyValue();
    return memoryKv;
  }
  return null;
}

// Test seam: drops the cached in-memory rows.
export function resetKeyValue(): void {
  memoryKv = null;
}
