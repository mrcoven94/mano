# Contributing

Thanks for helping. Read `AGENTS.md` and `docs/decisions.md` first; they apply to people and to coding agents alike.

## Run it

You need Node 24 and pnpm. No accounts and no keys: every package runs with local stand-ins when its keys are missing and says which parts are not live.

```sh
pnpm install
pnpm check
pnpm --filter @mano/site dev
```

Copy an app's `.env.example` to `.dev.vars` or `.env` to use your own keys.

## Test it

`pnpm check` at the root runs every package's checks. Changes to the action gateway, the protocol or anything that sends must add tests. If `pnpm-lock.yaml` conflicts, rebase on `main` and run `pnpm install` again.

## Propose a change

Small pull requests, one job each, with a `[Session]` prefix in the title so release notes group by session (for example `[Site] ...`). `pnpm check` must pass. Put usage in the root `README.md` or a header comment, and reports in the pull request.

## Sessions

During the hackathon each part of Mano is a named workstream with one ticket, such as Engine (LAP-500), Agent (LAP-613), Channels (LAP-508) or Mail (LAP-503). The full list and how work moves from brief to merge live in `AGENTS.md`. Nobody reviews their own work: every pull request is checked by a reviewer from a different model family, or a person, before it merges.

## Rules a contributor must follow

- Synthetic people only. No real names, documents, case numbers or phone numbers anywhere: not in fixtures, logs, prompts or screenshots.
- No keys in code, logs or commits. Keys live in config and secrets, never in the repo.
- Every outside action goes through the action gateway, with an approval bound to the exact document.
- Mano never presents itself as a human or as the person.
- No new Markdown files. The allowlist is in `AGENTS.md` hard rule 12, and `pnpm check` enforces it.
- Plain language in anything a person reads. No em dashes.
