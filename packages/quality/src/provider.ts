// Provider check: one tiny synthetic call before a live run, so an account
// problem at the model provider is reported as what it is instead of as
// every case failing. Only HTTP 402 (Payment Required: the provider refuses
// all calls until billing is fixed) counts as the provider being unavailable.
// A 401 can be a wrong or revoked key, a 429 or 5xx is transient load the
// responders already retry, and both can come from our own config, so they
// run as before and fail the run if they persist.

import { DEFAULT_MODEL_BASE_URL, viaAiGateway } from "./models.ts";

export type ProviderCheck =
  | { state: "available" }
  // The call failed some other way. The live run goes ahead and reports it.
  | { state: "error"; detail: string }
  | { state: "unavailable"; status: 402; errorType: string | null; errorCode: string | null };

interface ErrorBody {
  error?: { type?: unknown; code?: unknown };
  type?: unknown;
  code?: unknown;
}

const MACHINE_STRING_RE = /^[a-z0-9_.-]{1,64}$/i;
const TRAILING_SLASH_RE = /\/$/;

function field(value: unknown): string | null {
  return typeof value === "string" && MACHINE_STRING_RE.test(value) ? value : null;
}

// Reads only the error type and code, which are machine strings; the
// provider's message text is never kept.
export function classifyProviderResponse(status: number, bodyText: string): ProviderCheck {
  if (status >= 200 && status < 300) return { state: "available" };
  if (status !== 402) return { state: "error", detail: `http_${status}` };
  let body: ErrorBody = {};
  try {
    body = JSON.parse(bodyText) as ErrorBody;
  } catch {
    // A 402 without a JSON body is still Payment Required.
  }
  return {
    state: "unavailable",
    status: 402,
    errorType: field(body.error?.type ?? body.type),
    errorCode: field(body.error?.code ?? body.code),
  };
}

// Calls the same /responses endpoint and serving model the text line uses,
// with a synthetic prompt. Without a key there is nothing to check.
export async function checkProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<ProviderCheck | null> {
  const key = env.META_MODEL_API_KEY ?? "";
  const model = env.MANO_MODEL_BENCH_ID || env.MANO_MODEL_JUDGE_ID || "";
  if (!key || !model) return null;
  const base = (env.MANO_MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL).replace(TRAILING_SLASH_RE, "");
  try {
    const res = await fetchFn(`${base}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...(viaAiGateway(base) ? { "cf-aig-collect-log": "false" } : {}),
      },
      body: JSON.stringify({ model, input: "Reply with the word ok.", store: false, max_output_tokens: 64 }),
      signal: AbortSignal.timeout(30_000),
    });
    return classifyProviderResponse(res.status, await res.text().catch(() => ""));
  } catch (err) {
    return { state: "error", detail: err instanceof Error ? err.name : "request_error" };
  }
}

export function unavailableReason(check: Extract<ProviderCheck, { state: "unavailable" }>): string {
  const detail = [check.errorType, check.errorCode].filter((x) => x !== null).join(" / ");
  return `The model provider refused the check call with HTTP 402${detail ? ` (${detail})` : ""}, a billing or account problem on the provider side`;
}

// The text for the job summary and the pull request comment.
export function unavailableSummary(lane: "smoke" | "nightly", check: Extract<ProviderCheck, { state: "unavailable" }>): string {
  const skipped = lane === "smoke"
    ? "No case ran live and nothing was compared with main's baseline."
    : "No suite ran, nothing was recorded to R2 and the baseline did not move.";
  return [
    `## Quality ${lane}: model provider unavailable`,
    "",
    lane === "smoke"
      ? `This is not a pass and not a quality failure. ${unavailableReason(check)}.`
      : `No quality was measured tonight, so this run fails. ${unavailableReason(check)}.`,
    skipped,
    "",
    lane === "smoke"
      ? "The smoke replay job still ran the smoke path on recorded replies; its result is in its own check. Rerun this job once the provider account is fixed."
      : "Run the nightly again by hand once the provider account is fixed.",
  ].join("\n");
}

// The smoke gate on a 402. The outage stands in only for what needs the
// model; a strict failure that does not (main's baseline unreadable) still
// fails the gate, with the outage named next to it.
export function unavailableGate(
  check: Extract<ProviderCheck, { state: "unavailable" }>,
  opts: { strict: boolean; missing: string[] },
): { status: "provider-unavailable" | "fail"; reasons: string[] } {
  const reason = unavailableReason(check);
  if (opts.strict && opts.missing.length > 0) return { status: "fail", reasons: [...opts.missing, reason] };
  return { status: "provider-unavailable", reasons: [reason] };
}
