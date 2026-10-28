// Live alerts. When the day's hard-check failure rate or judge mean moves past
// the pull request gate thresholds, quality posts to LAP-567 through the
// Linear API with the numbers only, never text.

import { HARD_DROP_MAX, JUDGE_DROP_MAX } from "./report.ts";

export interface DayQuality {
  answers: number;
  hardFailRate: number;
  judgeMean: number | null;
  judgeSamples: number;
}

export interface AlertEvaluation {
  fire: boolean;
  reasons: string[];
}

export function evalAlert(day: DayQuality, baseline: { hardFailRate: number; judgeMean: number }): AlertEvaluation {
  const reasons: string[] = [];
  if (day.answers === 0) return { fire: false, reasons };
  if (day.hardFailRate - baseline.hardFailRate > HARD_DROP_MAX) {
    reasons.push(`hard-check failure rate ${(baseline.hardFailRate * 100).toFixed(1)}% to ${(day.hardFailRate * 100).toFixed(1)}% (over 5 points)`);
  }
  if (day.judgeMean !== null && baseline.judgeMean - day.judgeMean > JUDGE_DROP_MAX) {
    reasons.push(`judge mean ${baseline.judgeMean.toFixed(2)} to ${day.judgeMean.toFixed(2)} (drop over ${JUDGE_DROP_MAX})`);
  }
  return { fire: reasons.length > 0, reasons };
}

export function alertBody(day: DayQuality, reasons: string[], date: string): string {
  const lines = [
    `Live quality alert for ${date}, numbers only.`,
    `Answers checked: ${day.answers}.`,
    `Hard-check failure rate: ${(day.hardFailRate * 100).toFixed(1)}%.`,
    day.judgeMean === null
      ? `Judge samples: none yet.`
      : `Judge mean: ${day.judgeMean.toFixed(2)} over ${day.judgeSamples} samples.`,
    "",
    "Threshold crossings:",
  ];
  for (const r of reasons) lines.push(`- ${r}`);
  return lines.join("\n");
}

export interface LinearPoster {
  apiUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

export async function postToLinearTicket(poster: LinearPoster, issueNumber: string, body: string): Promise<{ issueId: string; commentId: string }> {
  const run = poster.fetchFn ?? fetch;
  const headers = { "content-type": "application/json", authorization: poster.apiKey };
  const [teamKey, num] = issueNumber.split("-");
  const found = (await (await run(poster.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: "query($team:String!,$num:Float!){issues(filter:{team:{key:{eq:$team}},number:{eq:$num}}){nodes{id identifier}}}",
      variables: { team: teamKey, num: Number(num) },
    }),
  })).json()) as { data?: { issues?: { nodes?: { id: string }[] } } };
  const issueId = found.data?.issues?.nodes?.[0]?.id;
  if (!issueId) throw new Error(`Linear ticket ${issueNumber} not found`);
  const made = (await (await run(poster.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: "mutation($issueId:String!,$body:String!){commentCreate(input:{issueId:$issueId,body:$body}){comment{id}}}",
      variables: { issueId, body },
    }),
  })).json()) as { data?: { commentCreate?: { comment?: { id: string } } } };
  const commentId = made.data?.commentCreate?.comment?.id;
  if (!commentId) throw new Error(`Linear comment on ${issueNumber} failed`);
  return { issueId, commentId };
}

export function linearPosterFromEnv(env: NodeJS.ProcessEnv = process.env): LinearPoster | null {
  const apiKey = env.LINEAR_BACKPACK_API_KEY ?? "";
  if (!apiKey) return null;
  return { apiUrl: env.LINEAR_API_URL || "https://api.linear.app/graphql", apiKey };
}
