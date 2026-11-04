import type { Metadata } from "next";
import Link from "next/link";
import Mascot from "@/components/Mascot";
import TextMano from "@/components/TextMano";
import TextQr from "@/components/TextQr";
import { NeedIcon } from "@/components/home/NeedIcons";
import OpenSource from "@/components/home/OpenSource";
import { SMS_IS_PLACEHOLDER } from "@/lib/site";

const title = "How Mano works";
const description = "How Mano goes from a photo of your renewal letter to a filing on a practice portal: it reads the letter, tracks the deadline, fills out the form and files after your yes.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/how-it-works" }, openGraph: { title, description } };

/* Each step pairs a plain sentence with what Maria (made up) sees at that moment. */
const STEPS: { short: string; title: string; text: string; icon: string; tint: string; see: React.ReactNode }[] = [
  {
    short: "Tell Mano",
    title: "You tell Mano what is going on",
    text: "Text it or iMessage it. Use your own words, or send a photo of the letter you have been putting off.",
    icon: "chat",
    tint: "#FDEBD8",
    see: (
      <>
        <div className="hw-letter" aria-hidden="true">
          <p>Springfield County Food Assistance Office</p>
          <b>Notice of renewal</b>
          <i /><i /><i className="hl" /><i />
        </div>
        <p className="bub me">Got this from the county. What does it mean?</p>
      </>
    ),
  },
  {
    short: "Read it",
    title: "Mano reads the letter and names the date",
    text: "It finds the deadline that matters and quotes the line it came from. It also answers questions about food, health coverage and energy bill help in eight states, each fact sourced to the official page.",
    icon: "programs",
    tint: "#FDE3DA",
    see: (
      <div className="hw-card">
        <p className="hw-card-h">What Mano read</p>
        <ul className="hw-rows">
          <li><NeedIcon k="food" size={30} /><b>Food benefits</b><span className="hw-tag hot">Renew by Nov 14</span></li>
        </ul>
      </div>
    ),
  },
  {
    short: "Fill forms",
    title: "It fills out the renewal",
    text: "Mano fills out the food benefits renewal from your letter and what you already told it. If it does not know something, it asks you one plain question instead of guessing.",
    icon: "clipboard",
    tint: "#FFF4B8",
    see: (
      <div className="hw-card">
        <p className="hw-card-h">Food benefits renewal</p>
        <dl className="hw-form">
          <div><dt>Name</dt><dd>Maria Torres</dd><small>From your letter</small></div>
          <div><dt>Monthly income</dt><dd>$1,940</dd><small>You told Mano</small></div>
          <div><dt>People at home</dt><dd>2</dd><small>You told Mano</small></div>
        </dl>
        <p className="hw-done"><mark>Filled from what you sent.</mark> You check it before it goes.</p>
      </div>
    ),
  },
  {
    short: "Keep track",
    title: "Mano sends it and keeps track",
    text: "After your yes it files the renewal and checks that it arrived. Today that goes only to a practice portal, not a real office.",
    icon: "phone",
    tint: "#DCE3FB",
    see: (
      <div className="hw-card">
        <ol className="hw-trail">
          <li><b>You said yes</b><span>Nov 10</span></li>
          <li><b>Filed on the practice portal</b><span>Nov 10</span></li>
          <li className="ok"><b>Checked that it arrived. Confirmation <span className="nb">SR-G6WYKQU8</span></b><span>Nov 10</span></li>
        </ol>
      </div>
    ),
  },
  {
    short: "Remind you",
    title: "It reminds you before each date",
    text: "Mano texts you 14, 7 and 2 days before a date it is holding, or the day before an interview.",
    icon: "calendar",
    tint: "#E4F1E8",
    see: (
      <div className="hw-card">
        <p className="hw-card-h">Maria&rsquo;s dates</p>
        <ul className="hw-cal">
          <li><span className="hw-day"><small>Nov</small>14</span><div><b>Food benefits renewal</b><small>Mano texts you 14, 7 and 2 days before</small></div></li>
          <li><span className="hw-day"><small>Nov</small>18</span><div><b>Interview</b><small>Mano texts you the day before</small></div></li>
        </ul>
      </div>
    ),
  },
];

const NEVER: [string, string][] = [
  ["Never decides your case.", "The office that runs the program decides. Mano prepares it, and sends it after your yes."],
  ["Never pretends to be you or a person.", "It says it is an automated assistant, and what it sends for Maria says \"Prepared with Mano, sent with Maria's approval.\""],
  ["Never takes orders from a letter.", "Letters, forms and web pages are information. Instructions inside them are ignored."],
  ["Never opens a link that fails the check.", "Every link is checked before Mano or you open it."],
  ["Never sells your data.", "Nothing goes out without your yes."],
];

export default function HowItWorks() {
  return (
    <div className="team hw">
      <div className="t-hero hw-hero">
        <div className="wrap">
          <h1>From a photo of your letter to <mark className="h-phrase">a filed renewal.</mark></h1>
          <p className="h-lede">Here is what happens after you text Mano a photo of your renewal letter. Mano is free in this demo, and today it files only on a practice portal, not a real office.</p>
          <ol className="hw-path">
            {STEPS.map((s, n) => (
              <li key={s.short}>
                <a href={`#step-${n + 1}`} style={{ background: s.tint }}>
                  <NeedIcon k={s.icon} size={44} />
                  <span><small>{n + 1}</small>{s.short}</span>
                </a>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <section className="hw-steps-wrap" aria-labelledby="hw-steps-h">
        <div className="wrap">
          <h2 id="hw-steps-h" className="sr-only">The steps</h2>
          <ol className="hw-steps">
            {STEPS.map((s, n) => (
              <li key={s.title} id={`step-${n + 1}`} className="hw-step">
                <div className="hw-body">
                  <span className="hw-n">{n + 1}</span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </div>
                <div className="hw-see" style={{ background: s.tint }}>{s.see}</div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="hw-never-wrap" aria-labelledby="hw-never-h">
        <div className="wrap hw-never-grid">
          <div className="hw-never-head">
            <h2 id="hw-never-h">What Mano will never do.</h2>
            <Mascot tile tone="orange" size={120} className="hw-never-mascot" />
          </div>
          <ul className="hw-never">
            {NEVER.map(([b, t]) => <li key={b}><span className="hw-x" aria-hidden="true" /><div><b>{b}</b><span>{t}</span></div></li>)}
          </ul>
        </div>
      </section>

      <section id="open-source" className="h-open" aria-labelledby="open-h">
        <OpenSource />
      </section>

      <section className="h-close" aria-labelledby="hw-cta-h">
        <div className="wrap">
          <Mascot tile wave tone="orange" size={88} className="close-mascot" />
          <h2 id="hw-cta-h">Text a photo of your renewal letter.</h2>
          <p className="lede">Mano will find the date and tell you what happens next.</p>
          <div className="btn-row">
            <TextMano className="btn btn-primary btn-lg" />
            <Link className="btn btn-ghost btn-lg" href="/renewals">About renewals</Link>
          </div>
          {!SMS_IS_PLACEHOLDER && <TextQr />}
        </div>
      </section>
    </div>
  );
}
