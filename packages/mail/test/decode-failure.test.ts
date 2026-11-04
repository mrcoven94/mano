import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { answerReading, readMail } from "../src/index.js";
import { RecordedModelClient } from "../src/model.js";
import { RENEWAL_PAGE, letterPhoto, recordedReader } from "./letter-fixture.js";

// What a decoder says about a file, against everything else that can stop
// decoding. Inputs are real files through real sharp and heic-decode; a
// broken deploy is simulated by mocking the module. No failure below may
// put its own words in a reply, a question or a log.
const SECRET = "/var/task/secret-path sk-or-secret";
const RETAKE = /flat, in good light/;
const FAILED_READ = /^I could not finish reading your photo just now\./;

const noise = (format: "jpeg" | "png" | "webp") => sharp(randomBytes(600 * 600 * 3), { raw: { width: 600, height: 600, channels: 3 } })[format]().toBuffer();
const cut = (b: Buffer) => b.subarray(0, Math.floor(b.length * 0.6));
const zeroAfterHeader = (b: Buffer) => {
  const out = Buffer.from(b);
  for (let i = 2000; i < out.length; i += 37) out[i] = 0xff;
  return out;
};

let logged: string[];
function captureLogs() {
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  }
}

afterEach(() => {
  vi.doUnmock("sharp");
  vi.doUnmock("heic-decode");
  vi.doUnmock("node:child_process");
  vi.resetModules();
  vi.restoreAllMocks();
});

function expectUnusable(reading: Awaited<ReturnType<typeof readMail>>, model: RecordedModelClient) {
  expect(reading.questions.map((q) => q.kind)).toEqual(["unreadable_page"]);
  expect(answerReading(reading).text).toMatch(RETAKE);
  expect(model.calls).toHaveLength(0);
  expect(logged.join("\n")).not.toContain("mano_mail_decode_failed");
}

function expectServiceFailure(reading: { questions: { kind: string }[] }, answerText: string, errorClass: string) {
  expect(reading.questions.map((q) => q.kind)).toEqual(["read_failed"]);
  expect(answerText).toMatch(FAILED_READ);
  expect(answerText).not.toMatch(RETAKE);
  expect(JSON.stringify(reading)).not.toMatch(/retake/i);
  expect(JSON.stringify(reading)).not.toContain(SECRET);
  expect(logged.map((l) => JSON.parse(l) as unknown)).toEqual([{ type: "mano_mail_decode_failed", errorClass }]);
  expect(logged.join("\n")).not.toContain(SECRET);
}

// The pipeline freshly imported, so a mock of its decoder applies.
async function readFresh(bytes: Uint8Array, mimeType: string) {
  vi.resetModules();
  const mail = await import("../src/index.js");
  const model = new mail.RecordedModelClient([]);
  const reading = await mail.readMail([{ bytes, mimeType, name: "doc-1" }], { personId: "p1", synthetic: false, model });
  return { reading, text: mail.answerReading(reading).text, model };
}

