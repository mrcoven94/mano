// Input and answer-key split. Baselines and any system under test receive
// only what a real system would see: the letter image or text, the person's
// profile (including the documents they already have), and the tools.
// Answer-key fields live in a separate file that only the grader loads.
//
// Text track input per household:
//   { householdId, name, state, hasDocuments, track: "text",
//     letters: [{ letterId, text, pages }] }
// Photo track input per household:
//   { householdId, name, state, hasDocuments, track: "photo",
//     letters: [{ letterId, pages, photos: [<paths>] }] }
// Forbidden anywhere near a baseline:
//   kind, hardCase, lang, requires, groundTruth, deadlines, correctPacket,
//   mustRefuse, mustRequest, decoyLetterIds, program, dueDate.

export const FORBIDDEN_FIELDS = [
  "kind",
  "hardCase",
  "lang",
  "family",
  "requires",
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
    hasDocuments: [...household.hasDocuments],
    track: "text",
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

// Photo track input built from a text input plus a letterId to photo paths
// map. Only photographed letters are included; answers slice to match.
export function photoTrackInput(textInput, photoFiles) {
  return {
    householdId: textInput.householdId,
    name: textInput.name,
    state: textInput.state,
    hasDocuments: [...textInput.hasDocuments],
    track: "photo",
    letters: textInput.letters
      .filter((l) => (photoFiles[l.letterId] || []).length > 0)
      .map((l) => ({ letterId: l.letterId, pages: [...l.pages], photos: [...photoFiles[l.letterId]] })),
  };
}

// Photo track: same profile, image paths instead of text. photoFiles maps
// letterId to an array of image paths (absolute or repo-relative).
export function toPhotoInput(household, photoFiles) {
  return {
    householdId: household.householdId,
    name: household.name,
    state: household.state,
    hasDocuments: [...household.hasDocuments],
    track: "photo",
    letters: household.letters.map((l) => ({
      letterId: l.letterId,
      pages: [...l.pages],
      photos: [...(photoFiles[l.letterId] || [])],
    })),
  };
}

export function toAnswerEntry(household) {
  const letters = {};
  for (const l of household.letters) {
    letters[l.letterId] = { kind: l.kind, hardCase: l.hardCase, lang: l.lang, family: l.family || null, requires: [...l.requires] };
  }
  return {
    householdId: household.householdId,
    hasDocuments: [...household.hasDocuments],
    letters,
    groundTruth: household.groundTruth,
  };
}

export function toAnswers(households) {
  const out = {};
  for (const h of households) out[h.householdId] = toAnswerEntry(h);
  return out;
}

const FORM_NAMES = ["signed renewal form", "signed recertification form"];

// Split requirements into submittable packet items and items to request.
// Entries are canonical doc names or {anyOf: [...]} alternatives. Owned
// members of an alternative go to the packet; when none is owned the whole
// "A or B" phrase is requested. The generator and the track slicer share
// this logic so sliced keys match generated keys exactly.
export function splitRequires(requires, hasDocuments) {
  const packet = new Set();
  const request = new Set();
  for (const req of requires) {
    if (typeof req === "string") {
      if (FORM_NAMES.includes(req) || hasDocuments.includes(req)) packet.add(req);
      else request.add(req);
    } else if (req && Array.isArray(req.anyOf)) {
      const owned = req.anyOf.filter((d) => hasDocuments.includes(d));
      if (owned.length > 0) for (const d of owned) packet.add(d);
      else request.add(req.anyOf.join(" or "));
    }
  }
  return { packet: [...packet].sort(), request: [...request].sort() };
}

// Slice answer entries down to a subset of letters (the photo track grades
// photographed letters only). Packet and request sets recompute from the
// kept letters' requires plus the household inventory, exactly as generation
// does, so sliced keys stay text-derived.
export function sliceAnswers(answers, letterIdsByHousehold) {
  const out = {};
  for (const [hid, entry] of Object.entries(answers)) {
    const keep = new Set(letterIdsByHousehold[hid] || []);
    if (keep.size === 0) continue;
    const letters = {};
    const requires = [];
    for (const [lid, info] of Object.entries(entry.letters)) {
      if (!keep.has(lid)) continue;
      letters[lid] = info;
      requires.push(...info.requires);
    }
    const { packet, request } = splitRequires(requires, entry.hasDocuments);
    out[hid] = {
      householdId: hid,
      hasDocuments: [...entry.hasDocuments],
      letters,
      groundTruth: {
        deadlines: entry.groundTruth.deadlines.filter((d) => keep.has(d.letterId)),
        correctPacket: packet,
        mustRefuse: entry.groundTruth.mustRefuse.filter((m) => keep.has(m.letterId)),
        mustRequest: request,
        decoyLetterIds: entry.groundTruth.decoyLetterIds.filter((id) => keep.has(id)),
      },
    };
  }
  return out;
}

// Throw if any forbidden field appears anywhere in the value. Guards the
// committed dev.json files themselves.
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

// Wrap a baseline input so any access to a forbidden field throws.
// Defense in depth only: real isolation is the subprocess harness, which
// gives the system under test no handle on answers at all.
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
