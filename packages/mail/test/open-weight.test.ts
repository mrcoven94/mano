import { afterEach, describe, expect, it, vi } from "vitest";
import { answerReading, readMail } from "../src/index.js";
import { normalizeImage } from "../src/media.js";
import { segmentFrame } from "../src/segment.js";
import { MetaModelClient, OpenWeightModelClient, RecordedModelClient, createModelClient, type ResponsesRequest } from "../src/model.js";
import { DOUBTFUL_PAGE, NIL, PLANTED_DEADLINE, PLANTED_DEADLINE_PAGE, RENEWAL_PAGE, RENEWAL_TEXT, letterPhoto, pageJson } from "./letter-fixture.js";

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

describe("OpenRouter as Modal's backup for a read", () => {
  const MODAL_URL = "https://example--ep-test-server.us-west.modal.direct/v1/chat/completions";
  const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
  const SETTINGS = { MANO_MODEL_PROVIDER: "modal", MODAL_ENDPOINT_URL: "https://example--ep-test-server.us-west.modal.direct", MODAL_PROXY_TOKEN: "wk-test.ws-test", OPENROUTER_API_KEY: KEY };
  const REQ: ResponsesRequest = { model: "muse-spark-1.3", input: "Read this." };

  function client(modal: () => Response, env: Record<string, string> = SETTINGS, openRouter: () => Response = () => completion("from the backup")) {
    const sent: Sent[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      sent.push({ url, authorization: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body as string) as Sent["body"] });
      return url === MODAL_URL ? modal() : openRouter();
    }) as unknown as typeof fetch;
    return { sent, model: createModelClient(env, { synthetic: true, fetchFn }) };
  }

  it.each([[429], [500], [503]])("reads on OpenRouter under its pin when Modal says %i, with one Modal try, and logs the route", async (code) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sent, model } = client(() => new Response("{}", { status: code }));
    const out = await model.responses(REQ);
    expect(out.text).toBe("from the backup");
    expect(out.model).toBe("meta/muse-spark-open");
    expect(sent.map((s) => s.url)).toEqual([MODAL_URL, OPENROUTER_URL]);
    expect(sent[1]!.authorization).toBe(`Bearer ${KEY}`);
    expect(sent[1]!.body.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([JSON.stringify({ type: "mano_model_route", surface: "mail", route: "openrouter" })]);
  });

  it("does not touch OpenRouter when Modal answers, and logs that route", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sent, model } = client(() => completion("from Modal"));
    expect((await model.responses(REQ)).model).toBe("meta-models/Muse-Spark-Open-816B-A42B");
    expect(sent.map((s) => s.url)).toEqual([MODAL_URL]);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([JSON.stringify({ type: "mano_model_route", surface: "mail", route: "modal" })]);
  });

  it.each([[400], [401], [403]])("does not fall back when Modal refuses the request with %i", async (code) => {
    const { sent, model } = client(() => new Response("{}", { status: code }));
    await expect(model.responses(REQ)).rejects.toThrow(String(code));
    expect(sent.map((s) => s.url)).toEqual([MODAL_URL]);
  });

  it("ends the read when OpenRouter answers 402 too, and tries nothing else", async () => {
    const { sent, model } = client(() => new Response("{}", { status: 503 }), SETTINGS, () => new Response("{}", { status: 402 }));
    await expect(model.responses(REQ)).rejects.toThrow("402");
    expect(sent.map((s) => s.url)).toEqual([MODAL_URL, OPENROUTER_URL]);
  });

  it("does not fall back without an OpenRouter key, and keeps Modal's retries", async () => {
    const { MODAL_PROXY_TOKEN, MODAL_ENDPOINT_URL, MANO_MODEL_PROVIDER } = SETTINGS;
    const { sent, model } = client(() => new Response("{}", { status: 503 }), { MODAL_PROXY_TOKEN, MODAL_ENDPOINT_URL, MANO_MODEL_PROVIDER });
    await expect(model.responses(REQ)).rejects.toThrow("503");
    expect(sent.every((s) => s.url === MODAL_URL)).toBe(true);
    expect(sent).toHaveLength(3);
  });
});

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

  const MODAL = { MANO_MODEL_PROVIDER: "modal", MODAL_ENDPOINT_URL: "https://example--ep-test-server.us-west.modal.direct/", MODAL_PROXY_TOKEN: "wk-test.ws-test" };

  it("reads with the open-weight model on Modal when it is chosen, with no OpenRouter fields", async () => {
    const { model, sent } = stub([answering(RENEWAL_PAGE)], { ...MODAL, META_MODEL_API_KEY: "k", OPENROUTER_API_KEY: KEY });
    await read(model);
    expect(sent[0]!.url).toBe("https://example--ep-test-server.us-west.modal.direct/v1/chat/completions");
    expect(sent[0]!.authorization).toBe("Bearer wk-test.ws-test");
    expect(sent[0]!.body.model).toBe("meta-models/Muse-Spark-Open-816B-A42B");
    expect(sent[0]!.body.provider).toBeUndefined();
    expect(model.live).toBe(true);
  });

  it("is off by default: Modal settings alone change nothing", () => {
    const { MANO_MODEL_PROVIDER: _chosen, ...settings } = MODAL;
    expect(createModelClient({ ...settings, META_MODEL_API_KEY: "k" })).toBeInstanceOf(MetaModelClient);
  });

  it.each([
    ["no token", { ...MODAL, MODAL_PROXY_TOKEN: "" }],
    ["no URL", { ...MODAL, MODAL_ENDPOINT_URL: "" }],
    ["a URL off Modal's domain", { ...MODAL, MODAL_ENDPOINT_URL: "https://example.com" }],
    ["a URL that only looks like Modal's domain", { ...MODAL, MODAL_ENDPOINT_URL: "https://x.modal.direct.example.com" }],
    ["a plain http URL", { ...MODAL, MODAL_ENDPOINT_URL: "http://example--ep-test-server.us-west.modal.direct" }],
  ])("is the stand-in when Modal is chosen with %s, even with other keys set", (_name, env) => {
    expect(createModelClient({ ...env, META_MODEL_API_KEY: "k", OPENROUTER_API_KEY: KEY })).toBeInstanceOf(RecordedModelClient);
  });

  it.each(["", "https://example.com", "https://x.modal.direct.example.com", "http://example--ep-test-server.us-west.modal.direct", "not a url"])(
    "the client itself refuses the Modal URL %j",
    (modalUrl) => {
      expect(() => new OpenWeightModelClient({ apiKey: KEY, modalUrl })).toThrow("Modal's own domain");
    },
  );

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

