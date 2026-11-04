// Recorded synthetic responses for the stand-in engine: Maria's spine
// run. Every person, letter and office here is invented for the demo.
// Real resident content never touches this file.

import type { Language } from "../strings";

export const MARIA = {
  personId: "maria-001",
  displayName: "Maria Torres",
  email: "maria.torres@example.com",
} as const;

// The renewal's answers as the agent's food-renewal form carries them
// (apps/agent/agent/lib/forms.ts), so the stand-in approval has the same
// shape a live one does. Like a live approval they stay in English in any
// language: they are what the yes approves (docs/decisions.md, November 4).
export const RENEWAL_DECLARATION =
  "I declare under penalty of perjury that the information in this renewal is true, correct and complete to the best of my knowledge.";
export const RENEWAL_ANSWERS = {
  caseNumber: "R-1042",
  fullName: "Maria Torres",
  dateOfBirth: "1988-03-14",
  householdSize: "2",
  monthlyIncome: "1940",
  address: "418 Alder St Apt 3, Springfield",
  phone: "(217) 555-0142",
} as const;

// What the stand-in itself says, in the person's language.
export interface DemoWords {
  greeting: string;
  mailReply: string;
  approveFollowup: string;
  // The text line's answer to a NO, word for word (apps/agent words.ts).
  declineReply: string;
  // The answer to "Ask Mano to change something": the approval stays
  // waiting and unsent. The stand-in cannot redo the form, so it does not
  // promise a new version.
  changeReply: string;
  caseworkerRequest: string;
  paystubReply: string;
  approvedNotice: string;
  fallbackReply: string;
  deadlinesReply(count: number): string;
  approvalsReply(pending: number): string;
  renewalDeadline: { title: string; detail: string };
  electricDeadline: { title: string; detail: string };
  paystubDeadline: { title: string; detail: string };
  grantPurpose: string;
  grantScope: string[];
}

export const DEMO_WORDS: Record<Language, DemoWords> = {
  en: {
    greeting:
      "Hi Maria, I am your Mano agent. Photograph your mail and I will read it, track your deadlines and fill out forms for your approval. Nothing is ever sent without you.",
    mailReply:
      "I found 2 letters in your photos.\n\n" +
      "1. SNAP renewal notice from Springfield County. Your renewal is due November 15. I filled out the renewal from your last application; it is waiting in Approvals.\n\n" +
      "2. Electricity bill, $84.20, due November 8.\n\n" +
      "Both are now on your deadlines list.",
    approveFollowup: "Your renewal is on its way to the Springfield County SNAP office. I will watch for their answer.",
    declineReply: "Okay, I did not send it. Nothing left Mano.",
    changeReply: "Got it. Nothing was sent. I noted your change; the version in Approvals stays unsent until you say yes or no to it.",
    caseworkerRequest:
      "Springfield County wrote back. They are missing one thing: a pay stub from the last 30 days. They need it by November 12. Photograph it and I will send it with your case number.",
    paystubReply: "Got it. I sent your pay stub to the Springfield County SNAP office with case R-1042.",
    approvedNotice: "Good news: the county approved your renewal. Your benefits continue without a gap. I saved their notice in Documents.",
    fallbackReply:
      "I can read your mail, track deadlines, fill out forms for your approval and send documents to offices you choose. Photograph your mail to start, or ask me about your deadlines.",
    deadlinesReply: (count) =>
      count === 0
        ? "You have no deadlines right now. Photograph your mail and I will build the list."
        : `You have ${count} upcoming deadline${count === 1 ? "" : "s"}. Open Deadlines to see each one.`,
    approvalsReply: (pending) =>
      pending === 0
        ? "Nothing is waiting for your approval right now."
        : `You have ${pending} thing${pending === 1 ? "" : "s"} waiting in Approvals. Each one shows exactly what will be sent before you approve it.`,
    renewalDeadline: { title: "SNAP renewal due", detail: "Springfield County, case R-1042. Your filled renewal is waiting in Approvals." },
    electricDeadline: { title: "Electricity bill, $84.20", detail: "Springfield Light and Power, account ending 4471." },
    paystubDeadline: { title: "Send the county a pay stub", detail: "Springfield County asked for a pay stub from the last 30 days for case R-1042." },
    grantPurpose: "Your SNAP renewal, case R-1042",
    grantScope: ["case documents", "deadlines"],
  },
  es: {
    greeting:
      "Hola, Maria. Soy su agente de Mano. Fotografíe su correo y yo lo leeré, llevaré sus fechas límite y llenaré formularios para su aprobación. Nunca se envía nada sin usted.",
    mailReply:
      "Encontré 2 cartas en sus fotos.\n\n" +
      "1. Aviso de renovación de SNAP del condado de Springfield. Su renovación vence el 15 de noviembre. Llené la renovación con su última solicitud; está esperando en la pestaña Aprobar.\n\n" +
      "2. Factura de electricidad, $84.20, vence el 8 de noviembre.\n\n" +
      "Las dos ya están en su lista de fechas límite.",
    approveFollowup: "Su renovación va en camino a la oficina de SNAP del condado de Springfield. Estaré pendiente de su respuesta.",
    declineReply: "Bien, no lo envié. Nada salió de Mano.",
    changeReply: "Entendido. No se envió nada. Anoté su cambio; la versión en la pestaña Aprobar sigue sin enviarse hasta que usted diga sí o no.",
    caseworkerRequest:
      "El condado de Springfield respondió. Les falta una cosa: un talón de pago de los últimos 30 días. Lo necesitan antes del 12 de noviembre. Fotografíelo y lo enviaré con su número de caso.",
    paystubReply: "Recibido. Envié su talón de pago a la oficina de SNAP del condado de Springfield con el caso R-1042.",
    approvedNotice: "Buenas noticias: el condado aprobó su renovación. Sus beneficios continúan sin interrupción. Guardé el aviso en Documentos.",
    fallbackReply:
      "Puedo leer su correo, llevar fechas límite, llenar formularios para su aprobación y enviar documentos a las oficinas que usted elija. Fotografíe su correo para empezar, o pregúnteme por sus fechas límite.",
    deadlinesReply: (count) =>
      count === 0
        ? "Ahora no tiene fechas límite. Fotografíe su correo y yo haré la lista."
        : count === 1
          ? "Tiene 1 fecha límite próxima. Abra la pestaña Fechas para verla."
          : `Tiene ${count} fechas límite próximas. Abra la pestaña Fechas para ver cada una.`,
    approvalsReply: (pending) =>
      pending === 0
        ? "Ahora nada espera su aprobación."
        : pending === 1
          ? "Tiene 1 cosa esperando en la pestaña Aprobar. Muestra exactamente lo que se enviará antes de que usted la apruebe."
          : `Tiene ${pending} cosas esperando en la pestaña Aprobar. Cada una muestra exactamente lo que se enviará antes de que usted la apruebe.`,
    renewalDeadline: { title: "Vence la renovación de SNAP", detail: "Condado de Springfield, caso R-1042. Su renovación ya llena está esperando en la pestaña Aprobar." },
    electricDeadline: { title: "Factura de electricidad, $84.20", detail: "Springfield Light and Power, cuenta que termina en 4471." },
    paystubDeadline: { title: "Enviar un talón de pago al condado", detail: "El condado de Springfield pidió un talón de pago de los últimos 30 días para el caso R-1042." },
    grantPurpose: "Su renovación de SNAP, caso R-1042",
    grantScope: ["documentos del caso", "fechas límite"],
  },
};

