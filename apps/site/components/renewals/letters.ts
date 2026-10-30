/* The sample renewal letters on /renewals. Every letter, office and person here is made up. */

export type Letter = {
  key: string;
  tab: string;
  program: string;
  dear: string;
  quote: string;
  after: string;
  date: string;
  remind: [string, string];
};

export const LETTERS: Letter[] = [
  {
    key: "food", tab: "Food benefits", program: "food benefits",
    dear: "Your food benefits end on December 31. To keep them, complete the enclosed renewal form and return it with proof of income.",
    quote: "Return your signed form by December 5, 2026.",
    after: "If we do not receive it, your benefits will stop.",
    date: "Dec 5", remind: ["Nov 28", "Dec 4"],
  },
  {
    key: "health", tab: "Health coverage", program: "health coverage",
    dear: "It is time to renew your health coverage. Please review the enclosed form, correct anything that changed and sign it.",
    quote: "Send your renewal form by January 15, 2027.",
    after: "If we do not receive it, your coverage will end on January 31, 2027.",
    date: "Jan 15", remind: ["Jan 8", "Jan 14"],
  },
  {
    key: "power", tab: "Power bill help", program: "power bill help",
    dear: "Your energy assistance credit is ending. Households that still qualify can reapply for the winter season.",
    quote: "Reapply by November 20, 2026 to keep your winter credit.",
    after: "Late applications are reviewed only if funds remain.",
    date: "Nov 20", remind: ["Nov 13", "Nov 19"],
  },
];

/* Mano's first reply to a photo of the letter: quote it, name the date, ask before holding it. */
export const askText = (L: Letter) => `your letter says \u201c${L.quote}\u201d looks like ${L.date}. want me to hold that date?`;
