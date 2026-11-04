// Every sentence Mano says about a letter, in each language it can say it
// in without a model. These are closed words: the reply is built from
// them and from closed fields, so a date or a warning reads the same in
// every language and no letter text gets in. A language missing a line is
// a type error, never an English sentence in the middle of a reply.
import type { LetterType, SendCategory } from "./answer.js";
import type { DocumentKind } from "./types.js";

export const REPLY_LANGUAGES = ["en", "es", "vi", "tl"] as const;
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];

export interface AnswerWords {
  date(iso: string): string;
  and: string;
  // How a letter with no program on Mano's list is named.
  benefits: string;
  letterType: Record<LetterType, (program: string) => string>;
  // What a document is when it is not a benefits letter, and that it was read.
  documentKind: Record<Exclude<DocumentKind, "benefits_letter">, string>;
  categories: Record<SendCategory, string>;
  due(date: string): string;
  nextDue(kind: "renewal" | "recertification", date: string): string;
  asksToSend(list: string): string;
  askDate(date: string): string;
  severalDates: string;
  // In a pile, for a letter with no date in its text and no open question.
  noDateFound: string;
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
  // A date the gate did not hold, named for the person to check.
  dueLooks: Record<"renewal" | "documents" | "payment" | "deadline", (date: string) => string>;
  dueFor: Record<"renewal" | "documents" | "payment" | "deadline", string>;
  checkDate: string;
  twoDates(first: string, firstFor: string, second: string, secondFor: string): string;
  alsoInterview(date: string): string;
  askRequest(date: string): string;
  askWindow(days: number, from: string, result: string): string;
  notYours: string;
  askAnyDate: string;
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
    noDateFound: "I did not find a date to meet in this one.",
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
    dueLooks: {
      renewal: (date) => `It looks like your renewal is due ${date}.`,
      documents: (date) => `It looks like the papers it asks for are due ${date}.`,
      payment: (date) => `It looks like your payment is due ${date}.`,
      deadline: (date) => `It looks like your deadline is ${date}.`,
    },
    dueFor: { renewal: "your renewal", documents: "the papers it asks for", payment: "your payment", deadline: "something it asks you to do" },
    checkDate: "Please check that against your letter. Is that the date you need to meet?",
    twoDates: (first, firstFor, second, secondFor) => `Your letter gives two dates: ${first} for ${firstFor}, and ${second} for ${secondFor}. Please check them against your letter. Which one do you need to meet first?`,
    alsoInterview: (date) => `It also lists an interview on ${date}.`,
    askRequest: (date) => `It looks like the date to send your request is ${date}. Please check that against your letter. Is that what it says?`,
    askWindow: (days, from, result) => `It looks like you have ${days} days from ${from}, which would be ${result}. Please check that against your letter. Is that what it says?`,
    notYours: "Something on this letter says it may be for someone else or may no longer apply, so I am not treating its dates as yours. Is this letter for you, and is it still current?",
    askAnyDate: "I don't want to guess wrong about the date on this letter. Which date, if any, does it say you need to meet?",
    official: "If you need to call the office, use the number on your state's official site, not one from a letter.",
    documentKind: {
      pay_stub: "This looks like a pay stub, and I could read it.",
      utility_bill: "This looks like a utility bill, and I could read it.",
      id: "This looks like an ID, and I could read it.",
      unknown: "I could read this, but I cannot tell what kind of document it is.",
    },
    unread: "I could not read the page in your photo. Send it again with the whole page flat, in good light, and I will try once more.",
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
    noDateFound: "No encontré una fecha que deba cumplir en esta.",
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
    dueLooks: {
      renewal: (date) => `Parece que su renovación vence el ${date}.`,
      documents: (date) => `Parece que los documentos que pide vencen el ${date}.`,
      payment: (date) => `Parece que su pago vence el ${date}.`,
      deadline: (date) => `Parece que su fecha límite es el ${date}.`,
    },
    dueFor: { renewal: "su renovación", documents: "los documentos que pide", payment: "su pago", deadline: "algo que le pide hacer" },
    checkDate: "Compruébelo en su carta, por favor. ¿Es esa la fecha que debe cumplir?",
    twoDates: (first, firstFor, second, secondFor) => `Su carta da dos fechas: el ${first} para ${firstFor}, y el ${second} para ${secondFor}. Compruébelas en su carta, por favor. ¿Cuál debe cumplir primero?`,
    alsoInterview: (date) => `También indica una entrevista el ${date}.`,
    askRequest: (date) => `Parece que la fecha para enviar su solicitud es el ${date}. Compruébelo en su carta, por favor. ¿Es eso lo que dice?`,
    askWindow: (days, from, result) => `Parece que tiene ${days} días a partir del ${from}, es decir, hasta el ${result}. Compruébelo en su carta, por favor. ¿Es eso lo que dice?`,
    notYours: "Algo en esta carta indica que puede ser para otra persona o que ya no aplica, así que no tomo sus fechas como suyas. ¿Esta carta es para usted y sigue vigente?",
    askAnyDate: "No quiero equivocarme con la fecha de esta carta. ¿Qué fecha, si hay alguna, dice que debe cumplir?",
    official: "Si necesita llamar a la oficina, use el número del sitio oficial de su estado, no uno de una carta.",
    documentKind: {
      pay_stub: "Parece un talón de pago, y pude leerlo.",
      utility_bill: "Parece una factura de servicios, y pude leerla.",
      id: "Parece una identificación, y pude leerla.",
      unknown: "Pude leer esto, pero no sé qué tipo de documento es.",
    },
    unread: "No pude leer la página de su foto. Envíela de nuevo con toda la página plana y con buena luz, y lo intentaré otra vez.",
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
    noDateFound: "Tôi không thấy ngày nào cần kịp trong thư này.",
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
    dueLooks: {
      renewal: (date) => `Có vẻ việc gia hạn của bạn đến hạn ${date}.`,
      documents: (date) => `Có vẻ các giấy tờ thư yêu cầu đến hạn ${date}.`,
      payment: (date) => `Có vẻ khoản thanh toán của bạn đến hạn ${date}.`,
      deadline: (date) => `Có vẻ hạn chót của bạn là ${date}.`,
    },
    dueFor: { renewal: "việc gia hạn", documents: "các giấy tờ thư yêu cầu", payment: "khoản thanh toán", deadline: "một việc thư yêu cầu" },
    checkDate: "Vui lòng đối chiếu với thư của bạn. Đó có phải là ngày bạn cần kịp không?",
    twoDates: (first, firstFor, second, secondFor) => `Thư của bạn có hai ngày: ${first} cho ${firstFor}, và ${second} cho ${secondFor}. Vui lòng đối chiếu với thư của bạn. Bạn cần kịp ngày nào trước?`,
    alsoInterview: (date) => `Thư cũng ghi một cuộc phỏng vấn vào ${date}.`,
    askRequest: (date) => `Có vẻ hạn gửi yêu cầu của bạn là ${date}. Vui lòng đối chiếu với thư của bạn. Thư có nói vậy không?`,
    askWindow: (days, from, result) => `Có vẻ bạn có ${days} ngày kể từ ${from}, tức là đến ${result}. Vui lòng đối chiếu với thư của bạn. Thư có nói vậy không?`,
    notYours: "Có chỗ trong thư cho thấy thư này có thể dành cho người khác hoặc không còn áp dụng, nên tôi không coi các ngày trong thư là của bạn. Thư này có phải cho bạn và vẫn còn hiệu lực không?",
    askAnyDate: "Tôi không muốn đoán sai ngày trong thư này. Thư nói bạn cần kịp ngày nào, nếu có?",
    official: "Nếu cần gọi văn phòng, hãy dùng số trên trang web chính thức của tiểu bang, không dùng số trong thư.",
    documentKind: {
      pay_stub: "Đây có vẻ là phiếu lương, và tôi đã đọc được.",
      utility_bill: "Đây có vẻ là hóa đơn tiện ích, và tôi đã đọc được.",
      id: "Đây có vẻ là giấy tờ tùy thân, và tôi đã đọc được.",
      unknown: "Tôi đọc được, nhưng không biết đây là loại giấy tờ gì.",
    },
    unread: "Tôi không đọc được trang trong ảnh của bạn. Hãy gửi lại, để cả trang phẳng, đủ sáng, và tôi sẽ thử lại.",
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
    noDateFound: "Wala akong nakitang petsang dapat habulin sa sulat na ito.",
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
    dueLooks: {
      renewal: (date) => `Mukhang ${date} ang huling araw ng pag-renew mo.`,
      documents: (date) => `Mukhang ${date} ang huling araw ng mga papel na hinihingi nito.`,
      payment: (date) => `Mukhang ${date} ang huling araw ng bayad mo.`,
      deadline: (date) => `Mukhang ${date} ang huling araw mo.`,
    },
    dueFor: { renewal: "pag-renew mo", documents: "mga papel na hinihingi nito", payment: "bayad mo", deadline: "isang bagay na hinihingi nito" },
    checkDate: "Pakitingnan ito sa sulat mo. Iyon ba ang petsang dapat mong habulin?",
    twoDates: (first, firstFor, second, secondFor) => `Dalawang petsa ang nasa sulat mo: ${first} para sa ${firstFor}, at ${second} para sa ${secondFor}. Pakitingnan ang mga ito sa sulat mo. Alin ang dapat mong habulin muna?`,
    alsoInterview: (date) => `May nakalista rin itong interview sa ${date}.`,
    askRequest: (date) => `Mukhang ${date} ang huling araw para ipadala ang hiling mo. Pakitingnan ito sa sulat mo. Iyon ba ang sinasabi nito?`,
    askWindow: (days, from, result) => `Mukhang may ${days} araw ka mula ${from}, ibig sabihin hanggang ${result}. Pakitingnan ito sa sulat mo. Iyon ba ang sinasabi nito?`,
    notYours: "May nakasaad sa sulat na maaaring para ito sa iba o hindi na ito naaangkop, kaya hindi ko itinuturing na iyo ang mga petsa nito. Para sa iyo ba ang sulat na ito, at kasalukuyan pa ba ito?",
    askAnyDate: "Ayokong magkamali sa petsa sa sulat na ito. Aling petsa, kung mayroon, ang sinasabi nitong dapat mong habulin?",
    official: "Kung kailangan mong tawagan ang opisina, gamitin ang numero sa opisyal na site ng iyong estado, hindi ang nasa sulat.",
    documentKind: {
      pay_stub: "Mukhang pay stub ito, at nabasa ko.",
      utility_bill: "Mukhang utility bill ito, at nabasa ko.",
      id: "Mukhang ID ito, at nabasa ko.",
      unknown: "Nabasa ko ito, pero hindi ko masabi kung anong uri ng dokumento ito.",
    },
    unread: "Hindi ko mabasa ang pahina sa larawan mo. Ipadala ulit na patag ang buong pahina at maliwanag, at susubukan ko ulit.",
    failed: "Hindi ko natapos basahin ang larawan mo ngayon. Ipadala ulit at susubukan ko ulit.",
    missedPart: "Hindi ko mabasa ang bahagi ng ipinadala mo. Ipadala ulit ang larawang iyon kung may isa pang sulat.",
    saved: (date) => `Na-save ko ang ${date} sa iyong mga deadline.`,
    passed: (date) => `Lumipas na ang ${date}, kaya walang paalalang ipapadala. Kung may mas bagong petsa mula sa opisina, ipadala mo sa akin.`,
    notSavedYet: (date) => `Hindi ko pa ma-save ang ${date} sa iyong mga deadline.`,
    notSavedNow: (date) => `Hindi ko ma-save ang ${date} sa iyong mga deadline ngayon.`,
    photoUnsaved: "Hindi ko na-save ang larawan mo, kaya hindi ko pa ito nabasa. Pakipadala ulit.",
  },
};
