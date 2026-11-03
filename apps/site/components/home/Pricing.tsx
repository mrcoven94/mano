import Link from "next/link";
import PlusPrice from "./PlusPrice";
import { NeedIcon } from "./NeedIcons";
import Mascot, { Wave } from "@/components/Mascot";
import { SMS_HREF } from "@/lib/site";

/* Two plans, the full side by side folded under them, then the support that comes with Plus. Applying and keeping help are free for everyone; Plus adds a support team, and daily
   checks for new help are coming. Faxes and mail, once ready, cost real money, so they are at cost on both. */

const FREE = [
  "Unlimited applications",
  "Forms filled on websites by its own computer",
  "Unlimited notices, read and explained",
  "Unlimited renewals, deadlines and reminders",
  "Unlimited benefit tracking",
  "Its own email inbox, so offices write to Mano directly, coming soon",
  "Unlimited mail scans and documents",
  "Text and iMessage, with the app and the web coming soon",
];

const PLUS: [string, string][] = [
  ["Always on, coming soon.", "Mano will check every day for new help you qualify for."],
  ["Calls and waiting on hold, coming soon.", "Mano will wait on hold for you and hand you the phone when a person picks up."],
  ["A support team that knows your case.", "Real people, ready when you need more than Mano."],
];

const SUPPORT: [string, string, string][] = [
  ["chat", "Answers the same day.", "Text support and hear back from a person who has read your file, so you never explain it twice."],
  ["programs", "Help when you are turned down.", "Mano reads the denial and writes the appeal, and a person checks it before it goes. If there is a hearing, you will be ready for it."],
  ["clipboard", "Ready for every interview.", "Practice the questions the office will ask and get a list of exactly what to bring."],
  ["now", "First in line when it is urgent.", "A shutoff or eviction notice moves your case to the front, any day of the week."],
  ["calendar", "A yearly checkup.", "Once a year a person goes over everything you get and finds what you are missing."],
  ["mano", "Someone on your side.", "If an office is not answering, support follows up with them until your case moves."],
];

type Cell = string | boolean;
const ROWS: [string, [string, Cell, Cell][]][] = [
  ["Getting help", [
    ["Applications", "Unlimited", "Unlimited"],
    ["Programs checked for you", "Every one", "Every one"],
    ["Notices read and explained", "Unlimited", "Unlimited"],
    ["Renewals, deadlines and reminders", "Unlimited", "Unlimited"],
    ["Benefit tracking", "Unlimited", "Unlimited"],
    ["Its own email inbox, coming soon", true, true],
    ["Mail scans and documents", "Unlimited", "Unlimited"],
  ]],
  ["Mano does it for you", [
    ["Always on, checks every day, coming soon", false, true],
    ["Its own computer for websites", true, true],
    ["Calls and waiting on hold, coming soon", false, true],
    ["Credit disputes", "Written for you", "Written and followed up"],
    ["Faxes and mailed letters, coming soon", "At cost", "At cost"],
  ]],
  ["Support", [
    ["Same-day answers from a person", false, true],
    ["Appeals when you are turned down", "Denial explained", "Written and checked"],
    ["Interview practice", false, true],
    ["Urgent cases first", false, true],
    ["Yearly checkup", false, true],
  ]],
  ["Always included", [
    ["Share a case with your caseworker, coming soon", true, true],
  ]],
];

function Mark({ v }: { v: Cell }) {
  if (v === true) return <span className="cmp-yes" aria-label="Included" />;
  if (v === false) return <span className="cmp-no" aria-label="Not included">&ndash;</span>;
  return <>{v}</>;
}

export default function Pricing() {
  return (
    <>
      <div className="h-head">
        <h2 id="pricing-h">Keeping your help is free, always.</h2>
        <p className="lede">Applications, notices, renewals, tracking and mail are free for everyone. Plus is $8 a month for a support team that knows your case. Daily checks for new help are coming soon.</p>
      </div>

      <div className="price-grid">
        <article className="price">
          <Mascot tile tone="orange" size={56} className="price-mascot" />
          <div className="price-top">
            <h3>Free</h3>
            <p className="amt">$0<small> forever</small></p>
            <p>Mano works whenever you text it.</p>
          </div>
          <ul>{FREE.map((x) => <li key={x}>{x}</li>)}</ul>
          <a className="btn btn-ghost price-cta" href={SMS_HREF}>Text Mano</a>
          <p className="price-fine">No card, no sign up. Just text.</p>
        </article>
        <article className="price plus">
          <Mascot tile wave tone="orange" size={56} className="price-mascot" />
          <div className="price-top">
            <h3>Plus</h3>
            <PlusPrice />
            <p>People who know your case back Mano up.</p>
          </div>
          <ul className="price-rich">
            <li>Everything in Free</li>
            {PLUS.map(([b, t]) => <li key={b}><span><b>{b}</b> {t}</span></li>)}
          </ul>
          <a className="btn btn-primary price-cta" href="#get-mano">Start Plus</a>
          <p className="price-fine">Cancel any time with one text.</p>
        </article>
      </div>

      <details className="cmp-wrap">
        <summary>Compare every feature</summary>
        <table className="cmp">
          <caption className="sr-only">Free and Plus, side by side</caption>
          <thead>
            <tr><td /><th scope="col">Free</th><th scope="col">Plus</th></tr>
          </thead>
          {ROWS.map(([group, rows]) => (
            <tbody key={group}>
              <tr className="cmp-group"><th scope="rowgroup" colSpan={2}>{group}</th><td /></tr>
              {rows.map(([name, a, b]) => (
                <tr key={name}><th scope="row">{name}</th><td><Mark v={a} /></td><td><Mark v={b} /></td></tr>
              ))}
            </tbody>
          ))}
        </table>
      </details>

      <div className="sup">
        <div className="sup-head">
          <span className="sc-label">Included with Plus</span>
          <h3>Support that knows your case.</h3>
          <p>Mano does the paperwork. When you need a person, there is one who has already read your file.</p>
        </div>
        <ul className="sup-list">
          {SUPPORT.map(([icon, b, t]) => (
            <li key={b}>
              {icon === "mano"
                ? <svg className="nd-icon" width={52} height={52} viewBox="0 0 100 100" aria-hidden="true"><rect x="6" y="6" width="88" height="88" rx="26" fill="#FFB26B" stroke="#121212" strokeWidth="4" /><Wave /></svg>
                : <NeedIcon k={icon} size={52} />}
              <b>{b}</b>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="price-note">Faxes and mailed letters are coming soon. They will cost what the post office and phone company charge, and Mano will tell you the price first. Organizations pay per staff seat. <Link href="/organizations">See plans for teams</Link></p>
    </>
  );
}
