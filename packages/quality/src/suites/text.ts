// Text suite: the same intents as short iMessage turns. 25 cases, including
// three messages in a row, a photo, STOP, and questions Mano cannot help with.
// Suite version 1.

import { FIXTURE_STATES, factsForState, stateByCode } from "../facts.ts";
import { syntheticPhoto } from "./art.ts";
import type { BenchCase } from "./types.ts";

export const TEXT_SUITE_VERSION = 1;
export const TEXT_MAX_BUBBLES = 3;
export const TEXT_MAX_BUBBLE_CHARS = 320;
export const STOP_MAX_BUBBLE_CHARS = 160;

interface Short {
  id: string;
  state: string;
  locale: "en" | "es";
  category: string;
  turns: string[];
  bubbles: string[];
  include: string[];
}

function normalShorts(): Short[] {
  const states = ["CA", "TX", "NY", "FL", "IL", "WA", "AZ", "OH", "CA", "TX", "NY", "FL"];
  const out: Short[] = [];
  for (let i = 0; i < states.length; i++) {
    const s = stateByCode(states[i]!);
    const [a] = s.programs;
    const kind = i % 4;
    if (kind === 0) {
      out.push({
        id: `text-${String(i + 1).padStart(2, "0")}`, state: s.code, locale: "en", category: "programs",
        turns: [`Can I get help with groceries in ${s.name}?`],
        bubbles: [
          `Yes, ${a!.name} helps with groceries, about ${a!.amount} a month.`,
          `Apply at ${a!.url} or call ${a!.phone} and I will walk you through it.`,
        ],
        include: [a!.name, a!.phone],
      });
    } else if (kind === 1) {
      out.push({
        id: `text-${String(i + 1).padStart(2, "0")}`, state: s.code, locale: "en", category: "deadlines",
        turns: ["When is my renewal due?"],
        bubbles: [`Your ${a!.name} renewal is due ${s.renewalDate}.`, "Want a reminder a week before?"],
        include: [s.renewalDate],
      });
    } else if (kind === 2) {
      out.push({
        id: `text-${String(i + 1).padStart(2, "0")}`, state: s.code, locale: "en", category: "documents",
        turns: ["What papers do I need?"],
        bubbles: ["Photo ID, your latest pay stub, and a rent receipt.", `Due ${s.renewalDate}. Send photos and I will check each page.`],
        include: ["pay stub", s.renewalDate],
      });
    } else {
      out.push({
        id: `text-${String(i + 1).padStart(2, "0")}`, state: s.code, locale: "en", category: "next-steps",
        turns: ["What should I do first?"],
        bubbles: ["First, send a photo of your renewal letter.", `I will read it and list your steps before ${s.renewalDate}.`],
        include: [s.renewalDate],
      });
    }
  }
  return out;
}

function spanishShorts(): Short[] {
  const states = ["CA", "TX", "AZ"];
  const cats = ["programs", "deadlines", "documents"];
  return states.map((code, i) => {
    const s = stateByCode(code);
    const [a] = s.programs;
    const cat = cats[i]!;
    if (cat === "programs") {
      return {
        id: `text-${13 + i}`, state: s.code, locale: "es" as const, category: cat,
        turns: ["¿Me ayudan con la comida?"],
        bubbles: [`Sí, ${a!.name} ayuda con comida, cerca de ${a!.amount} al mes.`, `Solicite en ${a!.url} o llame al ${a!.phone}.`],
        include: [a!.name, a!.phone],
      };
    }
    if (cat === "deadlines") {
      return {
        id: `text-${13 + i}`, state: s.code, locale: "es" as const, category: cat,
        turns: ["¿Cuándo vence mi renovación?"],
        bubbles: [`Su renovación de ${a!.name} vence el ${s.renewalDateEs}.`, "¿Le recuerdo una semana antes?"],
        include: [s.renewalDateEs],
      };
    }
    return {
      id: `text-${13 + i}`, state: s.code, locale: "es" as const, category: cat,
      turns: ["¿Qué papeles necesito?"],
      bubbles: ["Identificación con foto, recibo de pago y recibo de renta.", `Vence el ${s.renewalDateEs}. Envíe fotos y reviso cada página.`],
      include: ["recibo de pago", s.renewalDateEs],
    };
  });
}

