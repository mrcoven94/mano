import { describe, expect, it } from "vitest";
import { answerReading, readMail } from "../src/index.js";
import { MetaModelClient, RecordedModelClient, createModelClient, type ResponsesRequest } from "../src/model.js";
import { DOUBTFUL_PAGE, NIL, PLANTED_DEADLINE, PLANTED_DEADLINE_PAGE, RENEWAL_PAGE, letterPhoto, pageJson } from "./letter-fixture.js";

const KEY = "test-openrouter-key";
const ENV = { MANO_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: KEY };

interface Sent {
  url: string;
  authorization: string | null;
  body: {
    model: string;
    provider: unknown;
    max_tokens?: number;
    response_format?: { type: string; json_schema: { name: string; strict?: boolean; schema: unknown } };
    messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string; detail?: string } }[] }[];
  };
}

// OpenRouter as a chat completions answer. The answers go in order and
// the last one repeats.
const completion = (content: string, finishReason = "stop") =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { role: "assistant", content } }],
      usage: { prompt_tokens: 7, completion_tokens: 11 },
    }),
    { status: 200 },
  );

function stub(answers: (() => Response)[], env: Record<string, string> = ENV) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      authorization: new Headers(init.headers).get("authorization"),
      body: JSON.parse(init.body as string) as Sent["body"],
    });
    return answers[Math.min(sent.length, answers.length) - 1]!();
  }) as unknown as typeof fetch;
  return { sent, model: createModelClient(env, { synthetic: false, fetchFn }) };
}

const read = async (model: ReturnType<typeof createModelClient>) =>
  readMail([{ bytes: await letterPhoto(), mimeType: "image/jpeg", name: "doc-1" }], { personId: "p1", synthetic: false, model });

const answering = (content: string) => () => completion(content);

describe("which client createModelClient builds", () => {
  it("is the Meta Model API when the provider is not chosen", () => {
    expect(createModelClient({ META_MODEL_API_KEY: "k", OPENROUTER_API_KEY: KEY })).toBeInstanceOf(MetaModelClient);
  });

  it("is the Meta Model API when OpenRouter is chosen without its key, as the agent's route is", () => {
    expect(createModelClient({ META_MODEL_API_KEY: "k", MANO_MODEL_PROVIDER: "openrouter" })).toBeInstanceOf(MetaModelClient);
  });

  it("is the stand-in when OpenRouter is chosen with no key at all", () => {
    expect(createModelClient({ MANO_MODEL_PROVIDER: "openrouter" })).toBeInstanceOf(RecordedModelClient);
  });

  it("prefers OpenRouter over a Meta key when it is chosen", async () => {
    const { model, sent } = stub([answering(RENEWAL_PAGE)], { ...ENV, META_MODEL_API_KEY: "k" });
    await read(model);
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent[0]!.authorization).toBe(`Bearer ${KEY}`);
    expect(model.live).toBe(true);
  });
});

describe("the request for one page", () => {
  it("names the open-weight model, the zero-retention pin, the page image and the schema", async () => {
    const { model, sent } = stub([answering(RENEWAL_PAGE)]);
    await read(model);
    const { body } = sent[0]!;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "provider", "response_format"]);
    expect(body.model).toBe("meta/muse-spark-open");
    expect(body.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(body.max_tokens).toBe(8000);
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "mail_page", strict: true } });
    const user = body.messages.find((m) => m.role === "user")!;
    const parts = user.content as Exclude<Sent["body"]["messages"][number]["content"], string>;
    expect(parts.find((p) => p.type === "text")?.text).toMatch(/Read this page/);
    const image = parts.find((p) => p.type === "image_url")!;
    expect(image.image_url?.url).toMatch(/^data:image\/jpeg;base64,\/9j\//);
    expect(image.image_url?.detail).toBe("high");
  });

  it("also states the schema in words, for an endpoint that drops response_format", async () => {
    const { model, sent } = stub([answering(RENEWAL_PAGE)]);
    await read(model);
    const system = sent[0]!.body.messages.filter((m) => m.role === "system").map((m) => m.content as string).join("\n");
    expect(system).toMatch(/Transcribe text exactly as printed/);
    expect(system).toMatch(/one JSON object and nothing else/);
    expect(system).toContain("full_text");
    expect(system).toContain("box_2d");
  });

  it("carries the pin on every call of a run, retries included", async () => {
    const { model, sent } = stub([answering("not json"), answering(RENEWAL_PAGE)]);
    await read(model);
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(call.body.model).toBe("meta/muse-spark-open");
      expect(call.body.provider).toEqual({ zdr: true, data_collection: "deny" });
    }
  });
});

