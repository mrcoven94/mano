"use client";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import Mascot from "./Mascot";
import { Browser, IPhone } from "./Devices";
import { useInView } from "./InView";

/* Three live demos of Mano working: filling an application, searching for programs, waiting on hold.
   Each one plays from a single clock (ms since it started). Everyone and everything shown is made up. */

const DURATION = 11000;
const at = (t: number, ms: number) => t >= ms;
const typed = (t: number, start: number, text: string, cps = 28) => text.slice(0, Math.max(0, Math.floor(((t - start) / 1000) * cps)));

const fields: [label: string, value: string, start: number][] = [
  ["Full name", "Maria Lopez", 600],
  ["People in your household", "5", 1500],
  ["Monthly income", "$2,840", 2200],
  ["Children under 13", "4", 3000],
  ["Employer", "Sample Grocery", 3600],
];
const papers: [name: string, start: number][] = [["Pay stub, March", 5000], ["Pay stub, April", 5600], ["Lease", 6200]];

function ApplyDemo({ t }: { t: number }) {
  const filled = fields.filter(([, v, s]) => typed(t, s, v).length === v.length).length;
  return (
    <Browser url="apply.samplecounty.example" className="wm-browser">
      <div className="wm-form">
        <div className="wm-form-main">
          <p className="wm-kicker">Sample County</p>
          <h4>Child care assistance application</h4>
          {fields.map(([label, value, start]) => {
            const v = typed(t, start, value);
            const active = v.length > 0 && v.length < value.length;
            return (
              <label key={label} className={`wm-field${active ? " is-active" : ""}${v === value ? " is-done" : ""}`}>
                <span>{label}</span>
                <span className="wm-input">{v}{active && <i className="caret" />}</span>
              </label>
            );
          })}
          <label className={`wm-check${at(t, 4400) ? " on" : ""}`}><span className="box" />I need care during work hours</label>
        </div>
        <aside className="wm-side">
          <p className="wm-side-head"><Mascot size={22} tile tone="orange" /> Mano is working</p>
          <ul>
            <li className={at(t, 300) ? "done" : ""}>Read last year&rsquo;s application</li>
            <li className={filled === fields.length ? "done" : at(t, 600) ? "now" : ""}>Fill {filled} of {fields.length} fields</li>
            <li className={at(t, 6700) ? "done" : at(t, 5000) ? "now" : ""}>Attach your papers</li>
          </ul>
          <div className="wm-papers">
            {papers.map(([n, s]) => <span key={n} className={`wm-paper${at(t, s) ? " in" : ""}`}><i />{n}</span>)}
          </div>
          <p className={`wm-ready${at(t, 7600) ? " in" : ""}`}>Ready. Waiting for your yes.</p>
        </aside>
      </div>
    </Browser>
  );
}

const results: [name: string, where: string, verdict: string, kind: "yes" | "wait" | "no", start: number][] = [
  ["Child Care Assistance Program", "Sample County Human Services", "Your family qualifies", "yes", 3600],
  ["Early Learning Scholarship", "Sample City", "Your family qualifies", "yes", 4500],
  ["Head Start, Pine Street", "Sample Early Learning", "Waitlist, 3 months", "wait", 5400],
  ["After-school grant", "Sample School District", "For ages 6 to 12 only", "no", 6300],
];

function SearchDemo({ t }: { t: number }) {
  const q = typed(t, 400, "help paying for child care, family of 5, Sample County", 22);
  return (
    <Browser url="search" className="wm-browser">
      <div className="wm-search">
        <div className="wm-query"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><span>{q}{!at(t, 3000) && <i className="caret" />}</span></div>
        <p className={`wm-reading${at(t, 3200) && !at(t, 7200) ? " in" : ""}`}><Mascot size={18} tile tone="orange" /> Reading 12 pages and checking the rules for your family</p>
        <ul className="wm-results">
          {results.map(([name, where, verdict, kind, s]) => (
            <li key={name} className={`${at(t, s) ? "in" : ""} ${kind}`}>
              <span><strong>{name}</strong><small>{where}</small></span>
              <span className={`wm-verdict ${kind}`}>{verdict}</span>
            </li>
          ))}
        </ul>
        <p className={`wm-sum${at(t, 7400) ? " in" : ""}`}>2 programs fit. Mano filled out both and is waiting for your yes.</p>
      </div>
    </Browser>
  );
}

