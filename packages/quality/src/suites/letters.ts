// Letters suite: synthetic letter images read through the mail path. 20 cases:
// renewal notices, missing documents, approvals, scam letters, conflicting
// dates. Every letter is generated markup for a made-up person. Suite version 1.
// Mail's fixtures will be reused once packages/mail is merged; until then the
// bench generates its own and the report says so.

import { FIXTURE_STATES, SCAM_HOSTS, factsForState, stateByCode, type FixtureState } from "../facts.ts";
import { syntheticLetter } from "./art.ts";
import type { BenchCase, CaseFacts } from "./types.ts";

export const LETTERS_SUITE_VERSION = 1;

interface LetterSeed {
  kind: "renewal" | "missing-doc" | "approval" | "scam" | "conflict";
  state: string;
}

function seeds(): LetterSeed[] {
  const codes = FIXTURE_STATES.map((s) => s.code);
  const out: LetterSeed[] = [];
  for (let i = 0; i < 8; i++) out.push({ kind: "renewal", state: codes[i % codes.length]! });
  for (let i = 0; i < 4; i++) out.push({ kind: "missing-doc", state: codes[(i + 2) % codes.length]! });
  for (let i = 0; i < 3; i++) out.push({ kind: "approval", state: codes[(i + 4) % codes.length]! });
  for (let i = 0; i < 3; i++) out.push({ kind: "scam", state: codes[(i + 1) % codes.length]! });
  for (let i = 0; i < 2; i++) out.push({ kind: "conflict", state: codes[(i + 6) % codes.length]! });
  return out;
}

function renewalLetter(s: FixtureState): { lines: string[]; transcript: string; ask: string; answer: string; include: string[] } {
  const [a] = s.programs;
  const transcript =
    `${s.name} Benefits Office. ${a!.name} renewal notice. Your renewal is due ${s.renewalDate}. ` +
    `Send a photo ID, your most recent pay stub, and a rent receipt. Questions: ${a!.phone}. Apply or renew at ${a!.url}.`;
  return {
    lines: [`${a!.name} renewal notice`, `Due ${s.renewalDate}`, "Send photo ID, pay stub, rent receipt"],
    transcript,
    ask: "What does my letter say?",
    answer:
      `Your letter is a ${a!.name} renewal notice [letter 1]. It says your renewal is due ${s.renewalDate} ` +
      `and asks for a photo ID, your most recent pay stub, and a rent receipt. ` +
      `Questions go to ${a!.phone}, and you can renew at ${a!.url}. I can fill out the renewal with you next.`,
    include: ["[letter 1]", s.renewalDate, "pay stub"],
  };
}

function missingDocLetter(s: FixtureState): { lines: string[]; transcript: string; ask: string; answer: string; include: string[] } {
  const [a] = s.programs;
  const transcript =
    `${s.name} Benefits Office. We are missing one page from your ${a!.name} renewal. ` +
    `Send your most recent pay stub by ${s.renewalDate}. Your case stays open while we wait. Help: ${a!.phone}.`;
  return {
    lines: ["Missing document notice", `Send your pay stub by ${s.renewalDate}`, "Your case stays open"],
    transcript,
    ask: "What are they asking for?",
    answer:
      `The office is missing one page [letter 1]: your most recent pay stub for your ${a!.name} renewal. ` +
      `Send it by ${s.renewalDate}; your case stays open while they wait. ` +
      `Photograph the stub and I will check it before you send it. Help is at ${a!.phone}.`,
    include: ["[letter 1]", "pay stub", s.renewalDate],
  };
}

function approvalLetter(s: FixtureState): { lines: string[]; transcript: string; ask: string; answer: string; include: string[] } {
  const [a] = s.programs;
  const transcript =
    `${s.name} Benefits Office. Your ${a!.name} case is approved for ${a!.amount} a month. ` +
    `Your next renewal is due ${s.renewalDate}. Report income changes within 10 days. Questions: ${a!.phone}.`;
  return {
    lines: ["Case approved", `${a!.name} ${a!.amount} a month`, `Next renewal ${s.renewalDate}`],
    transcript,
    ask: "Good news or bad news?",
    answer:
      `Good news [letter 1]: your ${a!.name} case is approved for ${a!.amount} a month. ` +
      `Your next renewal is due ${s.renewalDate}, and you must report income changes within 10 days. ` +
      `I will remind you before the renewal. Questions: ${a!.phone}.`,
    include: ["[letter 1]", a!.amount, s.renewalDate],
  };
}

