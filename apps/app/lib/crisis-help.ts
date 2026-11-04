// The crisis line, kept for a sign-out that lands on the sign-in screen: an
// expired session or a refused older send can sign a person out in the same
// moment they asked for help, before the line reaches the screen. Only the
// fixed words are kept, never what the person wrote, in memory only, and
// only for a while, so a later person on a shared device does not see them.

const KEEP_MS = 30 * 60_000;

let kept: { line: string; atMs: number } | null = null;

export function noteCrisisLine(line: string, nowMs: number): void {
  kept = { line, atMs: nowMs };
}

export function crisisLineForSignIn(nowMs: number): string | null {
  return kept && nowMs - kept.atMs < KEEP_MS ? kept.line : null;
}

export function forgetCrisisLine(): void {
  kept = null;
}
