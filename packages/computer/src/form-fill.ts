/**
 * How Mano fills a form it may never have seen. The agent's fill and the layouts
 * probe both read these, so a number from the probe is about what the agent runs.
 */

/**
 * About 1.5 times the most any fill took on Muse Spark Open with these words,
 * 13 turns across 26 fills of new layouts (median 5). The deadline below stops a
 * run that wanders, so a cap with room costs little. Replay holds 29 at most.
 */
export const FILL_MAX_STEPS = 20;

/**
 * Inside the agent's 90 second wait for a turn (SETTLE_TIMEOUT_MS), with room
 * for the model call before the fill and the hold and reply after it. Raising
 * it means raising that wait, the turn's 95 second budget and Channels' 100
 * second wait for the agent with it.
 */
export const FILL_DEADLINE_MS = 60_000;

export const FILL_INSTRUCTIONS = [
  "The fields on a screen do not depend on each other: fill every field you can see in one batch of click and type actions.",
  "End that batch with the one action that shows more of the form: open a collapsed section, scroll to fields below, or press the button that moves on, whatever it is called.",
  "Before the last button, make sure every value is entered, and open any section you have not filled.",
].join(" ");

/** The task for one fill: each field in the words of Mano's own form, and the value as it should be typed. */
export function fillTask(fields: Array<{ label: string; value: string }>): string {
  return [
    "Fill out the form open in this browser with exactly these values. Do not attach or review anything.",
    ...fields.map((f) => `${f.label}: ${f.value}`),
    "This form may word these fields differently, ask them in another order, split them across steps, or keep them in collapsed sections. Match each value to the field that means the same thing.",
    "Type each value exactly as written. For a date field, click it, press Ctrl+A, then type the date.",
    "A long value can look cut off in a narrow field; that is fine, do not retype it.",
    "Once every value is entered, press the button that moves on, even if its name sounds final, because on this form it only saves a draft and files nothing.",
    "When a new page asks for something other than these values, such as attaching documents, stop and reply with exactly: ACCEPTED. Another step of these same fields is not the end.",
    "If the form shows an error instead, stop and reply with REJECTED: and the error text.",
  ].join("\n");
}
