// readMail: photos or short videos of a mail pile in, letters with
// cited fields, deadlines, warnings and questions out.
//
// Flow per file: decode to frames (one for photos, up to N for video),
// segment each frame into pages (SAM 3.1, whole-frame fallback), track
// video detections and keep the sharpest frame per track, crop and
// straighten, read each page (Muse Spark, structured output), group
// pages into letters, merge fields, scan for instructions/links/phones,
// and collect deadlines.
//
// Links and phone numbers are never acted on here: they come back as
// warnings for the action gateway. Unreadable or missing pages become
// questions for the person, never guesses. Content failures never
// throw; only invalid arguments do.

import {
  cropAndStraighten,
  extractVideoFrames,
  frameSharpness,
  hashDistance,
  mediaKind,
  normalizeImage,
  regionHash,
  trackBoxes,
  MediaError,
  type NormalizedImage,
} from "./media.js";
import { segmentFrame, type Detection, type SegmentMethod } from "./segment.js";
import {
  extraLetterExtraction,
  groupDeterministic,
  groupWithModel,
  readPage,
  type GroupablePage,
  type PageExtraction,
} from "./read.js";
import { parseWrittenDate } from "./dates.js";
import { scanContent, type ContentFlag } from "./safety.js";
import { readingModelFor } from "./model.js";
import type {
  Box,
  Cited,
  Citation,
  Contact,
  Deadline,
  InputFile,
  Letter,
  LetterFields,
  LetterPage,
  MailReading,
  ModelCallStat,
  Question,
  ReadMailOptions,
  Warning,
} from "./types.js";

export type { InputFile, MailReading, ReadMailOptions };
export * from "./types.js";
export * from "./model.js";
export { parseWrittenDate, parseAllDates } from "./dates.js";
export { scanContent, findInstructions, findLinks, findPhones, screenScam } from "./safety.js";

const MAX_FILES = 10;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const VIDEO_FPS = 1;
const VIDEO_MAX_FRAMES = 30;
const FULL_BOX: Box = { ymin: 0, xmin: 0, ymax: 1000, xmax: 1000 };

interface PipelinePage {
  order: number;
  file: string;
  crop: Box;
  image: NormalizedImage;
  extraction: PageExtraction | null;
  readFailed: boolean;
}

function fullBox(): Box {
  return { ...FULL_BOX };
}

