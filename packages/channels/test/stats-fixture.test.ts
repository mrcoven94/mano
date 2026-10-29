// Stats fixture: real channels records for the /stats page, plus the
// test that pins them. Generation runs the real production path (real
// SparkResponder with a stubbed network fetch, real StandInResponder,
// real MeteredResponder, real MeterRecorder) with fixed synthetic turns
// and writes apps/site/data/usage-<day>.jsonl through the real
// JsonLinesSink, plus usage.json and usage-summary.json copies. Every
// other run regenerates in memory and asserts the checked-in files
// still match, so the page can only ever show real recorder output.
//
// Regenerate: MANO_WRITE_STATS_FIXTURE=1 pnpm --filter @mano/channels test -- stats-fixture
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import {
  JsonLinesSink,
  MemorySink,
  MeterRecorder,
  RECORD_KEYS,
  formatLine,
  parseLine,
  summarizeDay,
  type UsageRecord,
  type UsageSink,
} from "@mano/meter";
import { nodeAppendLine } from "../../meter/src/nodefs.js";
import { SparkResponder, StandInResponder } from "../src/responder.js";
import { meterResponder } from "../src/metered.js";

// Fixed so regeneration is byte-identical apart from measured latency.
const DAY = "2026-10-29";
const FIXED_AT = `${DAY}T12:00:00.000Z`;
const DATA_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../apps/site/data");

const LIVE_TURNS: Array<{ texts: string[]; attachmentCount: number; reply: string; sleepMs: number }> = [
  { texts: ["What help can I get with rent?"], attachmentCount: 0, reply: "There is emergency rent help in your county. I can explain who qualifies and what to send.", sleepMs: 12 },
  { texts: ["My hours got cut to 20 a week."], attachmentCount: 0, reply: "Sorry to hear that. A smaller paycheck can raise your food benefits; I can walk through the numbers.", sleepMs: 7 },
  { texts: ["Got a renewal letter. What does it mean?"], attachmentCount: 1, reply: "It means the county needs fresh proof once a year. I saved the photo and listed what they asked for.", sleepMs: 18 },
  { texts: ["Can you fill out this form for me?"], attachmentCount: 0, reply: "Yes. I drafted it from your vault and marked the two lines I could not fill.", sleepMs: 9 },
  { texts: ["When is my light bill help due?"], attachmentCount: 0, reply: "The winter program opens next month. I set a reminder for the first day.", sleepMs: 14 },
  { texts: ["I need child care while I work."], attachmentCount: 0, reply: "There are three programs that pay part of daycare. I can check which ones take new families.", sleepMs: 6 },
  { texts: ["My medicine costs too much."], attachmentCount: 0, reply: "Two discount programs cover that prescription. I can explain both and what they ask for.", sleepMs: 21 },
  { texts: ["Help me reply to my landlord."], attachmentCount: 0, reply: "I drafted a short note asking for two more weeks. It is ready for you to approve.", sleepMs: 11 },
  { texts: ["Is my application still open?"], attachmentCount: 0, reply: "Yes, the county shows it as received. I will check again tomorrow and tell you if it moves.", sleepMs: 8 },
  { texts: ["What is an EBT card?"], attachmentCount: 0, reply: "It is the card food benefits arrive on each month. Groceries only, and it works like a debit card.", sleepMs: 16 },
  { texts: ["Can you wait on hold for me?"], attachmentCount: 0, reply: "Yes. I will call, wait through the hold music, and text you when a person picks up.", sleepMs: 10 },
  { texts: ["My address changed last week."], attachmentCount: 0, reply: "I updated your vault and listed the three offices that need the new address.", sleepMs: 13 },
];

const STAND_IN_TURNS = [
  "Hello, is anyone there?",
  "What can you do?",
  "Thanks, goodbye.",
];

const STAND_IN_REPLIES = [
  "Hi. I am Mano, running without a model key in this test.",
  "I explain programs, deadlines and next steps in plain language.",
  "Goodbye. I am here whenever you need help.",
];

function okFetch(reply: string, sleepMs: number): typeof fetch {
  return (async () => {
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
    return new Response(
      JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: reply }] }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network down for the fixture error turn");
  }) as unknown as typeof fetch;
}

