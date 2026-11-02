import { describe, expect, it } from "vitest";
import { planReminders } from "../lib/reminders";
import type { Approval, Deadline } from "../lib/api/types";

const NOW = new Date("2026-10-28T12:00:00.000Z").getTime();

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "appr-1",
    actionType: "submit",
    recipient: "r",
    recipientName: "R",
    purpose: "p",
    documentHash: null,
    documentId: null,
    documentName: null,
    requestJson: "{}",
    requestHash: "h",
    idempotencyKey: "k",
    status: "pending",
    problems: [],
    createdAt: "2026-10-28T00:00:00.000Z",
    remindAt: "2026-11-03T09:00:00.000Z",
    expiresAt: "2026-11-10T09:00:00.000Z",
    escalated: false,
    ...overrides,
  };
}

function deadline(overrides: Partial<Deadline> = {}): Deadline {
  return {
    id: "ddl-1",
    title: "t",
    detail: null,
    dueAt: "2026-10-29T12:00:00.000Z",
    relatedApprovalId: null,
    done: false,
    ...overrides,
  };
}

describe("planReminders", () => {
  it("schedules pending approvals at their remind time", () => {
    const items = planReminders([approval()], [], NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ fireAt: new Date("2026-11-03T09:00:00.000Z").getTime(), kind: "approval", id: "appr-1" });
  });

  it("skips decided approvals and past remind times", () => {
    expect(planReminders([approval({ status: "approved" })], [], NOW)).toHaveLength(0);
    expect(planReminders([approval({ remindAt: "2026-10-27T00:00:00.000Z" })], [], NOW)).toHaveLength(0);
  });

  it("reminds a day before near deadlines, or a minute from now when closer", () => {
    const dayOut = planReminders([], [deadline({ dueAt: "2026-10-29T12:00:00.000Z" })], NOW);
    expect(dayOut).toHaveLength(1);
    expect(dayOut[0]?.fireAt).toBe(NOW + 60_000);
    const twoDays = planReminders([], [deadline({ id: "ddl-2", dueAt: "2026-10-30T11:00:00.000Z" })], NOW);
    expect(twoDays[0]?.fireAt).toBe(new Date("2026-10-29T11:00:00.000Z").getTime());
  });

  it("skips done, distant and past deadlines", () => {
    expect(planReminders([], [deadline({ done: true })], NOW)).toHaveLength(0);
    expect(planReminders([], [deadline({ dueAt: "2026-11-15T00:00:00.000Z" })], NOW)).toHaveLength(0);
    expect(planReminders([], [deadline({ dueAt: "2026-10-27T00:00:00.000Z" })], NOW)).toHaveLength(0);
  });

  it("caps each kind at ten", () => {
    const many = Array.from({ length: 12 }, (_, i) => approval({ id: `a-${i}` }));
    expect(planReminders(many, [], NOW)).toHaveLength(10);
  });
});
