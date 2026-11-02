// Chat suite: a resident asks about programs, deadlines, documents and next
// steps. 40 cases across 8 states, English and Spanish. Suite version 1.
// A changed case means a new version, never a loosened or deleted case.

import { FIXTURE_STATES, factsForState, type FixtureState } from "../facts.ts";
import type { BenchCase } from "./types.ts";

export const CHAT_SUITE_VERSION = 1;

type ChatIntent = "programs" | "deadlines" | "documents" | "next-steps";

const ES_INTENTS: ChatIntent[] = ["programs", "deadlines", "documents", "next-steps", "programs", "deadlines", "documents", "next-steps"];

interface Turn {
  ask: string;
  answer: string;
  include: string[];
}

function programsTurn(s: FixtureState): Turn {
  const [a, b] = s.programs;
  return {
    ask: `What help with food and bills can I apply for in ${s.name}?`,
    answer:
      `In ${s.name}, two programs fit what you described. ` +
      `${a!.name} can add about ${a!.amount} a month for groceries. Apply at ${a!.url} or call ${a!.phone}. ` +
      `${b!.name} is the second option. Apply at ${b!.url} or call ${b!.phone}. ` +
      `I can walk you through either application, one step at a time.`,
    include: [a!.name, a!.phone, b!.name],
  };
}

function deadlinesTurn(s: FixtureState): Turn {
  const [a] = s.programs;
  return {
    ask: `When is my ${a!.name} renewal due?`,
    answer:
      `Your ${a!.name} renewal is due ${s.renewalDate}. ` +
      `Send the packet a week early so a missing page does not cost you coverage. ` +
      `If you photograph the letter, I will pull out exactly what they asked for.`,
    include: [s.renewalDate, a!.name],
  };
}

function documentsTurn(s: FixtureState): Turn {
  const [a] = s.programs;
  return {
    ask: `What documents do I need to renew my ${a!.name}?`,
    answer:
      `For your ${a!.name} renewal, gather three things: a photo ID, your most recent pay stub, and a rent receipt or lease page. ` +
      `Your renewal is due ${s.renewalDate}. Photograph each page and I will check nothing is cut off before you send it.`,
    include: ["pay stub", s.renewalDate],
  };
}

function nextStepsTurn(s: FixtureState): Turn {
  const [a] = s.programs;
  return {
    ask: "What are my next steps?",
    answer:
      `Here is the order I suggest. First, photograph your renewal letter so I can read the exact deadline. ` +
      `Second, gather your photo ID, pay stub, and rent receipt. ` +
      `Third, I will fill out the ${a!.name} renewal with you and you will approve the exact version before anything is sent. ` +
      `Your renewal is due ${s.renewalDate}. Questions or help with the county office are at ${a!.url} or ${a!.phone}.`,
    include: [s.renewalDate, a!.url],
  };
}

function programsTurnEs(s: FixtureState): Turn {
  const [a, b] = s.programs;
  return {
    ask: `¿Qué ayuda con comida y cuentas puedo pedir en ${s.spanishName}?`,
    answer:
      `En ${s.spanishName}, hay dos programas para usted. ` +
      `${a!.name} puede agregar cerca de ${a!.amount} al mes para comida. Solicite en ${a!.url} o llame al ${a!.phone}. ` +
      `La segunda opción es ${b!.name}. Solicite en ${b!.url} o llame al ${b!.phone}. ` +
      `Puedo guiarle en la solicitud paso a paso.`,
    include: [a!.name, a!.phone, b!.name],
  };
}

function deadlinesTurnEs(s: FixtureState): Turn {
  const [a] = s.programs;
  return {
    ask: `¿Cuándo vence mi renovación de ${a!.name}?`,
    answer:
      `Su renovación de ${a!.name} vence el ${s.renewalDateEs}. ` +
      `Envíe el paquete una semana antes para que no pierda la cobertura por una página faltante. ` +
      `Si me envía una foto de la carta, le digo exactamente lo que le pidieron.`,
    include: [s.renewalDateEs, a!.name],
  };
}

function documentsTurnEs(s: FixtureState): Turn {
  const [a] = s.programs;
  return {
    ask: `¿Qué documentos necesito para renovar ${a!.name}?`,
    answer:
      `Para renovar ${a!.name}, reúna tres cosas: una identificación con foto, su recibo de pago más reciente y un recibo de renta. ` +
      `Su renovación vence el ${s.renewalDateEs}. Envíeme una foto de cada página y reviso que nada salga cortado antes de enviarla.`,
    include: ["recibo de pago", s.renewalDateEs],
  };
}

function nextStepsTurnEs(s: FixtureState): Turn {
  const [a] = s.programs;
  return {
    ask: "¿Cuáles son mis próximos pasos?",
    answer:
      `Le sugiero este orden. Primero, envíeme una foto de su carta de renovación para leer la fecha exacta. ` +
      `Segundo, reúna su identificación, recibo de pago y recibo de renta. ` +
      `Tercero, llenamos juntos la renovación de ${a!.name} y usted aprueba la versión exacta antes de enviar nada. ` +
      `Su renovación vence el ${s.renewalDateEs}. Más ayuda en ${a!.url} o ${a!.phone}.`,
    include: [s.renewalDateEs, a!.url],
  };
}

const EN_BUILDERS: Record<ChatIntent, (s: FixtureState) => Turn> = {
  programs: programsTurn,
  deadlines: deadlinesTurn,
  documents: documentsTurn,
  "next-steps": nextStepsTurn,
};

const ES_BUILDERS: Record<ChatIntent, (s: FixtureState) => Turn> = {
  programs: programsTurnEs,
  deadlines: deadlinesTurnEs,
  documents: documentsTurnEs,
  "next-steps": nextStepsTurnEs,
};

export function buildChatCases(): BenchCase[] {
  const cases: BenchCase[] = [];
  let n = 0;
  for (let i = 0; i < FIXTURE_STATES.length; i++) {
    const s = FIXTURE_STATES[i]!;
    const intents: ChatIntent[] = ["programs", "deadlines", "documents", "next-steps"];
    for (const intent of intents) {
      n++;
      const t = EN_BUILDERS[intent](s);
      cases.push({
        id: `chat-${s.code.toLowerCase()}-${String(cases.filter((c) => c.state === s.code).length + 1).padStart(2, "0")}`,
        suite: "chat", version: CHAT_SUITE_VERSION, locale: "en", state: s.code,
        category: intent,
        input: { turns: [t.ask] },
        facts: factsForState(s.code, false),
        reference: t.answer,
        expect: { mustInclude: t.include },
        seed: 1000 + n,
      });
    }
    const esIntent = ES_INTENTS[i]!;
    n++;
    const t = ES_BUILDERS[esIntent](s);
    cases.push({
      id: `chat-${s.code.toLowerCase()}-es`,
      suite: "chat", version: CHAT_SUITE_VERSION, locale: "es", state: s.code,
      category: esIntent,
      input: { turns: [t.ask] },
      facts: factsForState(s.code, false),
      reference: t.answer,
      expect: { mustInclude: t.include },
      seed: 1000 + n,
    });
  }
  return cases;
}
