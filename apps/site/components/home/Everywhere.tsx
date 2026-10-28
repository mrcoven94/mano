"use client";
import { useState } from "react";
import Mascot from "@/components/Mascot";
import { NeedIcon } from "./NeedIcons";
import { REPO_URL, SMS_HREF, SMS_NUMBER, SMS_IS_PLACEHOLDER, EARLY_HREF, SIGN_UP_HREF, SIGN_IN_HREF } from "@/lib/site";

/* One Mano on every device. Each tab continues the same conversation, then the last one hands over the code. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;
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

/* Store-style download buttons. The app is not in either store yet, so each says where it stands. */
function AppleLogo() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path fill="currentColor" d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.86-.76-1.47.02-2.83.86-3.59 2.17-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.41 1.2-2.47-.03-.01-2.3-.88-2.32-3.51zM14.2 6.13c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.65-1.05 1.68-.92 2.67.97.08 1.96-.49 2.56-1.22z" />
    </svg>
  );
}

function PlayLogo() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path fill="#00D7FE" d="M3.6 2.4 13.4 12l-9.8 9.6c-.37-.2-.6-.6-.6-1.07V3.47c0-.47.23-.87.6-1.07z" />
      <path fill="#FFD400" d="m16.7 15.3-3.3-3.3 3.3-3.3 3.7 2.1c.8.46.8 1.94 0 2.4l-3.7 2.1z" />
      <path fill="#FF3A44" d="M16.7 15.3 13.4 12l-9.8 9.6c.36.2.83.2 1.27-.05l11.83-6.25z" />
      <path fill="#32F05C" d="M16.7 8.7 4.87 2.45c-.44-.25-.91-.25-1.27-.05L13.4 12l3.3-3.3z" />
    </svg>
  );
}

function StoreButton({ href, logo, small, big }: { href: string; logo: React.ReactNode; small: string; big: string }) {
  return (
    <a className="dv-store" href={href}>
      {logo}
      <span><small>{small}</small><b>{big}</b></span>
    </a>
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
            {k === "app" && <><StoreButton href={EARLY_HREF} logo={<PlayLogo />} small="Early access on" big="Android" /><StoreButton href={EARLY_HREF} logo={<AppleLogo />} small="Coming soon to" big="iPhone" /></>}
            {k === "web" && <><a className="btn btn-primary" href={SIGN_UP_HREF}>Create an account</a><a className="btn btn-ghost" href={SIGN_IN_HREF}>Sign in</a></>}
            {k === "own" && <><a className="btn btn-primary" href={`${REPO_URL}/archive/refs/heads/main.zip`}>Download the code</a><a className="btn btn-ghost" href={REPO_URL}>Read it on GitHub</a></>}
          </div>
          {k === "text" && SMS_IS_PLACEHOLDER && <p className="dv-small rv" style={d(0.24)}>Placeholder number until launch.</p>}
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
