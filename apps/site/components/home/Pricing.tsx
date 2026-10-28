import Link from "next/link";
import PlusPrice from "./PlusPrice";

/* Two plans and a full side by side. Keeping help is free for everyone; Plus adds unlimited applications, a Mano that
   works every day without being asked, and a support team. Faxes and mail cost real money, so they are at cost on both. */

const FREE = [
  "3 applications a month",
  "Unlimited renewals, deadlines and reminders",
  "Unlimited mail scans and documents",
  "Every benefit tracked in one place",
  "Text, iMessage, the app and the web",
];

const PLUS: [string, string][] = [
  ["Unlimited applications.", "Every program you qualify for, as many as you need, every month."],
  ["Always on.", "Mano checks your accounts and portals every day, finds new help you qualify for and starts renewals early, without being asked."],
  ["Its own computer and email.", "Mano creates and signs in to your county, landlord and utility accounts, with your OK for each one."],
  ["Calls and waiting on hold.", "Mano calls the office for you and hands you the phone when a person picks up."],
  ["A support team that knows your case.", "Real people, ready when you need more than Mano."],
];

const SUPPORT: [string, string][] = [
  ["Answers the same day.", "Text support and hear back from a person who has read your file, so you never explain it twice."],
  ["Help when you are turned down.", "Mano reads the denial and writes the appeal, and a person checks it before it goes. If there is a hearing, you will be ready for it."],
  ["Ready for every interview.", "Practice the questions the office will ask and get a list of exactly what to bring."],
  ["First in line when it is urgent.", "A shutoff or eviction notice moves your case to the front, any day of the week."],
  ["A yearly checkup.", "Once a year a person goes over everything you get and finds what you are missing."],
  ["Someone on your side.", "If an office is not answering, support follows up with them until your case moves."],
];

type Cell = string | boolean;
const ROWS: [string, [string, Cell, Cell][]][] = [
  ["Getting help", [
    ["Applications", "3 a month", "Unlimited"],
    ["Programs checked for you", "Every one", "Every one"],
    ["Renewals, deadlines and reminders", "Unlimited", "Unlimited"],
    ["Mail scans and documents", "Unlimited", "Unlimited"],
    ["Benefit tracking", true, true],
  ]],
  ["Mano does it for you", [
    ["Always on, checks every day", false, true],
    ["Its own computer and email", false, true],
    ["Calls and waiting on hold", false, true],
    ["Credit disputes", "Written for you", "Written and followed up"],
    ["Faxes and mailed letters", "At cost", "At cost"],
  ]],
  ["Support", [
    ["Same-day answers from a person", false, true],
    ["Appeals when you are turned down", "Denial explained", "Written and checked"],
    ["Interview practice", false, true],
    ["Urgent cases first", false, true],
    ["Yearly checkup", false, true],
  ]],
  ["Always included", [
    ["You approve everything before it is sent", true, true],
    ["Share a case with your caseworker", true, true],
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
        <p className="lede">Renewals, reminders and mail are free for everyone. Plus is $8 a month for unlimited applications, a Mano that works every day without being asked and a support team that knows your case.</p>
      </div>

      <div className="price-grid">
        <article className="price">
          <div className="price-top">
            <h3>Free</h3>
            <p className="amt">$0<small> forever</small></p>
            <p>Mano works whenever you text it.</p>
          </div>
          <ul>{FREE.map((x) => <li key={x}>{x}</li>)}</ul>
        </article>
        <article className="price plus">
          <div className="price-top">
            <h3>Plus</h3>
            <PlusPrice />
            <p>Mano works every day, and people back it up.</p>
          </div>
          <ul className="price-rich">
            <li>Everything in Free</li>
            {PLUS.map(([b, t]) => <li key={b}><span><b>{b}</b> {t}</span></li>)}
          </ul>
          <a className="btn btn-primary price-cta" href="#get-mano">Start Plus</a>
          <p className="price-fine">Cancel any time with one text.</p>
        </article>
      </div>

      <div className="sup">
        <div className="sup-head">
          <span className="sc-label">Included with Plus</span>
          <h3>Support that knows your case.</h3>
          <p>Mano does the paperwork. When you need a person, there is one who has already read your file.</p>
        </div>
        <ul className="sup-list">
          {SUPPORT.map(([b, t]) => <li key={b}><b>{b}</b><span>{t}</span></li>)}
        </ul>
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
      <p className="price-note">Faxes and mailed letters cost what the post office and phone company charge. Mano tries the free way first and tells you the price before anything costs money. Organizations pay per staff seat. <Link href="/organizations">See plans for teams</Link></p>
    </>
  );
}
