// Posts a smoke run to its pull request: one comment, found by its marker and
// edited in place on every run, and one check run whose conclusion is the
// gate (success, neutral or failure). The CI step exits with exitCodeFor, so
// only a failing gate, or a run that wrote no result, turns the job red.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateStatus } from "./report.ts";

export const COMMENT_MARKER = "<!-- mano-quality-smoke -->";
export const CHECK_NAME = "quality gate";

export interface SmokeOutcome {
  status: GateStatus | "error";
  reasons: string[];
  comment: string;
}

export function readOutcome(dir: string): SmokeOutcome {
  const gatePath = join(dir, "gate.json");
  const commentPath = join(dir, "comment.md");
  if (!existsSync(gatePath) || !existsSync(commentPath)) {
    return {
      status: "error",
      reasons: ["the smoke run stopped before it wrote a result; see the job log"],
      comment: "## Quality smoke: error\n\nThe smoke run stopped before scoring. See the job log.",
    };
  }
  const gate = JSON.parse(readFileSync(gatePath, "utf8")) as { status: GateStatus; reasons: string[] };
  return { status: gate.status, reasons: gate.reasons, comment: readFileSync(commentPath, "utf8").trim() };
}

export function exitCodeFor(status: SmokeOutcome["status"]): number {
  return status === "fail" || status === "error" ? 1 : 0;
}

const CONCLUSION: Record<SmokeOutcome["status"], "success" | "neutral" | "failure"> = {
  pass: "success",
  neutral: "neutral",
  fail: "failure",
  error: "failure",
};

export interface PublishTarget {
  repo: string;
  pr: number;
  sha: string;
  token: string;
  fetchFn?: typeof fetch;
  api?: string;
}

async function gh(t: PublishTarget, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await (t.fetchFn ?? fetch)(`${t.api ?? "https://api.github.com"}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${t.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]} failed: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export async function publishSmoke(outcome: SmokeOutcome, t: PublishTarget): Promise<{ commentId: number; edited: boolean; conclusion: string }> {
  const body = `${COMMENT_MARKER}\n${outcome.comment}`;
  const comments = (await gh(t, "GET", `/repos/${t.repo}/issues/${t.pr}/comments?per_page=100`)) as { id: number; body?: string }[];
  // Earlier runs posted without the marker; their comment is reused too.
  const mine = comments.find((c) => (c.body ?? "").startsWith(COMMENT_MARKER) || (c.body ?? "").startsWith("## Quality smoke"));
  let commentId: number;
  if (mine) {
    await gh(t, "PATCH", `/repos/${t.repo}/issues/comments/${mine.id}`, { body });
    commentId = mine.id;
  } else {
    const made = (await gh(t, "POST", `/repos/${t.repo}/issues/${t.pr}/comments`, { body })) as { id: number };
    commentId = made.id;
  }
  const conclusion = CONCLUSION[outcome.status];
  const title = outcome.status === "pass" ? "Quality holds" : outcome.status === "neutral" ? "Not gate-eligible" : outcome.status === "fail" ? "Quality regressed" : "Smoke run broke";
  await gh(t, "POST", `/repos/${t.repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: t.sha,
    status: "completed",
    conclusion,
    output: { title, summary: outcome.reasons.length > 0 ? outcome.reasons.map((r) => `- ${r}`).join("\n").slice(0, 60000) : title },
  });
  return { commentId, edited: mine !== undefined, conclusion };
}
