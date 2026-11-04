// Keeps what the person answered for a form on their profile, so a later
// call, turn or form finds it and they are asked once. The model passes
// answers only as the form tools' arguments, and a production run filled a
// whole renewal that way without one update_profile call, so the tools
// write them here themselves, as the person's own word.
//
// Each field is its own write: Engine refuses a whole patch for one value
// it will not take, and one odd phone number must not lose the rest. A
// failed write costs a later question, never this form, which already has
// the answer in hand, so it is logged and the form goes on. Keyed by the
// turn and the exact change, so a retried turn writes nothing twice.
import { EngineError, ProfileRefused, type PersonEngine, type Profile } from "./engine.js";
import { answerChanges, type FormSpec } from "./forms.js";
import { profileKey } from "./profile.js";

export async function keepAnswers(engine: PersonEngine, turnId: string, form: FormSpec, profile: Profile, answers: Record<string, string>): Promise<void> {
  await Promise.all(
    answerChanges(form, profile, answers).map(async ({ field, fields }) => {
      try {
        await engine.patchProfile({ idempotencyKey: profileKey(turnId, fields), source: "person", fields });
      } catch (err) {
        const status = err instanceof ProfileRefused || err instanceof EngineError ? err.status : null;
        console.warn(JSON.stringify({ type: "mano_answer_not_kept", field, status }));
      }
    }),
  );
}
