# Mano eval

Frozen held-out eval for the renewal and document story. Built by a separate agent session from the one building the agent, and frozen before anyone tunes prompts.

## Layout

- `src/generator.mjs`: synthetic households across CA, TX, NY, FL, IL and WA, 3 to 8 full one-page letters each (Medicaid renewals, SNAP recertifications, missing-document requests, work-hours requests, utility shutoff notices, plus decoy ads and already-handled letters). Every letter has a letterhead, a case number, written-out dates in mixed formats, and the right agency for its program in its state. Dev split uses the public `DEV_SEED`; held-out uses `MANO_EVAL_HELDOUT_SEED` from the environment only.
- Hard cases on purpose: unreadable and cut-off pages, out-of-order pages, conflicting dates, Spanish and mixed-language letters, instructions planted in letters, scam texts with blocked links, and missing evidence that must be requested rather than invented.
- `src/inputs.mjs`: the input and answer-key split. Baselines receive only `{ householdId, name, state, letters: [{ letterId, text, pages }] }`. Labels (`kind`, `hardCase`) and expected outputs live in the answers file that only the grader loads.
- `src/render.mjs`: every letter as text, plus a phone-photo render for 30 households. Photos are real JPG pixels rendered from an SVG text source, with skew, blur, shadows, a folded corner on some, and a second page for some. Deterministic, runs at $0 with no keys.
- `src/baselines.mjs`: a plain reminder tool (deterministic, ISO dates only) and a general agent with one generic prompt. The general agent is a real model run (`muse-spark-1.3-contributor`, structured JSON, same tools Mano gets in `src/tools.mjs` including the Cloudflare DoH link check that fails closed). Without `META_MODEL_API_KEY` it reports "not run" instead of numbers. Cost and time are recorded per scenario.
- `src/grader.mjs`: exact checks for dates, packet contents, refusals and evidence requests, plus a panel of non-Meta models that scores only against the written ground truth when panel keys are set. Without panel keys the report says the panel did not run; no scores are invented.
- Ground truth per household: deadlines, the correct packet contents, actions that must be refused, and evidence that must be requested.

## Splits and freezing

20 households are the development split: inputs in `data/dev.json`, answer keys in `data/dev-answers.json` (only the grader loads answers). 100 are held out. Their SHA-256 hashes are committed in `FROZEN.md` with the freeze date and the seed commitment. Held-out plaintext is never committed and the baselines command never loads it. Regenerate held-out scenarios at run time from `MANO_EVAL_HELDOUT_SEED` and verify against the frozen hashes. The seed itself is never printed or committed.

## Run

```sh
pnpm --filter ./eval run check      # tests, no keys needed
pnpm eval:baselines                 # reminder baseline; general agent needs a key
ws keys run -- pnpm eval:baselines  # both baselines live (from David's machine)
ws keys run -- pnpm --filter ./eval run generate  # regenerate dev split, photos, held-out hashes
ws keys run -- pnpm --filter ./eval run freeze    # rewrite FROZEN.md hashes
```

The baselines report prints correct packets, missed deadlines, unsafe actions blocked or not, evidence requests, failures, and cost and time per scenario for each baseline.
