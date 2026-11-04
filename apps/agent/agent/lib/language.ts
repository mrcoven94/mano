// The language a person writes in, read from their words with plain code,
// so Mano's own fixed sentences (the approval question, a letter's answer)
// can follow it without a model. Mano's model turns follow the person on
// their own; this only picks among the languages Mano has closed words for.
//
// It counts words names and addresses rarely use (so not "de la" or "ko
// po"), and needs two of them or one that stands alone as a greeting or a
// thanks. A name such as "Maria de
// la Cruz" or "Nguyen Van An", or a one-word answer, says nothing, and the
// turn falls back to what is on the profile. Guessing English is safe:
// Mano still answers, and a yes in any language still counts.
import type { ReplyLanguage } from "@mano/mail";

import type { PersonEngine, ProfileView } from "./engine.js";
import { profileKey } from "./profile.js";

const WORDS: Record<ReplyLanguage, Set<string>> = {
  en: new Set("the i to and my is you it of that this was for on are with have be what need help how do can".split(" ")),
  es: new Set(
    "que mi mis con por favor porque tengo yo una un está estoy eso esto quiero puedo necesito ayuda carta beneficios comida renovar renovación cómo qué dónde cuándo mañana tiene me dice hacer ayúdame".split(" "),
  ),
  vi: new Set(
    "tôi của không cần là và giúp đỡ thư gì làm được bị mình thế nào sao phải với này đó xin chào cảm ơn phiếu thực phẩm bạn có".split(" "),
  ),
  tl: new Set(
    "ng mga ako hindi kailangan paano ano ito tulong pagkain sulat naman yung kung akin gagawin".split(" "),
  ),
};

// Each of these is enough alone. Spanish "si" and Vietnamese "có" are not
// here: they answer a question and are read by decision.ts.
const ALONE: Partial<Record<ReplyLanguage, Set<string>>> = {
  es: new Set(["hola", "gracias"]),
  tl: new Set(["salamat", "kumusta"]),
};

const LETTER_RUN = /\p{L}+/gu;

export function detectLanguage(text: string): ReplyLanguage | null {
  const tokens = text.normalize("NFC").toLowerCase().match(LETTER_RUN) ?? [];
  let best: ReplyLanguage | null = null;
  let bestHits = 0;
  let tied = false;
  for (const language of Object.keys(WORDS) as ReplyLanguage[]) {
    const alone = ALONE[language];
    const hits = tokens.filter((t) => WORDS[language].has(t)).length + tokens.filter((t) => alone?.has(t)).length * 2;
    if (hits > bestHits) {
      best = language;
      bestHits = hits;
      tied = false;
    } else if (hits === bestHits && hits > 0) {
      tied = true;
    }
  }
  return bestHits >= 2 && !tied ? best : null;
}

const NAMES: Record<ReplyLanguage, string> = { en: "English", es: "Spanish", vi: "Vietnamese", tl: "Tagalog" };

const NAMES_ENGLISH = /english|ingl[eé]s/;
const NAMES_SPANISH = /spanish|espa[nñ]ol|castellano/;
const NAMES_VIETNAMESE = /vietnam|tiếng việt/;
const NAMES_TAGALOG = /tagalog|filipino/;

// What a language on the profile means, however it was written. Null for
// one Mano has no closed words for: its fixed sentences stay in English.
export function languageFromProfile(value: string | null | undefined): ReplyLanguage | null {
  const v = value?.normalize("NFC").toLowerCase() ?? "";
  if (NAMES_ENGLISH.test(v)) return "en";
  if (NAMES_SPANISH.test(v)) return "es";
  if (NAMES_VIETNAMESE.test(v)) return "vi";
  if (NAMES_TAGALOG.test(v)) return "tl";
  return null;
}

// Whether to save the language a person just wrote in. English needs no
// saving until something else is on file. Anything the person said about
// their language stands: this never even suggests a change to it.
export function shouldKeep(view: ProfileView, detected: ReplyLanguage): boolean {
  const stored = view.profile.person.language;
  if (!stored) return detected !== "en";
  return stored.source === "agent" && languageFromProfile(stored.value) !== detected;
}

// Saves it, so a later short answer ("3") or a photo with no words stays
// in it. It is Mano's reading and not their word, so it is stored below
// anything they say. A failed write only costs the fallback.
export async function keepLanguage(engine: PersonEngine, turnId: string, language: ReplyLanguage): Promise<void> {
  const fields = { "person.language": NAMES[language] };
  try {
    await engine.patchProfile({ idempotencyKey: profileKey(turnId, fields), source: "agent", fields });
  } catch (err) {
    console.warn(JSON.stringify({ type: "mano_language_save_failed", err: err instanceof Error ? err.name : "unknown" }));
  }
}