export async function readMail(files: InputFile[], opts: ReadMailOptions): Promise<MailReading> {
  const started = Date.now();
  validateArgs(files, opts);
  const modelCalls: ModelCallStat[] = [];
  const warnings: Warning[] = [];
  const questions: Question[] = [];
  let questionSeq = 0;
  const ask = (q: Omit<Question, "id">): void => {
    questionSeq += 1;
    questions.push({ ...q, id: `Q${questionSeq}` });
  };

  const pages: PipelinePage[] = [];
  let frameCount = 0;

  for (const file of files) {
    const kind = mediaKind(file.mimeType);
    if (kind === "other") {
      ask({
        kind: "unsupported_media",
        letterId: null,
        prompt: `Could not use ${file.name}: send a photo (JPEG, PNG, HEIC) or a short video instead.`,
        citation: null,
      });
      continue;
    }
    if (kind === "video" && file.bytes.length > MAX_VIDEO_BYTES) {
      ask({
        kind: "unsupported_media",
        letterId: null,
        prompt: `${file.name} is larger than 200 MB. Send a shorter clip.`,
        citation: null,
      });
      continue;
    }
    if ((kind === "image" || kind === "heic") && file.bytes.length > MAX_PHOTO_BYTES) {
      ask({
        kind: "unsupported_media",
        letterId: null,
        prompt: `${file.name} is larger than 25 MB. Send a smaller photo.`,
        citation: null,
      });
      continue;
    }

    let frames: NormalizedImage[];
    try {
      frames = await fileToFrames(file, kind);
    } catch (err) {
      if (err instanceof MediaError && err.code === "ffmpeg_missing") {
        ask({
          kind: "unsupported_media",
          letterId: null,
          prompt: `Could not read video ${file.name} here. Send photos of the letters instead.`,
          citation: null,
        });
        continue;
      }
      ask({
        kind: "unreadable_page",
        letterId: null,
        prompt: `Could not read ${file.name} (${shortMessage(err)}). Retake the photo with the letter flat and lit.`,
        citation: { file: file.name, page: 1, box: fullBox() },
      });
      continue;
    }
    frameCount += frames.length;

    // Segment every frame.
    const frameDets: Detection[][] = [];
    const methods = new Set<SegmentMethod>();
    for (const frame of frames) {
      const seg = await segmentFrame(frame, opts.model);
      modelCalls.push({
        model: "sam-3.1",
        purpose: "segment",
        inputTokens: seg.usage?.inputTokens ?? 0,
        outputTokens: seg.usage?.outputTokens ?? 0,
        elapsedMs: seg.elapsedMs,
      });
      methods.add(seg.method);
      frameDets.push(seg.detections);
    }
    if (methods.has("local") || methods.has("full-frame")) {
      const parts: string[] = [];
      if (methods.has("local")) parts.push("split with on-device paper detection");
      if (methods.has("full-frame")) parts.push("read as one page");
      warnings.push({
        kind: "segmentation_fallback",
        message:
          `SAM 3.1 returned nothing usable for ${file.name}; ` +
          (parts.length === 2 ? "some frames were split on-device and some read as one page." : `${parts[0]} instead.`),
        letterId: null,
        citation: { file: file.name, page: 1, box: fullBox() },
      });
    }

    // Photos: one page per detection. Video: track across frames, keep
    // the sharpest frame per track.
    if (kind === "video") {
      const hashed = await Promise.all(
        frameDets.map(async (dets, f) =>
          Promise.all(dets.map(async (det) => ({ ...det, hash: await regionHash(frames[f]!, det.box) }))),
        ),
      );
      // Tight appearance gate: dense text pages hash within a few bits
      // of each other, so anything above 4 starts a new track.
      // Over-splitting is safe (grouping re-joins same-sender pages);
      // merging different letters would lose one.
      const tracks = trackBoxes(hashed, 0.3, (prev, next) => hashDistance(prev.hash, next.hash) <= 4);
      for (const track of tracks) {
        const scored = await Promise.all(
          track.map(async (t) => ({ t, sharp: await frameSharpness(frames[t.frameIndex]!.buffer) })),
        );
        scored.sort((a, b) => b.sharp - a.sharp);
        const best = scored[0]!.t;
        const frame = frames[best.frameIndex]!;
        const crop = await cropAndStraighten(frame, best.detection.box);
        pages.push({ order: pages.length, file: file.name, crop: best.detection.box, image: crop, extraction: null, readFailed: false });
      }
      if (tracks.length === 0) {
        ask({
          kind: "unreadable_page",
          letterId: null,
          prompt: `No letters were found in ${file.name}. Film the pile again, slowly, with each letter visible.`,
          citation: { file: file.name, page: 1, box: fullBox() },
        });
      }
    } else {
      for (let f = 0; f < frames.length; f++) {
        for (const det of frameDets[f]!) {
          const crop = await cropAndStraighten(frames[f]!, det.box);
          pages.push({ order: pages.length, file: file.name, crop: det.box, image: crop, extraction: null, readFailed: false });
        }
      }
    }
  }

  // Read every page.
  for (const page of pages) {
    try {
      const extraction = await readPage(page.image.buffer, opts.model, { synthetic: opts.synthetic });
      page.extraction = extraction;
      modelCalls.push({
        model: readingModelFor(opts.synthetic),
        purpose: "read",
        inputTokens: extraction.usage?.inputTokens ?? 0,
        outputTokens: extraction.usage?.outputTokens ?? 0,
        elapsedMs: extraction.elapsedMs,
      });
    } catch (err) {
      page.readFailed = true;
      warnings.push({
        kind: "model_error",
        message: `Reading failed for a page in ${page.file} (${shortMessage(err)}).`,
        letterId: null,
        citation: { file: page.file, page: 1, box: fullBox() },
      });
      ask({
        kind: "read_failed",
        letterId: null,
        prompt: `A page in ${page.file} could not be read. Try again, or retake the photo.`,
        citation: { file: page.file, page: 1, box: fullBox() },
      });
    }
  }

  // Second letters found on shared crops become pseudo-pages, so the
  // same grouping, merging and safety logic applies to them.
  const physicalPages = pages.length;
  for (const page of pages.slice()) {
    if (!page.extraction || !page.extraction.readable) continue;
    const extra = extraLetterExtraction(page.extraction);
    if (extra) {
      pages.push({ order: pages.length, file: page.file, crop: page.crop, image: page.image, extraction: extra, readFailed: false });
    }
  }

  // Group readable pages into letters. Unreadable and failed pages each
  // stand alone so they can carry their own question.
  const groupable: GroupablePage[] = pages
    .filter((p) => p.extraction && p.extraction.readable)
    .map((p) => ({ index: p.order, extraction: p.extraction! }));
  const { groups: detGroups, ambiguous } = groupDeterministic(groupable);
  const groups: number[][] = [...detGroups];
  if (ambiguous.length > 0) {
    const ambPages = groupable.filter((p) => ambiguous.includes(p.index));
    try {
      const grouped = await groupWithModel(ambPages, opts.model, { synthetic: opts.synthetic });
      modelCalls.push({
        model: readingModelFor(opts.synthetic),
        purpose: "group",
        inputTokens: grouped.usage?.inputTokens ?? 0,
        outputTokens: grouped.usage?.outputTokens ?? 0,
        elapsedMs: grouped.elapsedMs,
      });
      groups.push(...grouped.groups);
    } catch {
      ambPages.forEach((p) => groups.push([p.index]));
    }
  }
  for (const page of pages) {
    if (!page.extraction || !page.extraction.readable) groups.push([page.order]);
  }
  groups.sort((a, b) => Math.min(...a) - Math.min(...b));

  // Build letters.
  const letters: Letter[] = [];
  const deadlines: Deadline[] = [];
  groups.forEach((memberOrders, li) => {
    const letterId = `L${li + 1}`;
    const members = memberOrders
      .map((o) => pages[o]!)
      .sort((a, b) => pageMarkerNum(a.extraction) - pageMarkerNum(b.extraction) || a.order - b.order);
    const letterPages: LetterPage[] = members.map((m, i) => ({
      page: i + 1,
      file: m.file,
      crop: m.crop,
      width: m.image.width,
      height: m.image.height,
    }));
    const cite = (memberIdx: number, box: Box | null): Citation => ({
      file: members[memberIdx]!.file,
      page: memberIdx + 1,
      box: box ?? fullBox(),
    });
    const fields = mergeFields(members, cite);
    letters.push({ id: letterId, pages: letterPages, fields });

    // Per-page questions and deadline checks.
    members.forEach((m, i) => {
      const ex = m.extraction;
      if (m.readFailed || !ex) return;
      if (!ex.readable) {
        ask({
          kind: "unreadable_page",
          letterId,
          prompt:
            `Page ${i + 1} of letter ${letterId} could not be read` +
            (ex.readabilityNote ? ` (${ex.readabilityNote})` : "") +
            `. Photograph that page again, flat and lit.`,
          citation: cite(i, null),
        });
      }
    });
    checkMissingPages(members, letterId, cite, ask);

    const isoDates = members
      .map((m) => (m.extraction?.deadlineText.text ? parseWrittenDate(m.extraction.deadlineText.text) : null))
      .filter((d): d is string => d !== null);
    const distinct = [...new Set(isoDates)];
    if (distinct.length > 1) {
      const firstIdx = members.findIndex(
        (m) => m.extraction?.deadlineText.text && parseWrittenDate(m.extraction.deadlineText.text) === distinct[0],
      );
      warnings.push({
        kind: "conflicting_dates",
        message: `Letter ${letterId} states more than one deadline (${distinct.join(", ")}).`,
        letterId,
        citation: cite(Math.max(0, firstIdx), members[Math.max(0, firstIdx)]!.extraction?.deadlineText.box ?? null),
        detail: distinct.join(", "),
      });
      ask({
        kind: "confirm_deadline",
        letterId,
        prompt: `Letter ${letterId} shows conflicting deadlines (${distinct.join(", ")}). Which date is on the letter?`,
        citation: cite(Math.max(0, firstIdx), null),
      });
    }
    if (fields.deadlineIso) {
      deadlines.push({
        letterId,
        program: fields.program?.value ?? null,
        dueDate: fields.deadlineIso.value,
        dateText: fields.deadlineText?.value ?? fields.deadlineIso.value,
        citation: fields.deadlineIso.citation,
      });
    }

    // Safety scan over the letter text.
    const fullText = members.map((m) => m.extraction?.fullText ?? "").join("\n");
    if (fullText.trim().length > 0) {
      for (const flag of scanContent(fullText, fields.sender?.value ?? null)) {
        warnings.push(flagToWarning(flag, letterId, members, cite));
      }
    }
  });

  const inputTokens = modelCalls.reduce((s, c) => s + c.inputTokens, 0);
  const outputTokens = modelCalls.reduce((s, c) => s + c.outputTokens, 0);
  return {
    letters,
    deadlines,
    warnings,
    questions,
    stats: {
      files: files.length,
      frames: frameCount,
      pages: physicalPages,
      modelCalls,
      inputTokens,
      outputTokens,
      elapsedMs: Date.now() - started,
      live: opts.model.live,
    },
  };
}

