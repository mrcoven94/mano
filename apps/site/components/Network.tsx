"use client";
import { useEffect, useState } from "react";
import Mascot from "./Mascot";

const steps = [
  { from: "County agent", to: "Maria's agent", text: "We need one pay stub for March.", color: "var(--blue)" },
  { from: "Maria's agent", to: "Maria", text: "The county asked for your March pay stub. Share it?", color: "var(--cyan)" },
  { from: "Maria", to: "Case manager's agent", text: "Maria approved sharing the pay stub for this case only.", color: "var(--green)" },
  { from: "Case manager's agent", to: "County agent", text: "Pay stub received and checked against the rule. Citation attached.", color: "var(--orange)" },
  { from: "County agent", to: "Maria's agent", text: "Case approved. Notice sent in Spanish, as Maria asked.", color: "var(--blue)" },
];

export default function Network() {
  const [i, setI] = useState(0);
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setI((v) => (v + 1) % steps.length), 2600);
    return () => clearInterval(t);
  }, [reduced]);
  const s = steps[i];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14, alignItems: "stretch" }} role="img" aria-label="Diagram: Maria's agent, the county agent and a case manager's agent pass a document request and a decision between each other, with Maria approving the share.">
        {[
          { name: "Maria's agent", sub: "Works for Maria", color: "var(--cyan)" },
          { name: "County agent", sub: "Works for the county office", color: "var(--blue)" },
          { name: "Case manager's agent", sub: "Works for her case manager", color: "var(--green)" },
        ].map((n) => (
          <div key={n.name} className="card" style={{ textAlign: "center", padding: "22px 16px" }}>
            <div style={{ display: "flex", justifyContent: "center" }}><Mascot size={46} wave={false} /></div>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: n.color, margin: "10px auto 8px", animation: "pulse 2s infinite" }} />
            <h3 style={{ fontSize: "1rem" }}>{n.name}</h3>
            <p style={{ fontSize: ".85rem", marginTop: 4 }}>{n.sub}</p>
          </div>
        ))}
      </div>
      <svg viewBox="0 0 600 44" width="100%" height="44" aria-hidden="true" style={{ display: "block", marginTop: 4 }}>
        <line x1="40" y1="22" x2="560" y2="22" stroke="rgba(255,255,255,.18)" strokeWidth="1.5" strokeDasharray="5 7" style={{ animation: "dashmove 1.2s linear infinite" }} />
        <circle r="5" fill={s.color}><animateMotion dur="2.4s" repeatCount="indefinite" path="M40,22 L560,22" /></circle>
      </svg>
      <div className="card" style={{ minHeight: 92, display: "flex", gap: 14, alignItems: "flex-start" }} aria-live="polite">
        <span className="dot" style={{ background: s.color, marginTop: 8 }} />
        <div>
          <p style={{ color: "var(--text)", fontWeight: 600, fontSize: ".92rem" }}>{s.from} <span style={{ color: "var(--faint)", fontWeight: 400 }}>to</span> {s.to}</p>
          <p style={{ marginTop: 4 }}>{s.text}</p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, flex: "none", paddingTop: 6 }}>
          {steps.map((_, k) => <button key={k} onClick={() => setI(k)} aria-label={`Show message ${k + 1}`} aria-current={k === i} style={{ width: 34, height: 34, borderRadius: "50%", border: "1px solid var(--border2)", background: k === i ? s.color : "transparent", cursor: "pointer", padding: 0, color: k === i ? "#141414" : "var(--muted)", fontSize: ".75rem" }}>{k + 1}</button>)}
        </div>
      </div>
      <p style={{ marginTop: 14, fontSize: ".9rem" }}>Agents share a case only when the resident says yes, for one purpose, and the resident can take that access back. Every message above is an example with synthetic people.</p>
    </div>
  );
}
