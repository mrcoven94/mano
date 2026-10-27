"use client";
import { useEffect, useRef, useState } from "react";
import { ApplyScene, FormScene, MailScene, RenewScene, HoldScene } from "./Scenes";
import Mascot from "@/components/Mascot";

/* The hero: one headline whose highlighted phrase follows the demo below it.
   Scenes advance on their own while the stage is on screen; choosing a tab stops that. */

const SCENES = [
  { key: "apply", tab: "Applies for help", phrase: "applies for help", Scene: ApplyScene },
  { key: "forms", tab: "Fills out any form", phrase: "fills out any form", Scene: FormScene },
  { key: "mail", tab: "Reads your mail", phrase: "reads your mail", Scene: MailScene },
  { key: "renew", tab: "Renews on time", phrase: "renews on time", Scene: RenewScene },
  { key: "hold", tab: "Waits on hold", phrase: "waits on hold", Scene: HoldScene },
];

const SECONDS = 8;

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
  const onKey = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + SCENES.length) % SCENES.length;
    pick(n);
    document.getElementById(`tab-${SCENES[n].key}`)?.focus();
  };

  const { Scene } = SCENES[i];
  const playing = auto && visible;

  return (
    <div className="h-hero">
      <div className="wrap h-hero-head">
        <h1>
          <span className="sr-only">Mano is AI that applies for help, fills out any form, reads your mail, renews on time and waits on hold.</span>
          <span aria-hidden="true">
            <span className="h-line">Mano <Mascot tile wave tone="orange" size="1em" className="h-mascot" /> is AI that</span>
            <span className="h-line"><mark key={i} className="h-phrase">{SCENES[i].phrase}</mark>.</span>
          </span>
        </h1>
        <p className="h-lede">Text it what you need or a photo of the letter you have been putting off. Mano does the paperwork, then asks you before anything is sent.</p>
        <div className="btn-row h-ctas">
          <a className="btn btn-primary btn-lg" href="#get-mano">Text Mano</a>
          <a className="btn btn-ghost btn-lg" href="#trust-h">How it stays safe</a>
        </div>
        <p className="h-note">Free for applying and renewals, and it stays free.</p>
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
              <span className="h-tab-n">0{n + 1}</span>
              {s.tab}
              {n === i && auto && (
                <span
                  key={`p-${i}`}
                  className="h-tab-bar"
                  style={{ animationDuration: `${SECONDS}s`, animationPlayState: playing ? "running" : "paused" }}
                  onAnimationEnd={() => setI((x) => (x + 1) % SCENES.length)}
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>
        <div className="h-stage" id="h-panel" role="tabpanel" aria-labelledby={`tab-${SCENES[i].key}`} data-paused={(auto && !visible) || undefined}>
          <Scene key={SCENES[i].key} />
        </div>
      </div>
    </div>
  );
}
