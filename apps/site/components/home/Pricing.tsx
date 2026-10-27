import Link from "next/link";
import PlusPrice from "./PlusPrice";

/* Two plans and a full side by side. Free covers getting help; Plus pays for the things that cost money to run. */

const FREE = [
  "Unlimited applications, for every program you qualify for",
  "Unlimited renewals, deadlines and reminders",
  "Unlimited mail scans and documents",
  "Every benefit tracked in one place",
  "Text, iMessage, the app and the web",
];

const PLUS: [string, string][] = [
  ["Its own computer.", "Mano creates and signs in to your county, landlord and utility accounts for you, with your OK for each one, and keeps them signed in."],
  ["Its own phone number and email.", "Offices call and write to Mano directly, so nothing gets lost in your voicemail or inbox."],
  ["Unlimited calls.", "Mano calls for you, waits on hold and hands you the call when a person picks up."],
  ["Unlimited faxes and mailed letters.", "Including certified mail when you need proof it arrived."],
  ["Credit repair, done for you.", "Disputes written, mailed and followed until they are answered."],
  ["A priority line.", "Reach a real person fast when something cannot wait."],
];

type Cell = string | boolean;
const ROWS: [string, [string, Cell, Cell][]][] = [
  ["Getting help", [
    ["Applications", "Unlimited", "Unlimited"],
    ["Programs checked for you", "Every one", "Every one"],
    ["Renewals, deadlines and reminders", "Unlimited", "Unlimited"],
    ["Mail scans and documents", "Unlimited", "Unlimited"],
    ["Benefit tracking", true, true],
  ]],
  ["Mano does it for you", [
    ["Its own computer for websites and accounts", false, true],
    ["Its own phone number and email", false, true],
    ["Calls and waiting on hold", false, "Unlimited"],
    ["Faxes and mailed letters", false, "Unlimited"],
    ["Credit disputes", "Written for you", "Mailed and followed"],
    ["Priority line to a person", false, true],
  ]],
  ["Always included", [
    ["You approve everything before it is sent", true, true],
    ["Share a case with your caseworker", true, true],
    ["Usage limits", "None", "None"],
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
        <h2 id="pricing-h">Getting help is free, and it stays free.</h2>
        <p className="lede">Plus is $8 a month. It gives Mano its own computer, phone number and email, so it can do every step for you, start to finish.</p>
      </div>

      <div className="price-grid">
        <article className="price">
          <div className="price-top">
            <h3>Free</h3>
            <p className="amt">$0<small> forever</small></p>
            <p>Everything you need to get help and keep it.</p>
          </div>
          <ul>{FREE.map((x) => <li key={x}>{x}</li>)}</ul>
        </article>
        <article className="price plus">
          <div className="price-top">
            <h3>Plus</h3>
            <PlusPrice />
            <p>Mano handles the calls, the mail and the logins too.</p>
          </div>
          <ul className="price-rich">
            <li>Everything in Free</li>
            {PLUS.map(([b, t]) => <li key={b}><span><b>{b}</b> {t}</span></li>)}
          </ul>
          <a className="btn btn-primary price-cta" href="#get-mano">Start Plus</a>
          <p className="price-fine">Cancel any time with one text.</p>
        </article>
      </div>

      <div className="cmp-wrap">
        <table className="cmp">
          <caption className="sr-only">Free and Plus, side by side</caption>
          <thead>
            <tr><th scope="col"><span className="sc-label">Compare plans</span></th><th scope="col">Free</th><th scope="col">Plus</th></tr>
          </thead>
          {ROWS.map(([group, rows]) => (
            <tbody key={group}>
              <tr className="cmp-group"><th scope="rowgroup" colSpan={3}>{group}</th></tr>
              {rows.map(([name, a, b]) => (
                <tr key={name}><th scope="row">{name}</th><td><Mark v={a} /></td><td><Mark v={b} /></td></tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <p className="price-note">Unlimited means no caps for your own household. Organizations pay per staff seat. <Link href="/organizations">See plans for teams</Link></p>
    </>
  );
}
