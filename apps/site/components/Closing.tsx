import { Wave } from "./Mascot";

const tones = { peach: "#FFB26B", sage: "#9CC8A6", sky: "#9CC3F0", lilac: "#C7B5F2" };
const keys = Object.keys(tones) as (keyof typeof tones)[];

export default function Closing({ id = "closing", title, text, children, extra, art }: { id?: string; title: string; text: string; children: React.ReactNode; extra?: React.ReactNode; art?: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} style={{ paddingBottom: 0 }}>
      <div className="wrap">
        <div className="closing">
          <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
            {keys.map((k) => (
              <symbol key={k} id={`${id}-t-${k}`} viewBox="0 0 100 100">
                <rect width="100" height="100" rx="28" fill={tones[k]} />
                <Wave />
              </symbol>
            ))}
          </svg>
          <div className="field" aria-hidden="true">
            {Array.from({ length: 180 }, (_, n) => (
              <svg key={n} className={n % 7 === 3 ? "wv" : undefined} style={n % 7 === 3 ? { animationDelay: `${(n % 11) * 0.4}s` } : undefined}>
                <use href={`#${id}-t-${keys[(n * 7 + (n >> 3)) % 4]}`} />
              </svg>
            ))}
          </div>
          {art}
          <h2 id={`${id}-h`}>{title}</h2>
          <p className="lede">{text}</p>
          <div className="btn-row">{children}</div>
          {extra}
        </div>
      </div>
    </section>
  );
}
