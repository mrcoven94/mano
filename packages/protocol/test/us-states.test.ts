import { describe, expect, it } from "vitest";
import { isUsState, timeZoneForState, usStateCode, usStateInAddress } from "../src/index.js";
import { STATE_NAMES } from "./state-names.js";

const CODES = STATE_NAMES.map(([code]) => code);

describe("isUsState", () => {
  it("covers exactly 56 places, each once", () => {
    expect(new Set(CODES).size).toBe(56);
  });

  it.each(CODES)("takes %s, in either case and with spaces around it", (code) => {
    expect(isUsState(code)).toBe(true);
    expect(isUsState(code.toLowerCase())).toBe(true);
    expect(isUsState(` ${code} `)).toBe(true);
  });

  it("takes every two-letter pair only if it is one of the 56", () => {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const pairs = letters.flatMap((a) => letters.map((b) => a + b));
    expect(pairs.filter(isUsState).sort()).toEqual([...CODES].sort());
  });

  it.each(["", " ", "ZZ", "CAL", "California", "C", "C A", "U.S"])("refuses %j", (value) => {
    expect(isUsState(value)).toBe(false);
  });

  it("agrees with the time zones: each of the 56 has its own entry there", () => {
    for (const code of CODES) expect(timeZoneForState(code)).toMatch(/^(America|Pacific)\//);
  });
});

describe("usStateCode", () => {
  it.each(STATE_NAMES)("%s from its code, English and Spanish name, in any case", (code, english, spanish) => {
    for (const name of [code, code.toLowerCase(), english, spanish, english.toUpperCase(), spanish.toLowerCase()]) {
      expect(usStateCode(name)).toBe(code);
    }
  });

  it.each([
    ["CA", ["Calif.", "Calif", "Cal."]],
    ["DC", ["D.C.", "Washington DC", "Washington, D.C.", "Distrito de Colombia"]],
    ["HI", ["Hawaiʻi", "Hawai'i", "Hawai"]],
    ["MS", ["Misisipí", "Mississippi"]],
    ["NH", ["Nueva Hampshire", "N.H.", "N. Hampshire"]],
    ["NM", ["Nuevo Méjico", "Nuevo Mejico", "N.M.", "N. Mexico"]],
    ["NY", ["N.Y.", "N. York"]],
    ["NC", ["N.C.", "N. Carolina", "N Carolina"]],
    ["ND", ["N. Dakota"]],
    ["PA", ["Penn.", "Penna", "Pa."]],
    ["SC", ["S.C.", "S. Carolina"]],
    ["SD", ["S. Dakota"]],
    ["TX", ["Tejas", "Tex."]],
    ["VI", ["U.S. Virgin Islands", "USVI", "Islas Vírgenes de los Estados Unidos", "Islas Virgenes Americanas"]],
    ["MP", ["CNMI", "Northern Marianas", "Marianas del Norte"]],
    ["WA", ["Wash."]],
    ["WV", ["W.Va.", "W. Virginia", "West Va"]],
  ] as [string, string[]][])("%s from its common forms", (code, forms) => {
    for (const form of forms) expect(usStateCode(form)).toBe(code);
  });

  it.each(["", "Kelvessa", "Californa", "ZZ", "United States", "Virginia Beach", "New", "Carolina", "Dakota", "Nueva", "Fresno"])("knows no state in %j", (name) => {
    expect(usStateCode(name)).toBeNull();
  });
});

describe("usStateInAddress", () => {
  it.each(STATE_NAMES)("%s written out, in English or Spanish, after the city", (code, english, spanish) => {
    for (const name of [english, spanish]) {
      expect(usStateInAddress(`12 Main St, Anytown, ${name} 00601`)).toBe(code);
      expect(usStateInAddress(`12 Main St, Anytown, ${name}, 00601-1234`)).toBe(code);
      expect(usStateInAddress(`12 Main St Anytown ${name} 00601`)).toBe(code);
    }
  });

  it.each(CODES)("%s by its code, with or without commas", (code) => {
    expect(usStateInAddress(`12 Main St, Anytown, ${code} 00601`)).toBe(code);
    expect(usStateInAddress(`12 Main St Anytown ${code} 00601`)).toBe(code);
    expect(usStateInAddress(`12 Main St, Anytown, ${code.toLowerCase()} 00601`)).toBe(code);
  });

  it.each([
    ["12 Oak St, Fresno, California 93721", "CA"],
    ["12 Oak St, Fresno, Calif. 93721", "CA"],
    ["5 Hill Rd, Charleston, West Virginia 25301", "WV"],
    ["5 Hill Rd, Charleston West Virginia 25301", "WV"],
    ["5 Hill Rd, Richmond, Virginia 23219", "VA"],
    ["9 Elm St, Kansas City, Missouri 64106", "MO"],
    ["9 Elm St, Kansas City, Kansas 66101", "KS"],
    ["1 Broadway, New York, New York 10001", "NY"],
    ["1 Broadway, Nueva York, Nueva York 10001", "NY"],
    ["1 K St NW, Washington, DC 20001", "DC"],
    ["1 K St NW, Washington, D.C. 20001", "DC"],
    ["1 K St NW, Washington, District of Columbia 20001", "DC"],
    ["1 Pike St, Seattle, Washington 98101", "WA"],
    ["12 Calle Sol, San Juan, Puerto Rico 00901", "PR"],
    ["12 Virginia Ave, Fresno, California 93721", "CA"],
    ["12 Oak St, Philadelphia, Pa. 19103", "PA"],
  ])("%s is %s", (address, code) => {
    expect(usStateInAddress(address)).toBe(code);
  });

  it.each([
    ["no such state", "703 Frendle Path, Drelvessa, Kelvessa 00042"],
    ["a misspelled state", "12 Oak St, Fresno, Californa 93721"],
    ["a code that is no state", "12 Oak St, Fresno, ZZ 93721"],
    ["no ZIP", "12 Oak St, Fresno, California"],
    ["only a street", "14 Elm St"],
    ["a city that starts with a state's name", "5 Hill Rd, Virginia Beach 23451"],
    ["a city named for a state, with no state", "9 Elm St, Oklahoma City 73101"],
    ["a street word that spells a code", "12 Oak Ct 93721"],
    ["a street word with a period", "12 Oak Ct. 93721"],
    ["a state only inside the street", "12 California St 93721"],
    ["empty", ""],
  ])("finds none with %s", (_why, address) => {
    expect(usStateInAddress(address)).toBeNull();
  });
});
