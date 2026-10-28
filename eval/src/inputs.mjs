// Input and answer-key split. Baselines and any system under test receive
// only what a real system would see: the letter image or text, the person's
// profile, and the tools. Answer-key fields live in a separate file that
// only the grader loads.
//
// Allowed baseline input per household:
//   { householdId, name, state, letters: [{ letterId, text, pages }] }
// Forbidden anywhere near a baseline:
//   kind, hardCase, lang, groundTruth, deadlines, correctPacket,
//   mustRefuse, mustRequest, decoyLetterIds, program, dueDate.

export const FORBIDDEN_FIELDS = [
  "kind",
  "hardCase",
  "lang",
  "groundTruth",
  "deadlines",
  "correctPacket",
  "mustRefuse",
  "mustRequest",
  "decoyLetterIds",
  "program",
  "dueDate",
];

export function toBaselineInput(household) {
  return {
    householdId: household.householdId,
    name: household.name,
    state: household.state,
    letters: household.letters.map((l) => ({
      letterId: l.letterId,
      text: l.text,
      pages: [...l.pages],
    })),
  };
}

export function toBaselineInputs(households) {
  return households.map(toBaselineInput);
}

export function toAnswerEntry(household) {
  const letters = {};
  for (const l of household.letters) {
    letters[l.letterId] = { kind: l.kind, hardCase: l.hardCase, lang: l.lang };
  }
  return {
    householdId: household.householdId,
    letters,
    groundTruth: household.groundTruth,
  };
}

export function toAnswers(households) {
  const out = {};
  for (const h of households) out[h.householdId] = toAnswerEntry(h);
  return out;
}

// Throw if any forbidden field appears anywhere in the value. The isolation
// test runs baselines against Proxy-guarded inputs; this helper guards the
// committed dev.json file itself.
export function assertNoForbiddenFields(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenFields(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_FIELDS.includes(k)) {
        throw new Error(`answer-key field "${k}" reachable at ${path}.${k}`);
      }
      assertNoForbiddenFields(v, `${path}.${k}`);
    }
  }
}

// Wrap a baseline input so any access to a forbidden field throws. The
// baseline isolation test uses this to prove baselines cannot read labels
// even when they are present next to the input.
export function guardInput(value) {
  if (Array.isArray(value)) return value.map(guardInput);
  if (value && typeof value === "object") {
    return new Proxy(value, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && FORBIDDEN_FIELDS.includes(prop)) {
          throw new Error(`baseline read forbidden field "${prop}"`);
        }
        const v = Reflect.get(target, prop, receiver);
        return guardInput(v);
      },
      has(target, prop) {
        if (typeof prop === "string" && FORBIDDEN_FIELDS.includes(prop)) {
          throw new Error(`baseline probed forbidden field "${prop}"`);
        }
        return Reflect.has(target, prop);
      },
    });
  }
  return value;
}
