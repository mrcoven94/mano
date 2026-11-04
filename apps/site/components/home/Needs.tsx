"use client";
import { useState } from "react";
import { NeedIcon, NEED_TINT } from "./NeedIcons";

/* The benefits Mano covers, as stickers. Pick a need to see a text a person might send, what works today and what is
   coming. "today" lists only what the code does: one form (food-renewal in apps/agent/agent/lib/forms.ts), program facts
   from packages/programs, and letters and deadlines for anything else. Every message here is made up. */

const READS = "Reads your letter and looks for the date that matters";
const KEEPS = "After you say so, keeps the date and texts you before it";

const TILT = [-2, 1.5, -1, 2, -1.5, 1];
const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

type Need = { key: string; name: string; short: string; ask: string; today: string[]; coming: string[] };

const NEEDS: Need[] = [
  {
    key: "food", name: "Food and EBT", short: "Renewal by text, on a practice portal",
    ask: "Got a letter. My food benefits are ending?",
    today: [READS, "Fills out your food benefits renewal by text and files it after your yes, on a practice portal, not a real office", "Answers questions about SNAP in eight states"],
    coming: ["Filing with a real office", "New food benefits applications"],
  },
  {
    key: "rent", name: "Rent", short: "Reads your notice. Forms coming soon",
    ask: "I got a late notice. Rent is $1,150 and I'm $400 short.",
    today: ["Reads your notice and looks for the date that matters", KEEPS],
    coming: ["Filling out rent help forms", "Answers about rent help programs"],
  },
  {
    key: "medicine", name: "Health care and medicine", short: "Answers and letters. Forms coming soon",
    ask: "Is my health coverage ending?",
    today: [READS, KEEPS, "Answers questions about Medicaid in eight states"],
    coming: ["Filling out health coverage forms", "Help with prescriptions and doctor visits"],
  },
  {
    key: "childcare", name: "Child care", short: "Reads your letter. Forms coming soon",
    ask: "Got a letter about our daycare help.",
    today: [READS, KEEPS],
    coming: ["Filling out child care forms", "Answers about child care programs"],
  },
  {
    key: "bills", name: "Light and water bills", short: "Answers and notices. Forms coming soon",
    ask: "The power company sent a notice about my bill.",
    today: ["Reads your notice and looks for the date that matters", KEEPS, "Answers questions about energy bill help in eight states"],
    coming: ["Filling out bill help forms", "Answers about help with water bills"],
  },
  {
    key: "transport", name: "Transportation", short: "Coming soon",
    ask: "I need a ride to my doctor visits.",
    today: [],
    coming: ["Answers about transportation help", "Filling out transportation forms"],
  },
];

function Check() {
  return (
    <svg className="sc-tick" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.4l2.9 2.8 6-6.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Needs() {
  const [i, setI] = useState(0);
  const n = NEEDS[i];

  return (
    <div className="nd">
      <div className="h-head">
        <h2 id="nd-h">What do you need help with?</h2>
        <p className="lede">Tell Mano what is going on in your own words. Pick one to see what works today and what is coming. The only form Mano files today is the food benefits renewal, and only on a practice portal. The office that runs a program decides if you qualify, never Mano.</p>
        <p className="nd-danger">If anyone is in danger, call 911.</p>
      </div>

      <div className="nd-grid">
        <div className="nd-list" role="group" aria-label="What you need help with">
          {NEEDS.map((x, k) => (
            <button key={x.key} className="nd-pick" aria-pressed={k === i} onClick={() => setI(k)} style={{ "--tint": NEED_TINT[x.key], "--tilt": `${TILT[k]}deg` } as React.CSSProperties}>
              <NeedIcon k={x.key} size={64} />
              <strong>{x.name}</strong>
              <span>{x.short}</span>
            </button>
          ))}
        </div>

        <div className="nd-stage" aria-live="polite">
          <div className="nd-panel" key={n.key}>
            <p className="sc-label">Text message</p>
            <p className="bub me rv" style={d(0.05)}>{n.ask}</p>
            <p className="sc-label rv" style={d(0.6)}>Works today</p>
            {n.today.length ? (
              <ul className="nd-steps rv" style={d(0.6)}>
                {n.today.map((s) => <li key={s}><Check />{s}</li>)}
              </ul>
            ) : (
              <p className="nd-none rv" style={d(0.6)}>Nothing yet. Mano has no transportation programs on file.</p>
            )}
            <p className="sc-label rv" style={d(1)}>Coming soon</p>
            <ul className="nd-soon rv" style={d(1)}>
              {n.coming.map((s) => <li key={s}>{s}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
