"use client";
import { useEffect, useRef, useState } from "react";

type Msg = { from: "maria" | "mano" | "system"; text: string; attach?: string };

const threadA: Msg[] = [
  { from: "maria", text: "I got this letter. I do not know what it wants.", attach: "Photo of county letter" },
  { from: "mano", text: "I read it. Your benefits renew on November 18. The county needs proof of income and your signed renewal form by that date." },
  { from: "mano", text: "I filled out the renewal from your last application. Two answers changed, so I marked them for you to check." },
  { from: "mano", text: "Here is the exact form I will send. Send it?", attach: "Renewal form, 4 pages, ready to review" },
  { from: "maria", text: "Yes, send it." },
  { from: "mano", text: "Sent. I saved the copy and the tracking number." },
  { from: "system", text: "Two days later" },
  { from: "mano", text: "The county confirmed they received it. Your next deadline is in March. I will remind you in February." },
];

const threadB: Msg[] = [
  { from: "maria", text: "The office said to call, but I am at work." },
  { from: "mano", text: "I can wait on hold for you. When a person picks up, I will call you and connect you. On the call I say: I am calling for Maria. I am their automated assistant. I also say the call is transcribed." },
  { from: "maria", text: "Yes please." },
  { from: "system", text: "Mano waited on hold for 47 minutes" },
  { from: "mano", text: "A person just picked up. Calling you now so you can talk to them directly." },
];

function Bubble({ m }: { m: Msg }) {
  if (m.from === "system")
    return <div style={{ textAlign: "center", margin: "14px 0" }}><span className="pill" style={{ fontSize: ".75rem" }}>{m.text}</span></div>;
  const me = m.from === "maria";
  return (
    <div className="msg" style={{ display: "flex", justifyContent: me ? "flex-end" : "flex-start", marginBottom: 10 }}>
      <div style={{ maxWidth: "82%", background: me ? "#f4f4f2" : "var(--fill2)", color: me ? "#141414" : "var(--text)", border: me ? "none" : "1px solid var(--border)", borderRadius: me ? "20px 20px 6px 20px" : "20px 20px 20px 6px", padding: "11px 15px", fontSize: ".93rem", lineHeight: 1.5 }}>
        {!me && <div className="mono" style={{ color: "var(--cyan)", marginBottom: 4, fontSize: ".62rem" }}>Mano</div>}
        {m.attach && <div style={{ display: "flex", gap: 8, alignItems: "center", background: me ? "rgba(20,20,20,.07)" : "rgba(255,255,255,.06)", borderRadius: 12, padding: "8px 10px", marginBottom: 8, fontSize: ".8rem" }}><span aria-hidden="true">▣</span>{m.attach}</div>}
        {m.text}
        {m.text === "Here is the exact form I will send. Send it?" && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <span style={{ background: "var(--cyan)", color: "#082f36", fontWeight: 700, padding: "7px 16px", borderRadius: 999, fontSize: ".85rem" }}>Yes, send it</span>
            <span style={{ border: "1px solid var(--border2)", padding: "7px 16px", borderRadius: 999, fontSize: ".85rem" }}>Let me look first</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ThreadPreview() {
  const [tab, setTab] = useState<"a" | "b">("a");
  const msgs = tab === "a" ? threadA : threadB;
  const [count, setCount] = useState(1);
  const [typing, setTyping] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => { setCount(reduced ? msgs.length : 1); setTyping(false); }, [tab]); // eslint-disable-line
  useEffect(() => {
    if (reduced || count >= msgs.length) return;
    setTyping(true);
    const t1 = setTimeout(() => setTyping(false), 650);
    const t2 = setTimeout(() => setCount((c) => Math.min(c + 1, msgs.length)), 1450);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [count, msgs.length, reduced]);
  useEffect(() => { boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: reduced ? "auto" : "smooth" }); }, [count, typing, reduced]);

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 8, padding: "14px 16px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }} role="tablist" aria-label="Example conversations">
        <button role="tab" aria-selected={tab === "a"} onClick={() => setTab("a")} className="btn" style={{ padding: "8px 14px", fontSize: ".85rem", background: tab === "a" ? "var(--text)" : "var(--fill)", color: tab === "a" ? "#141414" : "var(--text)", border: "1px solid var(--border)" }}>Renewal from a photo</button>
        <button role="tab" aria-selected={tab === "b"} onClick={() => setTab("b")} className="btn" style={{ padding: "8px 14px", fontSize: ".85rem", background: tab === "b" ? "var(--text)" : "var(--fill)", color: tab === "b" ? "#141414" : "var(--text)", border: "1px solid var(--border)" }}>Wait on hold for me</button>
        <button onClick={() => { setCount(1); }} className="btn btn-ghost" style={{ padding: "8px 14px", fontSize: ".85rem", marginLeft: "auto" }} aria-label="Replay conversation">↻ Replay</button>
      </div>
      <div ref={boxRef} style={{ height: 500, overflowY: "auto", padding: "20px 18px", background: "rgba(0,0,0,.22)" }} aria-live="polite">
        <p style={{ textAlign: "center", fontSize: ".8rem", color: "var(--faint)", marginBottom: 16 }}>Maria is a synthetic person. This is a demo conversation.</p>
        {msgs.slice(0, count).map((m, i) => <Bubble key={tab + i} m={m} />)}
        {typing && count < msgs.length && <div style={{ display: "flex", marginBottom: 10 }}><div className="typing" style={{ background: "var(--fill2)", border: "1px solid var(--border)", borderRadius: "20px 20px 20px 6px", padding: "12px 16px", display: "flex", gap: 4 }}><i /><i /><i /></div></div>}
        {count >= msgs.length && <p style={{ textAlign: "center", fontSize: ".8rem", color: "var(--faint)", marginTop: 14 }}>End of demo. Maria approved every step before anything was sent.</p>}
      </div>
    </div>
  );
}
