// The time zone a person's days are read in, from the two-letter state on
// their profile: Engine times deadline nudges in it and the agent reads
// "tomorrow at 9" in it. Pacific when the state is unknown.
//
// Sources. Zone names and the areas they cover: IANA tzdata, zone.tab. A
// state split across zones takes the zone most of its people live in, from
// the zone lines in 49 CFR Part 71 and the Census Bureau's county population
// estimates (Vintage 2023). The closest splits are Tennessee (66% Central)
// and South Dakota (74% Central).
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

const STATES_BY_ZONE: Record<string, readonly string[]> = {
  "America/New_York": ["CT", "DC", "DE", "FL", "GA", "KY", "MA", "MD", "ME", "NC", "NH", "NJ", "NY", "OH", "PA", "RI", "SC", "VA", "VT", "WV"],
  "America/Detroit": ["MI"],
  "America/Indiana/Indianapolis": ["IN"],
  "America/Chicago": ["AL", "AR", "IA", "IL", "KS", "LA", "MN", "MO", "MS", "ND", "NE", "OK", "SD", "TN", "TX", "WI"],
  "America/Denver": ["CO", "MT", "NM", "UT", "WY"],
  "America/Boise": ["ID"],
  "America/Phoenix": ["AZ"],
  "America/Los_Angeles": ["CA", "NV", "OR", "WA"],
  "America/Anchorage": ["AK"],
  "Pacific/Honolulu": ["HI"],
  "America/Puerto_Rico": ["PR"],
  "America/St_Thomas": ["VI"],
  "Pacific/Guam": ["GU"],
  "Pacific/Saipan": ["MP"],
  "Pacific/Pago_Pago": ["AS"],
};

const ZONE_BY_STATE = new Map(
  Object.entries(STATES_BY_ZONE).flatMap(([zone, states]) => states.map((state) => [state, zone] as const)),
);

export function timeZoneForState(state: string | null | undefined): string {
  return ZONE_BY_STATE.get(state?.trim().toUpperCase() ?? "") ?? DEFAULT_TIME_ZONE;
}
