"use client";
import { useEffect, useRef, useState } from "react";
import HeroThread, { threadSeconds, type ThreadScene } from "./HeroThread";
import Mascot from "@/components/Mascot";
import TextMano from "@/components/TextMano";

/* The hero: one headline whose highlighted need follows the demo below it. Each tab names the need and what Mano does
   for it today, and only the food benefits renewal is filed, on the practice portal. Scenes advance when their loop ends
   while the stage is on screen; choosing a tab stops that. */

/* The question Mano really sends after reading a date (checkDate in packages/mail/src/words.ts). */
const CHECK_DATE = "Please check that against your letter. Is that the date you need to meet?";

const SCENES: { key: string; tab: string; how: string; phrase: string; thread: ThreadScene }[] = [
  {
    key: "spine", tab: "Food benefits", how: "Renews by text", phrase: "your food benefits",
    thread: {
      letter: { from: "Springfield County Food Assistance Office", title: "SNAP renewal, case R-1042", due: "Your renewal is due November 14, 2026.", note: "Late forms stop benefits." },
      me: "Got a letter. My food benefits are ending?",
      read: "Your renewal is due Nov 14. That is the date that matters.",
      ask: "I filled it in. Send it to the practice portal? YES or NO",
      answer: "Filed on the practice portal, not a real office. Confirmation SR\u2011G6WYKQU8",
    },
  },
  {
    key: "rent", tab: "Rent", how: "Reads your notice", phrase: "your rent notice",
    thread: {
      letter: { from: "Springfield Property Management", title: "Late rent notice", due: "Pay the $400 you owe by November 17.", note: "Monthly rent: $1,150" },
      me: "Got this from my landlord. What does it mean?",
      read: "It looks like your payment is due November 17, 2026.",
      ask: CHECK_DATE,
      answer: "Holding Nov 17. I'll text you Nov 10 and Nov 15.",
      last: { text: "Filling out rent help forms is coming soon." },
    },
  },
  {
    key: "care", tab: "Child care", how: "Reads your letter", phrase: "your child care",
    thread: {
      letter: { from: "Springfield County Child Care Office", title: "Your child care help is up for review", due: "Send proof of your work hours by December 1.", note: "Care on file: Mon to Fri, 7:30 to 4:00" },
      me: "Got a letter about our daycare help.",
      read: "It looks like the papers it asks for are due December 1, 2026.",
      ask: CHECK_DATE,
      answer: "Holding Dec 1. I'll text you Nov 24 and Nov 29.",
      last: { text: "Filling out child care forms is coming soon." },
    },
  },
  {
    key: "lights", tab: "Light bills", how: "Reminds you on time", phrase: "your power bill",
    thread: {
      letter: { from: "Springfield Power", title: "Your energy assistance credit is ending", due: "Reapply by November 20, 2026 to keep your winter credit.", note: "Late applications are reviewed only if funds remain." },
      me: "Is this about my power bill?",
      read: "It looks like your deadline is November 20, 2026.",
      ask: CHECK_DATE,
      answer: "Holding Nov 20. I'll text you Nov 13 and Nov 18.",
      last: { text: "Reminder: reapply for your winter credit by Nov 20.", stamp: ["Nov 13", "10:00 AM"] },
    },
  },
  {
    key: "medicine", tab: "Health and medicine", how: "Reads your letter", phrase: "your health care",
    thread: {
      letter: { from: "Springfield County Human Services", title: "It is time to renew your health coverage", due: "Send your renewal form by January 15, 2027.", note: "If we do not receive it, your coverage will end on January 31, 2027." },
      me: "Is my health coverage ending?",
      read: "It looks like your renewal is due January 15, 2027.",
      ask: CHECK_DATE,
      answer: "Holding Jan 15. I'll text you Jan 8 and Jan 13.",
      last: { text: "Filling out health coverage forms is coming soon." },
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
          <span className="sr-only">Mano is AI for your food benefits, your rent notice, your child care, your power bill and your health care.</span>
          <span aria-hidden="true">
            <span className="h-line">Mano <Mascot tile wave tone="orange" size="1em" className="h-mascot" /> is AI for</span>
            {/* Every phrase stays in the same grid cell, so the tallest one sets the height and the buttons never move. */}
            <span className="h-line h-phrases">
              {SCENES.map((s, n) => (
                <span key={s.key} data-on={n === i || undefined}><mark key={n === i ? "on" : "off"} className="h-phrase">{s.phrase}</mark>.</span>
              ))}
            </span>
          </span>
        </h1>
        <p className="h-lede">Mano helps you find, apply for and track your benefits across rent, food, health care, child care, bills and transportation. Some of this works today and the rest is coming soon. Mano files only after your yes, on a practice portal, not a real office.</p>
        <div className="btn-row h-ctas">
          <TextMano className="btn btn-primary btn-lg" />
          <a className="btn btn-ghost btn-lg" href="#nd-h">What Mano helps with</a>
        </div>
        <p className="h-note">Mano is free in this demo. No card, no sign up.</p>
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
