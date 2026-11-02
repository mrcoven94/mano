// Tiny async mutex per key. JS runs one thing at a time, but an await
// between a check and a write lets a second caller slip in. Serializing
// the check-and-write on one promise chain per key makes code redemption
// and identity claims atomic.

export async function withKeyedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  locks.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}
