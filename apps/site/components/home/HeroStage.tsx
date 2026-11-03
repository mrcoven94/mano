"use client";
import { useEffect, useRef, useState } from "react";
import { ApplyScene, FormScene, RenewScene, HoldScene } from "./Scenes";
import SpineDemo, { SPINE_SECONDS } from "./SpineDemo";
import Mascot from "@/components/Mascot";
import TextMano from "@/components/TextMano";
import { SMS_HREF, SMS_NUMBER } from "@/lib/site";

/* The hero: one headline whose highlighted outcome follows the demo below it. Each tab names the outcome and the work behind it.
   Scenes advance on their own while the stage is on screen; choosing a tab stops that. The first scene is the spine
   (a text thread that ends with a renewal filed); it moves on when its loop ends, and chosen, it keeps looping. */

const SECONDS = 8;

type SceneDef = { key: string; tab: string; how: string; phrase: string; Scene: (props: { onLoop?: () => void }) => React.ReactNode; seconds?: number; flush?: boolean };

const SCENES: SceneDef[] = [
  { key: "spine", tab: "Keep your benefits", how: "Renews by text", phrase: "keeps food coming", Scene: SpineDemo, seconds: SPINE_SECONDS, flush: true },
  { key: "apply", tab: "Pay rent", how: "Applies for help", phrase: "helps you pay rent", Scene: ApplyScene },
  { key: "forms", tab: "Find child care", how: "Fills out any form", phrase: "finds child care", Scene: FormScene },
  { key: "renew", tab: "Keep the lights on", how: "Renews on time", phrase: "keeps the lights on", Scene: RenewScene },
  { key: "hold", tab: "Get your medicine", how: "Waits on hold", phrase: "gets your medicine", Scene: HoldScene },
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

  const { Scene, flush } = SCENES[i];
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
        <p className="h-note">Text <a className="h-num" href={SMS_HREF}>{SMS_NUMBER}</a>. Free to start, and keeping your help is always free.</p>
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
                  style={{ animationDuration: `${s.seconds ?? SECONDS}s`, animationPlayState: playing ? "running" : "paused" }}
                  onAnimationEnd={s.seconds ? undefined : next}
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>
        <div className="h-stage" id="h-panel" role="tabpanel" aria-labelledby={`tab-${SCENES[i].key}`} data-paused={(auto && !visible) || undefined} data-flush={flush || undefined}>
          <Scene key={SCENES[i].key} onLoop={auto ? next : undefined} />
        </div>
      </div>
    </div>
  );
}