function validateArgs(files: InputFile[], opts: ReadMailOptions): void {
  if (!Array.isArray(files) || files.length === 0) throw new Error("readMail needs at least one file.");
  if (files.length > MAX_FILES) throw new Error(`readMail takes at most ${MAX_FILES} files.`);
  for (const f of files) {
    if (!(f.bytes instanceof Uint8Array) || f.bytes.length === 0) throw new Error(`File ${f?.name ?? "?"} has no bytes.`);
    if (typeof f.mimeType !== "string" || !f.mimeType) throw new Error(`File ${f.name} has no MIME type.`);
    if (typeof f.name !== "string" || !f.name) throw new Error("Every file needs a name.");
  }
  if (!opts || typeof opts.personId !== "string" || !opts.personId) throw new Error("readMail needs opts.personId.");
  if (typeof opts.synthetic !== "boolean") throw new Error("readMail needs opts.synthetic (true or false).");
  if (!opts.model || typeof opts.model.responses !== "function") throw new Error("readMail needs opts.model (a ModelClient).");
}

async function fileToFrames(file: InputFile, kind: "image" | "heic" | "video"): Promise<NormalizedImage[]> {
  if (kind === "image" || kind === "heic") {
    return [await normalizeImage(file.bytes, file.mimeType)];
  }
  const raw = await extractVideoFrames(file.bytes, { fps: VIDEO_FPS, maxFrames: VIDEO_MAX_FRAMES });
  const frames: NormalizedImage[] = [];
  for (const frame of raw) {
    frames.push(await normalizeImage(frame, "image/jpeg"));
  }
  return frames;
}