describe("the decoder says this file is not a usable image", () => {
  let inputs: [string, Uint8Array, string][];

  beforeAll(async () => {
    inputs = [
      ["a text file labeled JPEG", Buffer.from("%PDF-1.4 not a picture"), "image/jpeg"],
      ["random bytes labeled PNG", randomBytes(400), "image/png"],
      ["a truncated JPEG", cut(await noise("jpeg")), "image/jpeg"],
      ["a corrupted JPEG", zeroAfterHeader(await noise("jpeg")), "image/jpeg"],
      ["a truncated PNG", cut(await noise("png")), "image/png"],
      ["a truncated WebP", cut(await noise("webp")), "image/webp"],
      ["a zero-size image", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>'), "image/png"],
      ["bytes that are not HEIC", Buffer.from("not a heic file at all, just words"), "image/heic"],
      ["a HEIC header with no image", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(40)]), "image/heic"],
    ];
  });

  it("keeps the retake advice and calls no model, for every kind of bad file", async () => {
    for (const [name, bytes, mimeType] of inputs) {
      captureLogs();
      const model = new RecordedModelClient([]);
      const reading = await readMail([{ bytes, mimeType, name: "doc-1" }], { personId: "p1", synthetic: false, model });
      expectUnusable(reading, model);
      expect(reading.letters, name).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it("treats zero dimensions from the decoder as unusable", async () => {
    captureLogs();
    const bytes = await letterPhoto();
    vi.doMock("sharp", () => ({
      default: () => ({
        metadata: async () => ({ width: 0, height: 0 }),
        rotate() { return this; },
        jpeg() { return this; },
        toBuffer: async () => Buffer.from([1]),
      }),
    }));
    const { reading, text, model } = await readFresh(bytes, "image/jpeg");
    expect(reading.questions.map((q) => q.kind)).toEqual(["unreadable_page"]);
    expect(text).toMatch(RETAKE);
    expect(model.calls).toHaveLength(0);
  });

  it("treats zero dimensions from the HEIC decoder as unusable", async () => {
    captureLogs();
    vi.doMock("heic-decode", () => ({ default: async () => ({ width: 0, height: 0, data: new Uint8ClampedArray(0) }) }));
    const { reading, text } = await readFresh(Buffer.from("anything"), "image/heic");
    expect(reading.questions.map((q) => q.kind)).toEqual(["unreadable_page"]);
    expect(text).toMatch(RETAKE);
  });
});

describe("anything else that stops decoding is a failed read, never a bad photo", () => {
  it("sharp failing to load, on a good photo", async () => {
    captureLogs();
    const bytes = await letterPhoto();
    vi.doMock("sharp", () => {
      throw new Error(`Could not load the "sharp" module using the linux-x64 runtime ${SECRET}`);
    });
    const { reading, text, model } = await readFresh(bytes, "image/jpeg");
    expectServiceFailure(reading, text, "Error");
    expect(model.calls).toHaveLength(0);
  });

  it("an unexpected error while decoding, named by its class only", async () => {
    captureLogs();
    const bytes = await letterPhoto();
    class VipsOutOfMemory extends Error {}
    vi.doMock("sharp", () => ({
      default: () => ({
        metadata: async () => {
          throw new VipsOutOfMemory(`out of memory ${SECRET}`);
        },
      }),
    }));
    const { reading, text } = await readFresh(bytes, "image/jpeg");
    expectServiceFailure(reading, text, "VipsOutOfMemory");
  });

  it("a thrown value that is not an error", async () => {
    captureLogs();
    const bytes = await letterPhoto();
    vi.doMock("sharp", () => ({
      default: () => ({
        metadata: async () => {
          throw SECRET;
        },
      }),
    }));
    const { reading, text } = await readFresh(bytes, "image/jpeg");
    expectServiceFailure(reading, text, "unknown");
  });

  it("a decoder message that only contains a verdict's words, not as its own", async () => {
    captureLogs();
    const bytes = await letterPhoto();
    vi.doMock("sharp", () => ({
      default: () => ({
        metadata: async () => {
          throw new Error(`worker died: Input buffer contains unsupported image format ${SECRET}`);
        },
      }),
    }));
    const { reading, text } = await readFresh(bytes, "image/jpeg");
    expectServiceFailure(reading, text, "Error");
  });

  it("heic-decode failing to load, on a HEIC photo", async () => {
    captureLogs();
    vi.doMock("heic-decode", () => {
      throw new Error(`Cannot find package heic-decode ${SECRET}`);
    });
    const { reading, text } = await readFresh(Buffer.from("anything"), "image/heic");
    expectServiceFailure(reading, text, "Error");
  });

  it("sharp failing to load after a HEIC photo decoded fine", async () => {
    captureLogs();
    vi.doMock("heic-decode", () => ({ default: async () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) }) }));
    vi.doMock("sharp", () => {
      throw new Error(`Could not load the "sharp" module ${SECRET}`);
    });
    const { reading, text } = await readFresh(Buffer.from("anything"), "image/heic");
    expectServiceFailure(reading, text, "Error");
  });
});

// A process that ends as told, in place of ffmpeg.
function fakeFfmpeg(end: (child: EventEmitter) => void) {
  vi.doMock("node:child_process", () => ({
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
      setTimeout(() => end(child), 0);
      return child;
    },
  }));
}

describe("the video decoder", () => {
  const video = Buffer.from("not really a video");

  it("exiting with an error is its verdict on the file", async () => {
    captureLogs();
    fakeFfmpeg((child) => child.emit("close", 1));
    const { reading, text } = await readFresh(video, "video/mp4");
    expect(reading.questions.map((q) => q.kind)).toEqual(["unreadable_page"]);
    expect(text).toMatch(RETAKE);
  });

  it("failing to start is a failed read", async () => {
    captureLogs();
    fakeFfmpeg((child) => child.emit("error", Object.assign(new Error(`spawn EACCES ${SECRET}`), { code: "EACCES" })));
    const { reading, text } = await readFresh(video, "video/mp4");
    expectServiceFailure(reading, text, "Error");
  });

  it("being killed by a signal is a failed read", async () => {
    captureLogs();
    fakeFfmpeg((child) => child.emit("close", null));
    const { reading, text } = await readFresh(video, "video/mp4");
    expectServiceFailure(reading, text, "Error");
  });

  it("not being installed still asks for photos", async () => {
    captureLogs();
    fakeFfmpeg((child) => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
    const { reading } = await readFresh(video, "video/mp4");
    expect(reading.questions.map((q) => q.kind)).toEqual(["unsupported_media"]);
  });

  it("timing out is not a verdict on the file", async () => {
    fakeFfmpeg(() => undefined);
    vi.resetModules();
    const media = await import("../src/media.js");
    const err = await media.extractVideoFrames(video, { fps: 1, maxFrames: 1, timeoutMs: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(media.MediaError);
  });
});

describe("a good photo", () => {
  it("still reads", async () => {
    captureLogs();
    const reading = await readMail([{ bytes: await letterPhoto(), mimeType: "image/jpeg", name: "doc-1" }], {
      personId: "p1",
      synthetic: false,
      model: recordedReader([RENEWAL_PAGE]),
    });
    expect(answerReading(reading).deadlines.map((d) => d.dueDate)).toEqual(["2026-11-20"]);
    expect(logged.join("\n")).not.toContain("mano_mail_decode_failed");
  });
});