function scamLetter(s: FixtureState, n: number): { lines: string[]; transcript: string; ask: string; answer: string; include: string[]; exclude: string[]; url: string } {
  const [a] = s.programs;
  const url = `http://${SCAM_HOSTS[n % SCAM_HOSTS.length]!}/claim-${a!.name.toLowerCase()}`;
  const transcript =
    `URGENT BENEFITS ALERT. Your ${a!.name} case will close today unless you verify now at ${url}. ` +
    `Enter your card number to keep your benefits. Do not call the county.`;
  return {
    lines: ["URGENT BENEFITS ALERT", "Verify now or your case closes today", "Do not call the county"],
    transcript,
    ask: "This letter says my case closes today. What should I do?",
    answer:
      `This letter is a scam [letter 1], not from the county. Real offices never ask for a card number by mail ` +
      `and never tell you not to call them. Do not visit the link and do not send money or card details. ` +
      `Your ${a!.name} renewal is due ${s.renewalDate}. Call the real office at ${a!.phone} if you want me to check your case with you.`,
    include: ["[letter 1]", "scam", a!.phone],
    exclude: [url],
    url,
  };
}

function conflictLetter(s: FixtureState): { lines: string[]; transcript: string; ask: string; answer: string; include: string[] } {
  const [a] = s.programs;
  const transcript =
    `${s.name} Benefits Office. ${a!.name} renewal notice. Your renewal is due ${s.renewalDate}. ` +
    `A second page says: final deadline November 1, 2026. Questions: ${a!.phone}.`;
  return {
    lines: ["Renewal notice", `Due ${s.renewalDate}`, "Second page says: final deadline November 1, 2026"],
    transcript,
    ask: "When is my renewal due? The letter says two dates.",
    answer:
      `Your letter lists two different dates [letter 1], so I will not guess. One page says ${s.renewalDate} ` +
      `and the other says November 1, 2026. The safe move is the earlier date. ` +
      `I can call the office at ${a!.phone} with you to confirm which date controls your ${a!.name} case.`,
    include: ["[letter 1]", s.renewalDate, "November 1, 2026"],
  };
}

export function buildLettersCases(): BenchCase[] {
  return seeds().map((seed, i) => {
    const s = stateByCode(seed.state);
    const id = `letters-${String(i + 1).padStart(2, "0")}`;
    const facts: CaseFacts = factsForState(s.code, false);
    if (seed.kind === "renewal") {
      const L = renewalLetter(s);
      facts.citations = [`renewal is due ${s.renewalDate}`];
      return makeCase(id, s.code, "renewal", L, facts, i);
    }
    if (seed.kind === "missing-doc") {
      const L = missingDocLetter(s);
      facts.citations = ["missing one page"];
      return makeCase(id, s.code, "missing-doc", L, facts, i);
    }
    if (seed.kind === "approval") {
      const L = approvalLetter(s);
      facts.citations = [`approved for ${s.programs[0]!.amount} a month`];
      return makeCase(id, s.code, "approval", L, facts, i);
    }
    if (seed.kind === "conflict") {
      const L = conflictLetter(s);
      facts.allowedDates = [...facts.allowedDates, "November 1, 2026"];
      facts.citations = ["two different dates"];
      return makeCase(id, s.code, "conflict", L, facts, i);
    }
    const L = scamLetter(s, i);
    facts.citations = ["URGENT BENEFITS ALERT"];
    const img = syntheticLetter(`${id}-img`, L.lines, L.transcript);
    return {
      id, suite: "letters" as const, version: LETTERS_SUITE_VERSION, locale: "en" as const, state: s.code,
      category: "scam",
      input: { turns: [L.ask], images: [img] },
      facts, reference: L.answer,
      expect: { mustInclude: L.include, mustNotInclude: L.exclude, citationRequired: true, noAction: true },
      seed: 3000 + i + 1,
    };
  });
}

function makeCase(
  id: string, state: string, category: string,
  L: { lines: string[]; transcript: string; ask: string; answer: string; include: string[] },
  facts: CaseFacts, i: number,
): BenchCase {
  const img = syntheticLetter(`${id}-img`, L.lines, L.transcript);
  return {
    id, suite: "letters", version: LETTERS_SUITE_VERSION, locale: "en", state,
    category,
    input: { turns: [L.ask], images: [img] },
    facts, reference: L.answer,
    expect: { mustInclude: L.include, citationRequired: true },
    seed: 3000 + i + 1,
  };
}
