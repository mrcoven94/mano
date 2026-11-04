import { describe, expect, it } from "vitest";

import { decisionLanguage, parseDecision } from "../agent/lib/decision.js";
import { detectLanguage, languageFromProfile } from "../agent/lib/language.js";
import { presentsExactly, renderQuestion, replayLine } from "../agent/lib/pending.js";
import { FORMS } from "../agent/lib/forms.js";
import { QUESTION_WORDS } from "../agent/lib/words.js";
import { RECIPIENT_NAMES, UNNAMED_RECIPIENT } from "@mano/protocol";

const DECLARATION = Object.values(FORMS)[0]!.declaration;
const approval = {
  purpose: "Food benefits renewal",
  recipient: "sandbox:county-portal",
  requestJson: JSON.stringify({
    documentId: "doc-1",
    payload: { fullName: "Rosa Testcase", phone: "253-555-0100", attachment: "the letter you sent on November 2", declaration: DECLARATION },
  }),
};

describe("a yes in another language", () => {
  it.each([
    ["si", "es"],
    ["Si", "es"],
    ["SI", "es"],
    ["sí", "es"],
    ["SÍ", "es"],
    ["Sí.", "es"],
    ["¡Sí!", "es"],
    ["  sí  ", "es"],
    ["sí", "es"],
    ["có", "vi"],
    ["Có", "vi"],
    ["CÓ", "vi"],
    ["có", "vi"],
    ["có.", "vi"],
    ["opo", "tl"],
    ["Opo!", "tl"],
    ["oui", null],
    ["OUI", null],
  ])("%j counts as yes", (text, language) => {
    expect(parseDecision(text)).toBe("yes");
    expect(decisionLanguage(text)).toBe(language);
  });

  // Each of these is a real message a person could send to a filing
  // question. None may file: they go to the model, which asks again.
  it.each([
    // Vietnamese without its mark can be another word entirely.
    "co", "cô", "cò", "cỏ", "cố", "cọ", "cơ", "cổ",
    "có lẽ", "có thể", "có không", "có sao không", "có phải không", "chưa có",
    // Spanish "si" is also "if", and a question is not an answer.
    "si...", "si..", "si…", "sí...", "sí..", "sí…", "si.!", "si!!", "có...", "có…", "opo...", "oui...", "yes...", "si?", "sí?", "¿sí?", "¿si?", "si no", "si puedo", "si quiero saber", "si tuviera", "sí pero cambia mi teléfono", "sí, espera", "sino", "sí sí", "sí no", "no sí", "si,", "a si",
    "oui ou non", "oui?", "oui mais", "non oui",
    "opo ba", "opo?", "hindi opo", "opo hindi", "opo pero teka", "oo", "po",
    "sí 👍", "👍", "ya", "tal vez", "quizás", "dạ", "vâng", "khoan",
  ])("%j does not count as yes", (text) => {
    expect(parseDecision(text)).not.toBe("yes");
  });

  it("keeps English answers as they were", () => {
    for (const text of ["yes", "YES!", "y", "ok", "sure", "go ahead", "1", "approve"]) expect(parseDecision(text)).toBe("yes");
    for (const text of ["no", "N", "nope", "stop", "2", "not yet"]) expect(parseDecision(text)).toBe("no");
    for (const text of ["maybe", "which form?", "", "yesterday", "note that down"]) expect(parseDecision(text)).toBeNull();
  });

  it.each([
    ["no", null],
    ["No.", null],
    ["không", "vi"],
    ["Không", "vi"],
    ["không", "vi"],
    ["hindi", "tl"],
    ["Hindi po", "tl"],
    ["non", null],
  ])("%j counts as no", (text, language) => {
    expect(parseDecision(text)).toBe("no");
    expect(decisionLanguage(text)).toBe(language);
  });
});

