"use client";
import { useEffect, useRef, useState } from "react";

export type StackItem = { tag: string; title: string; text: string; color: string; art: React.ReactNode };

export default function Stack({ id, title, intro, actions, items }: { id: string; title: string; intro: string; actions: React.ReactNode; items: StackItem[] }) {
  const [on, setOn] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setOn(Number((e.target as HTMLElement).dataset.i)); });
    }, { rootMargin: "-45% 0px -50% 0px" });
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  return (
    <section aria-labelledby={`${id}-h`}>
      <div className="wrap stack-wrap">
        <div className="stack-intro">
          <h2 id={`${id}-h`}>{title}</h2>
          <p className="lede">{intro}</p>
          <div className="btn-row">{actions}</div>
          <ol className="stack-index">
            {items.map((it, k) => (
              <li key={it.title}><a href={`#${id}-${k}`} className={k === on ? "on" : undefined}><span>{String(k + 1).padStart(2, "0")}</span>{it.tag}</a></li>
            ))}
          </ol>
        </div>
        <div className="stack-cards">
          {items.map((it, k) => (
            <article key={it.title} id={`${id}-${k}`} data-i={k} ref={(el) => { refs.current[k] = el; }} className="scard" style={{ top: `calc(96px + ${k * 18}px)`, background: it.color }}>
              <div className="row"><span className="tagp">{it.tag}</span><span className="count">{String(k + 1).padStart(2, "0")} / {String(items.length).padStart(2, "0")}</span></div>
              <div className="art" aria-hidden="true">{it.art}</div>
              <h3>{it.title}</h3>
              <p>{it.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
