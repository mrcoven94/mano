// Grades readMail against fixtures/manifest.json. Live run:
//   ws keys run -- pnpm eval-dev
// Without META_MODEL_API_KEY it stops after the keyless checks, because
// grading a stand-in would prove nothing.
// Usage: pnpm eval-dev [--photo <substring>] [--json]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelClient, readMail } from "../src/index.js";
import { isPhotoOk, scorePhoto, type PhotoScore } from "../src/grade.js";
import type { PhotoTruth } from "./make-fixtures.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(dir, "..", "fixtures");

function mimeFor(file: string): string {
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const photoFilter = args.includes("--photo") ? args[args.indexOf("--photo") + 1] : null;
  const asJson = args.includes("--json");

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
    }
  }

  // Bonus case: the two housing photos in one call must group into one
  // two-page letter.
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
    const oneLetter = multi.letters.length === 1 && multi.letters[0]!.pages.length === 2;
    const programOk = multi.letters[0]?.fields.program?.value === "Housing Choice Voucher";
    const deadlineOk = multi.letters[0]?.fields.deadlineIso?.value === "2026-12-12";
    if (!asJson) {
      console.log(
        `[${oneLetter && programOk && deadlineOk ? "ok" : "MISS"}] mail-04 multi-photo: ` +
          `${multi.letters.length} letter(s), ${multi.letters[0]?.pages.length ?? 0} page(s), ` +
          `program ${programOk ? "yes" : "NO"}, deadline ${deadlineOk ? "yes" : "NO"}, ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
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
