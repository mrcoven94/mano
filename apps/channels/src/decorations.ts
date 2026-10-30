// Decoration work (the eyes swap and settle, the chat background) runs
// here, outside the turn: a turn finishes and settles first, so a slow or
// hanging provider call can never hold the next message, a crisis
// included. Every piece is tracked, bounded by a timeout and cancellable;
// STOP, a close and a delete cancel all of it, pending timers included. The work does its own STOP, closed
// and generation checks right before each provider call.

export interface DecorationsOptions {
  // How long one piece may run before it is cancelled.
  timeoutMs?: number;
  // Keeps the host alive until the work settles (a Durable Object's
  // ctx.waitUntil). It is never awaited by a turn.
  hold?: (work: Promise<unknown>) => void;
  // Called with the piece's name when it throws or times out.
  onError?: (name: string, err: unknown) => void;
}

export const DECORATION_TIMEOUT_MS = 60_000;

interface Running {
  name: string;
  controller: AbortController;
  done: Promise<void>;
}

export class Decorations {
  private running = new Map<number, Running>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private next = 0;
  private timeoutMs: number;
  private hold: (work: Promise<unknown>) => void;
  private onError: (name: string, err: unknown) => void;

  constructor(opts: DecorationsOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DECORATION_TIMEOUT_MS;
    this.hold = opts.hold ?? (() => {});
    this.onError = opts.onError ?? (() => {});
  }

  // Starts a piece of work and returns at once.
  run(name: string, work: (signal: AbortSignal) => Promise<void>): void {
    const id = this.next++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${name} timed out`)), this.timeoutMs);
    // The work races its own signal, so a call that ignores the signal
    // still stops being tracked when the timeout or a cancel fires.
    const aborted = new Promise<void>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const done = Promise.race([Promise.resolve().then(() => work(controller.signal)), aborted])
      .catch((err: unknown) => this.onError(name, err))
      .finally(() => {
        clearTimeout(timer);
        this.running.delete(id);
      });
    this.running.set(id, { name, controller, done });
    this.hold(done);
  }

  // Runs work after a delay, unless cancelled first (the eyes timer).
  // Returns the cancel function.
  schedule(name: string, ms: number, work: () => void): () => void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      work();
    }, ms);
    this.timers.add(timer);
    return () => {
      clearTimeout(timer);
      this.timers.delete(timer);
    };
  }

  // Cancels every pending timer and everything still running (STOP, a
  // close, a delete).
  cancelAll(reason = "cancelled"): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const r of this.running.values()) r.controller.abort(new Error(reason));
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  get size(): number {
    return this.running.size;
  }

  // Resolves when nothing is running. For tests and shutdown.
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()].map((r) => r.done));
  }
}
