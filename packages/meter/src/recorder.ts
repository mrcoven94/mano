// Recorder: the one call every model client makes after each request.
// Build it once with the sinks for the environment (Analytics Engine
// in production, JSON lines locally), then await record() per call.
import { buildRecord, type BuildOptions, type UsageInput, type UsageRecord } from "./record.js";

export interface UsageSink {
  write(record: UsageRecord): void | Promise<void>;
}

export interface RecorderOptions extends BuildOptions {}

export class MeterRecorder {
  private sinks: UsageSink[];
  private opts: RecorderOptions;

  constructor(sinks: UsageSink[] = [], opts: RecorderOptions = {}) {
    this.sinks = sinks;
    this.opts = opts;
  }

  addSink(sink: UsageSink): void {
    this.sinks.push(sink);
  }

  async record(input: UsageInput): Promise<UsageRecord> {
    const record = buildRecord(input, this.opts);
    for (const sink of this.sinks) await sink.write(record);
    return record;
  }
}

// In-memory sink for tests and for callers that batch records before
// writing them elsewhere.
export class MemorySink implements UsageSink {
  records: UsageRecord[] = [];
  write(record: UsageRecord): void {
    this.records.push(record);
  }
}

// A sink that drops records. Used when metering is off; record() keeps
// its shape so callers never branch on environment.
export class NullSink implements UsageSink {
  write(): void {}
}

// Stopwatch for the latencyMs field. Start before the request, call the
// returned function after it settles:
//   const elapsed = startCall();
//   ... await the model ...
//   await meter.record({ ..., latencyMs: elapsed(), status: "ok" });
export function startCall(now: () => number = Date.now): () => number {
  const started = now();
  return () => Math.max(0, now() - started);
}
