import {
  RecordingChannel,
  StandInResponder,
  createLogger,
  type Logger,
  type NormalizedEvent,
  type Responder,
} from "@mano/channels";
import { ConversationRunner, DEFAULT_RUNNER_CONFIG, type RunnerConfig, type SpendLedger } from "../src/runner.js";
import { GlobalLedger, MemoryGlobalStore } from "../src/global.js";
import { MemoryStore } from "../src/store.js";
import { MemoryFileStore } from "../src/files.js";

export const TEST_PEPPER = "test-pepper-not-real";
export const TEST_KEK_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
export const TEST_HANDLE = "+15550001001";
export const TEST_HANDLE_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const TEST_CHAT = "chat_test_aaa";
export const TEST_CHANNEL = "ch_test_line";

export interface Harness {
  runner: ConversationRunner;
  store: MemoryStore;
  channel: RecordingChannel;
  responder: Responder;
  files: MemoryFileStore;
  ledger: GlobalLedger;
  lines: string[];
  logger: Logger;
  now: number;
  batchMs: number;
  advance(ms: number): void;
}

export function inboundEvent(overrides: Partial<NormalizedEvent> & { id: string }): NormalizedEvent {
  return {
    kind: "message.received",
    rawType: "message.received",
    channelId: TEST_CHANNEL,
    channelType: "blooio",
    chatId: TEST_CHAT,
    messageId: `msg_${overrides.id}`,
    group: null,
    handle: TEST_HANDLE,
    direction: "inbound",
    text: "Hello",
    attachments: [],
    errorCode: null,
    errorMessage: null,
    occurredAtMs: null,
    ...overrides,
  };
}

export function lifecycleEvent(
  kind: NormalizedEvent["kind"],
  id: string,
  messageId: string,
  errorCode: string | null = null,
): NormalizedEvent {
  return {
    id,
    kind,
    rawType: kind,
    channelId: TEST_CHANNEL,
    channelType: "blooio",
    chatId: TEST_CHAT,
    messageId,
    group: null,
    handle: TEST_HANDLE,
    direction: "outbound",
    text: null,
    attachments: [],
    errorCode,
    errorMessage: null,
    occurredAtMs: 0,
  };
}

export function makeHarness(
  opts: {
    replies?: string[];
    responder?: Responder;
    config?: Partial<RunnerConfig>;
    budgetUsd?: number;
    byteBudget?: number;
    startMs?: number;
    fetchFn?: typeof fetch;
  } = {},
): Harness {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const store = new MemoryStore();
  const channel = new RecordingChannel();
  const responder = opts.responder ?? new StandInResponder(opts.replies ?? ["Thanks for writing. Here is what I found."]);
  const files = new MemoryFileStore();
  const batchMs = opts.config?.batchMs ?? DEFAULT_RUNNER_CONFIG.batchMs;
  const h: Harness = {
    runner: null as unknown as ConversationRunner,
    store,
    channel,
    responder,
    files,
    ledger: null as unknown as GlobalLedger,
    lines,
    logger,
    now: opts.startMs ?? Date.parse("2026-10-28T12:00:00Z"),
    batchMs,
    advance(ms: number) {
      h.now += ms;
    },
  };
  h.ledger = new GlobalLedger(new MemoryGlobalStore(), () => h.now, opts.budgetUsd ?? 5, opts.byteBudget);
  const spend: SpendLedger = {
    reserve: async (key: string, worstUsd: number) => h.ledger.reserve(key, worstUsd),
    settle: async (key: string, actualUsd: number) => {
      h.ledger.settle(key, actualUsd);
    },
    byteReserve: async (key: string, bytes: number) => h.ledger.byteReserve(key, bytes),
    byteSettle: async (key: string, actualBytes: number) => {
      h.ledger.byteSettle(key, actualBytes);
    },
  };
  h.runner = new ConversationRunner({
    store,
    channel,
    responder,
    files,
    kekB64: TEST_KEK_B64,
    spend,
    logger,
    nowMs: () => h.now,
    fetchFn: opts.fetchFn ?? (async () => new Response("missing", { status: 404 })),
    config: { handleHash: TEST_HANDLE_HASH, ...DEFAULT_RUNNER_CONFIG, ...opts.config },
  });
  return h;
}

export async function runTurnAfterBatch(h: Harness): Promise<void> {
  h.advance(h.batchMs + 100);
  const result = await h.runner.runDueTurn();
  if (result !== "ran") throw new Error(`Expected a turn to run, got ${result}.`);
}
