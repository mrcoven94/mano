// @mano/mail: photos or a short video of a mail pile in, letters with
// cited fields, deadlines, warnings and questions out. A library with
// no dependency on apps/engine; the person's agent calls readMail and
// acts on the result through the action gateway.
//
// Usage:
//
//   import { createModelClient, readMail } from "@mano/mail";
//   const model = createModelClient(process.env, { synthetic: false });
//   const reading = await readMail(
//     [{ bytes, mimeType: "image/jpeg", name: "mail.jpg" }],
//     { personId: "person-123", synthetic: false, model },
//   );
//
// Synthetic runs use the contributor reading model; anything else uses
// the standard model. Without META_MODEL_API_KEY, createModelClient
// returns the recorded stand-in, which only answers explicitly
// recorded requests and fails closed otherwise.
//
// Flow per file: decode to frames (one for photos, up to 30 for video
// at 1 fps; truncation is reported and asked about, never silent),
// segment each frame into pages (SAM 3.1, on-device paper detection,
// then whole frame; every fallback is a warning), track video
// detections across frames by box plus appearance and keep the
// sharpest frame per track, crop and straighten, read each page (Muse
// Spark, structured output), verify every field against the page's own
// transcription, group pages into letters, merge fields, scan for
// instructions/links/phones, and resolve deadlines.
//
// Guarantees: a field publishes only with a real box and text found in
// the transcription, else it becomes a question; unreadable pages
// contribute nothing, though their contacts still warn; pages merge
// only on continuation evidence with no contradictions; a letter
// publishes at most one deadline, and only when its transcription has
// exactly one deadline sentence, returned by the reader and recovered
// verbatim, with no condition or audience in its paragraph, the line
// before it or the headings above it, that parses whole into an
// absolute form under src/gate.ts; counted deadlines ask, showing the
// count and the date counted from; any open deadline question, failed
// verification, failed chronology check, or missing page withholds
// every date on the letter, and every withheld sentence joins each
// deadline and missing-page question; a letter flagged as a scam gets
// the scam warning and no deadline, date to know or deadline question;
// links, phones and addresses are never acted on here and come back
// as warnings for the gateway.
// Content failures never throw; only invalid arguments do. Each file
// has a time and token budget, checked before every model call and
// shared by its retries as one deadline; past it the file stops early
// with a question.
//
// Run and test (no key needed): pnpm check. Regenerate fixtures:
// pnpm make-fixtures. Live dev-set grade: ws keys run -- pnpm eval-dev.