describe("what language a person writes in", () => {
  it.each([
    ["Hola, me cortaron los beneficios de comida", "es"],
    ["necesito ayuda con mi renovación", "es"],
    ["Quiero renovar mis beneficios por favor", "es"],
    ["gracias", "es"],
    ["Tôi cần giúp đỡ về phiếu thực phẩm", "vi"],
    ["xin chào", "vi"],
    ["Kailangan ko ng tulong para sa pagkain po", "tl"],
    ["Ano ang gagawin ko sa sulat na ito", "tl"],
    ["salamat po", "tl"],
    ["I need help with my food benefits", "en"],
    ["what is this letter about", "en"],
  ])("%j is %s", (text, language) => {
    expect(detectLanguage(text)).toBe(language);
  });

  // A short answer or a name says nothing about the language, so the turn
  // falls back to what is on file.
  it.each(["Maria de la Cruz", "Nguyễn Văn An", "Ang Ko Po", "3", "1800", "12 Calle de la Paz", "253-555-0100", "ok", "SNAP", "si", "no", "para", "La Paz"])("%j says nothing", (text) => {
    expect(detectLanguage(text)).toBeNull();
  });

  it.each([
    ["Spanish", "es"],
    ["español", "es"],
    ["Vietnamese", "vi"],
    ["tiếng Việt", "vi"],
    ["Tagalog", "tl"],
    ["Filipino", "tl"],
    ["English", "en"],
    ["Mandarin", null],
    [undefined, null],
  ])("the profile's %s reads as %s", (value, language) => {
    expect(languageFromProfile(value)).toBe(language);
  });
});

