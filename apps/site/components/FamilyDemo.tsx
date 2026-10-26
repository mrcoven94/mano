"use client";
import { useEffect, useRef, useState } from "react";
import Mascot from "./Mascot";
import { IPhone } from "./Devices";
import { useInView } from "./InView";

type Item = [title: string, detail: string];
type Step =
  | { who: "you"; text: string }
  | { who: "you"; letter: true }
  | { who: "mano"; text: string }
  | { who: "mano"; list: Item[] };

type Scenario = { id: string; tab: string; stat: string; sendAt: number; steps: Step[] };

/* Every person and place here is made up. sendAt is the step where the person says yes. */
const scenarios: Scenario[] = [
  {
    id: "food",
    tab: "Food help for a family of five",
    stat: "1 text, 4 applications",
    sendAt: 5,
    steps: [
      { who: "you", text: "I applied for food stamps for me and my 4 kids. Did it go through?" },
      { who: "mano", text: "It did. Sample County has it, and your interview is Tuesday at 10. I'll remind you Monday." },
      { who: "mano", text: "With 4 kids, your family likely qualifies for 3 more things. I filled them out from what you already told me:" },
      { who: "mano", list: [["Child care help", "Pays part of daycare while you work"], ["Free school meals", "Breakfast and lunch for all 4 kids"], ["Bus pass discount", "Half price for you"]] },
      { who: "mano", text: "Want me to send all 3?" },
      { who: "you", text: "Yes" },
      { who: "mano", text: "Sent. I'll text you as each one is approved." },
    ],
  },
  {
    id: "rent",
    tab: "Behind on rent",
    stat: "1 text, 3 applications",
    sendAt: 4,
    steps: [
      { who: "you", text: "I'm $640 short on rent this month." },
      { who: "mano", text: "Sample County has emergency rent help that covers it. Families who need rent help often qualify for help with the power bill too. Yours was $212 last month." },
      { who: "mano", list: [["Emergency rent help", "$640 for this month"], ["Energy bill help", "Toward your $212 bill"], ["Payment plan", "Spreads anything left over 6 months"]] },
      { who: "mano", text: "All 3 are filled out. Send them?" },
      { who: "you", text: "Send them" },
      { who: "mano", text: "Done. Want me to tell your landlord that help is on the way?" },
    ],
  },
  {
    id: "renew",
    tab: "Renew from a photo",
    stat: "1 photo, 0 forms to fill",
    sendAt: 5,
    steps: [
      { who: "you", letter: true },
      { who: "mano", text: "This is the health coverage renewal for you and the kids. It's due November 18." },
      { who: "mano", text: "I filled in all 4 pages from last year. One question: did your hours at work change since June?" },
      { who: "you", text: "No, same hours" },
      { who: "mano", list: [["Health coverage renewal", "4 pages, for you and 3 kids"]] },
      { who: "you", text: "Yes, send it" },
      { who: "mano", text: "Sent to Sample County. I'll remind you before the next one." },
    ],
  },
];

const TICK = 1150;

export default function FamilyDemo() {
  const [active, setActive] = useState(0);
  const s = scenarios[active];
  const [shown, setShown] = useState(s.steps.length);
  const [still, setStill] = useState(true);
  const [frame, seen] = useInView<HTMLDivElement>(0.3);
  const thread = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setStill(reduce);
    if (!reduce) setShown(0);
  }, []);

  useEffect(() => {
    if (still || !seen || shown >= s.steps.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 300 : TICK);
    return () => clearTimeout(t);
  }, [still, seen, shown, s.steps.length]);

  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: still ? "auto" : "smooth" });
  }, [shown, active, still]);

  const pick = (i: number) => { setActive(i); setShown(still ? scenarios[i].steps.length : 0); };
  const sent = shown > s.sendAt;
  const typing = !still && seen && shown < s.steps.length && s.steps[shown].who === "mano";

  return (
    <div className="demo" ref={frame}>
      <div className="demo-tabs" role="tablist" aria-label="Examples">
        {scenarios.map((x, i) => (
          <button key={x.id} role="tab" id={`tab-${x.id}`} aria-selected={i === active} aria-controls="demo-thread" className="demo-tab" onClick={() => pick(i)}>
            <span className="demo-tab-title">{x.tab}</span>
            <span className="demo-tab-stat">{x.stat}</span>
          </button>
        ))}
      </div>

      <div className="demo-stage">
      <IPhone>
        <div className="im-head">
          <span className="im-back" aria-hidden="true">‹</span>
          <span className="im-who"><Mascot size={44} tile tone="orange" /><small>Mano ›</small></span>
          {!still ? (
            <button className="replay" onClick={() => setShown(0)} aria-label="Play this example again">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" /></svg>
            </button>
          ) : <span />}
        </div>
        <ol className="thread" id="demo-thread" role="tabpanel" aria-labelledby={`tab-${s.id}`} ref={thread}>
          {s.steps.slice(0, shown).map((m, i) => (
            <li key={`${s.id}-${i}`} className={`msg ${m.who}${"list" in m ? " has-list" : ""}`}>
              {"letter" in m ? (
                <div className="letter-photo" role="img" aria-label="Photo of a letter from Sample County Human Services, renewal due November 18">
                  <span className="lp-org">Sample County Human Services</span>
                  <span className="lp-line" /><span className="lp-line short" />
                  <span className="lp-due">Renew by Nov 18</span>
                  <span className="lp-line" /><span className="lp-line" /><span className="lp-line short" />
                </div>
              ) : "list" in m ? (
                <ul className="checklist">
                  {m.list.map(([t, d], k) => (
                    <li key={t} style={{ "--k": k } as React.CSSProperties}>
                      <span className="cl-text"><strong>{t}</strong><small>{d}</small></span>
                      <span className={`state${sent ? " is-sent" : ""}`}>{sent ? "Sent" : "Ready"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{m.text}</p>
              )}
            </li>
          ))}
          {typing && <li className="msg mano typing" aria-hidden="true"><span /><span /><span /></li>}
        </ol>
        <div className="im-input" aria-hidden="true"><span className="im-plus">+</span><span className="im-field">iMessage</span></div>
      </IPhone>
      <p className="note-pin n1" aria-hidden="true"><span>Note</span>Mano spots the help that comes with what you asked for.</p>
      <p className="note-pin n2" aria-hidden="true"><span>Note</span>Nothing is sent until you say yes.</p>
      </div>
    </div>
  );
}
