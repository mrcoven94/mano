// Quality's two hooks into the reader, loaded by name from
// packages/quality (paths.ts mailPath and mail.ts loadDeadlineReader):
// the letters suite answers through readMail and answerReading, the same
// reply the text line sends, and mail's deadline score reads the
// deadline the gate publishes. Bench letters are synthetic SVGs, drawn
// to PNG here, and read on the contributor model ID. Shapes match
// Quality's AnswerPath and DeadlineReader without importing them.
import { answerReading } from "./answer.js";
import { readMail } from "./index.js";
import { createModelClient } from "./model.js";

interface BenchImage {
  id: string;
  svg: string;
}

interface BenchCaseInput {
  input: { turns?: string[]; images?: BenchImage[] };
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function readBench(images: BenchImage[]) {
  const { default: sharp } = await import("sharp");
  const files = await Promise.all(
    images.map(async (img) => ({
      bytes: await sharp(Buffer.from(img.svg), { density: 144 }).png().toBuffer(),
      mimeType: "image/png",
      name: img.id,
    })),
  );
  const model = createModelClient(process.env, { synthetic: true });
  const reading = await readMail(files, { personId: "quality-synthetic", synthetic: true, model });
  return { reading, answer: answerReading(reading) };
}

export const qualityAnswerPath = {
  name: "mail-reader",
  get live(): boolean {
    return Boolean(process.env.META_MODEL_API_KEY);
  },
  knowsCatalog: false,
  async answer(c: BenchCaseInput) {
    const started = Date.now();
    const { reading, answer } = await readBench(c.input.images ?? []);
    return {
      text: answer.text,
      actions: answer.deadlines.map((d) => ({ kind: "deadline", detail: d.dueDate })),
      latencyMs: Date.now() - started,
      inputTokens: reading.stats.inputTokens,
      outputTokens: reading.stats.outputTokens,
    };
  },
};

export const qualityDeadlineReader = {
  name: "mail-reader",
  get live(): boolean {
    return Boolean(process.env.META_MODEL_API_KEY);
  },
  async readDeadline(letter: BenchImage): Promise<string | null> {
    const { answer } = await readBench([letter]);
    const due = answer.deadlines[0]?.dueDate;
    if (!due) return null;
    const [y, m, d] = due.split("-").map(Number);
    return `${MONTHS[m! - 1]} ${d}, ${y}`;
  },
};
