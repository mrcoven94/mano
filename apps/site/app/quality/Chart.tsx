/* Server-rendered SVG trend lines: one card per metric, one line per series,
   gaps where a run has no value. No client code. */
import styles from "./quality.module.css";

export const SERIES_COLORS = ["#2443D6", "#1F7A4D", "#B42318", "#121212", "#8A6D3B", "#6A6A64"];

export interface Series {
  name: string;
  values: (number | null)[];
}

interface Props {
  title: string;
  now: string;
  series: Series[];
  labels: string[];
  // Fixed bounds keep rates on 0 to 100 and scores on 1 to 5.
  min?: number;
  max?: number;
  format: (n: number) => string;
}

const W = 300;
const H = 110;
const PAD = { l: 34, r: 8, t: 8, b: 18 };

export default function Chart({ title, now, series, labels, min, max, format }: Props) {
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const lo = min ?? (all.length ? Math.min(...all) : 0);
  const hiRaw = max ?? (all.length ? Math.max(...all) : 1);
  const hi = hiRaw === lo ? lo + 1 : hiRaw;
  const n = labels.length;
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  return (
    <div className={styles.chart}>
      <h3>{title}</h3>
      <p className={styles.now}>{now}</p>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} over ${n} run(s)`}>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(hi)} y2={y(hi)} stroke="var(--border)" />
        <line x1={PAD.l} x2={W - PAD.r} y1={y(lo)} y2={y(lo)} stroke="var(--border2)" />
        <text x={PAD.l - 4} y={y(hi) + 4} textAnchor="end" fontSize="9" fill="var(--faint)">{format(hi)}</text>
        <text x={PAD.l - 4} y={y(lo) + 3} textAnchor="end" fontSize="9" fill="var(--faint)">{format(lo)}</text>
        {n > 0 ? <text x={PAD.l} y={H - 4} fontSize="9" fill="var(--faint)">{labels[0]}</text> : null}
        {n > 1 ? <text x={W - PAD.r} y={H - 4} textAnchor="end" fontSize="9" fill="var(--faint)">{labels[n - 1]}</text> : null}
        {series.map((s, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length];
          const points = s.values.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`));
          const runs: string[][] = [];
          let current: string[] = [];
          for (const p of points) {
            if (p === null) {
              if (current.length) runs.push(current);
              current = [];
            } else current.push(p);
          }
          if (current.length) runs.push(current);
          return (
            <g key={s.name}>
              {runs.map((r, ri) => (r.length > 1 ? <polyline key={ri} points={r.join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" /> : null))}
              {s.values.map((v, i) => (v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={i === n - 1 ? 3 : 1.8} fill={color} />))}
            </g>
          );
        })}
      </svg>
      {series.length > 1 ? (
        <div className={styles.legend}>
          {series.map((s, si) => (
            <span key={s.name}><i style={{ background: SERIES_COLORS[si % SERIES_COLORS.length] }} />{s.name}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
