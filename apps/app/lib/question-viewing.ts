// Tracks which edges of a question the person has had in front of them,
// fed by the list's visibility reports and the app's foreground state. An
// edge counts once it has stayed on screen for the dwell in the foreground.
// Edges already counted stay counted while scrolling, so a question taller
// than the screen can be read by scrolling. Hidden time never counts, and
// leaving the foreground ends the viewing: both edges must be seen in one.

export const DWELL_MS = 500;

export class QuestionViewing {
  private visible: ReadonlySet<string> = new Set();
  private since = new Map<string, number>();
  private counted = new Set<string>();
  private foreground = false;

  setVisible(keys: ReadonlySet<string>, nowMs: number): void {
    this.credit(nowMs);
    this.visible = keys;
    if (!this.foreground) return;
    for (const key of this.since.keys()) if (!keys.has(key)) this.since.delete(key);
    for (const key of keys) if (!this.since.has(key)) this.since.set(key, nowMs);
  }

  enterForeground(nowMs: number): void {
    if (this.foreground) return;
    this.foreground = true;
    this.since = new Map([...this.visible].map((key) => [key, nowMs]));
  }

  leaveForeground(): void {
    this.foreground = false;
    this.since.clear();
    this.counted.clear();
  }

  seen(nowMs: number): ReadonlySet<string> {
    this.credit(nowMs);
    return new Set(this.counted);
  }

  // Milliseconds until the next edge finishes its dwell, or null for none.
  nextDueIn(nowMs: number): number | null {
    let next: number | null = null;
    for (const [key, at] of this.since) {
      if (this.counted.has(key)) continue;
      const left = Math.max(0, at + DWELL_MS - nowMs);
      if (next === null || left < next) next = left;
    }
    return next;
  }

  private credit(nowMs: number): void {
    for (const [key, at] of this.since) if (nowMs - at >= DWELL_MS) this.counted.add(key);
  }
}
