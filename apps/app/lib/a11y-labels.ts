// Spoken names for controls whose picture changes with their state, so the
// name never describes the state the control has left.

import type { Strings } from "./strings";

export function attachToggleLabel(open: boolean, s: Strings): string {
  return open ? s.attachClose : s.mailTitle;
}

export function voiceRecordLabel(recording: boolean, s: Strings): string {
  return recording ? s.recording : s.attachVoice;
}

// A tab's name carries the count its badge shows. iOS exposes tabs as buttons,
// so there the name also says it is a tab and which one, in the person's language.
export function tabLabel(title: string, tab: { position: number; total: number; count?: number }, platform: string, s: Strings): string {
  const named = tab.count ? `${title}, ${tab.count}` : title;
  return platform === "ios" ? `${named}, ${s.tabWord}, ${tab.position} ${s.tabOf} ${tab.total}` : named;
}
