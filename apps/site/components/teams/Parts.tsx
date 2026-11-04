import Link from "next/link";
import Image from "next/image";
import InView from "@/components/InView";
import Mascot from "@/components/Mascot";
import { NeedIcon } from "@/components/home/NeedIcons";
import { REPO_URL } from "@/lib/site";

/* Building blocks for the offices, nonprofits and partners pages, in the home page's paper and ink. These pages say
   what runs today and what is planned; there is no product for these teams yet. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

export function TeamHero({ before, phrase, after, lede, children, stage }: { before: string; phrase: string; after: string; lede: string; children: React.ReactNode; stage?: React.ReactNode }) {
  return (
    <div className="t-hero">
      <div className="wrap">
        <div className="t-hero-head">
          <div>
            <h1>{before}<mark className="h-phrase">{phrase}</mark>{after}</h1>
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

/* What runs today and what is planned, side by side in one section. Every line here has to trace to code or to
   docs/decisions.md. */
export function Today({ id, title, today, planned }: { id: string; title: string; today: [icon: string, name: string, text: string][]; planned: string[] }) {
  return (
    <section className="h-today t-now" id={id} aria-labelledby={`${id}-h`}>
      <div className="wrap">
        <h2 id={`${id}-h`}>{title}</h2>
        <ul className="h-today-list">
          {today.map(([icon, name, text]) => (
            <li key={name}>
              <NeedIcon k={icon} size={48} />
              <b>{name}</b>
              <span>{text}</span>
            </li>
          ))}
        </ul>
        <div className="t-plan">
          <h3>Planned, with no date</h3>
          <ul>{planned.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      </div>
    </section>
  );
}

export function Rules({ id, title, lede, facts }: { id: string; title: string; lede: string; facts: [string, string][] }) {
  return (
    <section className="t-rules" aria-labelledby={`${id}-h`}>
      <div className="wrap open-grid">
        <div>
          <h2 id={`${id}-h`}>{title}</h2>
          <p className="lede">{lede}</p>
        </div>
        <ul className="open-facts">{facts.map(([b, x]) => <li key={b}><b>{b}</b> {x}</li>)}</ul>
      </div>
    </section>
  );
}

export function Close({ id, title, text }: { id: string; title: string; text: React.ReactNode }) {
  return (
    <section id={id} className="h-close" aria-labelledby={`${id}-h`}>
      <div className="wrap">
        <Mascot tile wave tone="orange" size={88} className="close-mascot" />
        <h2 id={`${id}-h`}>{title}</h2>
        <p className="lede">{text}</p>
        <div className="btn-row">
          <a className="btn btn-primary btn-lg" href={REPO_URL}>Read the code</a>
          <Link className="btn btn-ghost btn-lg" href="/">See it from the resident side</Link>
        </div>
      </div>
    </section>
  );
}
