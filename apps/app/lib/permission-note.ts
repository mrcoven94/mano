// A permission the person has off, and how to say so. Apart from the picker
// so a screen can name the problem and tests never touch Expo modules.

import type { Strings } from "./strings";

export type DeniedMedia = "camera" | "library" | "microphone";

export class PermissionDeniedError extends Error {
  readonly media: DeniedMedia;
  constructor(media: DeniedMedia) {
    super(`The ${media} permission was not granted.`);
    this.name = "PermissionDeniedError";
    this.media = media;
  }
}

// null is no note. "failed" is anything else that stopped a pick or recording.
export type MediaNote = DeniedMedia | "failed" | null;

export function noteFor(err: unknown): Exclude<MediaNote, null> {
  return err instanceof PermissionDeniedError ? err.media : "failed";
}

// What happened and how to turn it on. A browser has no settings screen an
// app can open, so only a phone gets the button.
export function mediaNoteText(note: Exclude<MediaNote, null>, platform: string, s: Strings): { text: string; opensSettings: boolean } {
  if (note === "failed") return { text: s.mediaFailed, opensSettings: false };
  const what = note === "camera" ? s.permissionCamera : note === "library" ? s.permissionLibrary : s.permissionMicrophone;
  const web = platform === "web";
  return { text: `${what} ${web ? s.permissionHowWeb : s.permissionHowPhone}`, opensSettings: !web };
}
