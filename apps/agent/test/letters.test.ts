import { setTimeout as realSleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { engineFrom, personIdFor } from "../agent/lib/engine.js";
import { handleTurn, type AgentTurnInput, type TurnDeps } from "../agent/lib/turn.js";
import {
  DOUBTFUL_PAGE,
  PLANTED_INSTRUCTION,
  PLANTED_DEADLINE,
  PLANTED_DEADLINE_PAGE,
  PLANTED_PAGE,
  RENEWAL_PAGE,
  letterPhoto,
  recordedReader,
} from "../../../packages/mail/test/letter-fixture.js";
import { MetaModelClient } from "../../../packages/mail/src/model.js";
import { renderDeadlines } from "../agent/lib/deadlines.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

// A photo of a letter texted to the line: Channels stored it in Engine
// and sends its reference with the turn. The agent reads it (SAM 3.1
// split, Muse Spark read; recorded here), answers in the same reply,
// holds a published deadline in Engine, and only then lets the model add
// a line, with the reading as evidence.
const SECRET = "letters-test-secret";
const HANDLE = "c".repeat(64);
const PERSON = personIdFor(HANDLE);
const DOC = "g0t1i0-0123456789ab";

let engine: EngineDouble;
let grant: string;
let calls: AgentTurnInput[];

function photoTurn(
  turnId: string,
  opts: { texts?: string[]; documents?: { id: string; mimeType: string }[]; attachmentCount?: number; generation?: number } = {},
) {
  const raw = JSON.stringify({
    turnId,
    generation: opts.generation ?? 0,
    handleHash: HANDLE,
    grant,
    receivedAt: Date.now(),
    texts: opts.texts ?? [],
    attachmentCount: opts.attachmentCount ?? 1,
    documents: opts.documents ?? [{ id: DOC, mimeType: "image/jpeg" }],
  });
  const ts = Math.floor(Date.now() / 1000);
  return new Request("http://agent.test/channels/mano/turn", {
    method: "POST",
    headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(SECRET, ts, raw) },
    body: raw,
  });
}

function deps(pages: string[], overrides: Partial<TurnDeps> = {}): TurnDeps {
  return {
    secret: SECRET,
    engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch }),
    mailModel: recordedReader(pages),
    async runAgent(input) {
      calls.push(input);
      return { status: "replied" as const, text: "Want a reminder a week before?", reason: "stop" };
    },
    ...overrides,
  };
}

async function send(request: Request, d: TurnDeps) {
  const res = await handleTurn(request, d);
  return { status: res.status, body: (await res.json()) as { status: string; text: string } };
}

