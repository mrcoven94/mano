import type { Metadata } from "next";
import Link from "next/link";
import HeroStage from "@/components/home/HeroStage";
import TrustDemo from "@/components/home/TrustDemo";
import Needs from "@/components/home/Needs";
import Pricing from "@/components/home/Pricing";
import Faq from "@/components/Faq";
import Mascot from "@/components/Mascot";
import TextMano from "@/components/TextMano";
import TextQr from "@/components/TextQr";
import { SMS_HREF, SMS_NUMBER, SMS_IS_PLACEHOLDER } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Mano: AI that helps you pay rent, get food, medicine and child care" },
  description: "Mano is AI that gets you the help you need: rent, food and EBT, light and water bills, medicine, child care, housing and credit. It finds the help, fills out the forms and keeps it coming, and it is free to start.",
  alternates: { canonical: "/" },
};

const faqs: [string, string][] = [
  ["Is Mano really free?", "Keeping your help is always free: applications, notices, renewals, reminders, benefit tracking and mail scans have no limits. Plus is $8 a month or $60 a year for a support team that answers the same day and helps with appeals. Daily checks for new help, calls and waiting on hold are coming soon. Faxes and mailed letters are coming soon, at cost, and Mano will tell you the price first."],
  ["Does Mano decide if I get help?", "No. The office that runs the program decides. Mano prepares your application and sends it after your yes. Today that goes only to a practice portal, not a real office."],
  ["Who can see my information?", "Only the people and offices you choose, for the reason you choose. You can see who has access and take it back at any time. Mano cannot pull back copies that were already sent, and it tells you which ones those are."],
  ["Does Mano pretend to be me?", "No. Mano says it is an automated assistant whenever that could be in doubt. Anything it sends for you says \"Prepared with Mano, sent with (your name)'s approval.\" Mano never pretends to be you or to be a person."],
  ["What if a letter tells Mano to do something?", "Mano treats letters, forms and web pages as information, never as orders. It checks every link before opening it and will not open one that fails the check."],
  ["What do I need to start?", `A phone that can text. Text or iMessage Mano at ${SMS_NUMBER}. The Android app is in early access, and iPhone and the web are coming soon. It is the same Mano, with the same memory, everywhere you use it.`],
  ["Is Mano part of the government?", "No. Mano is independent. It deals with the offices that run programs for you, so you spend less time on the phone and in line."],
  ["What can Mano help me get?", "Help paying rent, SNAP food benefits on an EBT card, help with light and water bills, health coverage and prescriptions, child care, housing waitlists, credit repair and emergency help. Today Mano fills out food benefits renewals and files them on a practice portal, and answers questions about food, health coverage and energy bill help in eight states. The rest is coming soon."],
];

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
            <TextMano className="btn btn-primary btn-lg" />
            <Link className="btn btn-ghost btn-lg" href="/how-it-works">How Mano works</Link>
          </div>
          {!SMS_IS_PLACEHOLDER && <TextQr />}
          <nav className="close-links" aria-label="Mano for teams">
            <Link href="/government">For government</Link>
            <Link href="/organizations">For nonprofits</Link>
            <Link href="/how-it-works#open-source">For developers</Link>
          </nav>
        </div>
      </section>
    </div>
  );
}
