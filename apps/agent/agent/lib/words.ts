// The sentences Mano says around an approval, without a model, in each
// language it has closed words for: the frame of the yes or no question
// and what comes back after the answer. Only the frame changes. The form's
// labels, the values, the office and the declaration stay in English and
// word for word, since they are what the yes approves. A language missing
// a line is a type error, never an English sentence in the middle of a reply.
import type { ReplyLanguage } from "@mano/mail";

export interface QuestionWords {
  ready(purpose: string, office: string): string;
  attached(label: string): string;
  // Opens the declaration, which follows in English, word for word.
  declares(meaning: string | null): string;
  answerWithDeclaration: string;
  answer: string;
  replay(url: string): string;
  // What the known declaration means. The English after it is what they make.
  perjuryMeaning: string;
}

export interface OutcomeWords {
  done(purpose: string, receipt: { externalId: string; simulated: boolean } | null | undefined): string;
  checking: string;
  checkStarting: string;
  unconfirmed: string;
  stale: string;
  updated: string;
  showLatest: string;
  refused: string;
  shareRefused: string;
  alreadyApproved: string;
  declined: string;
  expired: string;
  alreadySent(confirmation: string): string;
  retryNo: string;
  retryYes: string;
  unshown: string;
  changed: string;
  // Fallback name for a request whose purpose could not be read.
  yourRequest: string;
}

export const QUESTION_WORDS: Record<ReplyLanguage, QuestionWords> = {
  en: {
    ready: (purpose, office) => `Ready to send: ${purpose} (to ${office}).`,
    attached: (label) => `With ${label} attached.`,
    declares: () => "It ends with a declaration only you can make:",
    answerWithDeclaration: "Reply YES to make this declaration yourself and send exactly this, or NO to stop.",
    answer: "Reply YES to send exactly this, or NO to stop.",
    replay: (url) => `See each step Mano took on the form: ${url}`,
    perjuryMeaning: "",
  },
  es: {
    ready: (purpose, office) => `Listo para enviar: ${purpose} (a ${office}).`,
    attached: (label) => `Adjunto: ${label}.`,
    declares: (meaning) => `Termina con una declaración que solo usted puede hacer.${meaning ? ` ${meaning}` : ""} Así dice en inglés, igual que en el formulario:`,
    answerWithDeclaration: "Responda SÍ para hacer esta declaración usted y enviar exactamente esto, o NO para parar.",
    answer: "Responda SÍ para enviar exactamente esto, o NO para parar.",
    replay: (url) => `Vea cada paso que Mano hizo en el formulario: ${url}`,
    perjuryMeaning: "Significa que usted afirma, bajo pena de perjurio, que la información es verdadera, correcta y completa según su conocimiento.",
  },
  vi: {
    ready: (purpose, office) => `Sẵn sàng gửi: ${purpose} (đến ${office}).`,
    attached: (label) => `Đính kèm: ${label}.`,
    declares: (meaning) => `Đơn kết thúc bằng một lời khai mà chỉ bạn mới có thể đưa ra.${meaning ? ` ${meaning}` : ""} Lời khai bằng tiếng Anh, đúng như trên đơn:`,
    answerWithDeclaration: "Trả lời CÓ để tự bạn đưa ra lời khai này và gửi đúng nội dung trên, hoặc KHÔNG để dừng lại.",
    answer: "Trả lời CÓ để gửi đúng nội dung trên, hoặc KHÔNG để dừng lại.",
    replay: (url) => `Xem từng bước Mano đã làm trên đơn: ${url}`,
    perjuryMeaning: "Lời khai có nghĩa là bạn khẳng định, chịu hình phạt về tội khai man, rằng thông tin là đúng sự thật, chính xác và đầy đủ theo hiểu biết của bạn.",
  },
  tl: {
    ready: (purpose, office) => `Handa nang ipadala: ${purpose} (sa ${office}).`,
    attached: (label) => `Kalakip: ${label}.`,
    declares: (meaning) => `Nagtatapos ito sa isang pahayag na ikaw lang ang makakagawa.${meaning ? ` ${meaning}` : ""} Ganito ito sa Ingles, gaya ng nasa form:`,
    answerWithDeclaration: "Sumagot ng OPO para ikaw mismo ang gumawa ng pahayag na ito at ipadala ang eksaktong ito, o HINDI para huminto.",
    answer: "Sumagot ng OPO para ipadala ang eksaktong ito, o HINDI para huminto.",
    replay: (url) => `Tingnan ang bawat hakbang ni Mano sa form: ${url}`,
    perjuryMeaning: "Ibig sabihin, pinagtitibay mo, sa ilalim ng parusa ng perjury, na totoo, tama at kumpleto ang impormasyon ayon sa iyong kaalaman.",
  },
};

