import Image from "next/image";

/* Building blocks for the Government, Nonprofits and Partners pages. */

export function PageHero({ pill, title, lede, art, artAlt, children }: { pill: string; title: string; lede: string; art: string; artAlt: string; children: React.ReactNode }) {
  return (
    <div className="hero2 biz-hero">
      <div className="wrap hero2-grid">
        <div className="hero2-copy">
          <span className="biz-pill">{pill}</span>
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
          <div className="btn-row">{children}</div>
        </div>
        <div className="hero2-art">
          <Image src={art} width={480} height={360} priority alt={artAlt} unoptimized />
        </div>
      </div>
    </div>
  );
}

export function Steps({ id, title, items }: { id: string; title: string; items: [title: string, text: string][] }) {
  return (
    <section aria-labelledby={`${id}-h`}>
      <div className="wrap">
        <h2 id={`${id}-h`} className="biz-h2">{title}</h2>
        <ol className="biz-steps" role="list">
          {items.map(([t, x], k) => (
            <li key={t} className="card"><span className="ho-step">{k + 1}</span><h3>{t}</h3><p>{x}</p></li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function Commitments({ id, title, items, aside }: { id: string; title: string; items: string[]; aside?: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="tint">
      <div className="wrap biz-rules">
        <div>
          <h2 id={`${id}-h`} className="biz-h2 left">{title}</h2>
          {aside}
        </div>
        <ul role="list">
          {items.map((x) => <li key={x}><span className="b-check" aria-hidden="true" />{x}</li>)}
        </ul>
      </div>
    </section>
  );
}

export function SeatStrip({ title, text, href }: { title: string; text: string; href: string }) {
  return (
    <section style={{ paddingTop: 0 }}>
      <div className="wrap">
        <div className="card seat">
          <div><h2 className="biz-h3">{title}</h2><p>{text}</p></div>
          <a className="btn btn-primary" href={href}>Talk to us</a>
        </div>
      </div>
    </section>
  );
}
