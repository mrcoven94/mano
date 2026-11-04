// The person's language for code outside React. The demo engine reads it to
// answer in that language; screens use useStrings.

import type { Language } from "./strings";

let now: Language = "en";

export function noteLanguage(language: Language): void {
  now = language;
}

export function currentLanguage(): Language {
  return now;
}