export const OUTCOME_WORDS: Record<ReplyLanguage, OutcomeWords> = {
  en: {
    done(purpose, receipt) {
      const label = receipt?.simulated ? " This was a simulated filing." : "";
      const confirmation = receipt ? ` Confirmation ${receipt.externalId}.` : "";
      return `Done. Sent: ${purpose}.${confirmation}${label}`;
    },
    checking: "I'm checking whether it went through. It will not be sent twice. Reply YES in a few minutes and I will check again.",
    checkStarting: "The safety check is taking a moment, so nothing was sent yet. Reply YES again in a few minutes and I will send it.",
    unconfirmed: "I could not confirm that went through, so I will not send it again on my own. If you want it sent, ask me to prepare it again and you can approve the new one.",
    stale: "That changed after you saw it, so nothing was sent. Want me to prepare it again?",
    updated: "I just updated that, so nothing was approved and nothing was sent.",
    showLatest: "Ask me to show the latest.",
    refused: "That approval can no longer be used, so nothing was sent. Want me to prepare it again?",
    shareRefused: "That did not go through, so nothing was sent.",
    alreadyApproved: "That one was already approved, so I cannot cancel it. I'm checking whether it went through. Reply YES and I will check again.",
    declined: "Okay, I did not send it. Nothing left Mano.",
    expired: "That request had already expired or changed, so nothing was sent.",
    alreadySent: (confirmation) => `That one was already sent, so I cannot cancel it. Confirmation ${confirmation}.`,
    retryNo: "I could not confirm that just now, so reply NO again to cancel it.",
    retryYes: "I could not confirm that just now. Reply YES again to retry; it will not be sent twice.",
    unshown: "I haven't shown you that one yet, so nothing was approved and nothing was sent. Ask me to show it again.",
    changed: "The question you answered changed since you saw it, so nothing was sent. Tell me what you want to send.",
    yourRequest: "your request",
  },
  es: {
    done(purpose, receipt) {
      const label = receipt?.simulated ? " Fue una presentación simulada." : "";
      const confirmation = receipt ? ` Confirmación ${receipt.externalId}.` : "";
      return `Listo. Enviado: ${purpose}.${confirmation}${label}`;
    },
    checking: "Estoy revisando si se envió. No se enviará dos veces. Responda SÍ en unos minutos y revisaré otra vez.",
    checkStarting: "La revisión de seguridad está tardando un momento, así que todavía no se envió nada. Responda SÍ otra vez en unos minutos y lo enviaré.",
    unconfirmed: "No pude confirmar que se envió, así que no lo enviaré otra vez por mi cuenta. Si quiere enviarlo, pídame prepararlo de nuevo y podrá aprobar el nuevo.",
    stale: "Eso cambió después de que lo vio, así que no se envió nada. ¿Quiere que lo prepare de nuevo?",
    updated: "Acabo de actualizar eso, así que no se aprobó nada y no se envió nada.",
    showLatest: "Pídame que le muestre lo más reciente.",
    refused: "Esa aprobación ya no se puede usar, así que no se envió nada. ¿Quiere que lo prepare de nuevo?",
    shareRefused: "Eso no se pudo hacer, así que no se envió nada.",
    alreadyApproved: "Eso ya estaba aprobado, así que no puedo cancelarlo. Estoy revisando si se envió. Responda SÍ y revisaré otra vez.",
    declined: "Bien, no lo envié. Nada salió de Mano.",
    expired: "Esa solicitud ya había vencido o cambiado, así que no se envió nada.",
    alreadySent: (confirmation) => `Eso ya se envió, así que no puedo cancelarlo. Confirmación ${confirmation}.`,
    retryNo: "No pude confirmarlo ahora, así que responda NO otra vez para cancelarlo.",
    retryYes: "No pude confirmarlo ahora. Responda SÍ otra vez para intentarlo; no se enviará dos veces.",
    unshown: "Todavía no le he mostrado eso, así que no se aprobó nada y no se envió nada. Pídame que se lo muestre otra vez.",
    changed: "La pregunta que respondió cambió desde que la vio, así que no se envió nada. Dígame qué quiere enviar.",
    yourRequest: "su solicitud",
  },
  vi: {
    done(purpose, receipt) {
      const label = receipt?.simulated ? " Đây là lần nộp mô phỏng." : "";
      const confirmation = receipt ? ` Mã xác nhận ${receipt.externalId}.` : "";
      return `Xong. Đã gửi: ${purpose}.${confirmation}${label}`;
    },
    checking: "Tôi đang kiểm tra xem đã gửi được chưa. Sẽ không gửi hai lần. Trả lời CÓ sau vài phút và tôi sẽ kiểm tra lại.",
    checkStarting: "Bước kiểm tra an toàn đang cần thêm chút thời gian, nên chưa có gì được gửi. Trả lời CÓ lại sau vài phút và tôi sẽ gửi.",
    unconfirmed: "Tôi không xác nhận được là đã gửi, nên tôi sẽ không tự gửi lại. Nếu bạn muốn gửi, hãy nhờ tôi chuẩn bị lại và bạn có thể duyệt bản mới.",
    stale: "Nội dung đã thay đổi sau khi bạn xem, nên chưa có gì được gửi. Bạn có muốn tôi chuẩn bị lại không?",
    updated: "Tôi vừa cập nhật nội dung đó, nên chưa có gì được duyệt và chưa có gì được gửi.",
    showLatest: "Hãy nhờ tôi cho xem bản mới nhất.",
    refused: "Lần duyệt đó không còn dùng được nữa, nên chưa có gì được gửi. Bạn có muốn tôi chuẩn bị lại không?",
    shareRefused: "Việc đó không thành công, nên chưa có gì được gửi.",
    alreadyApproved: "Nội dung đó đã được duyệt rồi, nên tôi không thể hủy. Tôi đang kiểm tra xem đã gửi được chưa. Trả lời CÓ và tôi sẽ kiểm tra lại.",
    declined: "Được, tôi không gửi. Không có gì rời khỏi Mano.",
    expired: "Yêu cầu đó đã hết hạn hoặc đã thay đổi, nên chưa có gì được gửi.",
    alreadySent: (confirmation) => `Nội dung đó đã được gửi rồi, nên tôi không thể hủy. Mã xác nhận ${confirmation}.`,
    retryNo: "Lúc này tôi không xác nhận được, nên hãy trả lời KHÔNG lần nữa để hủy.",
    retryYes: "Lúc này tôi không xác nhận được. Trả lời CÓ lần nữa để thử lại; sẽ không gửi hai lần.",
    unshown: "Tôi chưa cho bạn xem nội dung đó, nên chưa có gì được duyệt và chưa có gì được gửi. Hãy nhờ tôi cho xem lại.",
    changed: "Câu hỏi bạn trả lời đã thay đổi sau khi bạn xem, nên chưa có gì được gửi. Hãy cho tôi biết bạn muốn gửi gì.",
    yourRequest: "yêu cầu của bạn",
  },
  tl: {
    done(purpose, receipt) {
      const label = receipt?.simulated ? " Simulated na filing ito." : "";
      const confirmation = receipt ? ` Kumpirmasyon ${receipt.externalId}.` : "";
      return `Tapos na. Naipadala: ${purpose}.${confirmation}${label}`;
    },
    checking: "Tinitingnan ko kung naipadala ito. Hindi ito ipapadala nang dalawang beses. Sumagot ng OPO pagkalipas ng ilang minuto at titingnan ko ulit.",
    checkStarting: "Sandali pa ang safety check, kaya wala pang naipadala. Sumagot ulit ng OPO pagkalipas ng ilang minuto at ipapadala ko ito.",
    unconfirmed: "Hindi ko makumpirma na naipadala ito, kaya hindi ko ito ipapadala ulit nang kusa. Kung gusto mong ipadala, ipahanda mo ulit sa akin at maaprubahan mo ang bago.",
    stale: "Nagbago ito pagkatapos mong makita, kaya walang naipadala. Gusto mo bang ihanda ko ulit?",
    updated: "Kaka-update ko lang nito, kaya walang naaprubahan at walang naipadala.",
    showLatest: "Ipakita mo sa akin ang pinakabago kung gusto mo.",
    refused: "Hindi na magagamit ang pag-apruba na iyon, kaya walang naipadala. Gusto mo bang ihanda ko ulit?",
    shareRefused: "Hindi ito natuloy, kaya walang naipadala.",
    alreadyApproved: "Naaprubahan na iyon, kaya hindi ko na ito makakansela. Tinitingnan ko kung naipadala ito. Sumagot ng OPO at titingnan ko ulit.",
    declined: "Sige, hindi ko ipinadala. Walang lumabas mula kay Mano.",
    expired: "Nag-expire na o nagbago na ang request na iyon, kaya walang naipadala.",
    alreadySent: (confirmation) => `Naipadala na iyon, kaya hindi ko na ito makakansela. Kumpirmasyon ${confirmation}.`,
    retryNo: "Hindi ko makumpirma ngayon, kaya sumagot ulit ng HINDI para makansela ito.",
    retryYes: "Hindi ko makumpirma ngayon. Sumagot ulit ng OPO para subukan; hindi ito ipapadala nang dalawang beses.",
    unshown: "Hindi ko pa iyon naipapakita sa iyo, kaya walang naaprubahan at walang naipadala. Ipakita mo ulit sa akin kung gusto mo.",
    changed: "Nagbago ang tanong na sinagot mo mula nang makita mo ito, kaya walang naipadala. Sabihin mo sa akin kung ano ang gusto mong ipadala.",
    yourRequest: "ang iyong request",
  },
};
