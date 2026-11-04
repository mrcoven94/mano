// Reminder planning, with no notification dependencies: one item per
// pending approval at its remind time, one per open deadline due
// within 48 hours, a day before it hits (or a minute from now when the
// deadline is closer than that). notify.ts applies the plan. Also what a
// reminder carries for its tap, and where that tap goes.

import type { Approval, Deadline } from "./api/types";

export interface ReminderItem {
  fireAt: number;
  kind: "approval" | "deadline";
  id: string;
}

export function planReminders(approvals: Approval[], deadlines: Deadline[], nowMs = Date.now()): ReminderItem[] {
  const items: ReminderItem[] = [];
  for (const approval of approvals.filter((a) => a.status === "pending").slice(0, 10)) {
    const at = new Date(approval.remindAt).getTime();
    if (!Number.isNaN(at) && at > nowMs) items.push({ fireAt: at, kind: "approval", id: approval.id });
  }
  for (const deadline of deadlines.filter((d) => !d.done).slice(0, 10)) {
    const at = new Date(deadline.dueAt).getTime();
    if (Number.isNaN(at) || at <= nowMs || at - nowMs >= 48 * 3600_000) continue;
    const dayBefore = at - 24 * 3600_000;
    items.push({ fireAt: dayBefore > nowMs ? dayBefore : nowMs + 60_000, kind: "deadline", id: deadline.id });
  }
  return items;
}

// The approval's opaque ID travels in the notification's data, never in
// its words.
export function reminderData(item: ReminderItem): { kind: "approval"; approvalId: string } | { kind: "deadline" } {
  return item.kind === "approval" ? { kind: "approval", approvalId: item.id } : { kind: "deadline" };
}

export type NotificationRoute = "/(tabs)/deadlines" | "/(tabs)/approvals" | { pathname: "/approvals/[id]"; params: { id: string } };

// A reminder scheduled before it carried an ID, or any other notification,
// opens the list.
export function notificationRoute(data: unknown): NotificationRoute {
  const { kind, approvalId } = (data ?? {}) as { kind?: unknown; approvalId?: unknown };
  if (kind === "deadline") return "/(tabs)/deadlines";
  if (typeof approvalId === "string" && approvalId.length > 0) return { pathname: "/approvals/[id]", params: { id: approvalId } };
  return "/(tabs)/approvals";
}