import {
  cropAndStraighten,
  downscaleForModel,
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
import { parseAllDates, parseWrittenDate, recoverSentence, sentencesInContext } from "./dates.js";
import {
  gateSentence,
  hasQualifyingContext,
  isDeadlineSentence,
  type AskReason,
  type DayCount,
} from "./gate.js";
import { scanContent, type ContentFlag } from "./safety.js";
import { verifyExtraction, type DroppedField } from "./citations.js";
import { readingModelFor } from "./model.js";
import type {
  Box,
  Cited,
  Citation,
  Contact,
  Deadline,
  DeadlineCandidate,
  InputFile,
  Letter,
  LetterFields,
  LetterPage,
  MailReading,
  ModelCallStat,
  Obligation,
  Question,
  ReadMailOptions,
  Warning,
} from "./types.js";

export type { InputFile, MailReading, ReadMailOptions };
export * from "./types.js";
export * from "./model.js";
export { parseWrittenDate, parseAllDates } from "./dates.js";
export { gateSentence } from "./gate.js";
export { scanContent, findInstructions, findLinks, findPhones, screenScam } from "./safety.js";

const MAX_FILES = 10;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const VIDEO_FPS = 1;
const VIDEO_MAX_FRAMES = 30;
// Per-photo budgets. A normal photo spends about 7k input and 4k output
// tokens over 30 seconds; a 6-second clip about triple that. Past the
// budget the file stops early with a question, never silently.
const MAX_INPUT_TOKENS_PER_FILE = 100_000;
const MAX_OUTPUT_TOKENS_PER_FILE = 50_000;
const MAX_MS_PER_FILE = 300_000;

interface PipelinePage {
  order: number;
  file: string;
  crop: Box;
  image: NormalizedImage;
  frameTimeMs: number;
  rotationDegrees: number;
  extraction: PageExtraction | null;
  readFailed: boolean;
  dropped: DroppedField[];
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
  const fileSpend = new Map<string, { input: number; output: number; startMs: number }>();
  const addUsage = (file: string, usage: { inputTokens: number; outputTokens: number } | null): void => {
    const spend = fileSpend.get(file);
    if (!spend || !usage) return;
    spend.input += usage.inputTokens;
    spend.output += usage.outputTokens;
  };
  const overBudget = (file: string): boolean => {
    const spend = fileSpend.get(file);
    if (!spend) return false;
    return (
      spend.input > MAX_INPUT_TOKENS_PER_FILE ||
      spend.output > MAX_OUTPUT_TOKENS_PER_FILE ||
      Date.now() - spend.startMs > MAX_MS_PER_FILE
    );
  };
  // One deadline per file, shared by every model call and retry for it.
  const deadlineFor = (file: string): number => (fileSpend.get(file)?.startMs ?? Date.now()) + MAX_MS_PER_FILE;
  const budgetAsked = new Set<string>();
  const askBudget = (file: string): void => {
    if (budgetAsked.has(file)) return;
    budgetAsked.add(file);
    warnings.push({
      kind: "model_error",
      message: `Stopped reading ${file} early: it exceeded the per-photo time or token budget.`,
      letterId: null,
      citation: null,
    });
    ask({
      kind: "budget_exceeded",
      letterId: null,
      prompt: `${file} took too long or cost too much to finish. Photograph fewer letters per photo, or film shorter clips.`,
      citation: null,
    });
  };

  for (const file of files) {
    fileSpend.set(file.name, { input: 0, output: 0, startMs: Date.now() });
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

    let frames: TimedFrame[];
    try {
      const decoded = await fileToFrames(file, kind);
      frames = decoded.frames;
      if (decoded.truncated) {
        warnings.push({
          kind: "video_truncated",
          message: `Video ${file.name} runs past the first ${VIDEO_MAX_FRAMES} seconds sampled. The rest was not read.`,
          letterId: null,
          citation: null,
        });
        ask({
          kind: "video_truncated",
          letterId: null,
          prompt: `The video ${file.name} continues past what was read. Film the rest of the pile as a second clip.`,
          citation: null,
        });
      }
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
        citation: null,
      });
      continue;
    }
    frameCount += frames.length;

    // Segment every frame.
    const frameDets: Detection[][] = [];
    const methods = new Set<SegmentMethod>();
    for (const frame of frames) {
      if (overBudget(file.name)) {
        askBudget(file.name);
        break;
      }
      const seg = await segmentFrame(frame.image, opts.model, { deadline: deadlineFor(file.name) });
      modelCalls.push({
        model: "sam-3.1",
        purpose: "segment",
        inputTokens: seg.usage?.inputTokens ?? 0,
        outputTokens: seg.usage?.outputTokens ?? 0,
        elapsedMs: seg.elapsedMs,
      });
      addUsage(file.name, seg.usage);
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
        citation: null,
      });
    }

    // Photos: one page per detection. Video: track across frames, keep
    // the sharpest frame per track.
    if (kind === "video") {
      const hashed = await Promise.all(
        frameDets.map(async (dets, f) =>
          Promise.all(dets.map(async (det) => ({ ...det, hash: await regionHash(frames[f]!.image, det.box) }))),
        ),
      );
      // Tight appearance gate: dense text pages hash within a few bits
      // of each other, so anything above 4 starts a new track.
      // Over-splitting is safe (grouping re-joins same-sender pages);
      // merging different letters would lose one.
      const tracks = trackBoxes(hashed, 0.3, (prev, next) => hashDistance(prev.hash, next.hash) <= 4);
      for (const track of tracks) {
        const scored = await Promise.all(
          track.map(async (t) => ({ t, sharp: await frameSharpness(frames[t.frameIndex]!.image.buffer) })),
        );
        scored.sort((a, b) => b.sharp - a.sharp);
        const best = scored[0]!.t;
        const frame = frames[best.frameIndex]!;
        const crop = await cropAndStraighten(frame.image, best.detection.box);
        pages.push({ order: pages.length, file: file.name, crop: best.detection.box, image: crop, frameTimeMs: frame.timeMs, rotationDegrees: crop.deskewDegrees, extraction: null, readFailed: false, dropped: [] });
      }
      if (tracks.length === 0) {
        ask({
          kind: "unreadable_page",
          letterId: null,
          prompt: `No letters were found in ${file.name}. Film the pile again, slowly, with each letter visible.`,
          citation: null,
        });
      }
    } else {
      // Only frames segmented before the budget ran out.
      for (let f = 0; f < frameDets.length; f++) {
        for (const det of frameDets[f]!) {
          const crop = await cropAndStraighten(frames[f]!.image, det.box);
          pages.push({ order: pages.length, file: file.name, crop: det.box, image: crop, frameTimeMs: frames[f]!.timeMs, rotationDegrees: crop.deskewDegrees, extraction: null, readFailed: false, dropped: [] });
        }
      }
    }
  }

  // Read every page, then verify each field against the page's own
  // transcription. Unverified fields are dropped and become questions.
  // A file past its budget stops early: its unread pages are dropped
  // and one question says so.
  const skipped = new Set<number>();
  for (const page of pages) {
    if (overBudget(page.file)) {
      askBudget(page.file);
      skipped.add(page.order);
      continue;
    }
    try {
      const readBuffer = await downscaleForModel(page.image);
      const extraction = await readPage(readBuffer, opts.model, {
        synthetic: opts.synthetic,
        deadline: deadlineFor(page.file),
      });
      page.extraction = extraction;
      if (extraction.readable) {
        page.dropped = verifyExtraction(extraction, extraction.fullText);
      }
      modelCalls.push({
        model: readingModelFor(opts.synthetic),
        purpose: "read",
        inputTokens: extraction.usage?.inputTokens ?? 0,
        outputTokens: extraction.usage?.outputTokens ?? 0,
        elapsedMs: extraction.elapsedMs,
      });
      addUsage(page.file, extraction.usage);
    } catch (err) {
      page.readFailed = true;
      warnings.push({
        kind: "model_error",
        message: `Reading failed for a page in ${page.file} (${shortMessage(err)}).`,
        letterId: null,
        citation: null,
      });
      ask({
        kind: "read_failed",
        letterId: null,
        prompt: `A page in ${page.file} could not be read. Try again, or retake the photo.`,
        citation: null,
      });
    }
  }

  if (skipped.size > 0) {
    const kept = pages.filter((p) => !skipped.has(p.order));
    pages.length = 0;
    pages.push(...kept);
    pages.forEach((p, i) => {
      p.order = i;
    });
  }

  // Second letters found on shared crops become pseudo-pages, so the
  // same grouping, merging and safety logic applies to them.
  const physicalPages = pages.length;
  for (const page of pages.slice()) {
    if (!page.extraction || !page.extraction.readable) continue;
    const extra = extraLetterExtraction(page.extraction);
    if (extra) {
      // Verified against the shared crop's own transcription, not the
      // composed pseudo-text, so extra letters face the same check.
      const dropped = verifyExtraction(extra, page.extraction.fullText);
      pages.push({ order: pages.length, file: page.file, crop: page.crop, image: page.image, frameTimeMs: page.frameTimeMs, rotationDegrees: page.rotationDegrees, extraction: extra, readFailed: false, dropped });
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
    const blocked = ambPages.some((p) => overBudget(pages[p.index]!.file));
    if (blocked) {
      ambPages.forEach((p) => groups.push([p.index]));
    } else try {
      const grouped = await groupWithModel(ambPages, opts.model, {
        synthetic: opts.synthetic,
        deadline: Math.min(...ambPages.map((p) => deadlineFor(pages[p.index]!.file))),
      });
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
  const datesToKnow: Deadline[] = [];
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
      frameTimeMs: m.frameTimeMs,
      rotationDegrees: m.rotationDegrees,
    }));
    // No box means no citation. The full page is never substituted.
    const cite = (memberIdx: number, box: Box | null): Citation | null =>
      box ? { file: members[memberIdx]!.file, page: memberIdx + 1, box } : null;
    const fields = mergeFields(members, cite);
    letters.push({ id: letterId, pages: letterPages, fields });

    // Letter-wide withholding. Any open deadline question, any
    // deadline that failed verification, or any failed chronology
    // check holds back every date on the letter: none publishes until
    // the person confirms.
    let letterBlocked = false;
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
          citation: null,
        });
      }
      for (const d of m.dropped) {
        ask({
          kind: "unverified_field",
          letterId,
          prompt:
            `Letter ${letterId}: the ${d.name} ("${d.value}") could not be verified against the photo. ` +
            `Check the letter before relying on it.`,
          citation: null,
        });
        if (d.name === "deadline") letterBlocked = true;
      }
    });
    // A missing page withholds the letter: an incomplete notice may
    // contradict the dates on the pages in hand.
    if (checkMissingPages(members, letterId, cite, ask)) letterBlocked = true;

    // A letter publishes at most one deadline, and only when all of
    // these hold: its whole transcription has exactly one deadline
    // sentence (src/gate.ts isDeadlineSentence), whether or not the
    // reader returned it; that sentence was returned and recovered
    // verbatim from the original transcription; nothing in its
    // paragraph, the line before it or the headings above it sets a
    // condition or an audience; and it parses whole into an absolute
    // form under the gate's grammar. Counted deadlines ask, showing the
    // count. Anything else withholds every date on the letter, and
    // every withheld sentence joins each deadline and missing-page
    // question.
    interface GatedEntry {
      iso: string;
      text: string;
      sentence: string;
      obligation: Obligation;
      citation: Citation;
    }
    interface DeadlineSentence {
      sentence: string;
      context: string;
      cited: { text: string; citation: Citation } | null;
    }
    const toKnow: GatedEntry[] = [];
    const found: DeadlineSentence[] = [];
    const withheld: DeadlineCandidate[] = [];
    const candidateOf = (sentence: string, citation: Citation | null, count?: DayCount): DeadlineCandidate => ({
      sentence,
      dates: parseAllDates(sentence),
      citation,
      ...(count ? { count } : {}),
    });
    const withhold = (sentence: string, citation: Citation | null, prompt: string, count?: DayCount): void => {
      letterBlocked = true;
      withheld.push(candidateOf(sentence, citation, count));
      ask({ kind: "confirm_deadline", letterId, prompt, citation });
    };
    const noticeIso = fields.noticeDate ? parseWrittenDate(fields.noticeDate.value) : null;
    members.forEach((m, i) => {
      const ex = m.extraction;
      if (!ex?.readable) return;
      const returned = new Map<string, { text: string; citation: Citation }>();
      for (const d of ex.deadlines) {
        if (!d.text) continue;
        const citation = cite(i, d.box);
        if (!citation) continue;
        const sentence = recoverSentence(d.text, ex.fullText);
        if (sentence === null) {
          withhold(d.text, citation, askPrompt(letterId, d.text, { reason: "unrecovered" }));
          continue;
        }
        if (!returned.has(sentence)) returned.set(sentence, { text: d.text, citation });
      }
      for (const { sentence, context } of sentencesInContext(ex.fullText)) {
        const cited = returned.get(sentence) ?? null;
        if (isDeadlineSentence(sentence)) {
          if (!found.some((f) => f.sentence === sentence)) found.push({ sentence, context, cited });
          continue;
        }
        if (!cited) continue;
        const verdict = gateSentence(sentence, noticeIso);
        if (verdict.kind === "date-to-know") {
          toKnow.push({ iso: verdict.iso, text: cited.text, sentence, obligation: "other", citation: cited.citation });
        } else if (verdict.kind !== "no-date") {
          withhold(sentence, cited.citation, askPrompt(letterId, sentence, { reason: "unrecognized" }));
        }
      }
    });
    let deadline: GatedEntry | null = null;
    if (found.length > 1) {
      letterBlocked = true;
      const candidates = found.map((f) => candidateOf(f.sentence, f.cited?.citation ?? null));
      withheld.push(...candidates);
      const distinct = [...new Set(candidates.flatMap((c) => c.dates))];
      if (distinct.length > 1) {
        warnings.push({
          kind: "conflicting_dates",
          message: `Letter ${letterId} has more than one deadline sentence (${distinct.join(", ")}). None was published.`,
          letterId,
          citation: candidates.find((c) => c.citation)?.citation ?? null,
          detail: distinct.join(", "),
        });
      }
      ask({
        kind: "confirm_deadline",
        letterId,
        prompt: `Letter ${letterId} has ${found.length} sentences that read like deadlines, so none was set. Which date, if any, is the deadline?`,
        citation: null,
        candidates,
      });
    } else if (found.length === 1) {
      const { sentence, context, cited } = found[0]!;
      const citation = cited?.citation ?? null;
      const verdict = gateSentence(sentence, noticeIso);
      if (hasQualifyingContext(context)) {
        withhold(sentence, citation, askPrompt(letterId, sentence, { reason: "qualified" }));
      } else if (verdict.kind === "ask") {
        withhold(sentence, citation, askPrompt(letterId, sentence, verdict), verdict.count);
      } else if (verdict.kind !== "deadline") {
        withhold(sentence, citation, askPrompt(letterId, sentence, { reason: "unrecognized" }));
      } else if (!cited) {
        withhold(sentence, null, askPrompt(letterId, sentence, { reason: "uncited" }));
      } else {
        deadline = { iso: verdict.iso, text: cited.text, sentence, obligation: verdict.obligation, citation: cited.citation };
      }
    }
    const asDeadline = (entry: GatedEntry): Deadline => ({
      letterId,
      program: fields.program?.value ?? null,
      dueDate: entry.iso,
      dateText: entry.text,
      obligation: entry.obligation,
      citation: entry.citation,
    });
    if (!letterBlocked) {
      if (deadline) {
        fields.deadlineIso = { value: deadline.iso, citation: deadline.citation };
        deadlines.push(asDeadline(deadline));
      }
      const known = new Set<string>();
      for (const entry of toKnow) {
        if (known.has(entry.iso)) continue;
        known.add(entry.iso);
        datesToKnow.push(asDeadline(entry));
      }
    } else {
      for (const entry of toKnow) withheld.push(candidateOf(entry.sentence, entry.citation));
      const key = (c: DeadlineCandidate): string => `${c.citation?.file}:${c.citation?.page}:${c.sentence}`;
      for (const q of questions) {
        if (q.letterId !== letterId) continue;
        if (q.kind !== "confirm_deadline" && q.kind !== "missing_page") continue;
        const have = new Set((q.candidates ?? []).map(key));
        const add = withheld.filter((c) => {
          if (have.has(key(c))) return false;
          have.add(key(c));
          return true;
        });
        q.candidates = [...(q.candidates ?? []), ...add];
      }
    }

    // Safety: every returned contact becomes a warning on its own,
    // readable pages and unreadable ones alike, then the
    // transcription and every dropped field value are scanned for
    // anything the model transcribed but did not extract, or claimed
    // but could not verify. Duplicates collapse by kind and value.
    const warned = new Set<string>();
    const warnContact = (kind: Contact["kind"], value: string, citation: Citation | null): void => {
      const key = `${kind}:${value.toLowerCase()}`;
      if (warned.has(key)) return;
      warned.add(key);
      if (kind === "address") {
        warnings.push({
          kind: "address_unchecked",
          message: `Letter ${letterId} contains a mailing address (${value}). It was not used or checked here.`,
          letterId,
          citation,
          detail: value,
        });
        return;
      }
      warnings.push(
        flagToWarning({ kind, label: "", match: value }, letterId, members, cite, { citation }),
      );
    };
    // Contacts are read off every extraction before readability
    // filtering: readable pages were already trimmed to verified
    // fields, and unreadable pages keep their raw claims so nothing
    // dialable goes unflagged.
    members.forEach((m, i) => {
      const ex = m.extraction;
      if (!ex) return;
      for (const p of ex.phones) {
        if (p.text && p.text.trim()) warnContact("phone", p.text.trim(), cite(i, p.box));
      }
      for (const l of ex.links) {
        if (l.text && l.text.trim()) warnContact("link", l.text.trim(), cite(i, l.box));
      }
      for (const a of ex.addresses) {
        if (a.text && a.text.trim()) warnContact("address", a.text.trim(), cite(i, a.box));
      }
    });
    members.forEach((m, i) => {
      for (const d of m.dropped) {
        if (d.name === "phone number") warnContact("phone", d.value, cite(i, d.box));
        else if (d.name === "link") warnContact("link", d.value, cite(i, d.box));
        else if (d.name === "address") warnContact("address", d.value, cite(i, d.box));
      }
    });
    const scanSources: { text: string; citation?: { citation: Citation | null } }[] = members
      .map((m) => m.extraction?.fullText ?? "")
      .filter((t) => t.trim().length > 0)
      .map((text) => ({ text }));
    members.forEach((m, i) => {
      for (const d of m.dropped) {
        scanSources.push({ text: d.value, citation: { citation: cite(i, d.box) } });
      }
    });
    for (const source of scanSources) {
      for (const flag of scanContent(source.text, fields.sender?.value ?? null)) {
        const key = `${flag.kind}:${flag.match.toLowerCase()}`;
        if (warned.has(key)) continue;
        warned.add(key);
        warnings.push(flagToWarning(flag, letterId, members, cite, source.citation));
      }
    }

    // A letter flagged as a scam gets the scam warning and nothing that
    // treats its dates as real: no deadline, date to know or deadline
    // question.
    if (warnings.some((w) => w.letterId === letterId && w.kind === "scam_suspect")) {
      const drop = <T extends { letterId: string | null }>(list: T[], gone: (item: T) => boolean): void => {
        for (let k = list.length - 1; k >= 0; k--) if (list[k]!.letterId === letterId && gone(list[k]!)) list.splice(k, 1);
      };
      drop(deadlines, () => true);
      drop(datesToKnow, () => true);
      drop(questions, (q) => q.kind === "confirm_deadline");
      drop(warnings, (w) => w.kind === "conflicting_dates");
      for (const q of questions) if (q.letterId === letterId) delete q.candidates;
      fields.deadlineIso = null;
    }
  });

  const inputTokens = modelCalls.reduce((s, c) => s + c.inputTokens, 0);
  const outputTokens = modelCalls.reduce((s, c) => s + c.outputTokens, 0);
  return {
    letters,
    deadlines,
    datesToKnow,
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

interface TimedFrame {
  image: NormalizedImage;
  timeMs: number;
}

async function fileToFrames(
  file: InputFile,
  kind: "image" | "heic" | "video",
): Promise<{ frames: TimedFrame[]; truncated: boolean }> {
  if (kind === "image" || kind === "heic") {
    return { frames: [{ image: await normalizeImage(file.bytes, file.mimeType), timeMs: 0 }], truncated: false };
  }
  const raw = await extractVideoFrames(file.bytes, { fps: VIDEO_FPS, maxFrames: VIDEO_MAX_FRAMES });
  const frames: TimedFrame[] = [];
  for (let i = 0; i < raw.frames.length; i++) {
    frames.push({ image: await normalizeImage(raw.frames[i]!, "image/jpeg"), timeMs: Math.round((i * 1000) / VIDEO_FPS) });
  }
  return { frames, truncated: raw.truncated };
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
  cite: (memberIdx: number, box: Box | null) => Citation | null,
): LetterFields {
  // Only boxed fields from readable pages are published. Verification
  // already dropped the rest; these checks are a second lock on the
  // same door.
  const firstText = (
    pick: (ex: PageExtraction) => { text: string | null; box: Box | null },
  ): Cited<string> | null => {
    for (let i = 0; i < members.length; i++) {
      const ex = members[i]!.extraction;
      if (!ex || !ex.readable) continue;
      const f = pick(ex);
      if (f.text && f.text.trim() && f.box) {
        const citation = cite(i, f.box);
        if (citation) return { value: f.text.trim(), citation };
      }
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
      if (!ex || !ex.readable) return;
      for (const f of pick(ex)) {
        if (f.text && f.text.trim() && f.box) {
          const citation = cite(i, f.box);
          if (citation) out.push({ value: f.text.trim(), citation });
        }
      }
    });
    if (!kind) return out;
    return out.map((o) => ({ kind, value: o.value, citation: o.citation }));
  };

  const firstDeadline = (): Cited<string> | null => {
    for (let i = 0; i < members.length; i++) {
      const ex = members[i]!.extraction;
      if (!ex || !ex.readable) continue;
      const d = ex.deadlines[0];
      if (d?.text && d.text.trim() && d.box) {
        const citation = cite(i, d.box);
        if (citation) return { value: d.text.trim(), citation };
      }
    }
    return null;
  };
  const deadlineText = firstDeadline();
  // Resolved per letter in the pipeline, where a missing anchor and
  // conflicting dates can become questions.
  const deadlineIso: Cited<string> | null = null;
  const excerpt = (members.find((m) => m.extraction?.readable)?.extraction?.fullText ?? "").slice(0, 280);
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

const MAX_NOTICE_PAGES = 100;

function checkMissingPages(
  members: PipelinePage[],
  letterId: string,
  cite: (memberIdx: number, box: Box | null) => Citation | null,
  ask: (q: Omit<Question, "id">) => void,
): boolean {
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
  // Absurd counts ("page 1 of 999999999") get one question, not a
  // billion-iteration loop.
  if (expected > MAX_NOTICE_PAGES) {
    const claimed = members.find((m) => m.extraction?.pageMarker.text)?.extraction?.pageMarker.text ?? "";
    ask({
      kind: "missing_page",
      letterId,
      prompt:
        `Letter ${letterId} claims an implausible page count ("${claimed}"). ` +
        `Photograph the pages you have, one at a time.`,
      citation: null,
    });
    return true;
  }
  // Unique markers seen, not photos taken: two shots of page 1 still
  // miss page 2.
  if (expected > 0 && seen.size < expected) {
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
    return true;
  }
  return false;
}

function flagToWarning(
  flag: ContentFlag,
  letterId: string,
  members: PipelinePage[],
  cite: (memberIdx: number, box: Box | null) => Citation | null,
  direct?: { citation: Citation | null },
): Warning {
  // A caller-supplied citation wins. Otherwise prefer the citation of
  // any verified field holding the flagged text. Else no citation.
  let citation: Citation | null = direct?.citation ?? null;
  if (!direct) {
    outer: for (let i = 0; i < members.length; i++) {
      const ex = members[i]!.extraction;
      if (!ex || !ex.readable) continue;
      const fields = [
        ex.sender,
        ex.program,
        ex.subject,
        ...ex.deadlines,
        ex.consequence,
        ex.referenceNo,
        ex.noticeDate,
        ...ex.asked,
        ...ex.phones,
        ...ex.links,
        ...ex.addresses,
      ];
      for (const f of fields) {
        if (f.text && f.box && (f.text.includes(flag.match) || flag.match.includes(f.text))) {
          citation = cite(i, f.box);
          break outer;
        }
      }
    }
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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function spoken(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTH_NAMES[m! - 1]} ${d}, ${y}`;
}

type AskWhy = { reason: AskReason | "unrecovered" | "uncited" | "qualified"; count?: DayCount };

function askPrompt(letterId: string, sentence: string, why: AskWhy): string {
  const said = `Letter ${letterId} says "${sentence}".`;
  switch (why.reason) {
    case "ambiguous-date":
      return `${said} A date in it could be read more than one way, so no deadline was set. Which date is meant?`;
    case "notice-date":
      return `${said} That date is the letter's own notice date, so no deadline was set. What must be done, and by when?`;
    case "before-notice":
      return `${said} That deadline falls before the letter's notice date, so it was not set. Which date is the real deadline?`;
    case "too-far":
      return `${said} That deadline is more than a year after the notice date, so it was not set. Which date is the real deadline?`;
    case "no-notice-date":
      return `${said} The count starts from the notice date, which could not be read. What is the notice date?`;
    case "counted": {
      const c = why.count!;
      return (
        `${said} Counting ${c.days} days from ${spoken(c.fromIso)}, the date it was read as starting from, gives ` +
        `${spoken(c.resultIso)}. A counted deadline is not set without a check. Is ${spoken(c.resultIso)} the deadline?`
      );
    }
    case "qualified":
      return `${said} The text around it sets a condition or says who it is for, so no deadline was set. Does this deadline apply to you?`;
    case "uncited":
      return `${said} It reads like a deadline but could not be pointed to on the photo, so no deadline was set. Which date, if any, is the deadline?`;
    case "unrecovered":
      return `Letter ${letterId} shows a deadline ("${sentence}") that could not be matched word for word to the letter, so none was set. Which date, if any, is the deadline?`;
    case "unrecognized":
      return `${said} It does not state one clear deadline, so none was set. Which date, if any, is the deadline?`;
  }
}

function shortMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 160);
}
