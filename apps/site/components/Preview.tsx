"use client";
import { useEffect, useRef, useState } from "react";
import Mascot from "./Mascot";

type Msg = { from: "me" | "mano" | "sys"; text: string; attach?: string; ask?: boolean; stage: number };

const renewal: Msg[] = [
  { from: "me", text: "Got this in the mail. What do they want?", attach: "Photo of a letter", stage: 0 },
  { from: "mano", text: "It's your benefits renewal. It's due November 18. They need a signed form and proof of income.", stage: 1 },
  { from: "mano", text: "I filled out the form from your last application. Two answers might have changed, so I marked them for you.", stage: 2 },
  { from: "mano", text: "Send it to the county?", attach: "Renewal form, 4 pages", ask: true, stage: 2 },
  { from: "me", text: "Yes, send it.", stage: 3 },
  { from: "mano", text: "Sent. I kept a copy and the confirmation number.", stage: 4 },
  { from: "sys", text: "Two days later", stage: 4 },
  { from: "mano", text: "The county got your renewal. The next one is due in May. I'll remind you in April.", stage: 5 },
];

const hold: Msg[] = [
  { from: "me", text: "The office says I have to call them. I'm at work until 5.", stage: 0 },
  { from: "mano", text: "I can wait on hold for you. When a person answers, I'll call you and connect you.", stage: 0 },
  { from: "me", text: "Yes please.", stage: 1 },
  { from: "mano", text: "Calling now. When someone answers, I'll start with: \"I'm calling for Maria Lopez. I'm their automated assistant. This call is transcribed.\"", stage: 1 },
  { from: "sys", text: "On hold for 47 minutes", stage: 2 },
  { from: "mano", text: "A person just picked up. Calling you now so you can talk to them.", stage: 3 },
];

const renewalSteps = [
  ["Letter read", "Benefits renewal"],
  ["Deadline found", "November 18"],
  ["Form filled out", "2 answers to check"],
  ["Maria said yes", "Approved this exact copy"],
  ["Sent to the county", "Copy and confirmation saved"],
  ["County confirmed", "Next reminder in April"],
];
const holdSteps = [
  ["Maria asked for a call", "Office line"],
  ["Mano dialed in", "Says it is Maria's automated assistant"],
  ["Waiting on hold", "Mano listens so Maria can work"],
  ["A person answered", "Maria connected"],
];

