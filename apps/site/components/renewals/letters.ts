/* The sample renewal letters on /renewals. Every letter, office and person here is made up. */

export type Letter = {
  key: string;
  tab: string;
  program: string;
  office: string;
  dear: string;
  quote: string;
  after: string;
  date: string;
  remind: [string, string];
};

export const LETTERS: Letter[] = [
  {
    key: "food", tab: "Food benefits", program: "food benefits",
    office: "Springfield County Food Assistance Office",
    dear: "Re: SNAP renewal. Case R-1042.",
    quote: "Your renewal is due November 14, 2026.",
    after: "Send the signed renewal form and proof of income. Late forms stop benefits.",
    date: "Nov 14", remind: ["Nov 7", "Nov 12"],
  },
  {
    key: "health", tab: "Health coverage", program: "health coverage",
    office: "Springfield County Human Services",
    dear: "It is time to renew your health coverage. Please review the enclosed form, correct anything that changed and sign it.",
    quote: "Send your renewal form by January 15, 2027.",
    after: "If we do not receive it, your coverage will end on January 31, 2027.",
    date: "Jan 15", remind: ["Jan 8", "Jan 13"],
  },
  {
    key: "power", tab: "Power bill help", program: "power bill help",
    office: "Springfield Power",
    dear: "Your energy assistance credit is ending. Households that still qualify can reapply for the winter season.",
    quote: "Reapply by November 20, 2026 to keep your winter credit.",
    after: "Late applications are reviewed only if funds remain.",
    date: "Nov 20", remind: ["Nov 13", "Nov 18"],
  },
];

/* Mano's first reply to a photo of the letter: quote it, name the date, ask before holding it. */
export const askText = (L: Letter) => `your letter says \u201c${L.quote}\u201d looks like ${L.date}. want me to hold that date?`;
