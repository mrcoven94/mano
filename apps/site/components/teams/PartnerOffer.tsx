"use client";
import { useState } from "react";
import { Check, ManoHead, ManoSays, d } from "./Parts";
import { useAutoplay } from "./useAutoplay";

/* A partner's extension manifest beside the moment a resident is offered it. Each line of the offer comes
   from lines of the manifest; point at one to see which. The service and the person are made up. */

type Group = "does" | "data" | "cost" | "stop";
type Step = "offer" | "on" | "no" | "removed";

const manifest: [string, Group?][] = [
  ["{"],
  ['  "manifest": "mano.extension/0.1",'],
  ['  "id": "sample-rent-reporting",'],
  ['  "name": "Rent reporting",'],
  ['  "does": "Reports on-time rent to credit bureaus",', "does"],
  ['  "offer_when": ["build credit"],', "does"],
  ['  "data": [', "data"],
  ['    "rent.amount",', "data"],
  ['    "rent.paid_dates:12mo"', "data"],
  ["  ],", "data"],
  ['  "tools": ["report_rent_payment"],'],
  ['  "paid_by": "partner",', "cost"],
  ['  "cost_to_person": 0,', "cost"],
  ['  "stop": "any_time",', "stop"],
  ['  "delete_after_stop": "30d"', "stop"],
  ["}"],
];

const terms: [Group, string, string][] = [
  ["does", "Does", "Reports the rent you already pay on time"],
  ["data", "Uses", "Your rent amount and paid dates, last 12 months"],
  ["cost", "Costs you", "Nothing. The service provider pays."],
  ["stop", "Stop", "Any time. Sharing stops at once, and your data is deleted within 30 days."],
];

export default function PartnerOffer() {
  const [s, setS] = useState<Step>("offer");
  const [focus, setFocus] = useState<Group | null>(null);
  const [ref, touch] = useAutoplay<HTMLDivElement>([
    [3000, () => setFocus("does")], [3700, () => setFocus("data")], [4400, () => setFocus("cost")],
    [5100, () => setFocus("stop")], [5800, () => setFocus(null)],
  ]);
  const point = (g: Group | null) => { touch(); setFocus(g); };
  const go = (x: Step) => { touch(); setS(x); };

  const lineClass = (g?: Group) => {
    if (!g) return undefined;
    if (focus === g) return "on";
    if (s === "on" && g === "data") return "used";
    return undefined;
  };

  return (
    <div className="po" ref={ref}>
      <div className="po-man">
        <p className="t-who">The partner&rsquo;s manifest</p>
        <figure className="code" aria-label="Example extension manifest">
          <figcaption><span className="sc-label">rent-reporting.manifest.json</span><span className="sc-label">Written by the partner</span></figcaption>
          <pre className="po-code"><code>{manifest.map(([line, g], n) => <span key={n} className={lineClass(g)}>{line}</span>)}</code></pre>
        </figure>
        <p className="po-key"><span><i />Shown to Maria in plain words</span><span><i className="used" />Shared after she says yes</span></p>
      </div>

      <div className="po-phone">
      <p className="t-who">Maria&rsquo;s phone</p>
      <div className="t-phone" aria-label="Maria's phone" role="group">
        <p className="t-phone-head"><ManoHead>Mano</ManoHead></p>
        <div className="t-thread" aria-live="polite">
          <p className="bub me rv" style={d(0.3)}>How do I build my credit? I have never had a credit card.</p>
          <ManoSays style={d(1.3)}>The rent you already pay can count. A rent reporting service sends it to the credit bureaus. Here is exactly what it would use.</ManoSays>
          <div className="po-offer rv" style={d(2.3)}>
            <strong>Rent reporting</strong>
            <dl>
              {terms.map(([g, k, v]) => (
                <div key={g} tabIndex={0} className={focus === g ? "on" : undefined} onMouseEnter={() => point(g)} onMouseLeave={() => point(null)} onFocus={() => point(g)} onBlur={() => point(null)} onClick={() => point(g)}>
                  <dt>{k}</dt><dd>{v}</dd>
                </div>
              ))}
            </dl>
            {s === "offer" && (
              <div className="t-choice">
                <button className="btn btn-pen t-pulse" onClick={() => go("on")}>Turn it on</button>
                <button className="btn btn-ghost" onClick={() => go("no")}>Not now</button>
              </div>
            )}
            {s === "on" && <p className="po-state"><Check /> On since today</p>}
          </div>
          {s === "no" && <p className="bub me">Not now</p>}
          {s === "no" && <ManoSays style={d(0.3)}>Okay. I won&rsquo;t bring it up again unless you ask.</ManoSays>}
          {(s === "on" || s === "removed") && <p className="bub me">Turn it on</p>}
          {(s === "on" || s === "removed") && <ManoSays style={d(0.3)}>On. They get your rent amount and paid dates, nothing else. Your first report goes out in November.</ManoSays>}
          {s === "on" && <div className="t-choice rv" style={d(0.9)}><button className="btn btn-ghost" onClick={() => go("removed")}>Remove it</button></div>}
          {s === "removed" && <p className="bub me">Remove it</p>}
          {s === "removed" && <ManoSays style={d(0.3)}>Removed. They stopped getting your data today and must delete what they have by November 26. I&rsquo;ll tell you when they confirm.</ManoSays>}
          {(s === "no" || s === "removed") && <div className="t-choice"><button className="btn btn-ghost" onClick={() => go("offer")}>Start over</button></div>}
        </div>
      </div>
      </div>
    </div>
  );
}
