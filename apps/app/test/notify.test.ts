import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({
  cancelAllScheduledNotificationsAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  SchedulableTriggerInputTypes: { DATE: "date" },
}));

import * as Notifications from "expo-notifications";
import { syncReminders } from "../lib/notify";
import type { Approval, ManoClient, Session } from "../lib/api/types";

const cancelAll = vi.mocked(Notifications.cancelAllScheduledNotificationsAsync);
const schedule = vi.mocked(Notifications.scheduleNotificationAsync);

const session: Session = {
  token: "token-alice",
  personId: "alice",
  email: "alice@example.com",
  displayName: "alice",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

function clientWithApproval(): ManoClient {
  const approval = {
    id: "appr-1",
    status: "pending",
    remindAt: new Date(Date.now() + 3600_000).toISOString(),
  } as Approval;
  return {
    listApprovals: async () => [approval],
    listDeadlines: async () => [],
  } as unknown as ManoClient;
}

describe("syncReminders", () => {
  it("schedules from fresh data when the session is still current", async () => {
    cancelAll.mockClear();
    schedule.mockClear();
    const count = await syncReminders("en", clientWithApproval(), session, () => true);
    expect(count).toBe(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("schedules nothing when the fetch outlived its session", async () => {
    cancelAll.mockClear();
    schedule.mockClear();
    const count = await syncReminders("en", clientWithApproval(), session, () => false);
    expect(count).toBe(0);
    expect(cancelAll).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
});
