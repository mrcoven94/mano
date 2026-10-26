"use client";
import Mascot from "./Mascot";
import { IPhone } from "./Devices";
import DemoTabs, { at, typed, type Demo } from "./DemoTabs";

/* How a partner service reaches a family, and what a partner writes down. The service shown is made up. */

function OfferDemo({ t }: { t: number }) {
  const on = at(t, 6200);
  return (
    <div className="og-chase">
      <IPhone className="og-phone">
        <div className="im-head small"><span /><span className="im-who"><Mascot size={30} tile tone="orange" /><small>Mano ›</small></span><span /></div>
        <ol className="og-thread">
          {at(t, 400) && <li className="ev-msg you"><p>{typed(t, 400, "How do I build my credit?", 20)}</p></li>}
          {at(t, 2000) && <li className="ev-msg mano"><p>Your rent can count. A service can report the rent you already pay each month.</p></li>}
          {at(t, 3200) && (
            <li className="pt-card">
              <strong>Rent reporting</strong>
              <dl>
                <div><dt>Uses</dt><dd>Your rent payments, last 12 months</dd></div>
                <div><dt>Costs you</dt><dd>Nothing. The service pays.</dd></div>
                <div><dt>Stop</dt><dd>Text &ldquo;stop&rdquo; any time</dd></div>
              </dl>
              <span className={`pt-btn${on ? " on" : ""}`}>{on ? "Turned on" : "Turn on"}</span>
            </li>
          )}
          {at(t, 7000) && <li className="ev-msg mano"><p>On. Your first report goes out next month.</p></li>}
        </ol>
      </IPhone>
      <div className="og-req card">
        <small>What the family sees</small>
        <p>Mano offers a service only when it helps with what the family asked for, and shows exactly what it uses and who pays.</p>
        <p className={`og-got${on ? " in" : ""}`}>The family approved this use</p>
      </div>
    </div>
  );
}

const manifest: [string, string, number][] = [
  ["Name", "Rent reporting", 400],
  ["What it does", "Reports on-time rent to credit bureaus", 1100],
  ["Data used", "Rent amount and payment dates, 12 months", 2200],
  ["Cost to family", "Nothing. The partner pays.", 3500],
  ["How to stop", "The family texts stop. Data is deleted in 30 days.", 4500],
];

function ManifestDemo({ t }: { t: number }) {
  return (
    <div className="pt-manifest card">
      <p className="gv-out-head"><Mascot size={20} tile tone="orange" /> Your service</p>
      {manifest.map(([k, v, s]) => {
        const x = typed(t, s, v, 34);
        return <p key={k}><span>{k}</span><b>{x}{x.length > 0 && x.length < v.length && <i className="caret" />}</b></p>;
      })}
      <p className={`gv-review${at(t, 6400) ? " in" : ""}`}>Reviewed by Mano before families can see it.</p>
    </div>
  );
}

const demos: Demo[] = [
  { id: "pt-offer", title: "Offered at the right moment", text: "Mano suggests your service in the moment it fits, with plain terms the family approves.", Demo: OfferDemo },
  { id: "pt-manifest", title: "Terms in plain words", text: "What it does, the exact data it uses, who pays and how to stop. Families see all of it.", Demo: ManifestDemo },
];

export default function PartnerDemos() {
  return <DemoTabs demos={demos} label="How partner services work" duration={9000} />;
}
