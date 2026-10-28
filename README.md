# Mano

Apply once, for anything that makes your life better.

Mano gives every person their own agent. It applies for benefits, cash assistance, jobs, scholarships and training, fills out any form you hand it, reads your mail from a photo, renews on time and waits on hold for you. Every government office and nonprofit that runs those programs can claim agents of their own, and the agents work a case together with the resident's consent. A person approves every decision.

Built for the Meta Global AI Developer Hackathon (October 26 to November 4, 2026) on Meta's Muse models.

## Status

Under construction during the hackathon. Everything in this repository was written from October 26, 2026 onward.

## Team

Three members: David Coven, Claude and Muse.

- David decides what gets built, owns the accounts and approves every merge.
- Claude is the architect. It plans the work, writes each build session's brief, orchestrates the sessions and reviews what they produce.
- Muse writes the code. Each part of Mano is built by a Muse Code session running Muse Spark, working from one brief and one ticket.
- Other models handle evaluation and review: an independent critique of every pull request from a model outside the build, plus a panel of open-weight models for changes that touch security, personal data or anything irreversible. A session never reviews its own work.

## Layout

| Path | What |
| --- | --- |
| `apps/engine` | The agent engine on Cloudflare: one agent per person and per organization, the action gateway |
| `apps/sandbox-portal` | A fake benefits portal every demo submits to, on Cloudflare Workers |
| `apps/channels` | The messaging worker on Cloudflare: webhooks, one conversation per handle, answers by text |
| `apps/site` | withmano.com: the public website and the resident and staff screens, on Vercel |
| `packages/channels` | The messaging library: the provider interface, the responder interface, turns and limits |
| `packages/protocol` | The open message format agents use to work a case together |
| `eval` | The held-out test: scenarios, baselines and results |
| `docs` | Decisions and design notes |

## Sandbox portal

`apps/sandbox-portal` is a fake state benefits portal: a three-step renewal application with uploads, confirmation numbers, and idempotency keys the action gateway reconciles against. Demos submit here; Mano never touches a real benefits site. Run it with `pnpm --filter @mano/sandbox-portal dev` (details in the header comment of its `src/index.ts`). Pushing to `main` deploys it.

## Eval

The held-out test lives in `eval/`, frozen before anyone tunes prompts. Twenty development households are public (`eval/data/dev.json` plus answer keys in `eval/data/dev-answers.json`, which only the grader loads). One hundred households are held out: only hashes are committed, in the freeze record at `eval/data/heldout-hashes.json`, and scenarios regenerate at run time from the secret `MANO_EVAL_HELDOUT_SEED`.

Two tracks: text (all letters as text) and photo (photographed letters as images). Three baselines run each track in isolated subprocesses: a plain reminder tool, a deterministic string-matching parser (the honest bar), and a general agent (one generic prompt, real model run with a link-checker tool). The report prints correct packets, missed and false deadlines, model versus enforced safety recognition, evidence requests, failures, and cost and time per scenario.

```sh
pnpm --filter ./eval run check      # tests, no keys needed
pnpm --filter ./eval run verify     # verify freeze (held-out check needs the seed)
pnpm eval:baselines                 # deterministic baselines; agent needs a key
ws keys run -- pnpm eval:baselines  # all baselines live, both tracks
```

## Prior work

Program, office and form data come from Front Door, an earlier product by the same author, through its partner API. Front Door's code is not part of this repository.

## License

MIT
