// Recorded synthetic responses for the stand-in engine: Maria's spine
// run. Every person, letter and office here is invented for the demo.
// Real resident content never touches this file.

export const MARIA = {
  personId: "maria-001",
  displayName: "Maria Torres",
  email: "maria.torres@example.com",
} as const;

export const GREETING =
  "Hi Maria, I am your Mano agent. Photograph your mail and I will read it, track your deadlines and fill out forms for your approval. Nothing is ever sent without you.";

export const MAIL_REPLY =
  "I found 2 letters in your photos.\n\n" +
  "1. SNAP renewal notice from Springfield County. Your renewal is due November 15. I filled out the renewal from your last application; it is waiting in Approvals.\n\n" +
  "2. Electricity bill, $84.20, due November 8.\n\n" +
  "Both are now on your deadlines list.";

export const APPROVE_FOLLOWUP =
  "Your renewal is on its way to the Springfield County SNAP office. I will watch for their answer.";

export const CASEWORKER_REQUEST =
  "Springfield County wrote back. They are missing one thing: a pay stub from the last 30 days. They need it by November 12. Photograph it and I will send it with your case number.";

export const PAYSTUB_REPLY =
  "Got it. I sent your pay stub to the Springfield County SNAP office with case R-1042.";

export const APPROVED_NOTICE =
  "Good news: the county approved your renewal. Your benefits continue without a gap. I saved their notice in Documents.";

export const FALLBACK_REPLY =
  "I can read your mail, track deadlines, fill out forms for your approval and send documents to offices you choose. Photograph your mail to start, or ask me about your deadlines.";

export function deadlinesReply(count: number): string {
  return count === 0
    ? "You have no deadlines right now. Photograph your mail and I will build the list."
    : `You have ${count} upcoming deadline${count === 1 ? "" : "s"}. Open Deadlines to see each one.`;
}

export function approvalsReply(pending: number): string {
  return pending === 0
    ? "Nothing is waiting for your approval right now."
    : `You have ${pending} thing${pending === 1 ? "" : "s"} waiting in Approvals. Each one shows exactly what will be sent before you approve it.`;
}

// The exact renewal packet the approval binds to. The stand-in hashes
// these bytes at runtime, exactly like the engine hashes stored bytes.
export function renewalPacketText(): string {
  return (
    "SNAP RENEWAL PACKET - CASE R-1042\n" +
    "Springfield County SNAP Office\n" +
    "Prepared by Mano for Maria Torres, for her approval.\n" +
    "\n" +
    "Applicant: Maria Torres\n" +
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
    "Signature: Maria Torres (signed in the app on approval)\n" +
    "Date: at approval time\n"
  );
}

export function approvalNoticeText(): string {
  return (
    "SPRINGFIELD COUNTY SNAP OFFICE\n" +
    "Notice of approval - case R-1042\n" +
    "\n" +
    "Maria Torres,\n" +
    "Your SNAP renewal is approved. Your benefits continue with no gap.\n" +
    "Next renewal: November 2027.\n" +
    "\n" +
    "(Synthetic notice for the Mano demo.)\n"
  );
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
