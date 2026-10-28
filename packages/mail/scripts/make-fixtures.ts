// Generates fixtures/photos/*.jpg from the synthetic letters plus a
// manifest with ground truth. Also builds a short synthetic video from
// three photos for the video path. Run: pnpm make-fixtures.

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LETTERS, type DevLetter } from "./letters.js";
import { renderOverlap, renderPhoto, treatmentFor } from "./render.js";
import { ffmpegAvailable } from "../src/media.js";
import type { QuestionKind } from "../src/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const photosDir = join(root, "photos");

export interface PhotoTruth {
  file: string;
  kind: "single" | "overlap" | "video";
  // Question kinds the photo must produce (a lone page 2 of 2 still
  // misses page 1). Extra questions are reported, not penalized.
  questions: QuestionKind[];
  letters: {
    id: string;
    sender: string;
    program: string | null;
    referenceNo: string | null;
    deadlineIso: string | null;
    scam: boolean;
    plantedInstruction: boolean;
    phones: string[];
    links: string[];
    asked: string[];
  }[];
}

function truthFor(letter: DevLetter, asked?: string[]) {
  return {
    id: letter.id,
    sender: letter.sender,
    program: letter.program,
    referenceNo: letter.referenceNo,
    deadlineIso: letter.deadlineIso,
    scam: letter.scam,
    plantedInstruction: letter.plantedInstruction,
    phones: letter.phones,
    links: letter.links,
    asked: asked ?? letter.asked,
  };
}

async function main(): Promise<void> {
  mkdirSync(photosDir, { recursive: true });
  const photos: PhotoTruth[] = [];

  for (const letter of LETTERS) {
    for (let p = 0; p < letter.pages.length; p++) {
      const suffix = letter.pages.length > 1 ? `-p${p + 1}` : "";
      const file = `${letter.id}${suffix}.jpg`;
      const photo = await renderPhoto(letter.pages[p]!, `${letter.id} p${p + 1}`, treatmentFor(`${letter.id}:p${p + 1}`));
      writeFileSync(join(photosDir, file), photo);
      const asked = letter.askedByPage ? letter.askedByPage[p]! : letter.asked;
      const questions: QuestionKind[] = letter.pages.length > 1 ? ["missing_page"] : [];
      const truth = truthFor(letter, asked);
      // Page 2 states no program or deadline on its own; the lone photo
      // must not invent them. The multi-photo case covers the letter.
      if (letter.id === "mail-04" && p === 1) {
        truth.program = null;
        truth.deadlineIso = null;
      }
      photos.push({ file, kind: "single", questions, letters: [truth] });
      console.log(`wrote ${file}`);
    }
  }

  // One overlap photo: mail-05 full size, mail-06 smaller on top.
  const a = LETTERS.find((l) => l.id === "mail-05")!;
  const b = LETTERS.find((l) => l.id === "mail-06")!;
  const overlap = await renderOverlap(
    { text: a.pages[0]!, caption: "mail-05 overlap" },
    { text: b.pages[0]!, caption: "mail-06 overlap" },
    treatmentFor("overlap:mail-05+mail-06"),
  );
  writeFileSync(join(photosDir, "overlap-05-06.jpg"), overlap);
  photos.push({ file: "overlap-05-06.jpg", kind: "overlap", questions: [], letters: [truthFor(a), truthFor(b)] });
  console.log("wrote overlap-05-06.jpg");

  // Short synthetic video panning across three photos.
  if (ffmpegAvailable()) {
    await makeVideo(["mail-01.jpg", "mail-12.jpg", "mail-13.jpg"], "pile.mp4");
    photos.push({
      file: "pile.mp4",
      kind: "video",
      questions: [],
      letters: ["mail-01", "mail-12", "mail-13"].map((id) => truthFor(LETTERS.find((l) => l.id === id)!)),
    });
    console.log("wrote pile.mp4");
  } else {
    console.log("ffmpeg not found; skipping pile.mp4");
  }

  writeFileSync(join(root, "manifest.json"), JSON.stringify({ photos }, null, 2) + "\n");
  console.log(`manifest: ${photos.length} photos, ${LETTERS.length} letters`);
}

function makeVideo(files: string[], out: string): Promise<void> {
  const inputs: string[] = [];
  for (const f of files) inputs.push("-loop", "1", "-t", "2", "-i", join(photosDir, f));
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    `[0]scale=960:1280:force_original_aspect_ratio=decrease,pad=960:1280:(ow-iw)/2:(oh-ih)/2,fps=10[v0];[1]scale=960:1280:force_original_aspect_ratio=decrease,pad=960:1280:(ow-iw)/2:(oh-ih)/2,fps=10[v1];[2]scale=960:1280:force_original_aspect_ratio=decrease,pad=960:1280:(ow-iw)/2:(oh-ih)/2,fps=10[v2];[v0][v1][v2]concat=n=3:v=1:a=0`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    join(photosDir, out),
  ];
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
  });
}

await main();
