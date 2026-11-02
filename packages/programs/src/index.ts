// @mano/programs: the program facts Mano may state. SNAP, Medicaid and
// LIHEAP in CA, TX, NY, FL, IL, WA, AZ and OH: the state's own program
// name, what it covers, income limits by household size labeled with their
// year, the renewal cycle, how to apply or renew, and the official phone
// and site. Every fact is { value, sourceUrl, checkedAt, quote }, read from
// a .gov page or a program site a .gov page documents. What could not be
// confirmed is listed in each entry's gaps instead of guessed.
//
// lookupProgram({ state, program }) and listPrograms(state) take codes or
// names ("CA" or "California", "snap" or "CalFresh") and an optional place
// ("Brooklyn" gets New York City's route). screenIncome gives a rough screen
// with two outcomes, may qualify or can't tell: it never promises and never
// tells a person they are past a limit.
//
// Test: pnpm --filter @mano/programs check (tsc, the catalog check and the
// lookup tests; no network, no keys). Recheck the sources: pnpm --filter
// @mano/programs verify-sources fetches every source again and looks for
// each quote; some state sites block scripted fetches and are reported so.
export * from "./types.js";
export { CATALOG, CATALOG_VERSION } from "./catalog.js";
export { isOfficialUrl, validateCatalog, REQUIRED_FIELDS } from "./validate.js";
export { listPrograms, lookupProgram, parseProgram, parseState, type LookedUp } from "./lookup.js";
export { limitAt, screenIncome, type Household, type Screen } from "./screen.js";
