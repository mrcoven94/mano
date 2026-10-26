"use client";
import { useEffect, useRef, useState } from "react";
import Mascot, { type Tone } from "./Mascot";

type Id = "maria" | "mine" | "cm" | "county";

const nodes: Record<Id, { x: number; y: number; name: string; sub: string; tone?: Tone }> = {
  maria: { x: 110, y: 430, name: "Maria", sub: "Approves every share" },
  mine: { x: 270, y: 270, name: "Maria's agent", sub: "Works only for Maria", tone: "cyan" },
  cm: { x: 500, y: 95, name: "Case manager's agent", sub: "Works for her case manager", tone: "green" },
  county: { x: 790, y: 270, name: "County agent", sub: "Works for the county office", tone: "blue" },
};

const edges: { a: Id; b: Id; d: string }[] = [
  { a: "maria", b: "mine", d: "M110,430 Q160,330 270,270" },
  { a: "mine", b: "county", d: "M270,270 Q530,420 790,270" },
  { a: "mine", b: "cm", d: "M270,270 Q330,120 500,95" },
  { a: "cm", b: "county", d: "M500,95 Q720,120 790,270" },
];

const steps: { from: Id; to: Id; text: string }[] = [
  { from: "county", to: "mine", text: "For Maria's renewal we need one pay stub from March." },
  { from: "mine", to: "maria", text: "The county wants your March pay stub. Share it for this renewal only?" },
  { from: "maria", to: "mine", text: "Yes, share it." },
  { from: "mine", to: "cm", text: "Maria shared her March pay stub for the renewal. Can you check it?" },
  { from: "cm", to: "county", text: "Checked. The pay stub matches the income on the form. Sending it with the case." },
  { from: "county", to: "mine", text: "Renewal approved through May 2027. Notice sent in Spanish, as Maria asked." },
  { from: "mine", to: "maria", text: "You're approved through May 2027. There is nothing else to do." },
];

const colors: Record<Id, string> = { maria: "#f2f2ef", mine: "var(--cyan)", cm: "var(--green)", county: "var(--blue)" };

const bubblePos: Record<Id, React.CSSProperties> = {
  maria: { left: "15%", top: "63%" },
  mine: { left: "4%", top: "20%" },
  cm: { left: "56%", top: "4%" },
  county: { right: "0%", top: "64%" },
};

export default function Network() {
  const [i, setI] = useState(0);
  const [run, setRun] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => setRun(e.isIntersecting), { threshold: 0.25 });
    if (root.current) io.observe(root.current);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!run) return;
    const t = setInterval(() => setI((v) => (v + 1) % steps.length), 3000);
    return () => clearInterval(t);
  }, [run]);

  const s = steps[i];
  const active = edges.find((e) => (e.a === s.from && e.b === s.to) || (e.a === s.to && e.b === s.from))!;

  return (
    <div ref={root}>
      <div className="net" role="img" aria-label="Diagram: the county's agent asks Maria's agent for a pay stub. Maria's agent asks Maria, she says yes, her case manager's agent checks the pay stub and sends it to the county, and the county's agent reports the approval back.">
        <svg className="edges" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="true">
          {edges.map((e) => {
            const on = e === active;
            return <path key={e.d} d={e.d} className={`edge${on ? " on" : ""}`} style={on ? { stroke: colors[s.from] } : undefined} vectorEffect="non-scaling-stroke" />;
          })}
        </svg>
        {(Object.keys(nodes) as Id[]).map((id) => {
          const n = nodes[id];
          return (
            <div key={id} className={`node${s.from === id || s.to === id ? " active" : ""}`} style={{ left: `${n.x / 10}%`, top: `${(n.y / 520) * 100}%` }}>
              {n.tone ? <Mascot tile tone={n.tone} className="tile" wave={s.from === id && run} /> : <span className="person" aria-hidden="true">M</span>}
              <div><strong>{n.name}</strong><small>{n.sub}</small></div>
            </div>
          );
        })}
        <div key={i} className="bubble" style={bubblePos[s.from]} aria-hidden="true">
          <span className="mono" style={{ color: colors[s.from] }}>{nodes[s.from].name} to {nodes[s.to].name}</span>
          {s.text}
        </div>
      </div>
      <div className="card net-card" aria-hidden="true">
        <span className="mono" style={{ color: colors[s.from] }}>{nodes[s.from].name} to {nodes[s.to].name}</span>
        <p>{s.text}</p>
      </div>
      <div className="net-controls">
        {steps.map((_, k) => (
          <button key={k} onClick={() => { setI(k); setRun(false); }} aria-label={`Show message ${k + 1} of ${steps.length}`} aria-current={k === i}>{k + 1}</button>
        ))}
      </div>
    </div>
  );
}
