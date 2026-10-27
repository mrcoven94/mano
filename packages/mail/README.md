# @mano/mail

Mail photo and video to deadlines. Give it photos (JPEG, PNG, HEIC) or a short video of a mail pile; it splits the pile into letters, reads each page, and returns letters with cited fields, deadlines, warnings and questions.

This is a library with no dependency on `apps/engine`; the person's agent calls `readMail` and acts on the result through the action gateway.

## Use

```ts
import { createModelClient, readMail } from "@mano/mail";

const model = createModelClient(process.env, { synthetic: false });
const reading = await readMail(
  [{ bytes, mimeType: "image/jpeg", name: "mail.jpg" }],
  { personId: "person-123", synthetic: false, model },
);
for (const letter of reading.letters) {
  console.log(letter.fields.sender, letter.fields.deadlineIso);
}
```

`synthetic: true` runs use the contributor reading model; anything else uses the standard model. Without `META_MODEL_API_KEY`, `createModelClient` returns the recorded stand-in, which only answers explicitly recorded requests and fails closed otherwise.

## How it works

1. **Frames.** Photos decode to one frame (HEIC included). Videos decode through ffmpeg at 1 fps, capped at 30 frames.
2. **Segmentation.** SAM 3.1 (`sam-3.1` over the Responses API) finds each letter or page. On our key on Oct 26, SAM 3.1 returned empty output on every request shape tried, so the pipeline falls back to on-device paper detection (bright regions on the table) and finally to the whole frame. Every fallback is reported as a `segmentation_fallback` warning. Video detections are tracked across frames by box overlap and the sharpest frame per track is kept.
3. **Crop and straighten.** Each detection is cropped with a margin and corrected for in-plane rotation estimated from the paper mask. Keystone correction needs quad output and is future work.
4. **Reading.** Muse Spark reads each crop with structured output: sender, program, subject, what is being asked, deadline exactly as written, consequence, reference number, notice date, phones, links, addresses, page markers, and a citation box for every field. Two stacked letters on one crop come back as `extra_letter` and are treated as their own page.
5. **Grouping.** Pages sharing sender and reference number join into letters; explicit `page X of Y` markers chain the rest, with one small model call for ambiguous cases.
6. **Safety.** Letter text is evidence, never permission: planted instructions become `instruction_in_content` warnings. Links and phone numbers are never opened, called or checked here; they come back as `link_unchecked` / `phone_unchecked` warnings for the gateway. Urgent pay-or-verify asks with unofficial links raise `scam_suspect`.
7. **Questions, not guesses.** Unreadable pages, missing pages (`page 1 of 2` with only one photographed), conflicting deadlines and failed reads become questions for the person.

Written-out dates ("November 20, 2026") parse to ISO in `src/dates.ts`, so deadlines never depend on ISO-only matching.

## Run and test

- `pnpm check` runs the type check and the test suite (no key needed).
- `pnpm make-fixtures` regenerates `fixtures/` from `scripts/letters.ts`: 15 synthetic letters as phone photos with skew, blur, shadow and folds, one overlap photo, one synthetic video, and `manifest.json` ground truth. Deterministic per seed. Needs ffmpeg for the video.
- `pnpm eval-dev` grades `readMail` against the manifest with live models: `ws keys run -- pnpm eval-dev`. Without a key it stops after the keyless checks. `--photo <substring>` filters, `--json` prints machine output.

## Live services

| Part | Live when | Stand-in when not |
| --- | --- | --- |
| Reading and grouping | `META_MODEL_API_KEY` set | `RecordedModelClient` replays recorded responses |
| Segmentation | SAM 3.1 returns boxes | On-device paper detection, then whole frame |
| Video | ffmpeg installed | A question asking for photos instead |
| Gateway routing | `CF_ACCOUNT_ID` + `AI_GATEWAY_ID` set | Direct to `https://api.meta.ai/v1` |

Copy `.env.example` to `.env` for live runs. Never commit values.

## Limits

- One extra letter per crop: three stacked letters read as two plus a merged page.
- In-plane deskew only; heavy keystone stays tilted for the reader.
- HEIC needs the bundled decoder; corrupt files become questions, not errors.
