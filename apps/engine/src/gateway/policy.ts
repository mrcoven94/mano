import type { ActionRequest, ActionType, PolicyDecision } from "./types.js";

const DEFAULT_POLICY: Record<ActionType, PolicyDecision> = {
  send: "ask",
  submit: "ask",
  call: "ask",
  fax: "ask",
  share: "ask",
};

export function evaluatePolicy(
  req: ActionRequest,
  overrides: Partial<Record<ActionType, PolicyDecision>> = {},
): PolicyDecision {
  if (req.actor === "background") return "block";
  const policy = { ...DEFAULT_POLICY, ...overrides };
  return policy[req.type] ?? "block";
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