const transcript: [who: string, text: string, start: number][] = [
  ["Recording", "Thank you for calling. All of our staff are helping other callers.", 1200],
  ["Recording", "Your call is important to us. Please stay on the line.", 3600],
  ["Dana, county staff", "Hi, this is Dana. How can I help?", 7200],
  ["Mano", "Hi Dana. I'm calling for Maria Lopez. I'm her automated assistant. She's joining now.", 8000],
];

function HoldDemo({ t }: { t: number }) {
  const holdSec = Math.min(47 * 60 + 12, Math.floor((t / 7000) * (47 * 60 + 12)));
  const mm = String(Math.floor(holdSec / 60)).padStart(2, "0");
  const ss = String(holdSec % 60).padStart(2, "0");
  const place = Math.max(1, 14 - Math.floor((t / 7000) * 14));
  const picked = at(t, 7000);
  return (
    <div className="wm-hold">
      <Image className="wm-clay" src="/art/hold.svg" width={480} height={360} alt="" unoptimized />
      <IPhone className="wm-phone">
        <div className={`wm-banner${at(t, 7300) ? " in" : ""}`}><Mascot size={26} tile tone="orange" /><span><strong>Mano</strong>A person picked up. Tap to join the call.</span></div>
        <div className="wm-call">
          <p className="wm-call-label">{picked ? "Connected" : "On hold for you"}</p>
          <p className="wm-call-who">Sample County Human Services</p>
          <p className="wm-timer">{mm}:{ss}</p>
          <div className={`wm-wave${picked ? " live" : ""}`} aria-hidden="true">{Array.from({ length: 22 }, (_, i) => <i key={i} style={{ animationDelay: `${(i % 7) * -0.13}s` }} />)}</div>
          <p className="wm-line">{picked ? "A person is on the line" : `Number ${place} in line`}</p>
          <ol className="wm-transcript">
            {transcript.filter(([, , s]) => at(t, s)).slice(-3).map(([who, text]) => (
              <li key={text}><small>{who}</small>{text}</li>
            ))}
          </ol>
        </div>
      </IPhone>
    </div>
  );
}

const demos = [
  { id: "apply", title: "Fills out applications", text: "Mano reads your papers, fills every field and attaches what the office asks for.", Demo: ApplyDemo },
  { id: "search", title: "Searches for you", text: "Mano reads the rules for every program near you and keeps only the ones your family can get.", Demo: SearchDemo },
  { id: "hold", title: "Waits on hold", text: "Mano sits through the hold music and calls you in the moment a person picks up.", Demo: HoldDemo },
];

export default function WatchMano() {
  const [i, setI] = useState(0);
  const [t, setT] = useState(DURATION);
  const [still, setStill] = useState(true);
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  const clock = useRef(0);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setStill(reduce);
    if (!reduce) setT(0);
  }, []);

  useEffect(() => {
    if (still || !seen) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      clock.current += dt;
      if (clock.current >= DURATION + 1500) { clock.current = 0; setI((x) => (x + 1) % demos.length); }
      setT(clock.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [still, seen]);

  const pick = (k: number) => { setI(k); clock.current = 0; setT(still ? DURATION : 0); };
  const { Demo } = demos[i];

  return (
    <div className="wm" ref={ref}>
      <div className="wm-tabs" role="tablist" aria-label="What Mano does">
        {demos.map((d, k) => (
          <button key={d.id} role="tab" aria-selected={k === i} aria-controls="wm-stage" className="wm-tab" onClick={() => pick(k)}>
            <strong>{d.title}</strong>
            <span>{d.text}</span>
            <i className="wm-progress" style={{ transform: `scaleX(${k === i ? Math.min(1, t / DURATION) : 0})` }} />
          </button>
        ))}
      </div>
      <div className="wm-stage" id="wm-stage" role="tabpanel" aria-label={demos[i].title}>
        <Demo t={t} />
      </div>
    </div>
  );
}