describe("the question in the person's language", () => {
  const renewal = {
    purpose: "Food benefits renewal",
    recipient: "sandbox-agency-portal",
    requestJson: JSON.stringify({
      documentId: "doc-1",
      attachmentLabel: "the letter you sent on November 4",
      payload: { caseNumber: "WA-SNAP-0042117", fullName: "Rosa Testcase", phone: "253-555-0100", declaration: DECLARATION, attachment: "doc-1" },
    }),
  };

  it("reads as one Spanish sentence, with the frozen values and declaration as they are", () => {
    expect(renderQuestion(renewal, "es")).toBe(
      "Listo para enviar: Renovación de beneficios de alimentos (para el portal de prueba de la Oficina Estatal de Renovación de Beneficios). " +
        "Número de caso: WA-SNAP-0042117; Nombre legal completo: Rosa Testcase; Teléfono: 253-555-0100. " +
        "Adjunto: la carta que envió el 4 de noviembre. " +
        "Termina con una declaración que solo usted puede hacer. Significa que usted afirma, bajo pena de perjurio, que la información es verdadera, correcta y completa según su conocimiento. Así dice en inglés, igual que en el formulario: " +
        `${DECLARATION} ` +
        "Responda SÍ para hacer esta declaración usted y enviar exactamente esto, o NO para parar.",
    );
  });

  it.each([
    ["vi", "Sẵn sàng gửi: Gia hạn phúc lợi thực phẩm (đến cổng thử nghiệm của Văn phòng Gia hạn Phúc lợi Tiểu bang).", "Số hồ sơ: WA-SNAP-0042117", "Đính kèm: thư bạn gửi ngày 4 tháng 11.", "Trả lời CÓ"],
    ["tl", "Handa nang ipadala: Pag-renew ng benepisyo sa pagkain (sa test portal ng State Benefits Renewal Office).", "Numero ng kaso: WA-SNAP-0042117", "Kalakip: ang sulat na ipinadala mo noong Nobyembre 4.", "Sumagot ng OPO"],
  ] as const)("reads in %s too", (language, opens, field, attached, asks) => {
    const question = renderQuestion(renewal, language);
    expect(question.startsWith(opens)).toBe(true);
    for (const part of [field, attached, asks, "Rosa Testcase", "253-555-0100", DECLARATION]) expect(question).toContain(part);
  });

  it.each(["es", "vi", "tl"] as const)("%s has every form label, every office and every kind of attachment, and the text line carries it", (language) => {
    const words = QUESTION_WORDS[language];
    for (const form of Object.values(FORMS)) {
      expect(words.purposes[form.purpose]).toBeTruthy();
      for (const field of form.fields) expect(words.labels[field.label], field.label).toBeTruthy();
    }
    for (const name of [...Object.values(RECIPIENT_NAMES), UNNAMED_RECIPIENT]) expect(words.recipients[name], name).toBeTruthy();
    for (const noun of ["letter", "photo", "PDF", "file"]) {
      const question = renderQuestion({ ...renewal, requestJson: JSON.stringify({ documentId: "doc-1", attachmentLabel: `the ${noun} you sent on March 12`, payload: {} }) }, language);
      expect(question).not.toContain("you sent");
      expect(presentsExactly(question)).toBe(true);
    }
    expect(presentsExactly(renderQuestion(renewal, language))).toBe(true);
    expect(presentsExactly(replayLine("https://x.test/fill/1", language).replace(/https:\S+/, "").trim())).toBe(true);
  });

  // The demo's renewal goes with a letter and no pay stub. The person's yes
  // covers that, so these words must reach them in every language.
  it.each([
    ["en", "With the letter you sent on November 4, and no proof of income attached."],
    ["es", "Adjunto: la carta que envió el 4 de noviembre, y ningún comprobante de ingresos."],
    ["vi", "Đính kèm: thư bạn gửi ngày 4 tháng 11, và không có giấy tờ chứng minh thu nhập."],
    ["tl", "Kalakip: ang sulat na ipinadala mo noong Nobyembre 4, at walang katibayan ng kita."],
  ] as const)("%s says when no proof of income goes", (language, line) => {
    const noProof = { ...renewal, requestJson: JSON.stringify({ documentId: "doc-1", attachmentLabel: "the letter you sent on November 4, and no proof of income", payload: { fullName: "Rosa Testcase" } }) };
    expect(renderQuestion(noProof, language)).toContain(line);
    expect(presentsExactly(renderQuestion(noProof, language))).toBe(true);
  });

  it.each(["es", "vi", "tl"] as const)("%s keeps a label with any other ending whole, in English, and drops nothing", (language) => {
    const label = "the letter you sent on November 4, and no pay stub";
    const other = { ...renewal, requestJson: JSON.stringify({ documentId: "doc-1", attachmentLabel: label, payload: {} }) };
    expect(renderQuestion(other, language)).toContain(label);
  });

  it("a purpose, label, office or attachment it has no words for stays in its exact English", () => {
    const other = {
      purpose: "Housing form",
      recipient: "unknown-office",
      requestJson: JSON.stringify({ documentId: "doc-1", attachmentLabel: "the scan from Tuesday", payload: { customField: "42" } }),
    };
    const question = renderQuestion(other, "es");
    expect(question).toContain("Housing form (para una oficina que Mano no puede nombrar)");
    expect(question).toContain("customField: 42");
    expect(question).toContain("Adjunto: the scan from Tuesday.");
    expect(renderQuestion({ ...other, requestJson: JSON.stringify({ documentId: "doc-1", payload: {} }) }, "es")).toContain("Adjunto: su documento.");
  });

  it("tells the person in their language what they swear to, and only for the declaration it knows", () => {
    expect(renderQuestion(approval, "es")).toContain("bajo pena de perjurio");
    const other = { ...approval, requestJson: JSON.stringify({ payload: { declaration: "I agree to something else." } }) };
    const question = renderQuestion(other, "es");
    expect(question).toContain("I agree to something else.");
    expect(question).not.toContain("perjurio");
  });

  it("English stays exactly as it was", () => {
    expect(renderQuestion(approval)).toBe(renderQuestion(approval, "en"));
    expect(renderQuestion(approval)).toMatch(/^Ready to send: Food benefits renewal \(to /);
    expect(renderQuestion(approval)).toMatch(/Reply YES to make this declaration yourself and send exactly this, or NO to stop\.$/);
  });
});
