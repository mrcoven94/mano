"use client";
import { useMemo, useState } from "react";
import { Wave } from "@/components/Mascot";
import { useInView } from "@/components/InView";
import { COVERAGE_AS_OF, STATES } from "@/lib/coverage";

/* Scale and reach: one dot per county, filling in west to east. Pick a state to see what Mano knows there. */

const FRONT_DOOR = "https://localcarehub.org";
const n = (x: number) => x.toLocaleString("en-US");

const NUMBERS = [
  ["83,000+", "government offices"],
  ["3,144", "counties, in all 50 states and DC"],
  ["102,000+", "services checked against official pages"],
  ["1,488", "state programs"],
] as const;

export default function Reach() {
  const [ref, seen] = useInView<HTMLDivElement>(0.2);
  const [st, setSt] = useState("WA");
  const keys = useMemo(() => Object.keys(STATES).sort((a, b) => STATES[a].name.localeCompare(STATES[b].name)), []);
  const dots = useMemo(
    () => Object.fromEntries(Object.entries(STATES).map(([k, s]) => {
      const v = s.dots.split(",").map(Number);
      const out: [number, number][] = [];
      for (let i = 0; i < v.length; i += 2) out.push([v[i], v[i + 1]]);
      return [k, out];
    })),
    [],
  );
  const s = STATES[st];

  return (
    <div className="rc">
      <div className="h-head">
        <h2 id="rc-h">Mano knows every office, in every county.</h2>
        <p className="lede">What each office offers, when it is open and how to reach it, for every county in the country. Built by a team that has helped people get more than $740 million. Powered by <a href={FRONT_DOOR}>Front Door</a>.</p>
      </div>

      <div className="rc-stage" ref={ref} data-in={seen || undefined}>
        <svg className="rc-map" viewBox="0 0 975 610" role="group" aria-label="One dot per county. Pick a state to see its counts.">
          {keys.map((k) => (
            <g
              key={k}
              className="rc-st"
              data-on={k === st || undefined}
              style={{ "--d": `${(STATES[k].at[0] / 975) * 1.1}s` } as React.CSSProperties}
              onClick={() => setSt(k)}
            >
              <title>{STATES[k].name}</title>
              {dots[k].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.6" />)}
            </g>
          ))}
          <g className="rc-pin" style={{ transform: `translate(${s.at[0] - 24}px, ${s.at[1] - 58}px)` }} aria-hidden="true">
            <g className="rc-pin-hop">
              <rect width="48" height="48" rx="14" fill="#FFB26B" stroke="#121212" strokeWidth="2.5" />
              <g transform="scale(.48)"><Wave /></g>
            </g>
          </g>
        </svg>

        <div className="rc-card" aria-live="polite">
          <label className="sc-label" htmlFor="rc-pick">Pick a state</label>
          <select id="rc-pick" value={st} onChange={(e) => setSt(e.target.value)}>
            {keys.map((k) => <option key={k} value={k}>{STATES[k].name}</option>)}
          </select>
          <dl key={st}>
            <div className="rv"><dt>Offices and organizations</dt><dd>{n(s.orgs)}</dd></div>
            <div className="rv" style={{ "--d": ".08s" } as React.CSSProperties}><dt>Services</dt><dd>{n(s.services)}</dd></div>
            <div className="rv" style={{ "--d": ".16s" } as React.CSSProperties}><dt>Counties</dt><dd>{n(dots[st].length)}</dd></div>
          </dl>
        </div>
      </div>

      <ul className="rc-nums">
        {NUMBERS.map(([b, t]) => <li key={t}><b>{b}</b><span>{t}</span></li>)}
      </ul>
      <p className="rc-note">Counts as of {COVERAGE_AS_OF}. Office and program data from <a href={FRONT_DOOR}>Front Door</a>, checked against each office&rsquo;s official page.</p>
    </div>
  );
}
