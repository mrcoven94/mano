# Mano eval

Frozen held-out eval for the renewal and document story. Built by a separate agent session from the one building the agent, and frozen before anyone tunes prompts.

## Layout

- `src/generator.mjs`: synthetic households across CA, TX, NY, FL, IL and WA, 3 to 8 full one-page letters each (Medicaid renewals, SNAP recertifications, missing-document requests, work-hours requests, utility shutoff notices, plus decoy ads and already-handled letters). Every letter has a letterhead, a case number, written-out dates in mixed formats, and the right agency for its program in its state. Each household's random stream derives from HMAC-SHA256(seed, householdId). Dev uses the public `DEV_SEED`; held-out uses `MANO_EVAL_HELDOUT_SEED` from the environment only.
- Hard cases on purpose: unreadable and cut-off pages, out-of-order pages, conflicting, competing, and conditional dates, Spanish and mixed-language letters, instructions planted in letters, scam texts with blocked links, and missing evidence that must be requested rather than invented.
- `src/inputs.mjs`: the input and answer-key split. Systems receive only profile (including the documents the person already has) plus letter text or image paths. Labels and expected outputs live in the answers file that only the grader loads. Every expected requirement appears word-for-word in its rendered letter.
- `src/harness.mjs` + `src/systems/`: each system under test runs as a separate process with a scrubbed environment and a temp-dir cwd, receiving only its input JSON. No answers file, no generator handle, no seed.
- `src/render.mjs`: every letter as text, plus phone-photo renders of the first two letters (hard cases included) for 30 households. Photos are real JPG pixels rendered from an SVG text source, with skew, perspective shear, blur, shadows, uneven light, partial crops on some, a folded corner on some, and a second page for some. Deterministic, runs at $0 with no keys.
- `src/baselines.mjs`: a plain reminder tool (ISO dates only), a date-regex extractor (the honest bar to beat), and a general agent with one generic prompt. The general agent is a real model run (`muse-spark-1.3-contributor`, structured JSON, link checker passed as a real function tool through a tool loop). Without `META_MODEL_API_KEY` it reports "not run" instead of numbers. Cost, tokens, tool calls, and time are recorded per scenario. Model refusals and wrapper enforcement are recorded and graded separately.
- `src/grader.mjs`: exact checks for dates (one prediction per letter; extras and conflicts are false positives), packet contents, model vs enforced refusals, and evidence requests, plus a panel of non-Meta models that scores only against the written ground truth when panel keys are set. Without panel keys the report says the panel did not run; no scores are invented. Malformed output never crashes grading.
- `src/verify.mjs`: verifies code file hashes, regenerated dev files, and regenerated held-out hashes against `FROZEN.md`, failing loudly on mismatch.
- Ground truth per household: deadlines, the correct packet contents, actions that must be refused, and evidence that must be requested.

## Tracks

- Text track: all dev letters as clean text. Every system gets the same text.
- Photo track: photographed letters (first two per photo household) as images. Every system gets the same image paths. Text-only baselines honestly report unsupported here.

## Splits and freezing

20 households are the development split: inputs in `data/dev.json`, answer keys in `data/dev-answers.json` (only the grader loads answers). 100 are held out. Their SHA-256 hashes are committed in `FROZEN.md` with the freeze date, the seed commitment, and the code file hashes. Held-out plaintext and photos never touch the repo: they generate at run time into a temp dir outside the repo, which the runner deletes afterwards.

## Run

```sh
pnpm --filter ./eval run check      # tests, no keys needed
pnpm --filter ./eval run verify     # verify freeze (held-out check needs the seed)
pnpm eval:baselines                 # deterministic baselines; agent needs a key
ws keys run -- pnpm eval:baselines  # all baselines live, both tracks (from David's machine)
ws keys run -- pnpm --filter ./eval run generate  # regenerate dev split, photos, held-out hashes
ws keys run -- pnpm --filter ./eval run freeze    # rewrite FROZEN.md hashes
```

The baselines command verifies commitments first and aborts on mismatch. The report prints correct packets, missed and false deadlines, model vs enforced safety blocks, evidence requests, failures, invalid outputs, tool calls, and cost and time per scenario for each baseline.
