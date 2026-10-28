import type { Metadata } from "next";
import Link from "next/link";
import HeroStage from "@/components/home/HeroStage";
import TrustDemo from "@/components/home/TrustDemo";
import ShareFlow from "@/components/home/ShareFlow";
import Everywhere from "@/components/home/Everywhere";
import Improve from "@/components/home/Improve";
import Needs from "@/components/home/Needs";
import Pricing from "@/components/home/Pricing";
import Faq from "@/components/Faq";
import Mascot from "@/components/Mascot";
import { SMS_HREF, SMS_NUMBER, PLACEHOLDER_NOTE, REPO_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Mano: AI that helps you pay rent, get food, medicine and child care" },
  description: "Mano is AI that gets you the help you need: rent, food and EBT, light and water bills, medicine, child care, housing and credit. It finds the help, fills out the forms and keeps it coming. You approve every step, and it is free to start.",
  alternates: { canonical: "/" },
};

const faqs: [string, string][] = [
  ["Is Mano really free?", "Keeping your help is always free: renewals, reminders, mail scans and documents have no limits, and you can make 3 applications a month. Plus is $8 a month or $60 a year for unlimited applications, a Mano that works every day without being asked, calls and waiting on hold, and a support team that answers the same day and helps with appeals. Faxes and mailed letters are at cost, and Mano tells you the price first."],
  ["Does Mano decide if I get help?", "No. The office that runs the program decides. Mano prepares your application, sends it when you say yes, follows up and tells you what the office said."],
  ["Do I have to approve everything?", "Yes. Before anything goes out, Mano shows you who it is for, what it is for and the exact copy. If anything changes after you said yes, Mano asks you again."],
  ["Who can see my information?", "Only the people and offices you choose, for the reason you choose. You can see who has access and take it back at any time. Mano cannot pull back copies that were already sent, and it tells you which ones those are."],
  ["What happens when Mano makes a call?", "It says who it is right away: \"I'm calling for (your name). I'm their automated assistant. This call is transcribed.\" Mano never pretends to be you or to be a person."],
  ["What if a letter tells Mano to do something?", "Mano treats letters, forms and web pages as information, never as orders. It checks every link before opening it and will not open one that fails the check."],
  ["What do I need to start?", "A phone that can text. Text or iMessage Mano, or open it on the web. Apps for iPhone and Android are in early access. It is the same Mano, with the same memory, everywhere you use it."],
  ["Is Mano part of the government?", "No. Mano is independent. It deals with the offices that run programs for you, so you spend less time on the phone and in line."],
  ["What can Mano help me get?", "Help paying rent, food benefits on an EBT card, help with light and water bills, health coverage and prescriptions, child care, housing waitlists, credit repair and emergency help. If there is a program for it, Mano can find it and apply for you."],
  ["Can nonprofits and government offices use Mano?", "Yes. Each caseworker gets their own Mano for case management: it collects documents, prepares applications and tracks renewals for the people they serve, with each person's permission."],
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

      <section className="h-needs" aria-labelledby="nd-h">
        <div className="wrap">
          <Needs />
        </div>
      </section>

      <section className="h-trust" aria-labelledby="trust-h">
        <div className="wrap">
          <TrustDemo />
        </div>
      </section>

      <section className="h-dv" aria-labelledby="dv-h">
        <div className="wrap">
          <Everywhere />
        </div>
      </section>

      <section className="h-share" aria-labelledby="share-h">
        <div className="wrap">
          <ShareFlow />
        </div>
      </section>

      <section className="h-improve" aria-labelledby="im-h">
        <div className="wrap">
          <Improve />
        </div>
      </section>

      <section className="h-open" aria-labelledby="open-h">
        <div className="wrap open-grid">
          <div>
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
          <Pricing />
        </div>
      </section>

      <Faq items={faqs} />

      <section id="get-mano" className="h-close" aria-labelledby="close-h">
        <div className="wrap">
          <Mascot tile wave tone="orange" size={88} className="close-mascot" />
          <h2 id="close-h">Start with the letter you have been putting off.</h2>
          <p className="lede">Or just tell Mano what you need this month. Rent, food, a bill, medicine, child care. It will tell you what help there is and start on it tonight.</p>
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