// The exact renewal packet the approval binds to. The stand-in hashes
// these bytes at runtime, exactly like the engine hashes stored bytes.
export function renewalPacketText(): string {
  return (
    "SNAP RENEWAL PACKET - CASE R-1042\n" +
    "Springfield County SNAP Office\n" +
    "Prepared by Mano for Maria Torres, for her approval.\n" +
    "\n" +
    "Applicant: Maria Torres, born 1988-03-14\n" +
    "Phone: (217) 555-0142\n" +
    "Address: 418 Alder St Apt 3, Springfield\n" +
    "Household: 2 (Maria Torres, Sofia Torres)\n" +
    "Income: $1,940/mo, Greenline Grocers, pay stub attached\n" +
    "Rent: $1,150/mo\n" +
    "\n" +
    "Renewal answers (from the October 2026 application on file):\n" +
    "1. Household size unchanged: yes\n" +
    "2. Income changed by more than $100/mo: no\n" +
    "3. New address: no\n" +
    "4. All members still in the home: yes\n" +
    "\n" +
    "Declaration: I declare under penalty of perjury that the information in this renewal is true, correct and complete to the best of my knowledge.\n" +
    "Signature: Maria Torres (signed in the app on approval)\n" +
    "Date: at approval time\n"
  );
}

// The county answer as a one-page PDF, base64. It carries the same
// text as the renewal story, so the viewer gets a real render target.
export function approvalNoticePdfB64(): string {
  return "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzMjIgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA3MiA3MjAgVGQgKFNQUklOR0ZJRUxEIENPVU5UWSBTTkFQIE9GRklDRSkgVGogMCAtMzAgVGQgL0YxIDEyIFRmIChOb3RpY2Ugb2YgYXBwcm92YWwgLSBjYXNlIFItMTA0MikgVGogMCAtMzAgVGQgKE1hcmlhIFRvcnJlcywpIFRqIDAgLTIwIFRkIChZb3VyIFNOQVAgcmVuZXdhbCBpcyBhcHByb3ZlZC4gWW91ciBiZW5lZml0cyBjb250aW51ZSB3aXRoIG5vIGdhcC4pIFRqIDAgLTIwIFRkIChOZXh0IHJlbmV3YWw6IE5vdmVtYmVyIDIwMjcuKSBUaiAwIC00MCBUZCAoKFN5bnRoZXRpYyBub3RpY2UgZm9yIHRoZSBNYW5vIGRlbW8uKSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDA2MTQgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo2ODQKJSVFT0Y=";
}

export function snapLetterText(): string {
  return (
    "SPRINGFIELD COUNTY SNAP OFFICE\n" +
    "Your renewal is due November 15, 2026.\n" +
    "Case R-1042. Return the renewal form or your benefits may stop.\n" +
    "\n" +
    "(Transcription of synthetic demo mail.)\n"
  );
}

export function electricBillText(): string {
  return (
    "SPRINGFIELD LIGHT AND POWER\n" +
    "Amount due: $84.20 by November 8, 2026.\n" +
    "Account ending 4471, 418 Alder St Apt 3.\n" +
    "\n" +
    "(Transcription of synthetic demo mail.)\n"
  );
}
