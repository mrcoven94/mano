// Deterministic PRNG (mulberry32) with string seeding via FNV-1a.
// Fixed seed committed in generator; same seed always yields same households.
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
