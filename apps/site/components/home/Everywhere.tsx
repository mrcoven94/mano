"use client";
import { useState } from "react";
import Mascot from "@/components/Mascot";
import { NeedIcon } from "./NeedIcons";
import { REPO_URL, SMS_HREF, SMS_NUMBER } from "@/lib/site";

/* One Mano on every device. Each tab continues the same conversation, then the last one hands over the code. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;
const EARLY = "mailto:hello@withmano.com?subject=Mano%20early%20access";
const INSTALL = `git clone ${REPO_URL}\ncd mano && pnpm install\npnpm check`;

const TABS = [
  { key: "text", icon: "phone", sub: "Any phone", label: "Text or iMessage", title: "No app needed.", text: "Any phone that can text works. Send Mano a photo of a letter or ask a question, the same way you would text a friend." },
  { key: "app", icon: "app", sub: "Early access", label: "iPhone and Android", title: "Everything in one place.", text: "The app shows what is ready to send, what is due next and every letter Mano has read for you." },
  { key: "web", icon: "laptop", sub: "Any browser", label: "Computer", title: "Pick up where you left off.", text: "Open Mano in any browser to read long forms on a bigger screen, print copies or upload a stack of documents." },
  { key: "own", icon: "code", sub: "Open source", label: "Run your own", title: "Download the whole system.", text: "Mano is open source. An agency, nonprofit or developer can download it, read every line and run their own copy." },
] as const;

type Key = (typeof TABS)[number]["key"];

function Bubble({ me, children, t }: { me?: boolean; children: React.ReactNode; t: number }) {
  return me ? (
    <p className="dv-b me rv" style={d(t)}>{children}</p>
  ) : (
    <div className="dv-row rv" style={d(t)}><Mascot tile tone="orange" size={22} /><p className="dv-b">{children}</p></div>
  );
}

function Phone({ children, title, input = "iMessage" }: { children: React.ReactNode; title: string; input?: string }) {
  return (
    <div className="dv-phone">
      <div className="dv-glass">
        <div className="dv-status" aria-hidden="true"><span>9:41</span><span className="dv-island" /><span className="dv-sig"><i /><i /><i /><b /></span></div>
        <div className="dv-top"><Mascot tile tone="orange" size={34} /><span>{title}</span></div>
        <div className="dv-screen">{children}</div>
        <div className="dv-input" aria-hidden="true"><span>{input}</span><i /></div>
      </div>
    </div>
  );
}

function Copy() {
  const [done, setDone] = useState(false);
  return (
    <button
      className="dv-copy"
      onClick={() => {
        navigator.clipboard?.writeText(INSTALL).then(() => { setDone(true); setTimeout(() => setDone(false), 1600); }, () => {});
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export default function Everywhere() {
  const [k, setK] = useState<Key>("text");
  const tab = TABS.find((t) => t.key === k)!;

  return (
    <div className="ev">
      <div className="h-head">
        <h2 id="dv-h">Get help by text, in the app or on a computer.</h2>
        <p className="lede">Start by text, approve in the app and print from a laptop. It is one Mano that remembers everything, and anyone can run their own copy.</p>
      </div>

      <div className="dv-tabs" role="tablist" aria-label="Ways to use Mano">
        {TABS.map((t) => (
          <button key={t.key} role="tab" id={`dv-${t.key}`} aria-selected={k === t.key} aria-controls="dv-panel" className="dv-tab" onClick={() => setK(t.key)}>
            <NeedIcon k={t.icon} size={40} />
            <span><b>{t.label}</b><small>{t.sub}</small></span>
          </button>
        ))}
      </div>

      <div className="dv-stage" id="dv-panel" role="tabpanel" aria-labelledby={`dv-${k}`}>
        <div className="dv-copycol" key={`c-${k}`}>
          <h3 className="rv" style={d(0)}>{tab.title}</h3>
          <p className="rv" style={d(0.08)}>{tab.text}</p>
          <div className="btn-row rv" style={d(0.16)}>
            {k === "text" && <><a className="btn btn-primary" href={SMS_HREF}>Text {SMS_NUMBER}</a></>}
            {k === "app" && <><a className="btn btn-primary" href={EARLY}>Android, early access</a><a className="btn btn-ghost" href={EARLY}>iPhone, coming soon</a></>}
            {k === "web" && <><a className="btn btn-primary" href={EARLY}>Web app, early access</a></>}
            {k === "own" && <><a className="btn btn-primary" href={`${REPO_URL}/archive/refs/heads/main.zip`}>Download the code</a><a className="btn btn-ghost" href={REPO_URL}>Read it on GitHub</a></>}
          </div>
          {k === "text" && <p className="dv-small rv" style={d(0.24)}>Placeholder number until launch.</p>}
          {k === "own" && <p className="dv-small rv" style={d(0.24)}>MIT license. Every part runs on your laptop with stand-ins when keys are missing, and tells you which parts are not live.</p>}
        </div>

        <div className="dv-device" key={`d-${k}`}>
          {k === "text" && (
            <Phone title="Mano">
              <div className="dv-photo rv me" style={d(0.1)}><span>SAMPLE COUNTY</span><i /><i /><i /></div>
              <Bubble me t={0.4}>What is this one?</Bubble>
              <Bubble t={1.1}>Your food benefits renewal. It is due <mark>November 14</mark>. Want me to fill it out?</Bubble>
              <Bubble me t={2}>Yes please</Bubble>
              <Bubble t={2.7}>Done. It&rsquo;s in the app too.</Bubble>
            </Phone>
          )}
          {k === "app" && (
            <Phone title="Good evening, Maria" input="Ask Mano anything">
              <div className="dv-card hot rv" style={d(0.1)}><small>Ready to send</small><b>Food benefits renewal</b><span className="dv-pill">Review</span></div>
              <div className="dv-card rv" style={d(0.35)}><small>Due next</small><b>Health coverage, Jan 31</b><span className="dv-meta">Mano starts Jan 6</span></div>
              <div className="dv-card rv" style={d(0.6)}><small>Mail</small><b>3 letters read this week</b><span className="dv-meta">1 scam blocked</span></div>
              <div className="dv-card rv" style={d(0.85)}><small>Shared</small><b>Northside Family Center</b><span className="dv-meta">Renewal only</span></div>
            </Phone>
          )}
          {k === "web" && (
            <div className="dv-browser">
              <div className="dv-web">
                <nav aria-hidden="true"><b><Mascot tile tone="orange" size={20} />mano</b><span className="on">Messages</span><span>Applications</span><span>Documents</span><span>Deadlines</span></nav>
                <div className="dv-web-thread">
                  <p className="sc-label">Earlier, by text</p>
                  <Bubble t={0.1}>Done. It&rsquo;s in the app too.</Bubble>
                  <p className="sc-label">Now, on your laptop</p>
                  <Bubble me t={0.6}>Can you print the renewal for my records?</Bubble>
                  <Bubble t={1.3}>Here it is, 4 pages and your 2 pay stubs. I marked the pages you still need to sign.</Bubble>
                </div>
              </div>
            </div>
          )}
          {k === "own" && (
            <div className="dv-term">
              <div className="dv-term-bar"><span className="sc-label">Terminal</span><Copy /></div>
              <pre>
                <span className="rv" style={d(0.1)}><b>$</b> git clone {REPO_URL}</span>
                <span className="rv" style={d(0.6)}><b>$</b> cd mano &amp;&amp; pnpm install</span>
                <span className="rv" style={d(1.1)}><b>$</b> pnpm check</span>
                <span className="rv ok" style={d(1.8)}>Every package checked</span>
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