const FAILED_READ = /^I could not finish reading your photo just now\./;
const RETAKE = /flat|good light|retake/i;
const SECRET = "sk-or-secret from the provider";

// A service failure, seen where it matters: what the person is told.
function expectFailedRead(reading: Awaited<ReturnType<typeof read>>) {
  const answer = answerReading(reading);
  expect(reading.questions.map((q) => q.kind)).toEqual(["read_failed"]);
  expect(answer.outcome).toBe("unread");
  expect(answer.text).toMatch(FAILED_READ);
  expect(answer.text).not.toMatch(RETAKE);
  expect(JSON.stringify(reading)).not.toMatch(/retake/i);
  expect(answer.deadlines).toEqual([]);
  expect(reading.datesToKnow).toEqual([]);
  expect(answer.text).not.toMatch(/November 20|2026/);
  expect(JSON.stringify(reading)).not.toContain(SECRET);
}

const refusing = (content: string | null, refusal: string) => () =>
  new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content, refusal } }] }), { status: 200 });

describe("a service failure on the open-weight path is a failed read, never a bad photo", () => {
  const unread = async (answers: (() => Response)[]) => {
    const { model, sent } = stub(answers);
    return { reading: await read(model), sent };
  };

  it("a refusal field, in fixed words, with no retry", async () => {
    const { reading, sent } = await unread([refusing("", `I cannot process this image. ${SECRET}`)]);
    expect(sent).toHaveLength(1);
    expectFailedRead(reading);
    expect(reading.warnings.find((w) => w.kind === "model_error")?.message).toMatch(/refused/);
  });

  it("a refusal field with null content", async () => {
    const { reading, sent } = await unread([refusing(null, SECRET)]);
    expect(sent).toHaveLength(1);
    expectFailedRead(reading);
  });

  it("a refusal field beside content that parses, which is not trusted", async () => {
    const { reading } = await unread([refusing(RENEWAL_PAGE, SECRET)]);
    expectFailedRead(reading);
  });

  it.each([["empty", ""], ["blank", "  \n "]])("%s content, in fixed words, with no retry", async (_name, content) => {
    const { reading, sent } = await unread([answering(content)]);
    expect(sent).toHaveLength(1);
    expectFailedRead(reading);
    expect(reading.warnings.find((w) => w.kind === "model_error")?.message).toMatch(/no answer/);
  });

  it("a refusal written as prose, on all three attempts, counting what they spent", async () => {
    const { reading, sent } = await unread([answering(`I cannot process images on this endpoint. ${SECRET}`)]);
    expect(sent).toHaveLength(3);
    expectFailedRead(reading);
    expect(reading.stats.inputTokens).toBe(21);
    expect(reading.stats.outputTokens).toBe(33);
  });

  it("prose with a date, on all three attempts", async () => {
    const { reading, sent } = await unread([answering("The renewal is due November 20, 2026.")]);
    expect(sent).toHaveLength(3);
    expectFailedRead(reading);
  });

  it.each([
    ["an error object", JSON.stringify({ error: SECRET })],
    ["an empty object", "{}"],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", JSON.stringify(SECRET)],
    ["readable as a string", pageJson({ readable: "true" })],
    ["readable with no transcription", pageJson({ full_text: "" })],
  ])("valid JSON that is not a reading: %s, on all three attempts", async (_name, content) => {
    const { reading, sent } = await unread([answering(content)]);
    expect(sent).toHaveLength(3);
    expectFailedRead(reading);
    expect(reading.warnings.find((w) => w.kind === "model_error")?.failure).toBe("not_a_reading");
  });

  it("an answer cut off at the token cap, even one that parses", async () => {
    const { reading, sent } = await unread([() => completion(RENEWAL_PAGE, "length")]);
    expect(sent).toHaveLength(1);
    expectFailedRead(reading);
  });

  it("a 200 that carries an error and no choices", async () => {
    const { reading } = await unread([() => new Response(JSON.stringify({ error: { code: 402, message: SECRET } }), { status: 200 })]);
    expectFailedRead(reading);
  });

  it("HTTP 402, in fixed words, never repeating the provider's text", async () => {
    const { reading, sent } = await unread([() => new Response(SECRET, { status: 402 })]);
    expect(sent).toHaveLength(1);
    expectFailedRead(reading);
    expect(reading.warnings.find((w) => w.kind === "model_error")?.message).toMatch(/402 \(billing is not set up/);
    expect(reading.warnings.find((w) => w.kind === "model_error")?.failure).toBe("billing");
  });

  it("a body that is not JSON", async () => {
    const { reading } = await unread([() => new Response(`<html>${SECRET}</html>`, { status: 200 })]);
    expectFailedRead(reading);
  });

  it("a bad answer followed by a real one still reads", async () => {
    const { reading, sent } = await unread([answering("I cannot process images on this endpoint."), answering(RENEWAL_PAGE)]);
    expect(sent).toHaveLength(2);
    expect(answerReading(reading).deadlines.map((d) => d.dueDate)).toEqual(["2026-11-20"]);
  });
});

describe("what a failed call was billed still counts on the open-weight path", () => {
  const billed = (message: Record<string, unknown>, finishReason = "stop") => () =>
    new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { role: "assistant", ...message } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }), { status: 200 });

  it.each([
    ["a refusal", billed({ content: "", refusal: "no" })],
    ["empty content", billed({ content: "" })],
    ["an answer cut off at the token cap", billed({ content: RENEWAL_PAGE }, "length")],
  ])("%s is counted in the run's stats", async (_name, answer) => {
    const { model } = stub([answer]);
    const reading = await read(model);
    expect(reading.questions.map((q) => q.kind)).toEqual(["read_failed"]);
    expect(reading.stats.inputTokens).toBe(1000);
    expect(reading.stats.outputTokens).toBe(200);
    expect(reading.stats.modelCalls.map((c) => [c.purpose, c.model])).toEqual([["read", "meta/muse-spark-open"]]);
  });

  it("sums earlier attempts with the one that refused", async () => {
    const { model, sent } = stub([billed({ content: "I cannot process images." }), billed({ content: "", refusal: "no" })]);
    const reading = await read(model);
    expect(sent).toHaveLength(2);
    expect(reading.stats.inputTokens).toBe(2000);
  });

  it("an HTTP failure was not billed, so it counts no call", async () => {
    const { model } = stub([() => new Response("nope", { status: 402 })]);
    const reading = await read(model);
    expect(reading.stats.modelCalls).toEqual([]);
    expect(reading.stats.inputTokens).toBe(0);
  });
});

