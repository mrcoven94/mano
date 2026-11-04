// Spoken names for controls whose picture changes with their state, so the
// name never describes the state the control has left.

import type { Strings } from "./strings";

export function attachToggleLabel(open: boolean, s: Strings): string {
  return open ? s.attachClose : s.mailTitle;
}

export function voiceRecordLabel(recording: boolean, s: Strings): string {
  return recording ? s.recording : s.attachVoice;
}

// A tab's name carries the count its badge shows, which a name set here would
// otherwise hide from a screen reader.
export function tabLabel(title: string, count = 0): string {
  return count > 0 ? `${title}, ${count}` : title;
}
