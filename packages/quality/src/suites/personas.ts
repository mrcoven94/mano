// Personas suite: 13 resident personas probing that Mano adapts to how people
// write, without changing what is true. Every persona is synthetic. Cases run
// through the channels path as text turns with bubble limits. Suite version 1.

import { factsForState, stateByCode } from "../facts.ts";
import { syntheticPhoto } from "./art.ts";
import { TEXT_MAX_BUBBLE_CHARS, TEXT_MAX_BUBBLES } from "./text.ts";
import type { BenchCase } from "./types.ts";

export const PERSONAS_SUITE_VERSION = 1;

interface Probe {
  id: string;
  state: string;
  locale: "en" | "es";
  persona: string;
  turns: string[];
  photo?: { caption: string; transcript: string };
  bubbles: string[];
  include: string[];
  exclude?: string[];
}

function probes(): Probe[] {
  const ca = stateByCode("CA");
  const tx = stateByCode("TX");
  const ny = stateByCode("NY");
  const fl = stateByCode("FL");
  const il = stateByCode("IL");
  const wa = stateByCode("WA");
  const az = stateByCode("AZ");
  const oh = stateByCode("OH");
  return [
    {
      id: "personas-01", state: "CA", locale: "es", persona: "spanish-speaker",
      turns: ["¿Cuándo vence mi renovación de SNAP?"],
      bubbles: [`Su renovación de SNAP vence el ${ca.renewalDateEs}.`, "¿Le recuerdo una semana antes?"],
      include: [ca.renewalDateEs],
    },
    {
      id: "personas-02", state: "TX", locale: "en", persona: "plain-language",
      turns: ["Use simple words. When do I need to send my papers?"],
      bubbles: [`Send your papers by ${tx.renewalDate}.`, "You need a photo ID, pay stub, and rent receipt."],
      include: [tx.renewalDate, "pay stub"],
      exclude: ["adjudication", "determination"],
    },
    {
      id: "personas-03", state: "NY", locale: "en", persona: "typo-heavy",
      turns: ["wen is my SNAP renual due?"],
      bubbles: [`Your SNAP renewal is due ${ny.renewalDate}.`, "Want a reminder a week before?"],
      include: [ny.renewalDate],
    },
    {
      id: "personas-04", state: "FL", locale: "en", persona: "all-caps",
      turns: ["WHEN IS MY RENEWAL DUE??"],
      bubbles: [`Your ${fl.programs[0]!.name} renewal is due ${fl.renewalDate}.`, "Send a photo of the letter and I will list your steps."],
      include: [fl.renewalDate],
    },
    {
      id: "personas-05", state: "IL", locale: "en", persona: "very-short",
      turns: ["renewal?"],
      bubbles: [`Your ${il.programs[0]!.name} renewal is due ${il.renewalDate}.`, "Need the papers list?"],
      include: [il.renewalDate],
    },
    {
      id: "personas-06", state: "WA", locale: "en", persona: "urgent",
      turns: ["I need help today, I got an eviction notice."],
      bubbles: [
        "I hear you, today matters. First, photograph the notice so I can read the exact date.",
        `Then call ${wa.programs[0]!.phone} for emergency help, and I will start your ${wa.programs[0]!.name} renewal with you.`,
      ],
      include: [wa.programs[0]!.phone, "First"],
    },
    {
      id: "personas-07", state: "AZ", locale: "en", persona: "multi-program",
      turns: ["I need help with food and my lights bill."],
      bubbles: [
        `${az.programs[0]!.name} helps with food, about ${az.programs[0]!.amount} a month.`,
        `For lights, ${az.programs[1]!.name} can add about ${az.programs[1]!.amount}. Apply at ${az.programs[1]!.url} or call ${az.programs[1]!.phone}.`,
      ],
      include: [az.programs[0]!.name, az.programs[1]!.name],
    },
    {
      id: "personas-08", state: "OH", locale: "en", persona: "photo-only",
      turns: ["what is this"],
      photo: {
        caption: "Renewal notice close up",
        transcript: `Photo shows an ${oh.programs[0]!.name} renewal notice. It says the renewal is due ${oh.renewalDate}.`,
      },
      bubbles: [`That photo is your ${oh.programs[0]!.name} renewal notice, due ${oh.renewalDate}.`, "I can fill out the renewal with you next."],
      include: ["photo", oh.renewalDate],
    },
    {
      id: "personas-09", state: "CA", locale: "en", persona: "skeptic",
      turns: ["Are you a robot? Will you steal my data?"],
      bubbles: [
        "Fair questions. I am Mano, your automated assistant, not a person.",
        "I never sell your data. Only people and offices you choose see your case, and you can stop sharing any time.",
      ],
      include: ["automated assistant", "never sell"],
    },
    {
      id: "personas-10", state: "TX", locale: "en", persona: "step-by-step",
      turns: ["Tell me what to do first, second, third for my renewal."],
      bubbles: [
        `First, send a photo of your renewal letter. Second, gather your photo ID, pay stub, and rent receipt.`,
        `Third, we fill out the ${tx.programs[0]!.name} renewal together before ${tx.renewalDate}.`,
      ],
      include: ["First", "Second", "Third", tx.renewalDate],
    },
    {
      id: "personas-11", state: "AZ", locale: "es", persona: "repeat-ask",
      turns: ["¿Cuándo vence mi renovación?", "Perdón, ¿cuál era la fecha?"],
      bubbles: [`Su renovación vence el ${az.renewalDateEs}.`, "¿Quiere que le recuerde una semana antes?"],
      include: [az.renewalDateEs],
    },
    {
      id: "personas-12", state: "FL", locale: "en", persona: "resubscribe",
      turns: ["START"],
      bubbles: ["Welcome back. I will text you about your renewal again. Your next step is still the papers list, whenever you are ready."],
      include: ["Welcome back"],
    },
    {
      id: "personas-13", state: "OH", locale: "en", persona: "off-topic",
      turns: ["Can you do my homework for me?"],
      bubbles: ["I can't help with that one. I handle benefits, forms, mail, and reminders.", "Want help finding scholarships for school instead?"],
      include: ["can't help"],
    },
  ];
}

export function buildPersonasCases(): BenchCase[] {
  return probes().map((p, i) => {
    const images = p.photo ? [syntheticPhoto(`${p.id}-photo`, p.photo.caption, p.photo.transcript)] : undefined;
    return {
      id: p.id, suite: "personas" as const, version: PERSONAS_SUITE_VERSION, locale: p.locale, state: p.state,
      category: p.persona,
      input: { turns: p.turns, ...(images ? { images } : {}) },
      facts: factsForState(p.state, false),
      reference: p.bubbles.join("\n"),
      referenceBubbles: p.bubbles,
      expect: {
        mustInclude: p.include,
        ...(p.exclude ? { mustNotInclude: p.exclude } : {}),
        maxBubbles: TEXT_MAX_BUBBLES,
        maxBubbleChars: TEXT_MAX_BUBBLE_CHARS,
      },
      seed: 5000 + i + 1,
    };
  });
}
