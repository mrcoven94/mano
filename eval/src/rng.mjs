// Deterministic randomness for the eval.
//
// Household generation uses HMAC-SHA256(seed, householdId) expanded in
// counter mode. Each household's stream carries the full entropy of the
// seed: there is no 32-bit root to brute force against the committed
// hashes. Same seed plus same householdId always yields the same stream.
//
// The legacy FNV/mulberry32 path stays only for non-secret deterministic
// effects (photo rendering jitter), where brute force buys nothing.
import { createHmac, createHash } from "node:crypto";

export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export function mulberry32(seedInt) {
  let a = seedInt >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function rngFromString(str) {
  return mulberry32(hashSeed(str));
}

// 32-byte household key. The seed never leaves this derivation.
export function householdKey(seed, householdId) {
  return createHmac("sha256", seed).update(`mano-eval-household:${householdId}`).digest();
}

// Counter-mode SHA-256 stream over the household key. Returns a next()
// function compatible with pick/intBetween/shuffle below.
export function rngForHousehold(seed, householdId) {
  const key = householdKey(seed, householdId);
  let counter = 0n;
  let buf = Buffer.alloc(0);
  let pos = 0;
  function refill() {
    const h = createHash("sha256");
    h.update(key);
    const c = Buffer.alloc(8);
    c.writeBigUInt64BE(counter);
    h.update(c);
    counter += 1n;
    buf = h.digest();
    pos = 0;
  }
  function nextBytes(n) {
    const out = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      if (pos >= buf.length) refill();
      const take = Math.min(n - off, buf.length - pos);
      buf.copy(out, off, pos, pos + take);
      pos += take;
      off += take;
    }
    return out;
  }
  function next() {
    return nextBytes(4).readUInt32BE(0) / 4294967296;
  }
  next.bytes = nextBytes;
  return next;
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
export function intBetween(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}
export function shuffle(rng, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
