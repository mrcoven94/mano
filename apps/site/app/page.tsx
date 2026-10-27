import type { Metadata } from "next";
import Link from "next/link";
import HeroStage from "@/components/home/HeroStage";
import TrustDemo from "@/components/home/TrustDemo";
import ShareFlow from "@/components/home/ShareFlow";
import Faq from "@/components/Faq";
import Mascot from "@/components/Mascot";
import { SMS_HREF, SMS_NUMBER, PLACEHOLDER_NOTE, REPO_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Mano: AI that applies for help, reads your mail and waits on hold" },
  description: "Mano is an agent for every person. It applies for help, fills out any form, reads your mail, renews on time and waits on hold. You approve every step, and applying is free.",
  alternates: { canonical: "/" },
};

const faqs: [string, string][] = [
  ["Is Mano really free?", "Yes. Applying, renewals, deadlines, reminders and filing are free, and they stay free. Plus costs $8 a month or $60 a year and pays for things that cost money to run: phone calls, mailed and faxed letters and a priority line."],
  ["Does Mano decide if I get help?", "No. The office that runs the program decides. Mano prepares your application, sends it when you say yes, follows up and tells you what the office said."],
  ["Do I have to approve everything?", "Yes. Before anything goes out, Mano shows you who it is for, what it is for and the exact copy. If anything changes after you said yes, Mano asks you again."],
  ["Who can see my information?", "Only the people and offices you choose, for the reason you choose. You can see who has access and take it back at any time. Mano cannot pull back copies that were already sent, and it tells you which ones those are."],
  ["What happens when Mano makes a call?", "It says who it is right away: \"I'm calling for (your name). I'm their automated assistant. This call is transcribed.\" Mano never pretends to be you or to be a person."],
  ["What if a letter tells Mano to do something?", "Mano treats letters, forms and web pages as information, never as orders. It checks every link before opening it and will not open one that fails the check."],
  ["What do I need to start?", "A phone that can text. Text or iMessage Mano, or open it on the web. Apps for iPhone and Android are in early access. It is the same Mano, with the same memory, everywhere you use it."],
  ["Is Mano part of the government?", "No. Mano is independent. It deals with the offices that run programs for you, so you spend less time on the phone and in line."],
];

const grant = `{
  "type": "consent.grant",
  "from": "person:maria-lopez",
  "to": "org:northside-family-center",
  "purpose": "food-benefits-renewal",
  "documents": ["pay-stub-2026-10-24"],
  "expires": "2026-12-31",
  "revocable": true
}`;

export default function Home() {
  return (
    <div className="home">
      <HeroStage />

      <section className="h-trust" aria-labelledby="trust-h">
        <div className="wrap">
          <TrustDemo />
        </div>
      </section>

      <section className="h-proof" aria-labelledby="proof-h">
        <div className="wrap proof-grid">
          <div>
            <p className="h-eyebrow">How we test it</p>
            <h2 id="proof-h">Graded on paperwork it has never seen.</h2>
            <p className="lede">Before tuning anything, we froze a set of renewal and document cases that Mano never trains on. A real caseworker reviews sample packets, and every result is checked against the same answers.</p>
            <ul className="proof-cases" aria-label="What the test cases include">
              {["Unreadable pages", "Missing proof", "Dates that conflict", "Hidden instructions", "Scam links"].map((x) => <li key={x}>{x}</li>)}
            </ul>
          </div>
          <div className="score">
            <div className="score-col">
              <p className="sc-label">Compared with</p>
              <ul>
                <li><b>A plain reminder app</b>The way most people track renewals today.</li>
                <li><b>A general AI agent</b>Given the same tools Mano has, without its safeguards.</li>
              </ul>
            </div>
            <div className="score-col">
              <p className="sc-label">Every run reports</p>
              <ul className="score-measures">
                {["Correct packets", "Missed deadlines", "Unsafe actions blocked", "Failures", "Cost", "Time"].map((m) => <li key={m}>{m}</li>)}
              </ul>
            </div>
            <p className="score-note">Results are published with the final run, including the cases Mano gets wrong. We make no claims before then.</p>
          </div>
        </div>
      </section>

      <section className="h-share" aria-labelledby="share-h">
        <div className="wrap">
          <ShareFlow />
        </div>
      </section>

      <section className="h-open" aria-labelledby="open-h">
        <div className="wrap open-grid">
          <div>
            <p className="h-eyebrow">MIT license</p>
            <h2 id="open-h">Open source, from the first commit.</h2>
            <p className="lede">The code and the protocol that lets agents share a case are public. Any agency, nonprofit or developer can read how Mano works, build on it or run their own copy.</p>
            <ul className="open-facts">
              <li><b>Consent is a record.</b> Every share names who, why and until when, and can be taken back.</li>
              <li><b>Every action is logged first.</b> Mano decides, writes it down, then acts. If anything is unclear, it stops.</li>
              <li><b>Runs without our accounts.</b> Every part works locally with stand-ins, so you can try it today.</li>
            </ul>
            <div className="btn-row" style={{ marginTop: 32 }}>
              <a className="btn btn-primary" href={REPO_URL}>Read the code</a>
              <a className="btn btn-ghost" href={`${REPO_URL}#readme`}>Run your own</a>
            </div>
          </div>
          <figure className="code" aria-label="An example consent grant">
            <figcaption><span className="sc-label">consent-grant.json</span><span className="sc-label">Example</span></figcaption>
            <pre><code>{grant}</code></pre>
          </figure>
        </div>
      </section>

      <section id="pricing" className="h-price" aria-labelledby="pricing-h">
        <div className="wrap">
          <div className="h-head">
            <p className="h-eyebrow">Pricing</p>
            <h2 id="pricing-h">Getting help is free, and it stays free.</h2>
          </div>
          <div className="price-grid">
            <article className="price">
              <div className="price-top"><h3>Free</h3><p className="amt">$0</p><p>Everything you need to get help and keep it.</p></div>
              <ul>
                <li>Applying for programs, jobs and scholarships</li>
                <li>Renewals and deadlines</li>
                <li>Reminders before anything is due</li>
                <li>Reading your mail from a photo</li>
                <li>Filling out and filing forms</li>
              </ul>
            </article>
            <article className="price plus">
              <div className="price-top"><h3>Plus</h3><p className="amt">$8<small> a month, or $60 a year</small></p><p>For the things that cost us money to do for you.</p></div>
              <ul>
                <li>Everything in Free</li>
                <li>Phone calls for you, including waiting on hold</li>
                <li>Letters mailed and faxed for you</li>
                <li>A priority line when you need a person fast</li>
              </ul>
            </article>
          </div>
          <p className="price-note">Organizations pay per staff seat. <Link href="/organizations">See plans for teams</Link></p>
        </div>
      </section>

      <Faq items={faqs} />

      <section id="get-mano" className="h-close" aria-labelledby="close-h">
        <div className="wrap">
          <Mascot tile wave tone="orange" size={88} className="close-mascot" />
          <h2 id="close-h">Start with the letter you have been putting off.</h2>
          <p className="lede">Text Mano a photo. It will tell you what the letter says, what you can do and what happens next.</p>
          <a className="close-num" href={SMS_HREF}>{SMS_NUMBER}</a>
          <div className="btn-row">
            <a className="btn btn-primary btn-lg" href={SMS_HREF}>Text Mano</a>
            <a className="btn btn-ghost btn-lg" href="/government">For offices</a>
          </div>
          <p className="note">{PLACEHOLDER_NOTE}</p>
        </div>
      </section>
    </div>
  );
}
