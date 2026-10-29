// MeteredResponder: wraps any Responder and records one meter record
// per model call after each request. It never changes model selection:
// the inner responder picks the model, and this wrapper only reports
// what the provider said: input, output and reasoning tokens from the
// response's usage object, one record for every attempt including
// retries. Failed attempts carry zero tokens (the provider reported
// nothing for them) and status error.
//
// Metering never touches the reply path: records are launched without
// awaiting them, each on ctx.waitUntil when the worker passes one so
// the write survives the response, and no meter code (including the
// error hook) can throw into the responder. Tests use flush() to wait
// for launched records.
import {
  startCall,
  type DataClass,
  type MeterEnvironment,
  type MeterProvider,
  type MeterPurpose,
  type MeterRecorder,
  type UsageInput,
} from "@mano/meter";
import {
  ResponderFailed,
  STANDARD_MODEL_ID,
  type ModelUsage,
  type Responder,
  type ResponderResult,
  type TurnInput,
} from "./responder.js";

// The only meter surface this wrapper needs: one record call.
export type UsageMeter = Pick<MeterRecorder, "record">;

// ctx.waitUntil, or any equivalent. The worker passes
// (p) => ctx.waitUntil(p); without one, records still launch, they
// just do not hold the worker open.
export type WaitUntilFn = (promise: Promise<unknown>) => void;

export interface MeteredResponderOptions {
  meter: UsageMeter;
  purpose?: MeterPurpose;
  dataClass?: DataClass;
  environment?: MeterEnvironment;
  provider?: MeterProvider;
  // Model label when the inner call fails before returning one.
  model?: string;
  waitUntil?: WaitUntilFn;
  // Called with the error when recording fails. Must never throw into
  // the reply path; a throwing hook is caught and dropped.
  onMeterError?: (err: unknown) => void;
}

export class MeteredResponder implements Responder {
  readonly name: string;
  readonly maxAttempts: number;
  private inner: Responder;
  private meter: UsageMeter;
  private purpose: MeterPurpose;
  private dataClass: DataClass;
  private environment: MeterEnvironment;
  private provider: MeterProvider | null;
  private fallbackModel: string;
  private waitUntil: WaitUntilFn | null;
  private onMeterError: (err: unknown) => void;
  private inflight = new Set<Promise<void>>();

  constructor(inner: Responder, opts: MeteredResponderOptions) {
    this.inner = inner;
    this.name = inner.name;
    this.maxAttempts = inner.maxAttempts;
    this.meter = opts.meter;
    this.purpose = opts.purpose ?? "answer-texts";
    this.dataClass = opts.dataClass ?? "real";
    this.environment = opts.environment ?? "local";
    this.provider = opts.provider ?? null;
    this.fallbackModel = opts.model ?? (inner.name === "stand-in" ? "stand-in" : STANDARD_MODEL_ID);
    this.waitUntil = opts.waitUntil ?? null;
    this.onMeterError = opts.onMeterError ?? (() => {});
  }

  private providerFor(model: string): MeterProvider {
    if (this.provider) return this.provider;
    return model === "stand-in" ? "stand-in" : "meta";
  }

  private baseInput(model: string): Omit<UsageInput, "inputTokens" | "outputTokens" | "reasoningTokens" | "latencyMs" | "status"> {
    return {
      package: "channels",
      purpose: this.purpose,
      provider: this.providerFor(model),
      model,
      dataClass: this.dataClass,
      environment: this.environment,
    };
  }

  // One record call that cannot reject: record() failures go to the
  // hook, and a throwing hook is caught and dropped.
  private async safeRecord(input: UsageInput): Promise<void> {
    try {
      await this.meter.record(input);
    } catch (err) {
      try {
        this.onMeterError(err);
      } catch {
        // Meter code never throws into the responder.
      }
    }
  }

  // Launches recording off the reply path. Never awaited by respond(),
  // never throws: even waitUntil itself is guarded.
  private launch(work: Promise<void>): void {
    const tracked = work.then(
      () => {
        this.inflight.delete(tracked);
      },
      () => {
        this.inflight.delete(tracked);
      },
    );
    this.inflight.add(tracked);
    if (this.waitUntil) {
      try {
        this.waitUntil(tracked);
      } catch {
        // A broken waitUntil must not break the reply either.
      }
    }
  }

  // Waits for launched records. Tests use this; the reply path never does.
  async flush(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  private recordOk(result: ResponderResult, latencyMs: number): void {
    const attempts = Math.max(1, Math.floor(result.attempts) || 1);
    const base = this.baseInput(result.model);
    const usage: ModelUsage = result.usage;
    // Earlier attempts failed without reporting usage; the answering
    // attempt carries the provider's real counts and the full latency.
    for (let i = 1; i < attempts; i += 1) {
      this.launch(
        this.safeRecord({ ...this.baseInput(this.fallbackModel), inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, status: "error" }),
      );
    }
    this.launch(
      this.safeRecord({
        ...base,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        latencyMs,
        status: "ok",
      }),
    );
  }

  private recordError(err: unknown, latencyMs: number): void {
    const attempts = Math.max(1, Math.floor(err instanceof ResponderFailed ? err.attempts : 1) || 1);
    const base = this.baseInput(this.fallbackModel);
    for (let i = 1; i <= attempts; i += 1) {
      this.launch(
        this.safeRecord({
          ...base,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          latencyMs: i === attempts ? latencyMs : 0,
          status: "error",
        }),
      );
    }
  }

  async respond(turn: TurnInput): Promise<ResponderResult> {
    const elapsed = startCall();
    try {
      const result = await this.inner.respond(turn);
      this.recordOk(result, elapsed());
      return result;
    } catch (err) {
      this.recordError(err, elapsed());
      throw err;
    }
  }
}

export function meterResponder(
  inner: Responder,
  meter: UsageMeter,
  opts: Omit<MeteredResponderOptions, "meter"> = {},
): Responder {
  return new MeteredResponder(inner, { ...opts, meter });
}
