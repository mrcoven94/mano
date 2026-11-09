// Where one turn's time went, for the mano_turn log line: each Engine
// route the turn called (count and milliseconds), the agent run split by
// the Eve events it emitted (queue, setup before the first model call,
// time to first token, model, tools, other), and the turn's own steps. Numbers
// and fixed labels only: never a message, an ID or anything Engine
// returned.

// Every route the agent calls on Engine (lib/engine.ts). A call is
// labeled by the template it matches position by position, so an ID is
// never logged however it is spelled; a call matching none is "other".
const ROUTES = [
  "GET /approvals",
  "POST /approvals/supersede",
  "POST /approvals/fence",
  "POST /approvals/:id/approve",
  "POST /approvals/:id/reject",
  "POST /approvals/:id/retire",
  "PUT /approvals/:id/replay",
  "GET /approvals/:id/replay",
  "POST /action",
  "POST /turns",
  "GET /turns/:id",
  "POST /turns/:id/complete",
  "GET /pending-approval",
  "PUT /pending-approval",
  "DELETE /pending-approval",
  "GET /conversation",
  "DELETE /conversation",
  "GET /memory",
  "POST /memory",
  "DELETE /memory/:id",
  "GET /profile",
  "PATCH /profile",
  "GET /shares",
  "GET /reminders",
  "POST /reminders",
  "POST /reminders/:id/cancel",
  "GET /deadlines",
  "POST /deadlines",
  "PATCH /deadlines/:id",
  "DELETE /deadlines/:id",
  "GET /documents",
  "GET /documents/:id",
  "PATCH /documents/:id",
].map((label) => {
  const [method, path] = label.split(" ");
  return { label, method, segments: path.split("/").filter(Boolean) };
});

export function engineRoute(method: string, path: string): string {
  const segments = path.split("?")[0].split("/").filter(Boolean);
  const route = ROUTES.find(
    (r) => r.method === method && r.segments.length === segments.length && r.segments.every((s, i) => s === ":id" || s === segments[i]),
  );
  return route?.label ?? "other";
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
// Model output: the step's model call is still running while these arrive.
const MODEL_OUTPUT = new Set([...FIRST_TOKEN, "actions.requested"]);

// Splits an agent run by the emission times Eve stamps on each stream
// event (meta.at), so the split holds however late the stream is read.
export class AgentMarks {
  private turnStarted: number | null = null;
  private stepStarted: number | null = null;
  // The current step's last model output and last tool result.
  private modelEnded: number | null = null;
  private toolEnded: number | null = null;
  private firstStep: number | null = null;
  private firstToken: number | null = null;
  private last: number | null = null;
  private steps = 0;
  private modelMs = 0;
  private toolsMs = 0;

  constructor(private sentAt: number) {}

  observe(event: StampedEvent): void {
    const at = typeof event.meta?.at === "string" ? Date.parse(event.meta.at) : NaN;
    if (!Number.isFinite(at)) return;
    this.last = at;
    if (event.type === "turn.started") this.turnStarted ??= at;
    else if (event.type === "step.started") {
      this.stepStarted = at;
      this.modelEnded = null;
      this.toolEnded = null;
      this.firstStep ??= at;
      this.steps += 1;
    } else if (this.stepStarted === null) return;
    else if (MODEL_OUTPUT.has(event.type) && this.toolEnded === null) {
      this.modelEnded = at;
      if (FIRST_TOKEN.has(event.type)) this.firstToken ??= at;
    } else if (event.type === "action.result") this.toolEnded = at;
    else if (event.type === "step.completed" || event.type === "step.failed") {
      // Eve completes a step after its tools ran: the model ends at its
      // last output, and the tools from there to their last result.
      const modelEnded = this.modelEnded ?? at;
      this.modelMs += modelEnded - this.stepStarted;
      if (this.toolEnded !== null) this.toolsMs += Math.max(0, this.toolEnded - modelEnded);
      this.stepStarted = null;
    }
  }

  // queue: the send call to turn.started; setup: turn.started to the
  // first model call (Eve hooks and the dynamic instructions' Engine
  // reads); ttft: first model call to its first streamed token; model: all
  // model calls; tools: tool runs; other: the rest after the first model
  // call (between steps and after the last).
  write(into: Record<string, number>): void {
    into.steps = this.steps;
    if (this.turnStarted !== null) into.queue = this.turnStarted - this.sentAt;
    if (this.turnStarted !== null && this.firstStep !== null) into.setup = this.firstStep - this.turnStarted;
    if (this.firstStep !== null && this.firstToken !== null) into.ttft = this.firstToken - this.firstStep;
    into.model = this.modelMs;
    into.tools = this.toolsMs;
    if (this.firstStep !== null && this.last !== null) into.other = Math.max(0, this.last - this.firstStep - this.modelMs - this.toolsMs);
  }
}
