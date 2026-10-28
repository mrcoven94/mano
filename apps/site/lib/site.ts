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

/* The web app, from config. Set NEXT_PUBLIC_APP_URL (for example https://app.example.org) once it is live; until
   then the sign up and sign in buttons ask for early access by email. */
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
export const EARLY_HREF = "mailto:hello@withmano.com?subject=Mano%20early%20access";
export const SIGN_UP_HREF = APP_URL ? `${APP_URL}/sign-up` : EARLY_HREF;
export const SIGN_IN_HREF = APP_URL ? `${APP_URL}/sign-in` : EARLY_HREF;