describe("what cannot change the route", () => {
  const OTHER_ROUTES = {
    ...ENV,
    MODEL_ALLOWLIST_EXTRA: "openai/gpt-5,anthropic/claude",
    CF_ACCOUNT_ID: "acct",
    AI_GATEWAY_ID: "gw",
    AI_GATEWAY_PROVIDER: "other",
    MANO_MODEL_BASE_URL: "https://other.example/v1",
  };
  const ok = () => completion(RENEWAL_PAGE);
  const page: ResponsesRequest = { model: "muse-spark-1.3", input: "hello" };

  it("no setting moves the URL, the model or the pin", async () => {
    const { model, sent } = stub([ok], OTHER_ROUTES);
    await model.responses(page);
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent[0]!.body.model).toBe("meta/muse-spark-open");
    expect(sent[0]!.body.provider).toEqual({ zdr: true, data_collection: "deny" });
  });

  it("nothing on the request reaches the body beyond what is mapped", async () => {
    const { model, sent } = stub([ok]);
    const hostile = {
      ...page,
      provider: { zdr: false, data_collection: "allow", order: ["other"] },
      models: ["openai/gpt-5"],
      route: "fallback",
    } as ResponsesRequest;
    await model.responses(hostile);
    expect(Object.keys(sent[0]!.body).sort()).toEqual(["messages", "model", "provider"]);
    expect(sent[0]!.body.provider).toEqual({ zdr: true, data_collection: "deny" });
  });

  it("refuses any model ID Mail does not read with, before any call", async () => {
    const { model, sent } = stub([ok], OTHER_ROUTES);
    await expect(model.responses({ model: "openai/gpt-5", input: "hello" })).rejects.toThrow(/Unknown model ID/);
    await expect(model.responses({ model: "meta/muse-glimmer-30b", input: "hello" })).rejects.toThrow(/Unknown model ID/);
    expect(sent).toHaveLength(0);
  });

  it("reports the model that ran, whichever reading ID was asked for", async () => {
    const { model } = stub([ok]);
    const res = await model.responses({ model: "muse-spark-1.3-contributor", input: "hello" });
    expect(res.model).toBe("meta/muse-spark-open");
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 11 });
  });
});

describe("segmentation on this path", () => {
  it("never sends SAM a request, falls back on-device and records why", async () => {
    const { model, sent } = stub([answering(RENEWAL_PAGE)]);
    const reading = await read(model);
    expect(sent.map((s) => s.body.model)).toEqual(["meta/muse-spark-open"]);
    const warning = reading.warnings.find((w) => w.kind === "segmentation_fallback");
    expect(warning?.message).toMatch(/not called/);
    expect(warning?.detail).toMatch(/SAM 3\.1 was not called/);
    expect(reading.stats.pages).toBe(1);
  });

  it("counts no SAM call that did not happen, and names the model that read", async () => {
    const { model } = stub([answering(RENEWAL_PAGE)]);
    const reading = await read(model);
    expect(reading.stats.modelCalls.map((c) => [c.purpose, c.model])).toEqual([["read", "meta/muse-spark-open"]]);
  });
});

