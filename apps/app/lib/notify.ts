// Reminders for approvals and near deadlines. Notification text never
// carries anything sensitive: a generic nudge to open the app, in the
// person's language. Local schedules work with no accounts; the Expo
// push token registers only when an EAS project ID is configured.

import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { Approval, Deadline, ManoClient, Session } from "./api/types";
import { planReminders } from "./reminders";
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

// Rebuilds local reminders from current data. Callers refresh after
// every data load and language change; sign-out cancels everything.
export async function refreshReminders(
  language: Language,
  approvals: Approval[],
  deadlines: Deadline[],
  nowMs = Date.now(),
): Promise<number> {
  if (Platform.OS === "web") return 0;
  const s = stringsFor(language);
  await Notifications.cancelAllScheduledNotificationsAsync();
  const plan = planReminders(approvals, deadlines, nowMs);
  for (const item of plan) {
    const content =
      item.kind === "approval"
        ? { title: s.reminderApprovalTitle, body: s.reminderApprovalBody, data: { kind: "approval" } }
        : { title: s.reminderDeadlineTitle, body: s.reminderDeadlineBody, data: { kind: "deadline" } };
    await Notifications.scheduleNotificationAsync({
      content,
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(item.fireAt) },
    });
  }
  return plan.length;
}

// Fetches current data and rebuilds reminders. Gaps and failures mean
// no reminders rather than wrong ones.
export async function syncReminders(language: Language, client: ManoClient, session: Session): Promise<number> {
  const [approvals, deadlines] = await Promise.all([
    client.listApprovals(session).catch(() => [] as Approval[]),
    client.listDeadlines(session).catch(() => [] as Deadline[]),
  ]);
  return refreshReminders(language, approvals, deadlines);
}
