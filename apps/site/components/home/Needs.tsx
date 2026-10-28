"use client";
import { useState } from "react";
import Mascot from "@/components/Mascot";
import { NeedIcon, NEED_TINT } from "./NeedIcons";

/* What people come to Mano for, as stickers. Pick a need to see the text a person sends, what Mano does and what they end up with.
   Every message here is made up. */

const TILT = [-2, 1.5, -1, 2, -1.5, 1, -2.5, 1.5, -1];
const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

const NEEDS = [
  {
    key: "rent", name: "Pay rent", short: "Help before the late fee",
    ask: "I got a late notice. Rent is $1,150 and I'm $400 short.",
    steps: ["Applies for emergency rent help in your county", "Drafts a note asking your landlord for more time", "Tracks the date on the notice so nothing is missed"],
    get: "An application for rent help and a reply to your landlord, this week.",
  },
  {
    key: "food", name: "Food and EBT", short: "Groceries this week",
    ask: "We're out of groceries and I don't get paid until Friday.",
    steps: ["Finds a food pantry open tonight near you", "Applies for food benefits on an EBT card, and free school meals", "Renews your benefits before they stop"],
    get: "Food tonight, and benefits on your EBT card every month if you're approved.",
  },
  {
    key: "bills", name: "Light and water bills", short: "Keep the lights on",
    ask: "The power company sent a shutoff notice, and the water bill is late too.",
    steps: ["Reads both notices and finds the shutoff dates", "Applies for help paying your power and water bills", "Calls the power company for a payment plan and waits on hold"],
    get: "A payment plan and bill help applications in before the shutoff date.",
  },
  {
    key: "medicine", name: "Medicine and care", short: "Prescriptions and doctor visits",
    ask: "My prescription went from $15 to $240, and I don't have a doctor.",
    steps: ["Reads your coverage letter to see what changed", "Applies for health coverage and help paying for prescriptions", "Finds a clinic that charges by income and books a visit"],
    get: "Your medicine at a price you can pay, and a doctor you can see.",
  },
  {
    key: "childcare", name: "Child care", short: "Daycare while you work",
    ask: "I start a new job Monday and need daycare for my two kids.",
    steps: ["Finds licensed providers near your work with open spots", "Fills out the child care assistance form", "Sends the provider your approval once it comes"],
    get: "A daycare spot, and help paying for it.",
  },
  {
    key: "housing", name: "Housing", short: "Stay in a home you can afford",
    ask: "Our lease ends in March and we can't afford to renew.",
    steps: ["Puts you on every housing waitlist you qualify for", "Keeps each spot active so you don't get dropped", "Tells you when a unit opens and fills out the application"],
    get: "Your name on every list, kept active until a place opens.",
  },
  {
    key: "credit", name: "Credit", short: "Fix errors, build it back",
    ask: "I got turned down for an apartment because of my credit.",
    steps: ["Gets your free credit report and finds mistakes", "Writes the disputes for you to approve and send", "Reminds you before each bill is due"],
    get: "Mistakes disputed, and bills paid on time from here on.",
  },
  {
    key: "programs", name: "Government programs", short: "Everything you qualify for",
    ask: "It's me and my two kids. What help can we get?",
    steps: ["Checks every program you might qualify for from one conversation", "Applies to the ones you pick, all at once", "Tracks every decision and renewal date"],
    get: "Every program you qualify for, applied to in one sitting.",
  },
  {
    key: "now", name: "Get help now", short: "When it can't wait",
    ask: "My car broke down, I missed two shifts and we have $20 until Friday.",
    steps: ["Finds emergency cash help and food you can get today", "Calls ahead so you know they're open and what to bring", "Applies for longer-term help so next month is easier"],
    get: "Help today, and a plan for next month.",
  },
] as const;

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
        <p className="lede">Tell Mano what is going on in your own words. It finds the help you qualify for, applies and keeps it coming, so the bills get paid and you stay in your home. Pick one to see how.</p>
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
            <div className="bub-row rv" style={d(0.6)}>
              <Mascot tile tone="orange" size={30} className="bub-av" />
              <p className="bub mano">I can help with that. Here is what I&rsquo;ll do, and I&rsquo;ll check with you before anything is sent.</p>
            </div>
            <ul className="nd-steps">
              {n.steps.map((s, k) => (
                <li key={s} className="rv" style={d(1.1 + k * 0.35)}><Check />{s}</li>
              ))}
            </ul>
            <div className="nd-get rv" style={d(2.3)}>
              <span className="sc-label">What you get</span>
              <p><mark style={d(2.5)}>{n.get}</mark></p>
            </div>
            {n.key === "now" && <p className="nd-small rv" style={d(2.6)}>If anyone is in danger, call 911.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