// Drives the real responder stack and returns the records the meter kept.
async function driveFixture(sinks: UsageSink[]): Promise<UsageRecord[]> {
  const memory = new MemorySink();
  const meter = new MeterRecorder([memory, ...sinks], { at: FIXED_AT });
  for (const turn of LIVE_TURNS) {
    const inner = new SparkResponder({ apiKey: "fixture-key-not-real", fetchFn: okFetch(turn.reply, turn.sleepMs) });
    const responder = meterResponder(inner, meter, { dataClass: "synthetic" });
    const result = await responder.respond({ texts: turn.texts, attachmentCount: turn.attachmentCount });
    expect(result.model).toBe("muse-spark-1.3");
  }
  const standIn = meterResponder(new StandInResponder([...STAND_IN_REPLIES]), meter, { dataClass: "synthetic" });
  for (const text of STAND_IN_TURNS) {
    const result = await standIn.respond({ texts: [text], attachmentCount: 0 });
    expect(result.model).toBe("stand-in");
  }
  const failing = meterResponder(
    new SparkResponder({ apiKey: "fixture-key-not-real", fetchFn: failingFetch(), maxRetries: 0 }),
    meter,
    { dataClass: "synthetic" },
  );
  await expect(failing.respond({ texts: ["Will this fail?"], attachmentCount: 0 })).rejects.toThrow();
  return memory.records;
}

function jsonlFile(): string {
  const names = readdirSync(DATA_DIR).filter((n) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
  expect(names).toHaveLength(1);
  return path.join(DATA_DIR, names[0]!);
}

function stripLatency(records: UsageRecord[]): Array<Omit<UsageRecord, "latencyMs">> {
  return records.map(({ latencyMs: _ignored, ...rest }) => rest);
}

describe("stats fixture", () => {
  it("checked-in usage files match a fresh run of the real recorder", async () => {
    if (process.env.MANO_WRITE_STATS_FIXTURE === "1") {
      mkdirSync(DATA_DIR, { recursive: true });
      for (const name of readdirSync(DATA_DIR)) {
        if (/^usage-.*\.jsonl$/.test(name) || name === "usage.json" || name === "usage-summary.json") {
          rmSync(path.join(DATA_DIR, name));
        }
      }
      const sink = new JsonLinesSink({ dir: DATA_DIR, day: DAY, appendLine: nodeAppendLine });
      const records = await driveFixture([sink]);
      expect(records).toHaveLength(LIVE_TURNS.length + STAND_IN_TURNS.length + 1);
      writeFileSync(path.join(DATA_DIR, "usage.json"), `${JSON.stringify(records, null, 2)}\n`);
      writeFileSync(path.join(DATA_DIR, "usage-summary.json"), `${JSON.stringify(summarizeDay(records, DAY), null, 2)}\n`);
      expect(existsSync(sink.path())).toBe(true);
      return;
    }

    const lines = readFileSync(jsonlFile(), "utf8").trim().split("\n");
    const filed = lines.map(parseLine);
    expect(filed.length).toBe(LIVE_TURNS.length + STAND_IN_TURNS.length + 1);
    // Production shape: exactly the record keys, channels package,
    // synthetic test traffic, known models only.
    const allowedKeys = [...RECORD_KEYS].sort();
    for (const record of filed) {
      expect(Object.keys(record).sort()).toEqual(allowedKeys);
      expect(record.package).toBe("channels");
      expect(record.purpose).toBe("answer-texts");
      expect(record.dataClass).toBe("synthetic");
      expect(record.at).toBe(FIXED_AT);
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(filed.map((r) => r.model).sort()).toEqual(
      [...Array<string>(LIVE_TURNS.length + 1).fill("muse-spark-1.3"), ...Array<string>(STAND_IN_TURNS.length).fill("stand-in")].sort(),
    );
    expect(filed.filter((r) => r.status === "error")).toHaveLength(1);
    expect(filed.filter((r) => r.provider === "meta")).toHaveLength(LIVE_TURNS.length + 1);
    // Latencies were really measured: every live turn slept first.
    const liveLatencies = filed.filter((r) => r.model === "muse-spark-1.3" && r.status === "ok").map((r) => r.latencyMs);
    expect(liveLatencies).toHaveLength(LIVE_TURNS.length);
    const minSleep = Math.min(...LIVE_TURNS.map((t) => t.sleepMs));
    for (const latency of liveLatencies) expect(latency).toBeGreaterThanOrEqual(minSleep - 1);

    const fresh = await driveFixture([]);
    expect(stripLatency(fresh)).toEqual(stripLatency(filed));

    const usageJson = JSON.parse(readFileSync(path.join(DATA_DIR, "usage.json"), "utf8")) as UsageRecord[];
    expect(usageJson).toEqual(filed);
    expect(lines).toEqual(filed.map(formatLine));
    const summary = JSON.parse(readFileSync(path.join(DATA_DIR, "usage-summary.json"), "utf8"));
    expect(summary).toEqual(summarizeDay(filed, DAY));
  }, 30000);
});