describe("the deadline gate decides, whatever the model says", () => {
  it("publishes the date when the sentence passes the gate", async () => {
    const { model } = stub([answering(RENEWAL_PAGE)]);
    const answer = answerReading(await read(model));
    expect(answer.outcome).toBe("read");
    expect(answer.deadlines.map((d) => d.dueDate)).toEqual(["2026-11-20"]);
  });

  it("reads the same answer when the endpoint ignored the schema and fenced it in prose", async () => {
    const { model } = stub([answering(`Here is the page:\n\`\`\`json\n${RENEWAL_PAGE}\n\`\`\`\nDone.`)]);
    const answer = answerReading(await read(model));
    expect(answer.deadlines.map((d) => d.dueDate)).toEqual(["2026-11-20"]);
  });

  it("holds no date when a second date puts the deadline in doubt", async () => {
    const { model } = stub([answering(DOUBTFUL_PAGE)]);
    const answer = answerReading(await read(model));
    expect(answer.deadlines).toEqual([]);
    expect(answer.text).toMatch(/\?/);
  });

  it("does not take a deadline from a sentence that carries an instruction", async () => {
    const { model } = stub([answering(PLANTED_DEADLINE_PAGE)]);
    const answer = answerReading(await read(model));
    expect(answer.deadlines).toEqual([]);
    expect(answer.text).not.toContain(PLANTED_DEADLINE);
  });

  it("publishes nothing from a date the transcription does not hold", async () => {
    const { model } = stub([answering(pageJson({ deadlines: [{ text: "Your renewal is due December 25, 2026.", box_2d: [200, 60, 220, 300] }] }))]);
    const answer = answerReading(await read(model));
    expect(answer.deadlines.map((d) => d.dueDate)).not.toContain("2026-12-25");
    expect(answer.text).not.toContain("December 25");
  });

  it("publishes nothing when the model gives no box for the deadline", async () => {
    const { model } = stub([answering(pageJson({ deadlines: [{ text: "Your renewal is due November 20, 2026.", box_2d: null }] }))]);
    const answer = answerReading(await read(model));
    expect(answer.deadlines).toEqual([]);
  });
});

describe("a page that cannot be read asks, and never guesses a date", () => {
  const unread = async (answers: (() => Response)[]) => {
    const { model, sent } = stub(answers);
    const reading = await read(model);
    return { reading, sent, answer: answerReading(reading) };
  };
  const expectAsks = ({ reading, answer }: Awaited<ReturnType<typeof unread>>) => {
    expect(answer.deadlines).toEqual([]);
    expect(reading.datesToKnow).toEqual([]);
    expect(reading.questions.length).toBeGreaterThan(0);
    expect(answer.text).not.toMatch(/November 20|2026/);
  };

  it("prose with a date, on all three attempts", async () => {
    const result = await unread([answering("The renewal is due November 20, 2026.")]);
    expect(result.sent).toHaveLength(3);
    expect(result.answer.outcome).toBe("unread");
    expectAsks(result);
  });

  it("the model says the page is unreadable, with no retry", async () => {
    const result = await unread([answering(pageJson({ readable: false, readability_note: "too dark", full_text: "", deadlines: [], sender: NIL }))]);
    expect(result.sent).toHaveLength(1);
    expectAsks(result);
  });

  it("an answer cut off at the token cap, even one that parses", async () => {
    const result = await unread([() => completion(RENEWAL_PAGE, "length")]);
    expect(result.sent).toHaveLength(1);
    expectAsks(result);
  });

  it("a 200 that carries an error and no choices", async () => {
    const result = await unread([() => new Response(JSON.stringify({ error: { code: 402, message: "credit is out for sk-or-secret" } }), { status: 200 })]);
    expectAsks(result);
    expect(JSON.stringify(result.reading)).not.toContain("sk-or-secret");
  });

  it("HTTP 402, in fixed words, never repeating the provider's text", async () => {
    const result = await unread([() => new Response("credit is out for sk-or-secret", { status: 402 })]);
    expect(result.sent).toHaveLength(1);
    expectAsks(result);
    expect(JSON.stringify(result.reading)).not.toContain("sk-or-secret");
    expect(result.reading.warnings.find((w) => w.kind === "model_error")?.message).toMatch(/402 \(billing is not set up/);
  });

  it("a body that is not JSON", async () => {
    const result = await unread([() => new Response("<html>sk-or-secret</html>", { status: 200 })]);
    expectAsks(result);
    expect(JSON.stringify(result.reading)).not.toContain("sk-or-secret");
  });
});

describe("retries on this path", () => {
  it("retries a 5xx, then reads", async () => {
    const { model, sent } = stub([() => new Response("busy", { status: 503 }), answering(RENEWAL_PAGE)]);
    const answer = answerReading(await read(model));
    expect(sent).toHaveLength(2);
    expect(answer.deadlines.map((d) => d.dueDate)).toEqual(["2026-11-20"]);
  });

  it("stops at the shared deadline without calling", async () => {
    const { model, sent } = stub([answering(RENEWAL_PAGE)]);
    await expect(model.responses({ model: "muse-spark-1.3", input: "hello" }, { deadline: Date.now() - 1 })).rejects.toThrow(/time budget/);
    expect(sent).toHaveLength(0);
  });
});
