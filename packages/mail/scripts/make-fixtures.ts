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

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const photosDir = join(root, "photos");

export interface PhotoTruth {
  file: string;
  kind: "single" | "overlap" | "video";
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
  }[];
}

function truthFor(letter: DevLetter) {
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
      photos.push({ file, kind: "single", letters: [truthFor(letter)] });
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
  photos.push({ file: "overlap-05-06.jpg", kind: "overlap", letters: [truthFor(a), truthFor(b)] });
  console.log("wrote overlap-05-06.jpg");

  // Short synthetic video panning across three photos.
  if (ffmpegAvailable()) {
    await makeVideo(["mail-01.jpg", "mail-12.jpg", "mail-13.jpg"], "pile.mp4");
    photos.push({
      file: "pile.mp4",
      kind: "video",
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