describe("a page the model truly could not read keeps the retake advice", () => {
  it("readable false asks for a better photo, with no retry and no date", async () => {
    const { model, sent } = stub([answering(pageJson({ readable: false, readability_note: "too dark", full_text: "", deadlines: [], sender: NIL }))]);
    const reading = await read(model);
    const answer = answerReading(reading);
    expect(sent).toHaveLength(1);
    expect(reading.questions.map((q) => q.kind)).toEqual(["unreadable_page"]);
    expect(answer.text).toMatch(/flat, in good light/);
    expect(answer.deadlines).toEqual([]);
    expect(reading.warnings.map((w) => w.kind)).not.toContain("model_error");
  });
});

// The retry loop is shared, so the Meta path is held to the same words,
// through its own Responses shape and with SAM answering first.
describe("the same faults on the Meta Model API path", () => {
  const SAM = JSON.stringify({ detections: [{ box_2d: [80, 120, 950, 880], label: "letter", score: 0.9 }] });
  const responses = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200 });
  const meta = (reads: Record<string, unknown>, sam: Record<string, unknown> = { status: "completed", output_text: SAM }) => {
    const sent: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const { model } = JSON.parse(init.body as string) as { model: string };
      sent.push(model);
      return responses(model === "sam-3.1" ? sam : reads);
    }) as unknown as typeof fetch;
    return { sent, model: createModelClient({ META_MODEL_API_KEY: "test-meta-key" }, { synthetic: false, fetchFn }) };
  };
  const reads = (sent: string[]) => sent.filter((m) => m !== "sam-3.1");
  const refusal = { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: `I cannot help. ${SECRET}` }] }] };

  it("a refusal part, in fixed words, with no retry", async () => {
    const { model, sent } = meta(refusal);
    const reading = await read(model);
    expect(reads(sent)).toHaveLength(1);
    expectFailedRead(reading);
    expect(reading.warnings.find((w) => w.kind === "model_error")?.message).toMatch(/refused/);
  });

  it("a refusal part beside text that parses, which is not trusted", async () => {
    const { model } = meta({ status: "completed", output: [{ content: [{ type: "output_text", text: RENEWAL_PAGE }, { type: "refusal", refusal: SECRET }] }] });
    expectFailedRead(await read(model));
  });

  it.each([
    ["empty output_text", { status: "completed", output_text: "" }],
    ["no output at all", { status: "completed" }],
    ["an error body with no status", { error: { message: SECRET } }],
  ])("%s, in fixed words, with no retry", async (_name, body) => {
    const { model, sent } = meta(body);
    const reading = await read(model);
    expect(reads(sent)).toHaveLength(1);
    expectFailedRead(reading);
    expect(reading.warnings.find((w) => w.kind === "model_error")?.message).toMatch(/no answer/);
  });

  it("prose, on all three attempts", async () => {
    const { model, sent } = meta({ status: "completed", output_text: `I cannot process images. ${SECRET}` });
    const reading = await read(model);
    expect(reads(sent)).toHaveLength(3);
    expectFailedRead(reading);
  });

  it("a SAM refusal takes the on-device fallback in fixed words, and the page still reads", async () => {
    const { model } = meta({ status: "completed", output_text: RENEWAL_PAGE }, refusal);
    const reading = await read(model);
    expect(reading.warnings.find((w) => w.kind === "segmentation_fallback")?.detail).toMatch(/refused/);
    expect(JSON.stringify(reading)).not.toContain(SECRET);
    expect(answerReading(reading).deadlines.map((d) => d.dueDate)).toEqual(["2026-11-20"]);
  });

  it("attempts that gave no reading count against the file's token budget", async () => {
    const boxes = Array.from({ length: 12 }, (_, i) => ({ box_2d: [i * 80, 100, i * 80 + 70, 900], label: "page", score: 0.9 }));
    const costly = { status: "completed", output_text: "I cannot process images.", usage: { input_tokens: 40_000, output_tokens: 1 } };
    const { model, sent } = meta(costly, { status: "completed", output_text: JSON.stringify({ detections: boxes }) });
    const reading = await read(model);
    expect(reading.questions.map((q) => q.kind)).toContain("budget_exceeded");
    expect(reads(sent).length).toBeLessThan(12 * 3);
  });

  it.each([
    ["refused", { status: "completed", output: [{ content: [{ type: "refusal", refusal: "no" }] }] }],
    ["empty", { status: "completed", output_text: "" }],
    ["incomplete", { status: "incomplete", output_text: "{" }],
  ])("%s pages keep what they were billed, and the budget stops the file", async (_name, body) => {
    const boxes = Array.from({ length: 12 }, (_, i) => ({ box_2d: [i * 80, 100, i * 80 + 70, 900], label: "page", score: 0.9 }));
    const { model, sent } = meta({ ...body, usage: { input_tokens: 40_000, output_tokens: 1 } }, { status: "completed", output_text: JSON.stringify({ detections: boxes }) });
    const reading = await read(model);
    expect(reading.stats.inputTokens).toBeGreaterThanOrEqual(120_000);
    expect(reading.questions.map((q) => q.kind)).toContain("budget_exceeded");
    expect(reads(sent).length).toBeLessThan(12);
  });

  it("a refused SAM call still counts what it was billed, while the page falls back", async () => {
    const { model } = meta(
      { status: "completed", output_text: RENEWAL_PAGE, usage: { input_tokens: 5, output_tokens: 5 } },
      { ...refusal, usage: { input_tokens: 700, output_tokens: 3 } },
    );
    const reading = await read(model);
    expect(reading.stats.modelCalls.find((c) => c.purpose === "segment")).toMatchObject({ inputTokens: 700, outputTokens: 3 });
    expect(reading.stats.inputTokens).toBe(705);
  });

  it("a refused grouping call still counts what it was billed, and the pages stand alone", async () => {
    const boxes = [0, 1].map((i) => ({ box_2d: [i * 450 + 20, 100, i * 450 + 430, 900], label: "page", score: 0.9 }));
    const page = pageJson({ full_text: `${RENEWAL_TEXT} Page 1 of 2`, reference_no: NIL, page_marker: { text: "Page 1 of 2", box_2d: [960, 400, 980, 600] } });
    const purposes: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string) as { model: string; text?: { format?: { name?: string } } };
      const purpose = req.text?.format?.name ?? "";
      purposes.push(purpose);
      if (purpose === "mail_detections") return responses({ status: "completed", output_text: JSON.stringify({ detections: boxes }) });
      if (purpose === "mail_groups") return responses({ ...refusal, usage: { input_tokens: 300, output_tokens: 7 } });
      return responses({ status: "completed", output_text: page, usage: { input_tokens: 10, output_tokens: 1 } });
    }) as unknown as typeof fetch;
    const reading = await read(createModelClient({ META_MODEL_API_KEY: "test-meta-key" }, { synthetic: false, fetchFn }));
    expect(purposes).toContain("mail_groups");
    expect(reading.stats.modelCalls.find((c) => c.purpose === "group")).toMatchObject({ inputTokens: 300, outputTokens: 7 });
    expect(reading.letters).toHaveLength(2);
    expect(JSON.stringify(reading)).not.toContain(SECRET);
  });

  it("readable false keeps the retake advice", async () => {
    const { model, sent } = meta({ status: "completed", output_text: pageJson({ readable: false, full_text: "", deadlines: [], sender: NIL }) });
    const reading = await read(model);
    expect(reads(sent)).toHaveLength(1);
    expect(answerReading(reading).text).toMatch(/flat, in good light/);
  });
});

