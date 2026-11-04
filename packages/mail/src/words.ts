// Every sentence Mano says about a letter, in each language it can say it
// in without a model. These are closed words: the reply is built from
// them and from closed fields, so a date or a warning reads the same in
// every language and no letter text gets in. A language missing a line is
// a type error, never an English sentence in the middle of a reply.
import type { LetterType, SendCategory } from "./answer.js";

export const REPLY_LANGUAGES = ["en", "es", "vi", "tl"] as const;
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];

export interface AnswerWords {
  date(iso: string): string;
  and: string;
  // How a letter with no program on Mano's list is named.
  benefits: string;
  letterType: Record<LetterType, (program: string) => string>;
  categories: Record<SendCategory, string>;
  due(date: string): string;
  nextDue(kind: "renewal" | "recertification", date: string): string;
  asksToSend(list: string): string;
  askDate(date: string): string;
  severalDates: string;
  // In a pile, for a plain letter with no date, ask or consequence.
  canWait: string;
  letterNumber(n: number): string;
  scam: string;
  suspectLink: string;
  notSure: string;
  checkWithOffice: string;
  confirmedThenTell: string;
  claim(date: string): string;
  mentionsADate: string;
  mentionsSeveral: string;
  planted: string;
  official: string;
  unread: string;
  failed: string;
  missedPart: string;
  // What Mano says after it tries to hold the deadline.
  saved(date: string): string;
  passed(date: string): string;
  notSavedYet(date: string): string;
  notSavedNow(date: string): string;
  photoUnsaved: string;
}

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

const named = (months: string, form: (month: string, d: number, y: number) => string) => {
  const list = months.split(" ");
  return (iso: string): string => {
    const { y, m, d } = parts(iso);
    return form(list[m - 1]!, d, y);
  };
};

