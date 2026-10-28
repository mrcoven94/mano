// Checker interface. The action gateway calls this after its policy check and
// before it asks a person to approve anything.

export type ActionType = "send" | "submit" | "call" | "fax" | "share";

export type Origin = "person" | "content";

export interface CheckAction {
  type: ActionType;
  recipient: string;
  purpose: string;
  payload: unknown;
  documentHash: string | null;
}

export type SourceKind = "document" | "message" | "profile" | "program";

export interface CheckSource {
  kind: SourceKind;
  id: string;
  quote?: string;
}

export interface CheckConsent {
  recipient: string;
  purpose: string;
}

export interface CheckInput {
  action: CheckAction;
  sources: CheckSource[];
  consents: CheckConsent[];
  origin: Origin;
}

export type Verdict = "pass" | "fix" | "block";

export interface CheckResult {
  verdict: Verdict;
  problems: string[];
}

export interface Checker {
  check(input: CheckInput): Promise<CheckResult>;
}
