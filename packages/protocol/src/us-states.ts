// The 50 states, the District and the five inhabited territories, by the
// two-letter code on a person's profile and by the ways people write them in
// English and Spanish. The one place that knows what a state is called.
const STATE_FORMS: Record<string, readonly string[]> = {
  AL: ["Alabama", "Ala"],
  AK: ["Alaska"],
  AZ: ["Arizona", "Ariz"],
  AR: ["Arkansas", "Ark"],
  CA: ["California", "Calif", "Cal"],
  CO: ["Colorado", "Colo"],
  CT: ["Connecticut", "Conn", "Conecticut"],
  DE: ["Delaware", "Del"],
  DC: ["District of Columbia", "Washington DC", "Distrito de Columbia", "Distrito de Colombia"],
  FL: ["Florida", "Fla"],
  GA: ["Georgia"],
  HI: ["Hawaii", "Hawai"],
  ID: ["Idaho"],
  IL: ["Illinois", "Ill"],
  IN: ["Indiana", "Ind"],
  IA: ["Iowa"],
  KS: ["Kansas", "Kan", "Kans"],
  KY: ["Kentucky"],
  LA: ["Louisiana", "Luisiana"],
  ME: ["Maine"],
  MD: ["Maryland"],
  MA: ["Massachusetts", "Mass"],
  MI: ["Michigan", "Mich"],
  MN: ["Minnesota", "Minn"],
  MS: ["Mississippi", "Miss", "Misisipi"],
  MO: ["Missouri", "Misuri"],
  MT: ["Montana", "Mont"],
  NE: ["Nebraska", "Neb", "Nebr"],
  NV: ["Nevada", "Nev"],
  NH: ["New Hampshire", "N Hampshire", "Nuevo Hampshire", "Nueva Hampshire"],
  NJ: ["New Jersey", "N Jersey", "Nueva Jersey"],
  NM: ["New Mexico", "N Mexico", "Nuevo Mexico", "Nuevo Mejico"],
  NY: ["New York", "N York", "Nueva York"],
  NC: ["North Carolina", "N Carolina", "Carolina del Norte"],
  ND: ["North Dakota", "N Dakota", "Dakota del Norte"],
  OH: ["Ohio"],
  OK: ["Oklahoma", "Okla"],
  OR: ["Oregon", "Ore"],
  PA: ["Pennsylvania", "Penn", "Penna", "Pensilvania"],
  RI: ["Rhode Island", "Isla de Rodas"],
  SC: ["South Carolina", "S Carolina", "Carolina del Sur"],
  SD: ["South Dakota", "S Dakota", "Dakota del Sur"],
  TN: ["Tennessee", "Tenn"],
  TX: ["Texas", "Tex", "Tejas"],
  UT: ["Utah"],
  VT: ["Vermont"],
  VA: ["Virginia"],
  WA: ["Washington", "Wash"],
  WV: ["West Virginia", "W Virginia", "West Va", "W Va", "WVa", "Virginia Occidental"],
  WI: ["Wisconsin", "Wis"],
  WY: ["Wyoming", "Wyo"],
  AS: ["American Samoa", "Samoa Americana"],
  GU: ["Guam"],
  MP: ["Northern Mariana Islands", "Northern Marianas", "CNMI", "Islas Marianas del Norte", "Marianas del Norte"],
  PR: ["Puerto Rico"],
  VI: ["Virgin Islands", "US Virgin Islands", "USVI", "Islas Virgenes", "Islas Virgenes Americanas", "Islas Virgenes de los Estados Unidos"],
};

// Case, accents, periods, commas and apostrophes do not change a name.
function plain(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[.,'’ʻ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const CODE_BY_FORM = new Map(Object.entries(STATE_FORMS).flatMap(([code, forms]) => [code, ...forms].map((form) => [plain(form), code] as const)));
const LONGEST_FORM = Math.max(...[...CODE_BY_FORM.keys()].map((form) => form.split(" ").length));

export function isUsState(state: string): boolean {
  return Object.hasOwn(STATE_FORMS, state.trim().toUpperCase());
}

// The code for a state's code or name, or null when it names no state.
export function usStateCode(name: string): string | null {
  return CODE_BY_FORM.get(plain(name)) ?? null;
}

// The state an address names just before its ZIP, or null, in which case the
// caller must ask rather than guess. The longest name wins, so West Virginia
// is not Virginia. Two letters in mixed case are a street word ("12 Oak Ct
// 93721") unless they sit in their own place: street, city, state.
export function usStateInAddress(address: string): string | null {
  const before = /^(.+?),?\s*\d{5}(?:-\d{4})?$/.exec(address.trim())?.[1];
  if (!before) return null;
  const inOwnPlace = before.split(",").length >= 3;
  const words = before.slice(before.lastIndexOf(",") + 1).trim().split(/\s+/);
  for (let n = Math.min(words.length, LONGEST_FORM); n > 0; n--) {
    const phrase = words.slice(-n).join(" ");
    const code = usStateCode(phrase);
    if (!code) continue;
    const streetWord = plain(phrase).length === 2 && phrase !== phrase.toUpperCase() && !(inOwnPlace && n === words.length);
    return streetWord ? null : code;
  }
  return null;
}
