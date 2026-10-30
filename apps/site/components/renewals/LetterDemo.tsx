"use client";
import { useState } from "react";
import Mascot from "@/components/Mascot";

/* A renewal letter and Mano's reply to a photo of it. Mano quotes the letter, asks before it holds the date, then
   texts a reminder. Pick a letter, tap to move the thread along. Every letter, office and person here is made up. */

type Letter = {
  key: string;
  tab: string;
  program: string;
  dear: string;
  quote: string;
  after: string;
  date: string;
  remind: [string, string];
};

const LETTERS: Letter[] = [
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

/* The thread grows one beat at a time; each beat names the button that brings in the next one. */
const BEATS = ["ask", "yes", "reminder"] as const;
const NEXT: Record<(typeof BEATS)[number], string> = { ask: "Reply yes", yes: "Skip to the reminder", reminder: "Start over" };

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

export default function LetterDemo() {
  const [li, setLi] = useState(0);
  const [beat, setBeat] = useState(0);
  const L = LETTERS[li];
  const pick = (n: number) => { setLi(n); setBeat(0); };
  const advance = () => setBeat((b) => (b + 1) % BEATS.length);

  return (
    <div className="rw-demo">
      <div className="rw-picks" role="group" aria-label="Pick a letter">
        {LETTERS.map((x, n) => (
          <button key={x.key} className="vt-pick" aria-pressed={n === li} onClick={() => pick(n)}>{x.tab}</button>
        ))}
      </div>

      <div className="rw-stage">
        <div className="rw-envelope">
          <div className="rw-paper" key={L.key}>
            <p className="rw-office">Sample County Human Services</p>
            <p className="rw-letter-h">Notice of renewal</p>
            <p className="rw-body">Dear Maria Lopez,</p>
            <p className="rw-body">{L.dear}</p>
            <p><mark className="rw-hl">{L.quote}</mark></p>
            <p className="rw-body">{L.after}</p>
            <span className="tr-lines" aria-hidden="true"><i /><i /><i /></span>
            <p className="rw-example">Example letter. Sample County is made up.</p>
          </div>
        </div>

        <div className="rw-thread" aria-live="polite" key={`t-${L.key}`}>
          <p className="sc-label">Text message</p>
          <div className="rw-photo rv" aria-label="Photo of the letter" role="img">
            <span>Notice of renewal</span><i /><i /><i />
          </div>
          <div className="bub-row rv" style={d(0.5)}>
            <Mascot tile tone="orange" size={30} className="bub-av" />
            <p className="bub mano">your letter says &ldquo;{L.quote}&rdquo; looks like {L.date}. want me to hold that date?</p>
          </div>
          {beat >= 1 && (
            <>
              <p className="bub me rv" style={d(0)}>yes</p>
              <div className="bub-row rv" style={d(0.6)}>
                <Mascot tile tone="orange" size={30} className="bub-av" />
                <p className="bub mano">holding {L.date}. i&rsquo;ll text you on {L.remind[0]} and again on {L.remind[1]}.</p>
              </div>
            </>
          )}
          {beat >= 2 && (
            <>
              <p className="sc-label rw-later rv" style={d(0)}>{L.remind[0]}, 9:00 AM</p>
              <div className="bub-row rv" style={d(0.4)}>
                <Mascot tile tone="orange" size={30} className="bub-av" />
                <p className="bub mano">reminder: your {L.program} renewal is due {L.date}. want me to fill out the form now? you check it before anything is sent.</p>
              </div>
            </>
          )}
          <button className="btn btn-primary rw-next" onClick={advance}>{NEXT[BEATS[beat]]}</button>
        </div>
      </div>
    </div>
  );
}
