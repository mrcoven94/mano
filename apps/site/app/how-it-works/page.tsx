import type { Metadata } from "next";
import Link from "next/link";
import Mascot from "@/components/Mascot";
import { NeedIcon } from "@/components/home/NeedIcons";
import { REPO_URL, SMS_HREF } from "@/lib/site";

const title = "How Mano works";
const description = "How Mano goes from one text to help that keeps coming: it finds what you qualify for, fills out the forms from your private vault, asks before anything is sent, follows up and renews on time.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/how-it-works" }, openGraph: { title, description } };

/* Each step pairs a plain sentence with what Maria (made up) sees at that moment. */
const STEPS: { title: string; text: string; icon: string; see: React.ReactNode }[] = [
  {
    title: "You tell Mano what is going on",
    text: "Text it, iMessage it, or open the app or the web. Use your own words, or send a photo of the letter you have been putting off.",
    icon: "programs",
    see: <p className="bub me">Got a letter from the county. What does it mean?</p>,
  },
  {
    title: "Mano finds the help",
    text: "It checks every program you might qualify for. It knows what each office offers, when it is open and how to reach it, in every county.",
    icon: "food",
    see: <p className="bub mano">You likely qualify for 4 programs. Food benefits is the biggest, and your renewal is due Nov 14.</p>,
  },
  {
    title: "It fills out the forms from your vault",
    text: "Your ID, pay stubs, lease and the rest go into your private vault once. Mano uses them for every application, so you never type the same thing twice.",
    icon: "housing",
    see: <p className="hw-card"><b>Filled from your vault.</b> 5 things used, nothing typed twice.</p>,
  },
  {
    title: "You approve it",
    text: "Mano shows who it is going to, why, and the exact pages. If a word changes after you say yes, it asks you again.",
    icon: "credit",
    see: <p className="hw-card"><b>Send to Sample County?</b> Food benefits renewal, 6 pages. <span className="hw-yes">Yes, send it</span></p>,
  },
  {
    title: "Mano sends it and follows up",
    text: "It submits the application, calls the office and waits on hold when it has to, and tells you what they said.",
    icon: "bills",
    see: <p className="bub mano">Approved. Your food benefits continue through May.</p>,
  },
  {
    title: "It keeps your help coming",
    text: "Renewals start early, every deadline is tracked, and Mano tells you when new help you qualify for opens up.",
    icon: "now",
    see: <p className="hw-card"><b>Next renewal: April 2.</b> Mano starts it March 1.</p>,
  },
];

const NEVER: [string, string][] = [
  ["Never decides your case.", "The office that runs the program decides. Mano prepares, sends and follows up."],
  ["Never sends without your yes.", "Each yes covers one recipient, one purpose and one exact copy."],
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
          <p className="h-eyebrow">How Mano works</p>
          <h1>From one text to <mark className="h-phrase">help that keeps coming.</mark></h1>
          <p className="h-lede">Mano is your own agent for rent, food, bills, medicine, child care and every program in between. Here is what happens after you send the first message.</p>
        </div>
      </div>

      <section className="hw-steps-wrap" aria-labelledby="hw-steps-h">
        <div className="wrap">
          <h2 id="hw-steps-h" className="sr-only">The steps</h2>
          <ol className="hw-steps">
            {STEPS.map((s, n) => (
              <li key={s.title} className="hw-step">
                <div className="hw-mark"><span className="hw-n">{n + 1}</span><NeedIcon k={s.icon} size={52} /></div>
                <div className="hw-body">
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </div>
                <div className="hw-see">{s.see}</div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="t-rules" aria-labelledby="hw-never-h">
        <div className="wrap">
          <div className="h-head">
            <p className="h-eyebrow">The rules Mano follows</p>
            <h2 id="hw-never-h">What Mano will never do.</h2>
          </div>
          <ul className="hw-never">
            {NEVER.map(([b, t]) => <li key={b}><b>{b}</b><span>{t}</span></li>)}
          </ul>
        </div>
      </section>

      <section className="t-more" aria-labelledby="hw-team-h">
        <div className="wrap open-grid">
          <div>
            <p className="h-eyebrow">When you want help from a person</p>
            <h2 id="hw-team-h">Bring your caseworker in.</h2>
            <p className="lede">Share a case with a caseworker or a nonprofit for one purpose, like a renewal. Their Mano works on it with yours, they see only what you shared, and you can stop sharing at any time. <Link href="/organizations">How teams use Mano</Link></p>
          </div>
          <div>
            <p className="h-eyebrow">Built in the open</p>
            <h2>Anyone can check the work.</h2>
            <p className="lede">The code is public. Mano is tested on paperwork it has never seen, next to a reminder app and a general AI agent, and the results are published, including what it gets wrong. <a href={REPO_URL}>Read the code</a></p>
          </div>
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
        </div>
      </section>
    </div>
  );
}
