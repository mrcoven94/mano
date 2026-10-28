import Link from "next/link";
import Image from "next/image";
import InView from "@/components/InView";
import Mascot from "@/components/Mascot";

/* Building blocks for the offices, nonprofits and partners pages, in the home page's paper and ink,
   with Mano's waving hand wherever Mano speaks. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

export function TeamHero({ eyebrow, before, phrase, after, lede, children, stage }: { eyebrow: string; before: string; phrase: string; after: string; lede: string; children: React.ReactNode; stage: React.ReactNode }) {
  return (
    <div className="t-hero">
      <div className="wrap">
        <div className="t-hero-head">
          <div>
            <p className="h-eyebrow">{eyebrow}</p>
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

export function Steps({ id, eyebrow, title, art, artAlt, items }: { id: string; eyebrow: string; title: string; art: string; artAlt: string; items: [step: string, card: React.ReactNode][] }) {
  return (
    <section className="t-steps" aria-labelledby={`${id}-h`} id={id}>
      <div className="wrap">
        <div className="t-steps-head">
          <div className="h-head">
            <p className="h-eyebrow">{eyebrow}</p>
            <h2 id={`${id}-h`}>{title}</h2>
          </div>
          <Image className="t-art" src={art} width={320} height={240} alt={artAlt} unoptimized />
        </div>
        <InView as="ol" className="share-flow" threshold={0.3}>
          {items.map(([step, card], n) => (
            <li key={step} className="share-step rv" style={d(0.1 + n * 0.4)}>
              <p className="share-n"><span>0{n + 1}</span>{step}</p>
              <div className="share-card">{card}</div>
            </li>
          ))}
        </InView>
      </div>
    </section>
  );
}

export function Rules({ id, eyebrow, title, lede, facts, file, code }: { id: string; eyebrow: string; title: string; lede: string; facts: [string, string][]; file: string; code: string }) {
  return (
    <section className="t-rules" aria-labelledby={`${id}-h`}>
      <div className="wrap open-grid">
        <div>
          <p className="h-eyebrow">{eyebrow}</p>
          <h2 id={`${id}-h`}>{title}</h2>
          <p className="lede">{lede}</p>
          <ul className="open-facts">
            {facts.map(([b, x]) => <li key={b}><b>{b}</b> {x}</li>)}
          </ul>
        </div>
        <figure className="code" aria-label={`Example: ${file}`}>
          <figcaption><span className="sc-label">{file}</span><span className="sc-label">Example</span></figcaption>
          <pre><code>{code}</code></pre>
        </figure>
      </div>
    </section>
  );
}

export function Seat({ title, text, href }: { title: string; text: string; href: string }) {
  return (
    <section className="t-seat-wrap" aria-label="Pricing">
      <div className="wrap">
        <div className="t-seat">
          <div><p className="sc-label">Pricing</p><h2 className="t-seat-h">{title}</h2><p>{text}</p></div>
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