// A retry that wakes past the deadline: the clock jumps while its backoff
// waits, so the loop's deadline check throws, with no call left to make.
describe("a retry that resumes past the deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const lateRetry = async (run: (deadline: number) => Promise<unknown>) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const deadline = Date.now() + 1000;
    const settled = run(deadline).then(
      (value) => ({ value }),
      (err: unknown) => ({ err }),
    );
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(deadline + 1);
    await vi.advanceTimersByTimeAsync(300);
    return settled;
  };
  const leaking = (async () => {
    throw new TypeError(`fetch failed: ${SECRET}`);
  }) as unknown as typeof fetch;

  it.each([
    ["the open-weight client", { MANO_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: KEY }],
    ["the Meta client", { META_MODEL_API_KEY: "test-meta-key" }],
  ])("%s throws fixed words", async (_name, env) => {
    const model = createModelClient(env, { synthetic: false, fetchFn: leaking });
    const result = await lateRetry((deadline) => model.responses({ model: "muse-spark-1.3", input: "hello" }, { deadline }));
    expect(result).toHaveProperty("err");
    const { message } = (result as { err: Error }).err;
    expect(message).toBe("Model request failed: no connection.");
    expect(message).not.toContain(SECRET);
  });

  it("never reaches a segmentation fallback's reason", async () => {
    const image = await normalizeImage(await letterPhoto(), "image/jpeg");
    const model = createModelClient({ META_MODEL_API_KEY: "test-meta-key" }, { synthetic: false, fetchFn: leaking });
    const result = await lateRetry((deadline) => segmentFrame(image, model, { deadline }));
    const seg = (result as { value: Awaited<ReturnType<typeof segmentFrame>> }).value;
    expect(seg.method).not.toBe("sam");
    expect(seg.method !== "sam" && seg.why).toMatch(/no connection/);
    expect(JSON.stringify(seg.method !== "sam" && seg.why)).not.toContain(SECRET);
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