export const ANSWER_WORDS: Record<ReplyLanguage, AnswerWords> = {
  en: {
    date: named("January February March April May June July August September October November December", (month, d, y) => `${month} ${d}, ${y}`),
    and: "and",
    benefits: "benefits",
    letterType: {
      renewal: (p) => `This is a ${p} renewal letter.`,
      interview: (p) => `This is a ${p} letter about an interview.`,
      "documents needed": (p) => `This is a ${p} letter asking for documents.`,
      "change notice": (p) => `This is a ${p} notice of a change.`,
      denial: (p) => `This is a ${p} denial letter.`,
      overpayment: (p) => `This is a ${p} letter about an overpayment.`,
      hearing: (p) => `This is a ${p} letter about a hearing.`,
      other: (p) => `This is a ${p} letter.`,
    },
    categories: {
      "proof of income": "proof of income",
      ID: "ID",
      "proof of address": "proof of address",
      "pay stubs": "pay stubs",
      "bank statements": "bank statements",
      "rent or utility bills": "rent or utility bills",
      "household member info": "household member info",
      "other documents the letter lists": "other documents the letter lists",
    },
    due: (date) => `It is due ${date}.`,
    nextDue: (kind, date) => `Your next ${kind} is due ${date}.`,
    asksToSend: (list) => `It asks you to send: ${list}.`,
    askDate: (date) => `It looks like the letter gives a deadline of ${date}. Is that the date you need to meet?`,
    severalDates: "Your letter mentions more than one date, and I don't want to guess wrong. Which date does it say you need to meet?",
    canWait: "It has no deadline I could find and asks for nothing, so this one can wait. If you are not sure, check with your office.",
    letterNumber: (n) => `Letter ${n}.`,
    scam: "This letter looks like a scam. Do not pay, call, or open anything it lists. If you are not sure, call your office at a number you already trust.",
    suspectLink: "This letter has a link I do not trust. Do not open it, pay through it, or type anything into it.",
    notSure: "If you are not sure about this letter, check with your office, at a phone number or office you already know.",
    checkWithOffice: "Check with your office, at a phone number or office you already know.",
    confirmedThenTell: "If they confirm it, tell me and I will remind you.",
    claim: (date) => `The letter claims a deadline of ${date}, and I have not confirmed it.`,
    mentionsADate: "The letter mentions a date, and I have not confirmed it.",
    mentionsSeveral: "The letter mentions more than one date, and I have not confirmed any of them.",
    planted: "Part of this letter tries to give me instructions. I did not follow them.",
    official: "If you need to call the office, use the number on your state's official site, not one from a letter.",
    unread: "I could not read the letter in your photo. Send it again with the whole page flat, in good light, and I will try once more.",
    failed: "I could not finish reading your photo just now. Send it again and I will try once more.",
    missedPart: "I could not read part of what you sent. Send that photo again if it had another letter.",
    saved: (date) => `I saved ${date} to your deadlines.`,
    passed: (date) => `${date} has already passed, so no reminder will go out. If the office gave you a newer date, send it to me.`,
    notSavedYet: (date) => `I could not save ${date} to your deadlines yet.`,
    notSavedNow: (date) => `I could not save ${date} to your deadlines just now.`,
    photoUnsaved: "I could not save your photo, so I have not read it. Please send it again.",
  },
  es: {
    date: named("enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre", (month, d, y) => `${d} de ${month} de ${y}`),
    and: "y",
    benefits: "beneficios",
    letterType: {
      renewal: (p) => `Esta es una carta de renovación de ${p}.`,
      interview: (p) => `Esta es una carta de ${p} sobre una entrevista.`,
      "documents needed": (p) => `Esta es una carta de ${p} que pide documentos.`,
      "change notice": (p) => `Este es un aviso de ${p} sobre un cambio.`,
      denial: (p) => `Esta es una carta de negación de ${p}.`,
      overpayment: (p) => `Esta es una carta de ${p} sobre un pago en exceso.`,
      hearing: (p) => `Esta es una carta de ${p} sobre una audiencia.`,
      other: (p) => `Esta es una carta de ${p}.`,
    },
    categories: {
      "proof of income": "comprobante de ingresos",
      ID: "identificación",
      "proof of address": "comprobante de domicilio",
      "pay stubs": "talones de pago",
      "bank statements": "estados de cuenta bancarios",
      "rent or utility bills": "facturas de renta o servicios",
      "household member info": "información de los miembros del hogar",
      "other documents the letter lists": "otros documentos que la carta indica",
    },
    due: (date) => `Vence el ${date}.`,
    nextDue: (kind, date) => `Su próxima ${kind === "renewal" ? "renovación" : "recertificación"} vence el ${date}.`,
    asksToSend: (list) => `Pide que envíe: ${list}.`,
    askDate: (date) => `Parece que la carta da como fecha límite el ${date}. ¿Es esa la fecha que debe cumplir?`,
    severalDates: "Su carta menciona más de una fecha y no quiero equivocarme. ¿Qué fecha dice que debe cumplir?",
    canWait: "No encontré una fecha límite y no pide nada, así que esta puede esperar. Si tiene dudas, consulte con su oficina.",
    letterNumber: (n) => `Carta ${n}.`,
    scam: "Esta carta parece una estafa. No pague, no llame ni abra nada de lo que indica. Si tiene dudas, llame a su oficina a un número en el que ya confíe.",
    suspectLink: "Esta carta tiene un enlace en el que no confío. No lo abra, no pague por ahí ni escriba nada ahí.",
    notSure: "Si tiene dudas sobre esta carta, consulte con su oficina, por un teléfono o en una oficina que ya conozca.",
    checkWithOffice: "Consulte con su oficina, por un teléfono o en una oficina que ya conozca.",
    confirmedThenTell: "Si lo confirman, avíseme y le recordaré.",
    claim: (date) => `La carta dice que la fecha límite es el ${date}, y no lo he confirmado.`,
    mentionsADate: "La carta menciona una fecha, y no la he confirmado.",
    mentionsSeveral: "La carta menciona más de una fecha, y no he confirmado ninguna.",
    planted: "Una parte de esta carta intenta darme instrucciones. No las seguí.",
    official: "Si necesita llamar a la oficina, use el número del sitio oficial de su estado, no uno de una carta.",
    unread: "No pude leer la carta de su foto. Envíela de nuevo con toda la página plana y con buena luz, y lo intentaré otra vez.",
    failed: "No pude terminar de leer su foto ahora. Envíela de nuevo y lo intentaré otra vez.",
    missedPart: "No pude leer parte de lo que envió. Envíe esa foto de nuevo si tenía otra carta.",
    saved: (date) => `Guardé el ${date} en sus fechas límite.`,
    passed: (date) => `El ${date} ya pasó, así que no se enviará ningún recordatorio. Si la oficina le dio una fecha más reciente, envíemela.`,
    notSavedYet: (date) => `Todavía no pude guardar el ${date} en sus fechas límite.`,
    notSavedNow: (date) => `No pude guardar el ${date} en sus fechas límite ahora.`,
    photoUnsaved: "No pude guardar su foto, así que no la he leído. Envíela de nuevo, por favor.",
  },
  vi: {
    date: (iso) => {
      const { y, m, d } = parts(iso);
      return `ngày ${d} tháng ${m} năm ${y}`;
    },
    and: "và",
    benefits: "phúc lợi",
    letterType: {
      renewal: (p) => `Đây là thư gia hạn ${p}.`,
      interview: (p) => `Đây là thư ${p} về một cuộc phỏng vấn.`,
      "documents needed": (p) => `Đây là thư ${p} yêu cầu giấy tờ.`,
      "change notice": (p) => `Đây là thông báo ${p} về một thay đổi.`,
      denial: (p) => `Đây là thư từ chối ${p}.`,
      overpayment: (p) => `Đây là thư ${p} về khoản trả thừa.`,
      hearing: (p) => `Đây là thư ${p} về một phiên điều trần.`,
      other: (p) => `Đây là thư ${p}.`,
    },
    categories: {
      "proof of income": "giấy tờ chứng minh thu nhập",
      ID: "giấy tờ tùy thân",
      "proof of address": "giấy tờ chứng minh địa chỉ",
      "pay stubs": "cuống lương",
      "bank statements": "sao kê ngân hàng",
      "rent or utility bills": "hóa đơn tiền nhà hoặc điện nước",
      "household member info": "thông tin thành viên trong hộ",
      "other documents the letter lists": "các giấy tờ khác trong thư",
    },
    due: (date) => `Hạn chót là ${date}.`,
    nextDue: (kind, date) => `Lần ${kind === "renewal" ? "gia hạn" : "tái xác nhận"} tiếp theo của bạn đến hạn ${date}.`,
    asksToSend: (list) => `Thư yêu cầu bạn gửi: ${list}.`,
    askDate: (date) => `Có vẻ thư cho hạn chót là ${date}. Đó có phải là ngày bạn cần kịp không?`,
    severalDates: "Thư của bạn nhắc đến nhiều ngày, và tôi không muốn đoán sai. Thư nói bạn cần kịp ngày nào?",
    canWait: "Tôi không thấy hạn chót và thư không yêu cầu gì, nên thư này có thể chờ. Nếu không chắc, hãy hỏi lại văn phòng của bạn.",
    letterNumber: (n) => `Thư ${n}.`,
    scam: "Thư này có vẻ là lừa đảo. Đừng trả tiền, gọi điện hoặc mở bất cứ thứ gì trong thư. Nếu không chắc, hãy gọi văn phòng của bạn theo số bạn đã tin tưởng.",
    suspectLink: "Thư này có một đường link tôi không tin tưởng. Đừng mở, đừng trả tiền qua đó và đừng nhập gì vào đó.",
    notSure: "Nếu bạn không chắc về thư này, hãy hỏi lại văn phòng của bạn, qua số điện thoại hoặc văn phòng bạn đã biết.",
    checkWithOffice: "Hãy hỏi lại văn phòng của bạn, qua số điện thoại hoặc văn phòng bạn đã biết.",
    confirmedThenTell: "Nếu họ xác nhận, hãy báo tôi và tôi sẽ nhắc bạn.",
    claim: (date) => `Thư nói hạn chót là ${date}, và tôi chưa xác nhận điều đó.`,
    mentionsADate: "Thư có nhắc đến một ngày, và tôi chưa xác nhận.",
    mentionsSeveral: "Thư nhắc đến nhiều ngày, và tôi chưa xác nhận ngày nào.",
    planted: "Một phần của thư này cố ra lệnh cho tôi. Tôi đã không làm theo.",
    official: "Nếu cần gọi văn phòng, hãy dùng số trên trang web chính thức của tiểu bang, không dùng số trong thư.",
    unread: "Tôi không đọc được thư trong ảnh của bạn. Hãy gửi lại, để cả trang phẳng, đủ sáng, và tôi sẽ thử lại.",
    failed: "Tôi chưa đọc xong ảnh của bạn. Hãy gửi lại và tôi sẽ thử lại.",
    missedPart: "Tôi không đọc được một phần bạn gửi. Hãy gửi lại ảnh đó nếu có thư khác.",
    saved: (date) => `Tôi đã lưu ${date} vào danh sách hạn chót của bạn.`,
    passed: (date) => `Hạn ${date} đã qua, nên sẽ không có nhắc nhở. Nếu văn phòng cho bạn ngày mới hơn, hãy gửi cho tôi.`,
    notSavedYet: (date) => `Tôi chưa lưu được ${date} vào danh sách hạn chót của bạn.`,
    notSavedNow: (date) => `Lúc này tôi không lưu được ${date} vào danh sách hạn chót của bạn.`,
    photoUnsaved: "Tôi không lưu được ảnh của bạn, nên tôi chưa đọc nó. Vui lòng gửi lại.",
  },
  tl: {
    date: named("Enero Pebrero Marso Abril Mayo Hunyo Hulyo Agosto Setyembre Oktubre Nobyembre Disyembre", (month, d, y) => `${month} ${d}, ${y}`),
    and: "at",
    benefits: "benepisyo",
    letterType: {
      renewal: (p) => `Ito ay sulat ng pag-renew ng ${p}.`,
      interview: (p) => `Ito ay sulat ng ${p} tungkol sa interview.`,
      "documents needed": (p) => `Ito ay sulat ng ${p} na humihingi ng mga dokumento.`,
      "change notice": (p) => `Ito ay abiso ng ${p} tungkol sa pagbabago.`,
      denial: (p) => `Ito ay sulat ng pagtanggi sa ${p}.`,
      overpayment: (p) => `Ito ay sulat ng ${p} tungkol sa sobrang bayad.`,
      hearing: (p) => `Ito ay sulat ng ${p} tungkol sa hearing.`,
      other: (p) => `Ito ay sulat ng ${p}.`,
    },
    categories: {
      "proof of income": "katibayan ng kita",
      ID: "ID",
      "proof of address": "katibayan ng tirahan",
      "pay stubs": "pay stubs",
      "bank statements": "bank statements",
      "rent or utility bills": "mga bill ng upa o utilities",
      "household member info": "impormasyon ng mga kasama sa bahay",
      "other documents the letter lists": "iba pang dokumentong nakasaad sa sulat",
    },
    due: (date) => `Ang huling araw ay ${date}.`,
    nextDue: (kind, date) => `Ang susunod mong ${kind === "renewal" ? "pag-renew" : "recertification"} ay sa ${date}.`,
    asksToSend: (list) => `Hinihingi nitong ipadala mo: ${list}.`,
    askDate: (date) => `Mukhang ${date} ang huling araw na ibinibigay ng sulat. Iyon ba ang petsang dapat mong habulin?`,
    severalDates: "Mahigit isang petsa ang nasa sulat mo, at ayokong magkamali. Aling petsa ang sinasabi nitong dapat mong habulin?",
    canWait: "Wala akong nakitang huling araw at wala itong hinihingi, kaya puwede itong maghintay. Kung hindi ka sigurado, magtanong sa iyong opisina.",
    letterNumber: (n) => `Sulat ${n}.`,
    scam: "Mukhang scam ang sulat na ito. Huwag magbayad, tumawag, o magbukas ng anumang nakasaad dito. Kung hindi ka sigurado, tawagan ang iyong opisina sa numerong pinagkakatiwalaan mo na.",
    suspectLink: "May link ang sulat na ito na hindi ko pinagkakatiwalaan. Huwag itong buksan, huwag magbayad dito, at huwag mag-type ng kahit ano rito.",
    notSure: "Kung hindi ka sigurado sa sulat na ito, magtanong sa iyong opisina, sa numero ng telepono o opisinang alam mo na.",
    checkWithOffice: "Magtanong sa iyong opisina, sa numero ng telepono o opisinang alam mo na.",
    confirmedThenTell: "Kung kumpirmahin nila, sabihin mo sa akin at ipapaalala ko sa iyo.",
    claim: (date) => `Sinasabi ng sulat na ang huling araw ay ${date}, at hindi ko pa ito nakukumpirma.`,
    mentionsADate: "May binabanggit na petsa ang sulat, at hindi ko pa ito nakukumpirma.",
    mentionsSeveral: "Mahigit isang petsa ang binabanggit ng sulat, at wala pa akong nakukumpirma sa mga ito.",
    planted: "May bahagi ng sulat na ito na sumusubok mag-utos sa akin. Hindi ko iyon sinunod.",
    official: "Kung kailangan mong tawagan ang opisina, gamitin ang numero sa opisyal na site ng iyong estado, hindi ang nasa sulat.",
    unread: "Hindi ko mabasa ang sulat sa larawan mo. Ipadala ulit na patag ang buong pahina at maliwanag, at susubukan ko ulit.",
    failed: "Hindi ko natapos basahin ang larawan mo ngayon. Ipadala ulit at susubukan ko ulit.",
    missedPart: "Hindi ko mabasa ang bahagi ng ipinadala mo. Ipadala ulit ang larawang iyon kung may isa pang sulat.",
    saved: (date) => `Na-save ko ang ${date} sa iyong mga deadline.`,
    passed: (date) => `Lumipas na ang ${date}, kaya walang paalalang ipapadala. Kung may mas bagong petsa mula sa opisina, ipadala mo sa akin.`,
    notSavedYet: (date) => `Hindi ko pa ma-save ang ${date} sa iyong mga deadline.`,
    notSavedNow: (date) => `Hindi ko ma-save ang ${date} sa iyong mga deadline ngayon.`,
    photoUnsaved: "Hindi ko na-save ang larawan mo, kaya hindi ko pa ito nabasa. Pakipadala ulit.",
  },
};
