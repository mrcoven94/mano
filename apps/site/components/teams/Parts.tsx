import Link from "next/link";
import Image from "next/image";
import InView from "@/components/InView";
import Mascot from "@/components/Mascot";
import { NeedIcon } from "@/components/home/NeedIcons";

/* Building blocks for the offices, nonprofits and partners pages, in the home page's paper and ink,
   with Mano's waving hand wherever Mano speaks. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

export function TeamHero({ before, phrase, after, lede, children, stage }: { before: string; phrase: React.ReactNode; after: string; lede: string; children: React.ReactNode; stage: React.ReactNode }) {
  return (
    <div className="t-hero">
      <div className="wrap">
        <div className="t-hero-head">
          <div>
            <h1>{before}{typeof phrase === "string" ? <mark className="h-phrase">{phrase}</mark> : phrase}{after}</h1>
          </div>
          <div className="t-hero-side">
            <p className="h-lede">{lede}</p>
            <div className="btn-row h-ctas">{children}</div>
          </div>
        </div>
        {stage}
      </div>
    </div>
  );
}

/* The grey stage a live demo sits on. Mano waves from the corner and says what to try. */
export function Stage({ id, label, hint, children }: { id?: string; label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="t-stage" id={id}>
      <div className="t-stage-bar">
        <span className="sc-label">{label}</span>
        <span className="t-sticker"><span className="t-sticker-bubble">{hint}</span><Mascot tile wave tone="orange" size={56} /></span>
      </div>
      {children}
    </div>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 60 40" width="60" height="40">
      <path d="M4 26C18 8 36 6 52 18" fill="none" stroke="#121212" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M44 12L53 19L43 24" fill="none" stroke="#121212" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Steps({ id, title, art, artAlt, items }: { id: string; title: string; art: string; artAlt: string; items: [step: string, card: React.ReactNode, icon: string][] }) {
  return (
    <section className="t-steps" aria-labelledby={`${id}-h`} id={id}>
      <div className="wrap">
        <div className="t-steps-head">
          <div className="h-head">
            <h2 id={`${id}-h`}>{title}</h2>
          </div>
          <Image className="t-art" src={art} width={320} height={240} alt={artAlt} unoptimized />
        </div>
        <InView as="ol" className="share-flow" threshold={0.3}>
          {items.map(([step, card, icon], n) => [
            n > 0 && <li key={`a${n}`} className="share-arrow" aria-hidden="true"><Arrow /></li>,
            <li key={step} className="share-step rv" style={d(0.1 + n * 0.4)}>
              <p className="share-n">{step}</p>
              <div className="share-card"><NeedIcon k={icon} size={40} />{card}</div>
            </li>,
          ])}
        </InView>
      </div>
    </section>
  );
}

/* One line of an activity log: when, who and what happened. A person or Mano, never a code name. */
export type LogLine = { at: string; who: string; role?: string; text: string; mano?: boolean };

export function AuditLog({ title, lines }: { title: string; lines: LogLine[] }) {
  return (
    <InView className="t-log" threshold={0.3}>
      <p className="t-log-title">{title}</p>
      <ol>
        {lines.map((l, n) => (
          <li key={n} className="rv" style={d(0.15 + n * 0.35)}>
            {l.mano
              ? <Mascot tile tone="orange" size={34} className="t-log-av" />
              : <span className="t-log-av t-log-person" aria-hidden="true">{l.who.split(" ").map((w) => w[0]).join("").slice(0, 2)}</span>}
            <div>
              <p><b>{l.who}</b>{l.role && <span className="t-log-role"> {l.role}</span>}</p>
              <p className="t-log-text">{l.text}</p>
            </div>
            <span className="t-log-at">{l.at}</span>
          </li>
        ))}
      </ol>
    </InView>
  );
}

export function Rules({ id, title, lede, facts, log }: { id: string; title: string; lede: string; facts: [string, string][]; log?: { title: string; lines: LogLine[] } }) {
  return (
    <section className="t-rules" aria-labelledby={`${id}-h`}>
      <div className="wrap open-grid">
        <div>
          <h2 id={`${id}-h`}>{title}</h2>
          <p className="lede">{lede}</p>
          {log && <ul className="open-facts">{facts.map(([b, x]) => <li key={b}><b>{b}</b> {x}</li>)}</ul>}
        </div>
        {log ? <AuditLog title={log.title} lines={log.lines} /> : <ul className="open-facts">{facts.map(([b, x]) => <li key={b}><b>{b}</b> {x}</li>)}</ul>}
      </div>
    </section>
  );
}

export function Seat({ title, text, href }: { title: string; text: string; href: string }) {
  return (
    <section className="t-seat-wrap" aria-label="Pricing">
      <div className="wrap">
        <div className="t-seat">
          <Mascot tile wave tone="orange" size={72} className="t-seat-mascot" />
          <div className="t-seat-copy"><p className="sc-label">Pricing</p><h2 className="t-seat-h">{title}</h2><p>{text}</p></div>
          <a className="btn btn-primary" href={href}>Talk to us</a>
        </div>
      </div>
    </section>
  );
}

export function Close({ id, title, text, href }: { id: string; title: string; text: string; href: string }) {
  return (
    <section id={id} className="h-close" aria-labelledby={`${id}-h`}>
      <div className="wrap">
        <Mascot tile wave tone="orange" size={88} className="close-mascot" />
        <h2 id={`${id}-h`}>{title}</h2>
        <p className="lede">{text}</p>
        <div className="btn-row">
          <a className="btn btn-primary btn-lg" href={href}>Talk to us</a>
          <Link className="btn btn-ghost btn-lg" href="/">See it from the resident side</Link>
        </div>
      </div>
    </section>
  );
}

/* A message from Mano, with its hand as the avatar. */
export function ManoSays({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className={`bub-row${style ? " rv" : ""}`} style={style}>
      <Mascot tile tone="orange" size={28} className="bub-av" />
      <p className="bub mano">{children}</p>
    </div>
  );
}

export function ManoHead({ children }: { children: React.ReactNode }) {
  return <span className="t-mano-head"><Mascot tile tone="orange" size={22} />{children}</span>;
}

export function Check() {
  return (
    <svg className="sc-tick" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.4l2.9 2.8 6-6.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export { d };