function pageMarkerNum(ex: PageExtraction | null): number {
  const marker = ex?.pageMarker.text;
  if (!marker) return 0;
  const m = marker.match(/page\s*(\d+)\s*of\s*(\d+)/i);
  if (m) return Number(m[1]);
  return 0;
}

function mergeFields(
  members: PipelinePage[],
  cite: (memberIdx: number, box: Box | null) => Citation,
): LetterFields {
  const firstText = (
    pick: (ex: PageExtraction) => { text: string | null; box: Box | null },
  ): Cited<string> | null => {
    for (let i = 0; i < members.length; i++) {
      const ex = members[i]!.extraction;
      if (!ex) continue;
      const f = pick(ex);
      if (f.text && f.text.trim()) return { value: f.text.trim(), citation: cite(i, f.box) };
    }
    return null;
  };
  const allTexts = (
    pick: (ex: PageExtraction) => { text: string | null; box: Box | null }[],
    kind: "phone" | "link" | "address" | null,
  ): Cited<string>[] | Contact[] => {
    const out: { value: string; citation: Citation }[] = [];
    members.forEach((m, i) => {
      const ex = m.extraction;
      if (!ex) return;
      for (const f of pick(ex)) {
        if (f.text && f.text.trim()) out.push({ value: f.text.trim(), citation: cite(i, f.box) });
      }
    });
    if (!kind) return out;
    return out.map((o) => ({ kind, value: o.value, citation: o.citation }));
  };

  const deadlineText = firstText((ex) => ex.deadlineText);
  let deadlineIso: Cited<string> | null = null;
  if (deadlineText) {
    const iso = parseWrittenDate(deadlineText.value);
    if (iso) deadlineIso = { value: iso, citation: deadlineText.citation };
  }
  const excerpt = (members[0]?.extraction?.fullText ?? "").slice(0, 280);
  return {
    sender: firstText((ex) => ex.sender),
    program: firstText((ex) => ex.program),
    subject: firstText((ex) => ex.subject),
    asked: allTexts(
      (ex) => ex.asked,
      null,
    ) as Cited<string>[],
    deadlineText,
    deadlineIso,
    consequence: firstText((ex) => ex.consequence),
    referenceNo: firstText((ex) => ex.referenceNo),
    noticeDate: firstText((ex) => ex.noticeDate),
    contacts: [
      ...(allTexts(
        (ex) => ex.phones,
        "phone",
      ) as Contact[]),
      ...(allTexts(
        (ex) => ex.links,
        "link",
      ) as Contact[]),
      ...(allTexts(
        (ex) => ex.addresses,
        "address",
      ) as Contact[]),
    ],
    excerpt,
  };
}

