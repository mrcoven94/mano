/* The number people text Mano at comes from config. Set NEXT_PUBLIC_SMS_NUMBER to a US number with its country
   code (for example +18015550100). Without it the site shows a number reserved for fiction and says so. */
const RAW = (process.env.NEXT_PUBLIC_SMS_NUMBER ?? "").replace(/[^\d+]/g, "");
const LIVE = /^\+1\d{10}$/.test(RAW);
const E164 = LIVE ? RAW : "+15550100147";
const DIGITS = E164.slice(2);

export const SMS_NUMBER = `(${DIGITS.slice(0, 3)}) ${DIGITS.slice(3, 6)}-${DIGITS.slice(6)}`;
export const SMS_HREF = `sms:${E164}`;
export const SMS_IS_PLACEHOLDER = !LIVE;
export const PLACEHOLDER_NOTE = LIVE ? "" : `Placeholder number ${SMS_NUMBER} until launch`;
export const REPO_URL = "https://github.com/mrcoven94/mano";
