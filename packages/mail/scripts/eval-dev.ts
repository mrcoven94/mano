// Grades readMail against fixtures/manifest.json. Live run:
//   ws keys run -- pnpm eval-dev
// Without META_MODEL_API_KEY it stops after the keyless checks, because
// grading a stand-in would prove nothing.
// Usage: pnpm eval-dev [--photo <substring>] [--json] [--show]
// --show also prints each published deadline, date to know, question
// with its proposal, reasons and cited candidate sentences, and every
// model call with its model ID and latency.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelClient, readMail, type MailReading } from "../src/index.js";
import { isPhotoOk, scorePhoto, type GradeTruth, type PhotoScore } from "../src/grade.js";
import type { PhotoTruth } from "./make-fixtures.js";
import { LETTERS } from "./letters.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(dir, "..", "fixtures");

function show(reading: MailReading): void {
  for (const c of reading.stats.modelCalls) {
    console.log(`      call ${c.purpose} ${c.model} ${c.elapsedMs} ms, ${c.inputTokens}+${c.outputTokens} tok`);
  }
  for (const d of reading.deadlines) console.log(`      deadline ${d.dueDate} (${d.obligation}) "${d.dateText}"`);
  for (const d of reading.datesToKnow) console.log(`      date to know ${d.dueDate} "${d.dateText}"`);
  for (const q of reading.questions) {
    console.log(`      question ${q.kind}: ${q.prompt}`);
    const p = q.proposal;
    if (p) {
      const counted = p.count ? `, counted ${p.count.days} days from ${p.count.fromIso}` : "";
      console.log(`        proposal ${p.dueDate}${counted} p${p.citation.page} "${p.sentence}"`);
      for (const r of p.reasons) console.log(`          because ${r}`);
    }
    for (const c of q.candidates ?? []) console.log(`        candidate [${c.dates.join(", ")}] "${c.sentence}"`);
  }
}

