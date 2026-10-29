import type { ActionRequest, ActionType, PolicyDecision } from "./types.js";

const DEFAULT_POLICY: Record<ActionType, PolicyDecision> = {
  send: "ask",
  submit: "ask",
  call: "ask",
  fax: "ask",
  share: "ask",
};

const KNOWN_TYPES: ReadonlySet<string> = new Set(Object.keys(DEFAULT_POLICY));
const DECISIONS: ReadonlySet<string> = new Set(["allow", "ask", "block"]);

export function evaluatePolicy(
  req: ActionRequest,
  overrides: Partial<Record<ActionType, PolicyDecision>> = {},
): PolicyDecision {
  if (req.actor === "background") return "block";
  // Own-property lookup against a fixed allowlist: inherited names such as
  // "toString" or "__proto__" never match, and overrides for unknown types
  // are ignored. Anything other than allow or ask is a block.
  let decision: unknown;
  if (KNOWN_TYPES.has(req.type)) {
    decision = DEFAULT_POLICY[req.type];
    if (Object.hasOwn(overrides, req.type)) {
      const override = (overrides as Record<string, unknown>)[req.type];
      if (typeof override === "string" && DECISIONS.has(override)) decision = override;
    }
  }
  return decision === "allow" || decision === "ask" ? decision : "block";
}

export function approvalWindow(now: Date, deadlineAt?: string) {
  const createdAt = now;
  const remindAt = new Date(now.getTime() + 4 * 3600_000);
  let expiresAt = new Date(now.getTime() + 24 * 3600_000);
  let escalated = false;
  if (deadlineAt) {
    const deadline = new Date(deadlineAt).getTime();
    const hoursLeft = (deadline - now.getTime()) / 3600_000;
    if (hoursLeft < 24) {
      escalated = true;
      const sooner = new Date(now.getTime() + Math.max(1, hoursLeft / 2) * 3600_000);
      if (sooner < expiresAt) expiresAt = sooner;
    }
    if (hoursLeft < 8) {
      const soonerRemind = new Date(now.getTime() + 30 * 60_000);
      return { createdAt, remindAt: soonerRemind, expiresAt, escalated };
    }
  }
  return { createdAt, remindAt, expiresAt, escalated };
}