function Steps({ steps, stage, label }: { steps: string[][]; stage: number; label: string }) {
  return (
    <div className="card">
      <div className="side-label"><span className="mono">{label}</span><span className="chip"><span className="dot" style={{ background: "var(--green)" }} />Live</span></div>
      <ol className="steps">
        {steps.map(([t, s], k) => (
          <li key={t} className={k < stage ? "on" : k === stage ? "on now" : undefined}>
            <span className="tick" /><span>{t}<small>{s}</small></span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Letter({ stage }: { stage: number }) {
  return (
    <div className={`letter${stage >= 1 ? " read" : ""}${stage === 0 ? " scanning" : ""}`} aria-hidden="true">
      <div className="scan" />
      <div className="lh">SAMPLE COUNTY HUMAN SERVICES</div>
      <div style={{ color: "#77766f", fontSize: ".64rem", marginTop: 2 }}>Notice date October 21, 2026</div>
      <div style={{ marginTop: 14 }}>Dear Maria Lopez,</div>
      <div className="ln" style={{ width: "92%" }} /><div className="ln" style={{ width: "80%" }} />
      <div className="hl">Return your renewal form by November 18, 2026.</div>
      <div className="ln" style={{ width: "88%" }} /><div className="ln" style={{ width: "70%" }} />
      <div style={{ marginTop: 10, fontWeight: 650 }}>Include proof of income for the last 30 days.</div>
      <div className="ln" style={{ width: "84%", marginTop: 12 }} /><div className="ln" style={{ width: "60%" }} />
    </div>
  );
}

function Hold({ stage }: { stage: number }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (stage < 2) { setSecs(0); return; }
    if (stage > 2) { setSecs(47 * 60 + 12); return; }
    const t = setInterval(() => setSecs((s) => Math.min(s + 97, 47 * 60 + 12)), 50);
    return () => clearInterval(t);
  }, [stage]);
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return (
    <>
      <div className="card">
        <div className="side-label"><span className="mono">{stage >= 3 ? "Connected" : stage >= 1 ? "On hold" : "Ready to call"}</span></div>
        <div className="timer">{mm}:{ss}</div>
        <div className={`wave${stage >= 1 ? " live" : ""}`}>{Array.from({ length: 28 }, (_, k) => <i key={k} />)}</div>
      </div>
      <div className="card">
        <span className="mono">What the office hears first</span>
        <p className="quote">&ldquo;I&rsquo;m calling for Maria Lopez. I&rsquo;m their automated assistant. This call is transcribed.&rdquo;</p>
      </div>
    </>
  );
}

const DocIcon = () => (
  <svg width="26" height="30" viewBox="0 0 26 30" aria-hidden="true"><rect x="1" y="1" width="24" height="28" rx="4" fill="#efeee9" /><rect x="5" y="7" width="14" height="2" rx="1" fill="#bdbcb5" /><rect x="5" y="12" width="16" height="2" rx="1" fill="#bdbcb5" /><rect x="5" y="17" width="10" height="2" rx="1" fill="#ffb26b" /></svg>
);

export default function Preview() {
  const [tab, setTab] = useState<"renewal" | "hold">("renewal");
  const msgs = tab === "renewal" ? renewal : hold;
  const [count, setCount] = useState(0);
  const [typing, setTyping] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const r = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setReduced(r);
    if (r) { setCount(renewal.length); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } }, { threshold: 0.3 });
    if (root.current) io.observe(root.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduced || !visible || count >= msgs.length) return;
    const next = msgs[count];
    const wait = count === 0 ? 500 : next.from === "mano" ? 1500 : next.from === "sys" ? 900 : 1100;
    if (next.from === "mano") { const t0 = setTimeout(() => setTyping(true), 250); const t1 = setTimeout(() => { setTyping(false); setCount((c) => c + 1); }, wait); return () => { clearTimeout(t0); clearTimeout(t1); }; }
    const t = setTimeout(() => setCount((c) => c + 1), wait);
    return () => clearTimeout(t);
  }, [count, msgs, visible, reduced]);

  useEffect(() => { const el = box.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" }); }, [count, typing, reduced]);

  const pick = (t: "renewal" | "hold") => { setTab(t); setTyping(false); setCount(reduced ? (t === "renewal" ? renewal : hold).length : 0); };
  const shown = msgs.slice(0, count);
  const stage = shown.length ? shown[shown.length - 1].stage : -1;
  const done = count >= msgs.length;
  const steps = tab === "renewal" ? renewalSteps : holdSteps;
  const current = steps[Math.max(stage, 0)];

  return (
    <div className="preview" ref={root}>
      <div className="window">
        <div className="window-bar" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div className="window-dots" style={{ display: "flex", gap: 7 }} aria-hidden="true"><i /><i /><i /></div>
          <div className="tabs" role="tablist" aria-label="Example conversations">
            <button role="tab" className="tab" aria-selected={tab === "renewal"} onClick={() => pick("renewal")}>Renew from a photo</button>
            <button role="tab" className="tab" aria-selected={tab === "hold"} onClick={() => pick("hold")}>Wait on hold</button>
          </div>
          <button className="tab" onClick={() => pick(tab)} aria-label="Replay the conversation" title="Replay"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ display: "inline" }}><path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1M13.5 2.5v3.2h-3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        </div>
        <div className="preview-grid">
          <div className="side">
            {tab === "renewal" ? (
              <>
                <span className="mono">The letter</span>
                <Letter stage={stage} />
              </>
            ) : <Hold stage={stage} />}
          </div>
          <div>
            <div className="status-strip" aria-hidden="true"><span className="dot" style={{ background: done ? "var(--green)" : "var(--cyan)" }} />{current[0]}<span style={{ color: "var(--faint)" }}>{current[1]}</span></div>
            <div className="phone">
              <div className="phone-screen">
                <div className="phone-top">
                  <Mascot size={34} tile tone="orange" />
                  <strong>Mano</strong>
                  <small>Text message</small>
                </div>
                <div className="thread" ref={box} aria-live="polite" aria-label="Example text conversation between Maria and Mano">
                  {shown.map((m, k) => m.from === "sys" ? (
                    <div key={tab + k} className="sys"><span>{m.text}</span></div>
                  ) : (
                    <div key={tab + k} className={`b ${m.from === "me" ? "me" : "them"}${reduced ? "" : " anim"}`}>
                      <div>
                        {m.attach && <div className="attach"><DocIcon />{m.attach}</div>}
                        {m.text}
                        {m.ask && <div className="ask" aria-hidden="true"><span className="yes">Yes, send it</span><span className="no">Not yet</span></div>}
                      </div>
                    </div>
                  ))}
                  {typing && <div className="b them" aria-hidden="true"><span className="typing"><i /><i /><i /></span></div>}
                </div>
                <div className="phone-input" aria-hidden="true">Text message</div>
              </div>
            </div>
          </div>
          <div className="side">
            <Steps steps={steps} stage={stage} label={tab === "renewal" ? "Maria's renewal" : "The call"} />
            <p className="note" style={{ textAlign: "left" }}>Maria is a made-up person. Nothing leaves Mano until she says yes.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
