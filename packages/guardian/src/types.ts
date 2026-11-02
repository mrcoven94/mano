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

// The request the model checker sends: built explicitly from the validated
// schema fields the checker needs. Unknown fields never leave Mano.
export interface ModelRequest {
  action: {
    type: ActionType;
    recipient: string;
    purpose: string;
    payload: unknown;
  };
  sources: { kind: SourceKind; id: string; quote?: string }[];
  consents: { recipient: string; purpose: string }[];
  origin: Origin;
}

export interface CheckResult {
  verdict: Verdict;
  problems: string[];
}

export interface Checker {
  check(input: CheckInput): Promise<CheckResult>;
  // Starts a model-backed checker ahead of a check. Rules-only checkers
  // have nothing to start.
  warm?(): Promise<WarmState>;
}

export type WarmState = "ready" | "starting" | "failed";