beforeEach(async () => {
  engine = new EngineDouble();
  calls = [];
  grant = await grantFor(HANDLE);
  engine.putDocument(PERSON, DOC, new Uint8Array(await letterPhoto()));
  vi.stubGlobal("fetch", engine.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The fixture letter's deadline is a fixed date; a turn that depends on
// where today falls against it names its own day.
async function dayIs(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(iso));
  grant = await grantFor(HANDLE);
}

describe("a texted letter for someone who writes in another language", () => {
  it.each([
    ["Spanish", "Esta es una carta de renovación de Medi-Cal. Vence el 20 de noviembre de 2026.", "Guardé el 20 de noviembre de 2026 en sus fechas límite."],
    ["Vietnamese", "Đây là thư gia hạn Medi-Cal. Hạn chót là ngày 20 tháng 11 năm 2026.", "Tôi đã lưu ngày 20 tháng 11 năm 2026 vào danh sách hạn chót của bạn."],
    ["Tagalog", "Ito ay sulat ng pag-renew ng Medi-Cal. Ang huling araw ay Nobyembre 20, 2026.", "Na-save ko ang Nobyembre 20, 2026 sa iyong mga deadline."],
  ])("is answered in %s when the profile says so, and the deadline Mano holds is the same date", async (language, opens, saved) => {
    await dayIs("2026-11-03T18:00:00.000Z");
    const person = engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!.forHandle(HANDLE, grant, 0);
    await person.patchProfile({ idempotencyKey: `lang-${language}`, source: "person", fields: { "person.language": language } });
    const { body } = await send(photoTurn("turn_letter_lang"), deps([RENEWAL_PAGE]));
    expect(body.text.startsWith(opens)).toBe(true);
    expect(body.text).toContain(saved);
    expect(engine.deadlineCalls[0]!.body).toMatchObject({ title: "Medi-Cal renewal", kind: "renewal", dueDate: "2026-11-20" });
  });

  it("follows the language of the words sent with the photo", async () => {
    await dayIs("2026-11-03T18:00:00.000Z");
    const { body } = await send(photoTurn("turn_letter_lang2", { texts: ["Hola, qué dice esta carta"] }), deps([RENEWAL_PAGE]));
    expect(body.text.startsWith("Esta es una carta de renovación de Medi-Cal.")).toBe(true);
  });
});

describe("a crisis Channels' floor found, with a photo", () => {
  function crisisPhotoTurn(turnId: string, text: string) {
    const raw = JSON.stringify({
      turnId, generation: 0, handleHash: HANDLE, grant, receivedAt: Date.now(), texts: [text], attachmentCount: 1, documents: [{ id: DOC, mimeType: "image/jpeg" }], crisis: true,
    });
    const ts = Math.floor(Date.now() / 1000);
    return new Request("http://agent.test/channels/mano/turn", {
      method: "POST",
      headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(SECRET, ts, raw) },
      body: raw,
    });
  }

  it("tells the model, in a language the agent's own words do not cover", async () => {
    await send(crisisPhotoTurn("turn_crisis_tl_01", "Papatayin ko ang sarili ko"), deps([RENEWAL_PAGE]));
    expect(calls[0]!.context.join("\n")).toMatch(/988/);
  });

  it("with no time left for the model, answers with the letter alone, for Channels to open with the line", async () => {
    await dayIs("2026-11-03T18:00:00.000Z");
    const { body } = await send(crisisPhotoTurn("turn_crisis_vi_01", "Chồng tôi đang đánh tôi"), deps([RENEWAL_PAGE], { turnBudgetMs: 10_000 }));
    expect(calls).toHaveLength(0);
    expect(body.status).toBe("replied");
    expect(body.text).toMatch(/Medi-Cal/);
  });
});

describe("a texted letter", () => {
  it("is answered in the same reply: what it is, the deadline, what to send, and the deadline is held in Engine", async () => {
    await dayIs("2026-11-03T18:00:00.000Z");
    const { status, body } = await send(photoTurn("turn_letter0001"), deps([RENEWAL_PAGE]));
    expect(status).toBe(200);
    expect(body.text).toMatch(/^This is a Medi-Cal renewal letter\. It is due November 20, 2026\./);
    expect(body.text).toContain("It asks you to send: other documents the letter lists.");
    expect(body.text).toContain("I saved November 20, 2026 to your deadlines.");
    expect(engine.deadlineCalls).toHaveLength(1);
    expect(engine.deadlineCalls[0]!.body).toMatchObject({
      title: "Medi-Cal renewal",
      kind: "renewal",
      dueDate: "2026-11-20",
      program: "Medicaid",
      source: { kind: "letter", documentId: DOC, sentence: "Your renewal is due November 20, 2026." },
      generation: 0,
    });
    expect(String(engine.deadlineCalls[0]!.body.idempotencyKey)).toMatch(/^[0-9a-f]{40}$/);
    // When the photo arrived: the turn's receive time from Channels.
    const source = engine.deadlineCalls[0]!.body.source as { receivedAt?: string };
    expect(Date.parse(source.receivedAt ?? "")).toBeGreaterThan(Date.now() - 60_000);
    // A photo with no words is answered from the reading alone, and Mano
    // remembers what it said for the next turn.
    expect(calls).toHaveLength(0);
    expect(engine.memoryOf(PERSON).join("\n")).toContain("November 20, 2026");
  });

  it("with words, the model answers them after the reading, seeing it only as evidence", async () => {
    const { body } = await send(photoTurn("turn_letter0010", { texts: ["Can you help me renew?"] }), deps([RENEWAL_PAGE]));
    expect(body.text).toMatch(/^This is a Medi-Cal renewal letter\./);
    expect(body.text).toMatch(/\n\nWant a reminder a week before\?$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.message).toContain("Can you help me renew?");
    // The reading is data in the person's turn, never a system instruction.
    expect(calls[0]!.message).toMatch(/<letter_reading>\n\{"photoRead":true,"alreadySent":"This is a Medi-Cal renewal letter\.[^\n]*\n<\/letter_reading>$/);
    const context = calls[0]!.context.join("\n");
    expect(context).not.toContain("November 20, 2026");
    expect(context).not.toContain("Medi-Cal");
    expect(context).toMatch(/letter_reading block/);
  });

  it("asks one question quoting the sentence when the gate does not publish the deadline, and holds nothing", async () => {
    const { body } = await send(photoTurn("turn_letter0002"), deps([DOUBTFUL_PAGE]));
    expect(engine.deadlineCalls).toHaveLength(0);
    expect(body.text).toMatch(/Your letter mentions more than one date, and I don't want to guess wrong\. Which date does it say you need to meet\?$/);
    expect(body.text).not.toContain("November 20");
    expect(body.text).not.toContain("to your deadlines");
  });

  it("never follows or passes on an instruction planted in the letter", async () => {
    const { body } = await send(photoTurn("turn_letter0003", { texts: ["What is this?"] }), deps([PLANTED_PAGE]));
    expect(body.text).toContain("I did not follow them.");
    expect(body.text).not.toContain("300-4000");
    const toModel = [calls[0]!.message, ...calls[0]!.context].join("\n");
    expect(toModel).not.toContain(PLANTED_INSTRUCTION.slice(0, 30));
    expect(toModel).not.toContain("300-4000");
    expect(calls[0]!.message).toContain("What is this?");
  });

  it("says the deadline could not be saved when Engine has no deadlines route yet", async () => {
    engine.deadlinesLive = false;
    const { body } = await send(photoTurn("turn_letter0004"), deps([RENEWAL_PAGE]));
    expect(body.text).toContain("November 20, 2026");
    expect(body.text).not.toContain("I saved");
    expect(body.text).toContain("I could not save November 20, 2026 to your deadlines yet.");
  });

  it("sends the generation the turn started under, and a refused deadline is never called saved", async () => {
    await send(photoTurn("turn_letter0011", { generation: 2 }), deps([RENEWAL_PAGE]));
    expect(engine.deadlineCalls[0]!.body.generation).toBe(2);

    // The conversation is deleted (moved to generation 3) while the
    // letter is read: Engine refuses the deadline, and the reply says so.
    const moved = deps([RENEWAL_PAGE]);
    const turnEngine = moved.engine!;
    moved.engine = {
      forHandle: (h, g, gen) => {
        const person = turnEngine.forHandle(h, g, gen);
        const save = person.saveDeadline.bind(person);
        person.saveDeadline = async (input) => {
          await turnEngine.forHandle(h, g, gen + 1).advanceConversation();
          return save(input);
        };
        return person;
      },
    };
    const { body } = await send(photoTurn("turn_letter0012", { generation: 2 }), moved);
    expect(body.text).not.toContain("I saved");
    expect(body.text).toContain("I could not save November 20, 2026 to your deadlines just now.");
    expect(engine.deadlineCalls).toHaveLength(1);
  });

  it("a letter whose date has gone by says so instead of promising a reminder", async () => {
    await dayIs("2026-12-01T18:00:00.000Z");
    const { body } = await send(photoTurn("turn_letter0020"), deps([RENEWAL_PAGE]));
    expect(body.text).toContain("It is due November 20, 2026.");
    expect(body.text).not.toContain("I saved");
    expect(body.text).toContain("November 20, 2026 has already passed, so no reminder will go out.");
    // Kept as what the letter said: the model reads it as "was due".
    const [kept] = engine.deadlinesOf(PERSON);
    expect(kept).toMatchObject({ dueDate: "2026-11-20", nudges: [] });
    expect(renderDeadlines([kept!], Date.now())).toContain("was due 2026-11-20");
  });

  it("a retried turn holds the same deadline once", async () => {
    await send(photoTurn("turn_letter0005"), deps([RENEWAL_PAGE]));
    await send(photoTurn("turn_letter0005"), deps([RENEWAL_PAGE]));
    expect(engine.deadlineCalls).toHaveLength(2);
    expect(engine.deadlinesOf(PERSON)).toHaveLength(1);
  });

  it("says honestly when the reading failed, offers to try again, and invents nothing", async () => {
    const { body } = await send(photoTurn("turn_letter0006"), deps([]));
    expect(body.text).toMatch(/could not finish reading/i);
    expect(body.text).toMatch(/again/i);
    expect(body.text).not.toContain("November");
    expect(engine.deadlineCalls).toHaveLength(0);
  });

  it("logs why a photo went unread, in fixed labels with nothing from the page", async () => {
    engine.putDocument(PERSON, "doc-broken", new TextEncoder().encode("%PDF-1.4 not a picture"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { body } = await send(photoTurn("turn_letter0090", { documents: [{ id: "doc-broken", mimeType: "image/jpeg" }] }), deps([]));
      expect(body.text).toContain("I could not read the letter in your photo.");
      const line = log.mock.calls.map(([m]) => String(m)).find((m) => m.includes("mano_letters_read"));
      expect(JSON.parse(line!)).toMatchObject({ letters: 0, asked: ["unreadable_page"] });
    } finally {
      log.mockRestore();
    }
  });

  it("logs why a reading failed as a fixed kind, never the provider's words", async () => {
    const provider = "Billing failed for Maria Santos on key mk-synthetic-7f3a91.";
    const mailModel = new MetaModelClient({
      apiKey: "k",
      maxRetries: 0,
      fetchFn: (async () => Response.json({ error: { message: provider } }, { status: 402 })) as typeof fetch,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { body } = await send(photoTurn("turn_letter0091"), deps([], { mailModel }));
      expect(body.text).toContain("I could not finish reading your photo");
      const line = log.mock.calls.map(([m]) => String(m)).find((m) => m.includes("mano_letters_read"))!;
      expect(JSON.parse(line)).toMatchObject({ asked: ["read_failed"], failed: ["billing"] });
      expect(line).not.toContain("Maria Santos");
      expect(line).not.toContain("mk-synthetic");
    } finally {
      log.mockRestore();
    }
  });

  it("stops waiting on a slow reading and says so", async () => {
    const slow = {
      live: true,
      responses: (_req: unknown, opts?: { deadline?: number }) =>
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("aborted")), Math.max(0, (opts?.deadline ?? Date.now()) - Date.now()) + 5)),
    };
    const started = Date.now();
    const { body } = await send(photoTurn("turn_letter0007"), deps([], { mailModel: slow as never, turnBudgetMs: 8_400 }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(body.text).toMatch(/could not finish reading/i);
  });

  it("says so when the photo was not stored", async () => {
    const { body } = await send(photoTurn("turn_letter0008", { documents: [] }), deps([RENEWAL_PAGE]));
    expect(body.text).toMatch(/could not save your photo/i);
    expect(engine.deadlineCalls).toHaveLength(0);
  });

  it("review blocker 1: a deadline sentence with an instruction and a phone reaches neither the reply nor the model", async () => {
    const { body } = await send(photoTurn("turn_letter0013", { texts: ["What is this?"] }), deps([PLANTED_DEADLINE_PAGE]));
    expect(body.text).toContain("the letter gives a deadline of November 20, 2026");
    const everything = [body.text, calls[0]!.message, ...calls[0]!.context].join("\n");
    expect(everything).not.toMatch(/ignore previous/i);
    expect(everything).not.toContain("300-4000");
    expect(everything).not.toContain(PLANTED_DEADLINE.slice(0, 40));
    expect(engine.deadlineCalls).toHaveLength(0);
  });

  it("review should-fix 6: the reading is the answer when the conversational model fails", async () => {
    const failing = deps([RENEWAL_PAGE], { runAgent: async () => ({ status: "failed" as const, text: "", reason: "error" }) });
    const { status, body } = await send(photoTurn("turn_letter0014", { texts: ["Can you help me renew?"] }), failing);
    expect(status).toBe(200);
    expect(body.status).toBe("replied");
    expect(body.text).toMatch(/^This is a Medi-Cal renewal letter\./);
  });

  it("review should-fix 5: one deadline for the turn; a reading that uses most of it is the whole reply", async () => {
    const recorded = recordedReader([RENEWAL_PAGE]);
    const slowRead = { live: false, responses: async (req: never, opts: never) => {
      await new Promise((r) => setTimeout(r, 2_600));
      return recorded.responses(req, opts);
    } };
    const { body } = await send(photoTurn("turn_letter0015", { texts: ["Can you help me renew?"] }), deps([], { mailModel: slowRead as never, turnBudgetMs: 20_000 }));
    expect(calls).toHaveLength(0);
    expect(body.text).toMatch(/^This is a Medi-Cal renewal letter\./);
    expect(body.text).toContain("November 20, 2026");
  }, 15_000);

  it("review 2 should-fix 3: a deadline write that does not fit the turn is cut off, and the reply says the date is not saved yet", async () => {
    engine.deadlinesDelayMs = 30_000;
    const started = Date.now();
    const { body } = await send(photoTurn("turn_letter0016"), deps([RENEWAL_PAGE], { turnBudgetMs: 10_000 }));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(body.text).toContain("I could not save November 20, 2026 to your deadlines yet.");
    expect(body.text).not.toContain("I saved");
    // Too little was left to remember it; the reply still went out.
    expect(engine.memoryOf(PERSON)).toEqual([]);
  }, 15_000);

  it("refuses a document reference that is not slug-safe", async () => {
    const { status } = await send(photoTurn("turn_letter0009", { documents: [{ id: "../x", mimeType: "image/jpeg" }] }), deps([RENEWAL_PAGE]));
    expect(status).toBe(400);
  });
});

// Fake clock: the letter read and the profile read take fake seconds, and
// Engine's per-call limit (AbortSignal.timeout, which fake timers do not
// drive) runs on the same fake setTimeout. Each step waits a real
// millisecond so Engine's in-process work lands before the clock moves.
describe("the profile read on a photo turn", () => {
  const STEP_MS = 25;
  let profileGets: number;

  function slowLetter(delayMs: number) {
    const recorded = recordedReader([RENEWAL_PAGE]);
    let first = true;
    return {
      live: false,
      responses: async (req: never, opts: never) => {
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, delayMs));
        }
        return recorded.responses(req, opts);
      },
    } as never;
  }

  // GET /profile answers after delayMs, or never (null), until the caller aborts.
  function profileAfter(delayMs: number | null): typeof fetch {
    return async (input, init) => {
      if (!(new URL(String(input)).pathname.endsWith("/profile") && (init?.method ?? "GET") === "GET")) return engine.fetch(input, init);
      profileGets++;
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = delayMs === null ? undefined : setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
      return engine.fetch(input, init);
    };
  }

  async function timedTurn(request: Request, d: TurnDeps) {
    const started = Date.now();
    let modelLeftMs: number | null = null;
    const run = d.runAgent;
    d.runAgent = async (input) => {
      modelLeftMs = input.deadlineMs - Date.now();
      return run(input);
    };
    let done = false;
    const turn = send(request, d).finally(() => (done = true));
    while (!done) {
      await realSleep(1);
      await vi.advanceTimersByTimeAsync(STEP_MS);
    }
    return { ...(await turn), totalMs: Date.now() - started, modelLeftMs: modelLeftMs as number | null };
  }

  beforeEach(() => {
    profileGets = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
      return controller.signal;
    });
    engine.profile = {
      person: { fullName: { value: "Maria Lopez", source: "person", updatedAt: "2026-11-01T00:00:00Z" }, address: {} },
      household: [],
      income: [],
      programs: [],
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("a profile read that never answers neither holds the reply nor cuts into the model's time", async () => {
    const d = deps([], { mailModel: slowLetter(75_000) });
    d.engine = engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: profileAfter(null) });
    const { body, totalMs, modelLeftMs } = await timedTurn(photoTurn("turn_letter0017", { texts: ["Can you help me renew?"] }), d);
    expect(body.text).toMatch(/^This is a Medi-Cal renewal letter\./);
    expect(body.text).toMatch(/Want a reminder a week before\?$/);
    // The reply goes out when the letter is read, not 15 seconds later.
    expect(totalMs).toBeLessThan(78_000);
    expect(modelLeftMs).toBeGreaterThanOrEqual(15_000);
    // What the reply loses: only the profile block.
    expect(calls[0]!.context.join("\n")).not.toContain("<profile_data>");
  }, 30_000);

  it("on a short budget, a profile read that never answers stops before the model's minimum", async () => {
    const d = deps([], { mailModel: slowLetter(1_000), turnBudgetMs: 25_000 });
    d.engine = engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: profileAfter(null) });
    const { totalMs, modelLeftMs } = await timedTurn(photoTurn("turn_letter0018", { texts: ["Can you help me renew?"] }), d);
    expect(calls).toHaveLength(1);
    expect(totalMs).toBeLessThan(11_000);
    expect(modelLeftMs).toBeGreaterThanOrEqual(14_000);
  }, 30_000);

  it("a profile read that answers while the letter is read is used, and adds no time", async () => {
    const d = deps([], { mailModel: slowLetter(5_000) });
    d.engine = engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: profileAfter(3_000) });
    const { totalMs } = await timedTurn(photoTurn("turn_letter0019", { texts: ["Can you help me renew?"] }), d);
    expect(calls[0]!.context.join("\n")).toContain("Maria Lopez");
    expect(totalMs).toBeLessThan(6_500);
  }, 30_000);

  it("a photo with no words reads the profile only for its language, and never waits for it", async () => {
    const d = deps([], { mailModel: slowLetter(1_000) });
    d.engine = engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: profileAfter(null) });
    const { body, totalMs } = await timedTurn(photoTurn("turn_letter0020"), d);
    expect(body.text).toMatch(/^This is a Medi-Cal renewal letter\./);
    expect(profileGets).toBe(1);
    expect(calls).toHaveLength(0);
    expect(totalMs).toBeLessThan(2_500);
  }, 30_000);
});
