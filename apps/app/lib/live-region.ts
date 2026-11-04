// How a message reaches a screen reader on each platform. On Android and the
// web a live region speaks when content lands in it, so components/ui.tsx
// keeps one on screen before its text arrives. iOS has no live regions in
// React Native (0.88 reads accessibilityLiveRegion only on Android), so there
// the same words go through AccessibilityInfo. Calling both would speak twice.

// A region and its text added together are not announced: the region has to
// be in the accessibility tree first. This is long enough for a new tree to
// settle, and short enough that a person does not see the text arrive late.
export const LIVE_REGION_ARM_MS = 100;

export function liveRegionProps(urgent: boolean): { role: "alert"; "aria-live": "assertive" } | { role: "status"; "aria-live": "polite" } {
  return urgent ? { role: "alert", "aria-live": "assertive" } : { role: "status", "aria-live": "polite" };
}

export function announcesByCall(platform: string): boolean {
  return platform === "ios";
}

// An urgent message cuts in. Anything else waits for what is being read, such
// as the button the person just pressed.
export function announceOptions(urgent: boolean): { queue: boolean } {
  return { queue: !urgent };
}
