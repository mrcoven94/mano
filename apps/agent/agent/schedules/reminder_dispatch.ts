import { defineSchedule } from "eve/schedules";

import { deliverToChannels } from "../lib/deliver.js";
import { getReminderStore } from "../lib/reminder-store.js";

const CLAIM_LIMIT = 25;

// Every minute, delivers due reminders as texts through Channels. Each
// row is claimed before delivery and marked sent only after Channels
// accepts it; a crash in between leaves the claim to expire so the next
// run picks the row up, and Channels dedupes on the reminder ID.
export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const channelsUrl = process.env.MANO_CHANNELS_URL;
    const secret = process.env.MANO_AGENT_SECRET;
    if (!channelsUrl || !secret) {
      console.warn("mano: MANO_CHANNELS_URL or MANO_AGENT_SECRET is not set; reminders stay queued.");
      return;
    }
    const store = await getReminderStore();
    const due = await store.claimDue(Date.now(), CLAIM_LIMIT);
    for (const reminder of due) {
      try {
        await deliverToChannels({
          channelsUrl,
          secret,
          handleHash: reminder.handleHash,
          text: `Reminder: ${reminder.text}`,
          key: reminder.id,
        });
        await store.markSent(reminder.id, Date.now());
        console.log(JSON.stringify({ type: "mano_reminder_sent", reminder: reminder.id }));
      } catch (err) {
        await store.releaseClaim(reminder.id);
        console.warn(
          JSON.stringify({
            type: "mano_reminder_failed",
            reminder: reminder.id,
            err: err instanceof Error ? err.name : "unknown",
          }),
        );
      }
    }
  },
});
