import type { SourceCitation } from "@mano/protocol";
import type { ActionType } from "./types.js";

// The Checker hook. The gateway calls it after policy and before an
// approval is created (and before executing allow-path actions). Verdicts:
// pass continues; fix continues on the ask path with the problems attached
// to the approval for the person to see, and blocks on the allow path;
// block always blocks. A checker error or timeout blocks. The Guardian
// session implements the production checker against this shape.
export interface CheckInput {
  action: {
    type: ActionType;
    recipient: string;
    purpose: string;
    payload: unknown;
    documentHash: string | null;
  };
  sources: SourceCitation[];
  consents: { recipient: string; purpose: string }[];
  origin: "person" | "content";
}

export interface CheckResult {
  verdict: "pass" | "fix" | "block";
  problems: string[];
}

export interface Checker {
  check(input: CheckInput): Promise<CheckResult>;
}

export class LocalRulesChecker implements Checker {
  async check(input: CheckInput): Promise<CheckResult> {
    const problems: string[] = [];
    if (input.origin === "content") {
      problems.push(
        "This request was derived from document content, which is evidence and never permission. A person must review it.",
      );
    }
    if (input.action.type === "share") {
      const covered = input.consents.some(
        (c) => c.recipient === input.action.recipient && c.purpose === input.action.purpose,
      );
      if (!covered) problems.push("No recorded consent covers this recipient and purpose yet.");
    }
    if (problems.length > 0) return { verdict: "fix", problems };
    return { verdict: "pass", problems: [] };
  }
}

export function checkerWithTimeout(checker: Checker, timeoutMs: number): Checker {
  return {
    async check(input: CheckInput): Promise<CheckResult> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          checker.check(input),
          new Promise<CheckResult>((_, reject) => {
            timer = setTimeout(() => reject(new Error("checker timed out")), timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
