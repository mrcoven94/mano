// MeteredResponder: wraps any Responder and records one meter record
// after each request. It never changes model selection: the inner
// responder picks the model, and this wrapper only reports which model
// answered, with token counts estimated from the char counts the
// Responder interface already returns (about 4 chars per token).
// Metering never breaks a reply: a failing meter calls onMeterError
// (default: ignore) and the inner result or error passes through.
import { startCall, type DataClass, type MeterRecorder } from "@mano/meter";
import { ResponderFailed, STANDARD_MODEL_ID, type Responder, type ResponderResult, type TurnInput } from "./responder.js";

// The only meter surface this wrapper needs: one record call.
export type UsageMeter = Pick<MeterRecorder, "record">;

export interface MeteredResponderOptions {
  meter: UsageMeter;
  purpose?: string;
  dataClass?: DataClass;
  provider?: string;
  // Model label when the inner call fails before returning one.
  model?: string;
  onMeterError?: (err: unknown) => void;
}

// Rough chars-to-tokens estimate for meter counts. The spend ledger
// keeps its own char-based math; this only feeds usage records.
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

export class MeteredResponder implements Responder {
  readonly name: string;
  readonly maxAttempts: number;
  private inner: Responder;
  private meter: UsageMeter;
  private purpose: string;
  private dataClass: DataClass;
  private provider: string | null;
  private fallbackModel: string;
  private onMeterError: (err: unknown) => void;

  constructor(inner: Responder, opts: MeteredResponderOptions) {
    this.inner = inner;
    this.name = inner.name;
    this.maxAttempts = inner.maxAttempts;
    this.meter = opts.meter;
    this.purpose = opts.purpose ?? "answer-texts";
    this.dataClass = opts.dataClass ?? "real";
    this.provider = opts.provider ?? null;
    this.fallbackModel = opts.model ?? (inner.name === "stand-in" ? "stand-in" : STANDARD_MODEL_ID);
    this.onMeterError = opts.onMeterError ?? (() => {});
  }

  private providerFor(model: string): string {
    if (this.provider) return this.provider;
    return model === "stand-in" ? "stand-in" : "meta";
  }

  private async safeRecord(input: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    status: "ok" | "error";
  }): Promise<void> {
    try {
      await this.meter.record({
        package: "channels",
        purpose: this.purpose,
        provider: this.providerFor(input.model),
        model: input.model,
        dataClass: this.dataClass,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        latencyMs: input.latencyMs,
        status: input.status,
      });
    } catch (err) {
      this.onMeterError(err);
    }
  }

  async respond(turn: TurnInput): Promise<ResponderResult> {
    const elapsed = startCall();
    try {
      const result = await this.inner.respond(turn);
      await this.safeRecord({
        model: result.model,
        inputTokens: estimateTokens(result.inputChars),
        outputTokens: estimateTokens(result.outputChars),
        latencyMs: elapsed(),
        status: "ok",
      });
      return result;
    } catch (err) {
      const inputChars = err instanceof ResponderFailed ? err.inputChars : 0;
      await this.safeRecord({
        model: this.fallbackModel,
        inputTokens: estimateTokens(inputChars),
        outputTokens: 0,
        latencyMs: elapsed(),
        status: "error",
      });
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
