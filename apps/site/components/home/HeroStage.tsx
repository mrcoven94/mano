"use client";
import { useEffect, useRef, useState } from "react";
import HeroThread, { threadSeconds, type ThreadScene } from "./HeroThread";
import Mascot from "@/components/Mascot";
import TextMano from "@/components/TextMano";

/* The hero: one headline whose highlighted outcome follows the demo below it. Each tab names the outcome and what Mano
   does toward it today. Scenes advance when their loop ends while the stage is on screen; choosing a tab stops that. */

const YES_NO = "Want me to hold that date? YES or NO";

const SCENES: { key: string; tab: string; how: string; phrase: string; thread: ThreadScene }[] = [
  {
    key: "spine", tab: "Keep your benefits", how: "Renews by text", phrase: "keeps food coming",
    thread: {
      letter: { from: "Sample County Human Services", title: "Your food benefits end November 30", due: "Return your renewal by November 14.", note: "Phone interview: November 13 at 10:00 AM" },
      me: "Got a letter. My food benefits are ending?",
      read: "Your renewal is due Nov 14. That is the date that matters.",
      ask: "I filled it in. Send it to the practice portal? YES or NO",
      answer: "Filed on the practice portal, not a real office. Confirmation SB-20481",
    },
  },
  {
    key: "rent", tab: "Pay rent", how: "Reads your notice", phrase: "helps you pay rent",
    thread: {
      letter: { from: "Sample Property Management", title: "Late rent notice", due: "Pay the $400 you owe by November 10.", note: "Monthly rent: $1,150" },
      me: "Got this from my landlord. What does it mean?",
      read: "You owe $400 by Nov 10. That is the date that matters.",
      ask: YES_NO,
      answer: "Holding Nov 10. I'll text you Nov 3 and Nov 8.",
      last: { text: "Filling out rent help forms is coming soon." },
    },
  },
  {
    key: "care", tab: "Find child care", how: "Holds your date", phrase: "finds child care",
    thread: {
      letter: { from: "Sample County Child Care Office", title: "Your child care help is up for review", due: "Send proof of your work hours by December 1.", note: "Care on file: Mon to Fri, 7:30 to 4:00" },
      me: "Got a letter about our daycare help.",
      read: "Send proof of your work hours by Dec 1. That is the date that matters.",
      ask: YES_NO,
      answer: "Holding Dec 1. I'll text you Nov 24 and Nov 29.",
      last: { text: "Filling out child care forms is coming soon." },
    },
  },
  {
    key: "lights", tab: "Keep the lights on", how: "Reminds you on time", phrase: "keeps the lights on",
    thread: {
      letter: { from: "Sample Power", title: "Your energy assistance credit is ending", due: "Reapply by November 20, 2026 to keep your winter credit.", note: "Late applications are reviewed only if funds remain." },
      me: "Is this about my power bill?",
      read: "Yes. Reapply by Nov 20 to keep your winter credit.",
      ask: YES_NO,
      answer: "Holding Nov 20. I'll text you Nov 13 and Nov 18.",
      last: { text: "Reminder: reapply for your winter credit by Nov 20.", stamp: ["Nov 13", "10:00 AM"] },
    },
  },
  {
    key: "medicine", tab: "Get your medicine", how: "Reads your letter", phrase: "gets your medicine",
    thread: {
      letter: { from: "Sample County Human Services", title: "It is time to renew your health coverage", due: "Send your renewal form by January 15, 2027.", note: "If we do not receive it, your coverage will end on January 31, 2027." },
      me: "Is my health coverage ending?",
      read: "Send your renewal form by Jan 15, or your coverage ends Jan 31.",
      ask: YES_NO,
      answer: "Holding Jan 15. I'll text you Jan 8 and Jan 13.",
      last: { text: "Waiting on hold for you is coming soon." },
    },
  },
];

export default function HeroStage() {
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);
  const [visible, setVisible] = useState(true);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setAuto(false);
    const el = stage.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const pick = (n: number) => { setAuto(false); setI(n); };
  const next = () => setI((x) => (x + 1) % SCENES.length);
  const onKey = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + SCENES.length) % SCENES.length;
    pick(n);
    document.getElementById(`tab-${SCENES[n].key}`)?.focus();
  };

  const playing = auto && visible;

  return (
    <div className="h-hero">
      <div className="wrap h-hero-head">
        <h1>
          <span className="sr-only">Mano is AI that keeps food coming, helps you pay rent, finds child care, keeps the lights on and gets your medicine.</span>
          <span aria-hidden="true">
            <span className="h-line">Mano <Mascot tile wave tone="orange" size="1em" className="h-mascot" /> is AI that</span>
            <span className="h-line"><mark key={i} className="h-phrase">{SCENES[i].phrase}</mark>.</span>
          </span>
        </h1>
        <p className="h-lede">Rent, food, medicine, child care, light and water bills. Text Mano what is going on and it finds the help, fills out the forms and keeps the help coming.</p>
        <div className="btn-row h-ctas">
          <TextMano className="btn btn-primary btn-lg" />
          <a className="btn btn-ghost btn-lg" href="#nd-h">What Mano helps with</a>
        </div>
        <p className="h-note">Free to start, and keeping your help is always free.</p>
      </div>

      <div className="wrap h-stage-wrap" ref={stage}>
        <div className="h-sticker" aria-hidden="true">
          <span className="h-sticker-bubble">Hi, I&rsquo;m Mano. Watch me work.</span>
          <Mascot tile wave tone="orange" size={64} />
        </div>
        <div className="h-tabs" role="tablist" aria-label="What Mano does" onKeyDown={onKey}>
          {SCENES.map((s, n) => (
            <button
              key={s.key}
              id={`tab-${s.key}`}
              role="tab"
              aria-selected={n === i}
              aria-controls="h-panel"
              tabIndex={n === i ? 0 : -1}
              className="h-tab"
              onClick={() => pick(n)}
            >
              <span className="h-tab-t">{s.tab}<small>{s.how}</small></span>
              {n === i && auto && (
                <span
                  key={`p-${i}`}
                  className="h-tab-bar"
                  style={{ animationDuration: `${threadSeconds(s.thread)}s`, animationPlayState: playing ? "running" : "paused" }}
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>
        <div className="h-stage" id="h-panel" role="tabpanel" aria-labelledby={`tab-${SCENES[i].key}`} data-flush>
          <HeroThread key={SCENES[i].key} scene={SCENES[i].thread} onLoop={auto ? next : undefined} />
        </div>
      </div>
    </div>
  );
}
