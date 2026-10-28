// Reminders for approvals and near deadlines. Notification text never
// carries anything sensitive: a generic nudge to open the app, in the
// person's language. Local schedules work with no accounts; the Expo
// push token registers only when an EAS project ID is configured.

import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { Approval, Deadline } from "./api/types";
import { stringsFor, type Language } from "./strings";

const CHANNEL_ID = "mano-reminders";

export async function ensureNotificationSetup(projectId: string | null): Promise<{
  granted: boolean;
  pushToken: string | null;
}> {
  if (Platform.OS === "web") return { granted: false, pushToken: null };
  Notifications.setNotificationHandler({
    handleNotification: () => Promise.resolve({ shouldPlaySound: false, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true }),
  });
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Reminders",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  const granted =
    current.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return { granted: false, pushToken: null };
  if (!projectId) return { granted: true, pushToken: null };
  try {
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return { granted: true, pushToken: token.data };
  } catch {
    return { granted: true, pushToken: null };
  }
}

// Rebuilds local reminders from current data: one per pending approval
// at its remind time, one per open deadline due within 48 hours.
export async function refreshReminders(
  language: Language,
  approvals: Approval[],
  deadlines: Deadline[],
  nowMs = Date.now(),
): Promise<number> {
  if (Platform.OS === "web") return 0;
  const s = stringsFor(language);
  await Notifications.cancelAllScheduledNotificationsAsync();
  let count = 0;
  const pending = approvals.filter((a) => a.status === "pending").slice(0, 10);
  for (const approval of pending) {
    const at = new Date(approval.remindAt).getTime();
    if (Number.isNaN(at) || at <= nowMs) continue;
    await Notifications.scheduleNotificationAsync({
      content: { title: s.reminderApprovalTitle, body: s.reminderApprovalBody },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at) },
    });
    count += 1;
  }
  const soon = deadlines
    .filter((d) => !d.done)
    .filter((d) => {
      const at = new Date(d.dueAt).getTime();
      return !Number.isNaN(at) && at > nowMs && at - nowMs < 48 * 3600_000;
    })
    .slice(0, 10);
  for (const deadline of soon) {
    await Notifications.scheduleNotificationAsync({
      content: { title: s.reminderDeadlineTitle, body: s.reminderDeadlineBody },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(new Date(deadline.dueAt).getTime() - 24 * 3600_000),
      },
    });
    count += 1;
  }
  return count;
}
