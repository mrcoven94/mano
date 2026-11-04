// The letters from the mail reader's transcript stage on, for runs on Meta's
// open-weight model while the Meta Model API is down. The letter is drawn and
// decoded as usual. SAM 3.1 is refused, so the reader takes its own fallback
// (paper detection, then the whole page). The page vision read is replaced:
// the model gets the letter's own text instead of an image, so a perfect
// transcription is assumed and citation boxes prove nothing. Everything after
// that is the real reader: field checks against the transcription, the
// deadline gate, the scam screen and the reply.

import { answerReading, readMail, SEGMENT_MODEL, type ModelClient as MailModelClient, type ModelInput, type ResponsesRequest, type ResponsesResult } from "@mano/mail";
import sharp from "sharp";
import type { DeadlineReader } from "./mail.ts";
import { OPEN_WEIGHT_MODEL_ID, OpenRouterModelClient, type ChatMessage } from "./models.ts";
import type { AnswerPath, BenchAnswer } from "./paths.ts";
import type { BenchCase, LetterImage } from "./suites/types.ts";

export const TRANSCRIPT_STAGE_DETAIL =
  "the mail reader from its transcript stage on, with the letter's own text in place of an image; SAM 3.1 and the page vision read were skipped, since both need the Meta Model API";

const TRANSCRIPT_NOTE =
  "There is no image of this page. Its text is below, exactly as printed. Copy it into full_text unchanged. For every field that has text, use the box [0, 0, 1000, 1000]; the box of an absent field is null.";

function chatMessages(input: ModelInput, transcript: string): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  return input.map((item) => ({
    role: item.role === "user" ? "user" : "system",
    content: item.content.map((part) => (part.type === "input_text" ? part.text : `${TRANSCRIPT_NOTE}\n\n${transcript}`)).join("\n\n"),
  }));
}

export class TranscriptMailClient implements MailModelClient {
  readonly live = true;
  private transcript: string;
  private model: OpenRouterModelClient;

  constructor(transcript: string, model: OpenRouterModelClient) {
    this.transcript = transcript;
    this.model = model;
  }

  async responses(req: ResponsesRequest): Promise<ResponsesResult> {
    if (req.model === SEGMENT_MODEL) throw new Error("skipped: SAM 3.1 needs the Meta Model API");
    const format = req.text?.format;
    const res = await this.model.complete(chatMessages(req.input, this.transcript), {
      ...(req.max_output_tokens ? { maxTokens: req.max_output_tokens } : {}),
      ...(format ? { jsonSchema: { name: format.name, schema: format.schema, strict: format.strict ?? true } } : {}),
    });
    return { text: res.text, model: this.model.id, usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens }, raw: null };
  }
}

async function readLetter(letter: LetterImage, model: OpenRouterModelClient) {
  const bytes = await sharp(Buffer.from(letter.svg), { density: 144 }).png().toBuffer();
  const reading = await readMail([{ bytes, mimeType: "image/png", name: letter.id }], {
    personId: "quality-synthetic",
    synthetic: true,
    model: new TranscriptMailClient(letter.transcript, model),
  });
  return { reading, answer: answerReading(reading) };
}

export class TranscriptMailPath implements AnswerPath {
  readonly name = "mail-transcript-stage";
  readonly live = true;
  readonly knowsCatalog = false;
  private model: OpenRouterModelClient;

  constructor(apiKey: string, fetchFn?: typeof fetch) {
    this.model = new OpenRouterModelClient(OPEN_WEIGHT_MODEL_ID, apiKey, fetchFn);
  }

  async answer(c: BenchCase): Promise<BenchAnswer> {
    const images = c.input.images ?? [];
    if (images.length !== 1) throw new Error("the transcript stage reads one letter per case");
    const started = Date.now();
    const { reading, answer } = await readLetter(images[0]!, this.model);
    return {
      text: answer.text,
      actions: answer.deadlines.map((d) => ({ kind: "deadline", detail: d.dueDate })),
      latencyMs: Date.now() - started,
      inputTokens: reading.stats.inputTokens,
      outputTokens: reading.stats.outputTokens,
    };
  }
}

export class TranscriptDeadlineModelReader implements DeadlineReader {
  readonly name = "mail-transcript-stage";
  readonly live = true;
  private model: OpenRouterModelClient;

  constructor(apiKey: string, fetchFn?: typeof fetch) {
    this.model = new OpenRouterModelClient(OPEN_WEIGHT_MODEL_ID, apiKey, fetchFn);
  }

  async readDeadline(letter: LetterImage): Promise<string | null> {
    const { answer } = await readLetter(letter, this.model);
    const due = answer.deadlines[0]?.dueDate;
    if (!due) return null;
    const [y, m, d] = due.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
}