export function buildTextCases(): BenchCase[] {
  const cases: BenchCase[] = [];
  const shorts = [...normalShorts(), ...spanishShorts()];
  for (const [i, t] of shorts.entries()) {
    cases.push({
      id: t.id, suite: "text", version: TEXT_SUITE_VERSION, locale: t.locale, state: t.state,
      category: t.category,
      input: { turns: t.turns },
      facts: factsForState(t.state, false),
      reference: t.bubbles.join("\n"),
      referenceBubbles: t.bubbles,
      expect: { mustInclude: t.include, maxBubbles: TEXT_MAX_BUBBLES, maxBubbleChars: TEXT_MAX_BUBBLE_CHARS },
      seed: 2000 + i + 1,
    });
  }

  const ca = stateByCode("CA");
  const [snap] = ca.programs;
  cases.push({
    id: "text-16", suite: "text", version: TEXT_SUITE_VERSION, locale: "en", state: "CA",
    category: "multi-turn",
    input: { turns: ["When is my SNAP renewal due?", "Also what documents do I need?", "And can you remind me a week before?"] },
    facts: factsForState("CA", false),
    reference: [
      `Your SNAP renewal is due ${ca.renewalDate}. You need a photo ID, your latest pay stub, and a rent receipt.`,
      "I will remind you a week before. Send photos of each page and I will check them.",
    ].join("\n"),
    referenceBubbles: [
      `Your SNAP renewal is due ${ca.renewalDate}. You need a photo ID, your latest pay stub, and a rent receipt.`,
      "I will remind you a week before. Send photos of each page and I will check them.",
    ],
    expect: { mustInclude: [ca.renewalDate, "pay stub", "remind"], maxBubbles: TEXT_MAX_BUBBLES, maxBubbleChars: TEXT_MAX_BUBBLE_CHARS },
    seed: 2016,
  });

  const tx = stateByCode("TX");
  const photo = syntheticPhoto(
    "text-17-photo",
    "Renewal notice on a table",
    `Photo shows a ${tx.programs[0]!.name} renewal notice for a made-up resident. It says the renewal is due ${tx.renewalDate} and lists a photo ID, pay stub, and rent receipt.`,
  );
  cases.push({
    id: "text-17", suite: "text", version: TEXT_SUITE_VERSION, locale: "en", state: "TX",
    category: "photo",
    input: { turns: ["Here is the letter I got"], images: [photo] },
    facts: factsForState("TX", false),
    reference: [
      `Got the photo. It is your ${tx.programs[0]!.name} renewal notice, due ${tx.renewalDate}.`,
      "You need a photo ID, pay stub, and rent receipt. I can fill out the renewal with you next.",
    ].join("\n"),
    referenceBubbles: [
      `Got the photo. It is your ${tx.programs[0]!.name} renewal notice, due ${tx.renewalDate}.`,
      "You need a photo ID, pay stub, and rent receipt. I can fill out the renewal with you next.",
    ],
    expect: { mustInclude: ["photo", tx.renewalDate], maxBubbles: TEXT_MAX_BUBBLES, maxBubbleChars: TEXT_MAX_BUBBLE_CHARS },
    seed: 2017,
  });

  const az = stateByCode("AZ");
  const photoEs = syntheticPhoto(
    "text-18-photo",
    "Aviso de renovación sobre la mesa",
    `La foto muestra un aviso de renovación de ${az.programs[0]!.name}. Dice que vence el ${az.renewalDateEs} y pide identificación, recibo de pago y recibo de renta.`,
  );
  cases.push({
    id: "text-18", suite: "text", version: TEXT_SUITE_VERSION, locale: "es", state: "AZ",
    category: "photo",
    input: { turns: ["Le envío la foto de mi carta"], images: [photoEs] },
    facts: factsForState("AZ", false),
    reference: [
      `Recibí la foto. Es su aviso de renovación de ${az.programs[0]!.name}, que vence el ${az.renewalDateEs}.`,
      "Necesita identificación, recibo de pago y recibo de renta. Puedo llenar la renovación con usted.",
    ].join("\n"),
    referenceBubbles: [
      `Recibí la foto. Es su aviso de renovación de ${az.programs[0]!.name}, que vence el ${az.renewalDateEs}.`,
      "Necesita identificación, recibo de pago y recibo de renta. Puedo llenar la renovación con usted.",
    ],
    expect: { mustInclude: ["foto", az.renewalDateEs], maxBubbles: TEXT_MAX_BUBBLES, maxBubbleChars: TEXT_MAX_BUBBLE_CHARS },
    seed: 2018,
  });

  cases.push({
    id: "text-19", suite: "text", version: TEXT_SUITE_VERSION, locale: "en", state: "CA",
    category: "stop",
    input: { turns: ["STOP"] },
    facts: factsForState("CA", false),
    reference: "Done. You won't get more texts from Mano. Text START any time to hear from me again.",
    referenceBubbles: ["Done. You won't get more texts from Mano. Text START any time to hear from me again."],
    expect: { mustInclude: ["won't get more texts"], stopReply: true, maxBubbles: 1, maxBubbleChars: STOP_MAX_BUBBLE_CHARS },
    seed: 2019,
  });
  cases.push({
    id: "text-20", suite: "text", version: TEXT_SUITE_VERSION, locale: "es", state: "TX",
    category: "stop",
    input: { turns: ["STOP"] },
    facts: factsForState("TX", false),
    reference: "Listo. No recibirá más mensajes de Mano. Escriba START cuando quiera volver.",
    referenceBubbles: ["Listo. No recibirá más mensajes de Mano. Escriba START cuando quiera volver."],
    expect: { mustInclude: ["No recibirá más mensajes"], stopReply: true, maxBubbles: 1, maxBubbleChars: STOP_MAX_BUBBLE_CHARS },
    seed: 2020,
  });

  const il = stateByCode("IL");
  cases.push({
    id: "text-21", suite: "text", version: TEXT_SUITE_VERSION, locale: "en", state: "IL",
    category: "cannot-help",
    input: { turns: ["Can you fix my car transmission?"] },
    facts: factsForState("IL", false),
    reference: `I can't help with that one. I handle benefits, forms, mail, and reminders. A repair shop is the faster path, and I can still help with your ${il.programs[0]!.name} renewal due ${il.renewalDate}.`,
    referenceBubbles: [
      "I can't help with that one. I handle benefits, forms, mail, and reminders.",
      `A repair shop is the faster path, and I can still help with your ${il.programs[0]!.name} renewal due ${il.renewalDate}.`,
    ],
    expect: { mustInclude: ["can't help", il.renewalDate], maxBubbles: TEXT_MAX_BUBBLES, maxBubbleChars: TEXT_MAX_BUBBLE_CHARS },
    seed: 2021,
  });
  const wa = stateByCode("WA");
  cases.push({
    id: "text-22", suite: "text", version: TEXT_SUITE_VERSION, locale: "en", state: "WA",
    category: "cannot-help",
    input: { turns: ["Write my college essay for me"] },
    facts: factsForState("WA", false),
    reference: "I can't help with that one. I handle benefits, forms, mail, and reminders. I can help you find scholarships to pay for college instead.",
    referenceBubbles: ["I can't help with that one. I handle benefits, forms, mail, and reminders.", "I can help you find scholarships to pay for college instead."],
    expect: { mustInclude: ["can't help"], maxBubbles: TEXT_MAX_BUBBLES, maxBubbleChars: TEXT_MAX_BUBBLE_CHARS },
    seed: 2022,
  });
  const fl = stateByCode("FL");
  cases.push({
    id: "text-23", suite: "text", version: TEXT_SUITE_VERSION, locale: "es", state: "FL",
    category: "cannot-help",
    input: { turns: ["¿Me arregla el carro?"] },
    facts: factsForState("FL", false),
    reference: "No puedo ayudar con eso. Me encargo de beneficios, formularios, correo y recordatorios. Un taller es más rápido, y sigo aquí para su renovación.",
    referenceBubbles: ["No puedo ayudar con eso. Me encargo de beneficios, formularios, correo y recordatorios.", "Un taller es más rápido, y sigo aquí para su renovación."],
    expect: { mustInclude: ["No puedo ayudar"], maxBubbles: TEXT_MAX_BUBBLES, maxBubbleChars: TEXT_MAX_BUBBLE_CHARS },
    seed: 2023,
  });

  const ny = stateByCode("NY");
  cases.push({
    id: "text-24", suite: "text", version: TEXT_SUITE_VERSION, locale: "en", state: "NY",
    category: "follow-up",
    input: { turns: ["Thanks! Where do I send the packet?"] },
    facts: factsForState("NY", false),
    reference: `Send it through ${ny.programs[0]!.url} or call ${ny.programs[0]!.phone} for the mailing address. I will check your photos before you send them.`,
    referenceBubbles: [`Send it through ${ny.programs[0]!.url} or call ${ny.programs[0]!.phone} for the mailing address.`, "I will check your photos before you send them."],
    expect: { mustInclude: [ny.programs[0]!.url], maxBubbles: TEXT_MAX_BUBBLES, maxBubbleChars: TEXT_MAX_BUBBLE_CHARS },
    seed: 2024,
  });
  const oh = stateByCode("OH");
  cases.push({
    id: "text-25", suite: "text", version: TEXT_SUITE_VERSION, locale: "en", state: "OH",
    category: "follow-up",
    input: { turns: ["Did my renewal go through?"] },
    facts: factsForState("OH", false),
    reference: `I sent your ${oh.programs[0]!.name} packet and the office confirmed receipt. I will watch for their decision letter and tell you the day it arrives.`,
    referenceBubbles: [`I sent your ${oh.programs[0]!.name} packet and the office confirmed receipt.`, "I will watch for their decision letter and tell you the day it arrives."],
    expect: { mustInclude: ["confirmed receipt"], maxBubbles: TEXT_MAX_BUBBLES, maxBubbleChars: TEXT_MAX_BUBBLE_CHARS },
    seed: 2025,
  });

  void snap;
  return cases;
}

export function fixtureStateCount(): number {
  return FIXTURE_STATES.length;
}
