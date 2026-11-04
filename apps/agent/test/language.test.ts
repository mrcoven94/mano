import { describe, expect, it } from "vitest";

import { decisionLanguage, parseDecision } from "../agent/lib/decision.js";
import { detectLanguage, languageFromProfile } from "../agent/lib/language.js";
import { presentsExactly, renderQuestion, replayLine } from "../agent/lib/pending.js";
import { FORMS } from "../agent/lib/forms.js";

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
  it.each([
    ["es", "Listo para enviar:", "Responda SÍ", "dice en inglés"],
    ["vi", "Sẵn sàng gửi:", "Trả lời CÓ", "bằng tiếng Anh"],
    ["tl", "Handa nang ipadala:", "Sumagot ng OPO", "sa Ingles"],
  ] as const)("%s asks in the language and keeps every approved value exact", (language, opens, asks, says) => {
    const question = renderQuestion(approval, language);
    expect(question.startsWith(opens)).toBe(true);
    expect(question).toContain(asks);
    expect(question).toContain(says);
    // The form stays in English, its values and declaration word for word.
    expect(question).toContain("Food benefits renewal");
    expect(question).toContain("Rosa Testcase");
    expect(question).toContain("253-555-0100");
    expect(question).toContain("the letter you sent on November 2");
    expect(question).toContain(DECLARATION);
    // The text line carries it unchanged, or nothing could be approved.
    expect(presentsExactly(question)).toBe(true);
    expect(presentsExactly(replayLine("https://x.test/fill/1", language).replace(/https:\S+/, "").trim())).toBe(true);
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