function checkMissingPages(
  members: PipelinePage[],
  letterId: string,
  cite: (memberIdx: number, box: Box | null) => Citation,
  ask: (q: Omit<Question, "id">) => void,
): void {
  let expected = 0;
  const seen = new Set<number>();
  members.forEach((m) => {
    const marker = m.extraction?.pageMarker.text;
    if (!marker) return;
    const mt = marker.match(/page\s*(\d+)\s*of\s*(\d+)/i);
    if (mt) {
      seen.add(Number(mt[1]));
      expected = Math.max(expected, Number(mt[2]));
    }
  });
  if (expected > members.length) {
    const missing: number[] = [];
    for (let n = 1; n <= expected; n++) {
      if (!seen.has(n)) missing.push(n);
    }
    ask({
      kind: "missing_page",
      letterId,
      prompt:
        `Letter ${letterId} runs to ${expected} pages but only ${members.length} ` +
        `${members.length === 1 ? "was" : "were"} photographed` +
        (missing.length > 0 ? ` (missing page ${missing.join(", page ")}).` : ".") +
        ` Photograph the missing pages.`,
      citation: cite(0, null),
    });
  }
}

function flagToWarning(
  flag: ContentFlag,
  letterId: string,
  members: PipelinePage[],
  cite: (memberIdx: number, box: Box | null) => Citation,
): Warning {
  // Prefer the citation of the matching contacts field; otherwise cite
  // the first page that contains the flagged text.
  let citation: Citation | null = null;
  if (flag.kind === "link" || flag.kind === "phone") {
    outer: for (let i = 0; i < members.length; i++) {
      const ex = members[i]!.extraction;
      if (!ex) continue;
      const fields = flag.kind === "link" ? ex.links : ex.phones;
      for (const f of fields) {
        if (f.text && (f.text.includes(flag.match) || flag.match.includes(f.text))) {
          citation = cite(i, f.box);
          break outer;
        }
      }
    }
  }
  if (!citation) {
    const idx = members.findIndex((m) => (m.extraction?.fullText ?? "").includes(flag.match));
    citation = cite(Math.max(0, idx), null);
  }
  switch (flag.kind) {
    case "instruction":
      return {
        kind: "instruction_in_content",
        message: `Letter ${letterId} contains text that ${flag.label} ("${flag.match}"). It was read as evidence only.`,
        letterId,
        citation,
        detail: flag.match,
      };
    case "link":
      return {
        kind: "link_unchecked",
        message: `Letter ${letterId} contains a link (${flag.match}). It was not opened or checked here.`,
        letterId,
        citation,
        detail: flag.match,
      };
    case "phone":
      return {
        kind: "phone_unchecked",
        message: `Letter ${letterId} contains a phone number (${flag.match}). It was not called or checked here.`,
        letterId,
        citation,
        detail: flag.match,
      };
    case "scam":
      return {
        kind: "scam_suspect",
        message: `Letter ${letterId} looks like a possible scam: ${flag.label} (${flag.match}).`,
        letterId,
        citation,
        detail: flag.detail,
      };
  }
}

function shortMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 160);
}
