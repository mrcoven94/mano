"use client";
import { useEffect, useRef, useState, type ComponentType } from "react";

/* Numbered tabs over one stage, the same pattern as the home hero. On wide screens scenes advance on their
   own while the stage is on screen and not under the pointer; choosing a tab stops that. Phones never auto-advance. */

export type SceneTab = { key: string; tab: string; Scene: ComponentType };

const SECONDS = 9;

export default function SceneTabs({ scenes, label }: { scenes: SceneTab[]; label: string }) {
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);
  const [visible, setVisible] = useState(false);
  const [held, setHeld] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const id = scenes[0].key;

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce), (max-width: 720px)").matches) setAuto(false);
    const el = stage.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const pick = (n: number) => { setAuto(false); setI(n); };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = (i + step + scenes.length) % scenes.length;
    pick(n);
    document.getElementById(`tab-${scenes[n].key}`)?.focus();
  };

  const { Scene } = scenes[i];

  return (
    <div ref={stage} onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}>
      <div className="h-tabs t-tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
        {scenes.map((s, n) => (
          <button key={s.key} id={`tab-${s.key}`} role="tab" aria-selected={n === i} aria-controls={`${id}-panel`} tabIndex={n === i ? 0 : -1} className="h-tab" onClick={() => pick(n)}>
            {s.tab}
            {n === i && auto && (
              <span
                key={`p-${i}`}
                className="h-tab-bar"
                style={{ animationDuration: `${SECONDS}s`, animationPlayState: visible && !held ? "running" : "paused" }}
                onAnimationEnd={() => setI((x) => (x + 1) % scenes.length)}
                aria-hidden="true"
              />
            )}
          </button>
        ))}
      </div>
      <div className="h-stage t-scene" id={`${id}-panel`} role="tabpanel" aria-labelledby={`tab-${scenes[i].key}`} data-paused={(auto && !visible) || undefined}>
        <Scene key={scenes[i].key} />
      </div>
    </div>
  );
}
