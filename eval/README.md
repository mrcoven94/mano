# Mano eval

Frozen held-out eval for the renewal and document story. Built by a separate agent session from the one building the agent, and frozen before anyone tunes prompts.

## Layout

- `src/generator.mjs`: fixed-seed generator, 120 synthetic households across CA, TX, NY, FL, IL and WA, 3 to 8 letters each (Medicaid renewals, SNAP recertifications, missing-document requests, work-hours requests, utility shutoff notices, plus decoy ads and already-handled letters).
- Hard cases on purpose: unreadable and cut-off pages, out-of-order pages, conflicting dates, Spanish and mixed-language letters, instructions planted in letters, scam texts with blocked links, and missing evidence that must be requested rather than invented.
- `src/render.mjs`: every letter as text, plus a phone-photo render for 30 households. With `META_MODEL_API_KEY` set it calls Muse Image (`muse-image-1.0-contributor`, synthetic data only); without a key it writes a deterministic local SVG so the pipeline runs at $0. Budget stays under $25 by capping photos at 30 households.
- `src/baselines.mjs`: a plain reminder tool and a general agent with one generic prompt. Same inputs, same tools (`src/tools.mjs`, including the Cloudflare DoH link check that fails closed). Until the engine exists they call Meta models directly through the Responses API when a key is set, and run deterministic offline parsers when it is not.
- `src/grader.mjs`: exact checks for dates, packet contents and refusals, plus a panel of non-Meta models that scores only against the written ground truth when panel keys are set. Without panel keys the report says the panel did not run; no scores are invented.
- Ground truth per household: deadlines, the correct packet contents, actions that must be refused, and evidence that must be requested.

## Splits and freezing

20 households are the development split in `data/dev.json`. 100 are held out. Their SHA-256 hashes are committed in `FROZEN.md` with the freeze date. Held-out plaintext is never committed and the baselines command never loads it. Regenerate and verify with the fixed seed in `src/generator.mjs`.

## Run

```sh
pnpm --filter ./eval run generate   # regenerate dev split and photo renders
pnpm --filter ./eval run freeze     # rewrite FROZEN.md hashes
pnpm eval:baselines                 # both baselines on the dev split, with the report
pnpm --filter ./eval run check      # tests
```

The baselines report prints correct packets, missed deadlines, unsafe actions blocked or not, failures, cost and time for each baseline.
