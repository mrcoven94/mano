#!/usr/bin/env node
// @mano/meter history collector: reads git history plus the GitHub API and
// writes one summary JSON object with counts only. No message content,
// titles, bodies or SHAs reach the output. Plain node, no dependencies.
//
// Usage: node packages/meter/history/collect.mjs [--repo owner/name]
//   [--ref HEAD] [--out meter-history-YYYY-MM-DD.json]
//
// Needs git plus `gh` (authenticated; in Actions the GITHUB_TOKEN works).
// Prints the R2 key suffix (history/<day>.json) and the JSON to stdout, or
// writes it to --out. Exit 1 on any git/gh failure: a partial report would
// read as a quiet day, so fail closed instead.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  COMMITS_BODY_FORMAT,
  COMMITS_FORMAT,
  NUMSTAT_FORMAT,
  addCommits,
  addPrs,
  emptySummary,
  joinCommits,
  parseCommitBodies,
  parseCommitList,
  parseNumstat,
  r2HistoryKey,
  summarizePr,
} from "./aggregate.mjs";

function arg(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`missing value for ${flag}`);
    process.exit(1);
  }
  return value;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function main() {
  const ref = arg("ref", "HEAD");
  const out = arg("out", null);
  let repo = arg("repo", null);

  const viewArgs = repo === null ? ["repo", "view"] : ["repo", "view", repo];
  const info = JSON.parse(run("gh", [...viewArgs, "--json", "nameWithOwner,owner"]));
  repo = info.nameWithOwner;
  const owner = info.owner.login;
  const summary = emptySummary(repo);
  summary.generatedAt = new Date().toISOString();

  const list = parseCommitList(run("git", ["log", ref, "--no-merges", `--format=${COMMITS_FORMAT}`]));
  const bodies = parseCommitBodies(
    run("git", ["log", ref, "--no-merges", `--format=${COMMITS_BODY_FORMAT}`]),
  );
  const numstat = parseNumstat(
    run("git", ["log", ref, "--no-merges", `--format=${NUMSTAT_FORMAT}`, "--numstat"]),
  );
  addCommits(summary, joinCommits(list, bodies, numstat));

  const prs = JSON.parse(
    run("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      "500",
      "--json",
      "number,title,state,createdAt,mergedAt",
    ]),
  );
  const rows = [];
  for (const pr of prs) {
    const detail = JSON.parse(
      run("gh", ["pr", "view", String(pr.number), "--repo", repo, "--json", "comments,reviews"]),
    );
    rows.push(summarizePr(pr, detail, owner));
  }
  addPrs(summary, rows);

  const day = summary.generatedAt.slice(0, 10);
  const key = r2HistoryKey("meter/", day);
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (out) {
    writeFileSync(out, json);
    console.log(`${key} ${out}`);
  } else {
    process.stdout.write(json);
  }
}

main();