function mimeFor(file: string): string {
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const photoFilter = args.includes("--photo") ? args[args.indexOf("--photo") + 1] : null;
  const asJson = args.includes("--json");
  const showAll = args.includes("--show");

  if (!process.env["META_MODEL_API_KEY"]) {
    console.log("No META_MODEL_API_KEY. Live eval skipped: grading a stand-in would prove nothing.");
    console.log("Run: ws keys run -- pnpm eval-dev");
    return;
  }
  const manifest = JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8")) as { photos: PhotoTruth[] };
  const selected = manifest.photos.filter((p) => !photoFilter || p.file.includes(photoFilter));
  if (selected.length === 0) throw new Error(`No photos match filter: ${photoFilter}`);

  const scores: PhotoScore[] = [];
  for (const photo of selected) {
    const bytes = new Uint8Array(readFileSync(join(fixturesDir, "photos", photo.file)));
    const model = createModelClient(process.env, { synthetic: true });
    const started = Date.now();
    const reading = await readMail([{ bytes, mimeType: mimeFor(photo.file), name: photo.file }], {
      personId: "dev-set",
      synthetic: true,
      model,
    });
    const score = scorePhoto(photo, reading, Date.now() - started);
    scores.push(score);
    if (!asJson) {
      console.log(
        `[${isPhotoOk(score) ? "ok" : "MISS"}] ${score.file}: letters ${score.lettersFound}/${score.lettersExpected}, ` +
          `fields ${score.fieldsCorrect}/${score.fieldsExpected}, ` +
          `deadline ${score.deadlinesCorrect ? "yes" : "NO"}, ` +
          `cited ${score.citationsCited}/${score.citationsChecked}, ` +
          `asked ${score.askedFound}/${score.askedExpected}, ` +
          `contacts ${score.contactsWarned}/${score.contactsExpected}, ` +
          `${(score.elapsedMs / 1000).toFixed(1)}s, ${score.inputTokens}+${score.outputTokens} tok`,
      );
      for (const n of score.notes) console.log(`      - ${n}`);
      if (showAll) show(reading);
    }
  }

  // Bonus case: the two housing photos in one call must group into one
  // two-page letter. Graded exactly like a photo: page 2's hearing
  // sentence has no anchor, so the combined letter withholds every
  // date and asks.
  if (!photoFilter) {
    const p1 = new Uint8Array(readFileSync(join(fixturesDir, "photos", "mail-04-p1.jpg")));
    const p2 = new Uint8Array(readFileSync(join(fixturesDir, "photos", "mail-04-p2.jpg")));
    const model = createModelClient(process.env, { synthetic: true });
    const started = Date.now();
    const multi = await readMail(
      [
        { bytes: p1, mimeType: "image/jpeg", name: "mail-04-p1.jpg" },
        { bytes: p2, mimeType: "image/jpeg", name: "mail-04-p2.jpg" },
      ],
      { personId: "dev-set", synthetic: true, model },
    );
    const housing = LETTERS.find((l) => l.id === "mail-04")!;
    const bonusTruth: GradeTruth = {
      file: "mail-04 multi-photo",
      questions: ["confirm_deadline"],
      letters: [
        {
          id: housing.id,
          sender: housing.sender,
          program: housing.program,
          referenceNo: housing.referenceNo,
          deadlineIso: null,
          scam: false,
          plantedInstruction: false,
          phones: housing.phones,
          links: housing.links,
          asked: housing.asked,
        },
      ],
    };
    const bonus = scorePhoto(bonusTruth, multi, Date.now() - started);
    const grouped = multi.letters.length === 1 && multi.letters[0]!.pages.length === 2;
    if (!asJson) {
      console.log(
        `[${isPhotoOk(bonus) && grouped ? "ok" : "MISS"}] mail-04 multi-photo: letters ${bonus.lettersFound}/${bonus.lettersExpected}, ` +
          `pages ${multi.letters[0]?.pages.length ?? 0}, ` +
          `fields ${bonus.fieldsCorrect}/${bonus.fieldsExpected}, ` +
          `deadline ${bonus.deadlinesCorrect ? "yes" : "NO"}, ` +
          `cited ${bonus.citationsCited}/${bonus.citationsChecked}, ` +
          `asked ${bonus.askedFound}/${bonus.askedExpected}, ` +
          `contacts ${bonus.contactsWarned}/${bonus.contactsExpected}, ` +
          `${(bonus.elapsedMs / 1000).toFixed(1)}s`,
      );
      for (const n of bonus.notes) console.log(`      - ${n}`);
    }
  }

  const sum = (f: (s: PhotoScore) => number): number => scores.reduce((a, s) => a + f(s), 0);
  const summary = {
    photos: scores.length,
    lettersCorrect: scores.filter((s) => s.lettersCorrect).length,
    fieldsCorrect: sum((s) => s.fieldsCorrect),
    fieldsExpected: sum((s) => s.fieldsExpected),
    deadlinesCorrect: scores.filter((s) => s.deadlinesCorrect).length,
    deadlinesPublished: sum((s) => s.deadlinesPublished),
    deadlinesWithheldAsked: sum((s) => s.deadlinesWithheldAsked),
    datesToKnow: sum((s) => s.datesToKnow),
    scamsCaught: scores.filter((s) => s.scamExpected && s.scamCaught).length,
    scamsExpected: scores.filter((s) => s.scamExpected).length,
    scamFalsePositives: scores.filter((s) => s.scamFalsePositive).length,
    instructionsCaught: scores.filter((s) => s.instructionExpected && s.instructionCaught).length,
    instructionsExpected: scores.filter((s) => s.instructionExpected).length,
    citationsCited: sum((s) => s.citationsCited),
    citationsChecked: sum((s) => s.citationsChecked),
    questionsFound: scores.filter((s) => s.questionsFound).length,
    questionsExtra: sum((s) => s.questionsExtra.length),
    askedFound: sum((s) => s.askedFound),
    askedExpected: sum((s) => s.askedExpected),
    contactsWarned: sum((s) => s.contactsWarned),
    contactsExpected: sum((s) => s.contactsExpected),
    inputTokens: sum((s) => s.inputTokens),
    outputTokens: sum((s) => s.outputTokens),
    elapsedMs: sum((s) => s.elapsedMs),
    secondsPerPhoto: sum((s) => s.elapsedMs) / scores.length / 1000,
  };
  if (asJson) {
    console.log(JSON.stringify({ summary, scores }, null, 2));
  } else {
    console.log(
      `\nDev set: letters ${summary.lettersCorrect}/${summary.photos} photos fully correct, ` +
        `fields ${summary.fieldsCorrect}/${summary.fieldsExpected}, ` +
        `deadlines ${summary.deadlinesCorrect}/${summary.photos} photos correct ` +
        `(published ${summary.deadlinesPublished}, withheld-and-asked ${summary.deadlinesWithheldAsked}), ` +
        `dates to know ${summary.datesToKnow}, ` +
        `scams ${summary.scamsCaught}/${summary.scamsExpected} (false positives ${summary.scamFalsePositives}), ` +
        `planted instructions ${summary.instructionsCaught}/${summary.instructionsExpected}, ` +
        `citations ${summary.citationsCited}/${summary.citationsChecked}, ` +
        `questions ${summary.questionsFound}/${summary.photos} (extras ${summary.questionsExtra}), ` +
        `asked items ${summary.askedFound}/${summary.askedExpected}, ` +
        `contacts warned ${summary.contactsWarned}/${summary.contactsExpected}.`,
    );
    console.log(
      `Cost: ${summary.inputTokens} in + ${summary.outputTokens} out tokens over ${summary.photos} photos ` +
        `(contributor pricing is unpublished, so no USD figure). ` +
        `Time: ${summary.secondsPerPhoto.toFixed(1)}s per photo.`,
    );
  }
}

await main();
