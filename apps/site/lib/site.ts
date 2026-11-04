/* The number people text Mano at comes from config. Set NEXT_PUBLIC_SMS_NUMBER to a US number with its country
   code (for example +18015550100). Without it the site shows a number reserved for fiction and says so. */
const RAW = (process.env.NEXT_PUBLIC_SMS_NUMBER ?? "").replace(/[^\d+]/g, "");
const LIVE = /^\+1\d{10}$/.test(RAW);
const E164 = LIVE ? RAW : "+15550100147";
const DIGITS = E164.slice(2);

export const SMS_NUMBER = `(${DIGITS.slice(0, 3)}) ${DIGITS.slice(3, 6)}-${DIGITS.slice(6)}`;
/* ?&body opens Messages with the text filled in on iPhone and Android. */
export const smsHref = (body: string) => `sms:${E164}?&body=${encodeURIComponent(body)}`;
export const SMS_HREF = smsHref("Hi Mano");
export const SMS_IS_PLACEHOLDER = !LIVE;
export const PLACEHOLDER_NOTE = LIVE ? "" : `Placeholder number ${SMS_NUMBER} until launch`;
export const REPO_URL = "https://github.com/mrcoven94/mano";
export const ISSUES_URL = `${REPO_URL}/issues`;

/* The web app, from config. Set NEXT_PUBLIC_APP_URL (for example https://app.example.org) once it is live; until
   then sign up and sign in point to the project's public GitHub issues. */
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
export const EARLY_HREF = ISSUES_URL;
export const SIGN_UP_HREF = APP_URL ? `${APP_URL}/sign-up` : EARLY_HREF;
export const SIGN_IN_HREF = APP_URL ? `${APP_URL}/sign-in` : EARLY_HREF;

/* The renewal banner remembers a dismissal under this key and hides itself while <html> carries this attribute. */
export const BANNER_KEY = "mano-renewal-banner";
export const BANNER_ATTR = "data-rb-off";
