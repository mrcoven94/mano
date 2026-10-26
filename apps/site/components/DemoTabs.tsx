"use client";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { useInView } from "./InView";

/* Tabs on the left, a live demo on the right. Each demo draws itself from one clock (ms since it started)
   and the tabs advance on their own. With reduced motion every demo shows its finished state. */

export type Demo = { id: string; title: string; text: string; Demo: ComponentType<{ t: number }> };

export const at = (t: number, ms: number) => t >= ms;
export const typed = (t: number, start: number, text: string, cps = 28) =>
  text.slice(0, Math.max(0, Math.floor(((t - start) / 1000) * cps)));

export default function DemoTabs({ demos, duration = 11000, label }: { demos: Demo[]; duration?: number; label: string }) {
  const [i, setI] = useState(0);
  const [t, setT] = useState(duration);
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
      clock.current += now - last;
      last = now;
      if (clock.current >= duration + 1500) { clock.current = 0; setI((x) => (x + 1) % demos.length); }
      setT(clock.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [still, seen, duration, demos.length]);

  const pick = (k: number) => { setI(k); clock.current = 0; setT(still ? duration : 0); };
  const { Demo: Current } = demos[i];
  const stage = `${demos[0].id}-stage`;

  return (
    <div className="wm" ref={ref}>
      <div className="wm-tabs" role="tablist" aria-label={label}>
        {demos.map((d, k) => (
          <button key={d.id} role="tab" aria-selected={k === i} aria-controls={stage} className="wm-tab" onClick={() => pick(k)}>
            <strong>{d.title}</strong>
            <span>{d.text}</span>
            <i className="wm-progress" style={{ transform: `scaleX(${k === i ? Math.min(1, t / duration) : 0})` }} />
          </button>
        ))}
      </div>
      <div className="wm-stage" id={stage} role="tabpanel" aria-label={demos[i].title}>
        <Current t={t} />
      </div>
    </div>
  );
}
