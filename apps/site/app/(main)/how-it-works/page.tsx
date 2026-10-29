import type { Metadata } from "next";
import Link from "next/link";
import Mascot from "@/components/Mascot";
import TextQr from "@/components/TextQr";
import { NeedIcon } from "@/components/home/NeedIcons";
import { REPO_URL, SMS_HREF, SMS_IS_PLACEHOLDER } from "@/lib/site";

const title = "How Mano works";
const description = "How Mano goes from one text to help that keeps coming: it finds what you qualify for, fills out the forms from your private vault, follows up and renews on time.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/how-it-works" }, openGraph: { title, description } };

/* Each step pairs a plain sentence with what Maria (made up) sees at that moment. */
const STEPS: { short: string; title: string; text: string; icon: string; tint: string; see: React.ReactNode }[] = [
  {
    short: "Tell Mano",
    title: "You tell Mano what is going on",
    text: "Text it, iMessage it, or open the app or the web. Use your own words, or send a photo of the letter you have been putting off.",
    icon: "chat",
    tint: "#FDEBD8",
    see: (
      <>
        <div className="hw-letter" aria-hidden="true">
          <p>Sample County Human Services</p>
          <b>Notice of renewal</b>
          <i /><i /><i className="hl" /><i />
        </div>
        <p className="bub me">Got this from the county. What does it mean?</p>
      </>
    ),
  },
  {
    short: "Find help",
    title: "Mano finds the help",
    text: "It checks every program you might qualify for. It knows what each office offers, when it is open and how to reach it, in every county.",
    icon: "programs",
    tint: "#FDE3DA",
    see: (
      <div className="hw-card">
        <p className="hw-card-h">You likely qualify for 4 programs</p>
        <ul className="hw-rows">
          <li><NeedIcon k="food" size={30} /><b>Food benefits</b><span className="hw-tag hot">Renew by Nov 14</span></li>
          <li><NeedIcon k="bills" size={30} /><b>Light bill help</b><span className="hw-tag">Open now</span></li>
          <li><NeedIcon k="medicine" size={30} /><b>Health coverage</b><span className="hw-tag">You qualify</span></li>
          <li><NeedIcon k="childcare" size={30} /><b>Child care</b><span className="hw-tag">Opens Jan 6</span></li>
        </ul>
      </div>
    ),
  },
  {
    short: "Fill forms",
    title: "It fills out the forms from your vault",
    text: "Your ID, pay stubs, lease and the rest go into your private vault once. Mano uses them for every application, so you never type the same thing twice.",
    icon: "clipboard",
    tint: "#FFF4B8",
    see: (
      <div className="hw-card">
        <p className="hw-card-h">Food benefits renewal</p>
        <dl className="hw-form">
          <div><dt>Name</dt><dd>Maria Lopez</dd><small>From your ID</small></div>
          <div><dt>Monthly income</dt><dd>$2,570</dd><small>From your pay stubs</small></div>
          <div><dt>People at home</dt><dd>3</dd><small>From your household</small></div>
        </dl>
        <p className="hw-done"><mark>Filled from your vault.</mark> Nothing typed twice.</p>
      </div>
    ),
  },
  {
    short: "Follow up",
    title: "Mano sends it and follows up",
    text: "It submits the application, calls the office and waits on hold when it has to, and tells you what they said.",
    icon: "phone",
    tint: "#DCE3FB",
    see: (
      <div className="hw-card">
        <ol className="hw-trail">
          <li><b>Sent to Sample County</b><span>Oct 28</span></li>
          <li><b>Called the office, waited 47 minutes</b><span>Nov 3</span></li>
          <li><b>They asked for one more pay stub. Mano sent it.</b><span>Nov 3</span></li>
          <li className="ok"><b>Approved through May</b><span>Nov 6</span></li>
        </ol>
      </div>
    ),
  },
  {
    short: "Keep it",
    title: "It keeps your help coming",
    text: "Renewals start early, every deadline is tracked, and Mano tells you when new help you qualify for opens up.",
    icon: "calendar",
    tint: "#E4F1E8",
    see: (
      <div className="hw-card">
        <p className="hw-card-h">Maria&rsquo;s next few months</p>
        <ul className="hw-cal">
          <li><span className="hw-day"><small>Mar</small>1</span><div><b>Food benefits renewal</b><small>Mano starts it a month early</small></div></li>
          <li><span className="hw-day"><small>May</small>15</span><div><b>Summer meals for Leo and Ana</b><small>New, and they qualify</small></div></li>
          <li><span className="hw-day"><small>Jun</small>2</span><div><b>Light bill help</b><small>Reapply, already filled in</small></div></li>
        </ul>
      </div>
    ),
  },
];

const NEVER: [string, string][] = [
  ["Never decides your case.", "The office that runs the program decides. Mano prepares, sends and follows up."],
  ["Never pretends to be you or a person.", "On calls it says \"I'm calling for Maria. I'm her automated assistant.\" and that the call is transcribed."],
  ["Never takes orders from a letter.", "Letters, forms and web pages are information. Instructions inside them are ignored."],
  ["Never opens a link that fails the check.", "Every link is checked before Mano or you open it."],
  ["Never sells your data.", "Only the people and offices you choose see your case, for the reason you choose, and you can take it back."],
];

export default function HowItWorks() {
  return (
    <div className="team hw">
      <div className="t-hero hw-hero">
        <div className="wrap">
          <h1>From one text to <mark className="h-phrase">help that keeps coming.</mark></h1>
          <p className="h-lede">Mano is your own agent for rent, food, bills, medicine, child care and every program in between. Here is what happens after you send the first message.</p>
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

      <section className="hw-duo-wrap" aria-label="More">
        <div className="wrap hw-duo">
          <article className="hw-duo-card share">
            <NeedIcon k="chat" size={52} />
            <h2>Bring your caseworker in.</h2>
            <p>Share a case with a caseworker or a nonprofit for one purpose, like a renewal. Their Mano works on it with yours, they see only what you shared, and you can stop sharing at any time.</p>
            <div className="hw-chip"><NeedIcon k="clipboard" size={28} /><span><b>Pay stub, Oct 24</b> Shared with Northside until Dec 31</span></div>
            <Link className="btn btn-ghost" href="/organizations">How teams use Mano</Link>
          </article>
          <article className="hw-duo-card repo">
            <NeedIcon k="code" size={52} />
            <h2>Anyone can check the work.</h2>
            <p>The code is public. Mano is tested on paperwork it has never seen, next to a reminder app and a general AI agent, and the results are published, including what it gets wrong.</p>
            <a className="btn btn-ghost" href={REPO_URL}>Read the code</a>
          </article>
        </div>
      </section>

      <section className="h-close" aria-labelledby="hw-cta-h">
        <div className="wrap">
          <Mascot tile wave tone="orange" size={88} className="close-mascot" />
          <h2 id="hw-cta-h">Start with one text.</h2>
          <p className="lede">Tell Mano what you need this month. It will tell you what help there is and start on it tonight.</p>
          <div className="btn-row">
            <a className="btn btn-primary btn-lg" href={SMS_HREF}>Text Mano</a>
            <Link className="btn btn-ghost btn-lg" href="/#pricing">See pricing</Link>
          </div>
          {!SMS_IS_PLACEHOLDER && <TextQr />}
        </div>
      </section>
    </div>
  );
}
