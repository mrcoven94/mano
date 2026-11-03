// Where one turn's time went, for the mano_turn log line: each Engine
// route the turn called (count and milliseconds), the agent run split by
// the Eve events it emitted (queue, setup before the first model call,
// time to first token, model, tools), and the turn's own steps. Numbers
// and fixed labels only: never a message, an ID or anything Engine
// returned.

// One Engine route as a label: the method and the path's word segments,
// with every ID and the query dropped ("POST /turns/:id/complete").
export function engineRoute(method: string, path: string): string {
  const words = path
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map((s) => (/^[a-z]+(-[a-z]+)*$/.test(s) ? s : ":id"));
  return `${method} /${words.join("/")}`;
}

export class TurnClock {
  // Wall-clock milliseconds per turn step.
  readonly steps: Record<string, number> = {};
  // Engine route label: [calls, total milliseconds]. Concurrent calls
  // each count their own time.
  readonly engine: Record<string, [number, number]> = {};
  // Filled by the agent run (channels/mano.ts and settle.ts).
  readonly agent: Record<string, number> = {};

  constructor(private now: () => number = Date.now) {}

  async time<T>(step: string, work: () => Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await work();
    } finally {
      this.steps[step] = (this.steps[step] ?? 0) + this.now() - start;
    }
  }

  readonly engineCall = (route: string, ms: number): void => {
    const entry = (this.engine[route] ??= [0, 0]);
    entry[0] += 1;
    entry[1] += ms;
  };
}

interface StampedEvent {
  type: string;
  meta?: { at?: unknown };
}

const FIRST_TOKEN = new Set(["reasoning.appended", "message.appended", "action.input.appended"]);

// Splits an agent run by the emission times Eve stamps on each stream
// event (meta.at), so the split holds however late the stream is read.
export class AgentMarks {
  private turnStarted: number | null = null;
  private stepStarted: number | null = null;
  private firstStep: number | null = null;
  private firstToken: number | null = null;
  private last: number | null = null;
  private steps = 0;
  private modelMs = 0;

  constructor(private sentAt: number) {}

  observe(event: StampedEvent): void {
    const at = typeof event.meta?.at === "string" ? Date.parse(event.meta.at) : NaN;
    if (!Number.isFinite(at)) return;
    this.last = at;
    if (event.type === "turn.started") this.turnStarted ??= at;
    else if (event.type === "step.started") {
      this.stepStarted = at;
      this.firstStep ??= at;
      this.steps += 1;
    } else if (event.type === "step.completed" || event.type === "step.failed") {
      if (this.stepStarted !== null) this.modelMs += at - this.stepStarted;
      this.stepStarted = null;
    } else if (FIRST_TOKEN.has(event.type) && this.stepStarted !== null) this.firstToken ??= at;
  }

  // queue: send to turn.started; setup: turn.started to the first model
  // call (Eve hooks and the dynamic instructions' Engine reads); ttft:
  // first model call to its first streamed token; model: all model calls;
  // tools: the rest of the run after the first model call.
  write(into: Record<string, number>): void {
    into.steps = this.steps;
    if (this.turnStarted !== null) into.queue = this.turnStarted - this.sentAt;
    if (this.turnStarted !== null && this.firstStep !== null) into.setup = this.firstStep - this.turnStarted;
    if (this.firstStep !== null && this.firstToken !== null) into.ttft = this.firstToken - this.firstStep;
    into.model = this.modelMs;
    if (this.firstStep !== null && this.last !== null) into.tools = Math.max(0, this.last - this.firstStep - this.modelMs);
  }
}
