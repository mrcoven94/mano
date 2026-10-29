import type { Metadata } from "next";
import Link from "next/link";
import HeroStage from "@/components/home/HeroStage";
import TrustDemo from "@/components/home/TrustDemo";
import ShareFlow from "@/components/home/ShareFlow";
import Everywhere from "@/components/home/Everywhere";
import Improve from "@/components/home/Improve";
import Needs from "@/components/home/Needs";
import Vault from "@/components/home/Vault";
import Reach from "@/components/home/Reach";
import Pricing from "@/components/home/Pricing";
import OpenSource from "@/components/home/OpenSource";
import Faq from "@/components/Faq";
import Mascot from "@/components/Mascot";
import TextQr from "@/components/TextQr";
import { SMS_HREF, SMS_NUMBER, SMS_IS_PLACEHOLDER, PLACEHOLDER_NOTE, REPO_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Mano: AI that helps you pay rent, get food, medicine and child care" },
  description: "Mano is AI that gets you the help you need: rent, food and EBT, light and water bills, medicine, child care, housing and credit. It finds the help, fills out the forms and keeps it coming, and it is free to start.",
  alternates: { canonical: "/" },
};

const faqs: [string, string][] = [
  ["Is Mano really free?", "Keeping your help is always free: notices, renewals, reminders, benefit tracking, mail scans and Mano's own email inbox have no limits, and you can make 5 applications a month. Plus is $8 a month or $60 a year for unlimited applications, a Mano that works every day without being asked, calls and waiting on hold, and a support team that answers the same day and helps with appeals. Faxes and mailed letters are at cost, and Mano tells you the price first."],
  ["Does Mano decide if I get help?", "No. The office that runs the program decides. Mano prepares your application, sends it, follows up and tells you what the office said."],
  ["Who can see my information?", "Only the people and offices you choose, for the reason you choose. You can see who has access and take it back at any time. Mano cannot pull back copies that were already sent, and it tells you which ones those are."],
  ["What happens when Mano makes a call?", "It says who it is right away: \"I'm calling for (your name). I'm their automated assistant. This call is transcribed.\" Mano never pretends to be you or to be a person."],
  ["What if a letter tells Mano to do something?", "Mano treats letters, forms and web pages as information, never as orders. It checks every link before opening it and will not open one that fails the check."],
  ["What do I need to start?", "A phone that can text. Text or iMessage Mano, or open it on the web. Apps for iPhone and Android are in early access. It is the same Mano, with the same memory, everywhere you use it."],
  ["Is Mano part of the government?", "No. Mano is independent. It deals with the offices that run programs for you, so you spend less time on the phone and in line."],
  ["What can Mano help me get?", "Help paying rent, food benefits on an EBT card, help with light and water bills, health coverage and prescriptions, child care, housing waitlists, credit repair and emergency help. If there is a program for it, Mano can find it and apply for you."],
  ["Can nonprofits and government offices use Mano?", "Yes. Each caseworker gets their own Mano for case management: it collects documents, prepares applications and tracks renewals for the people they serve, with each person's permission."],
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

      <section className="h-vault" aria-labelledby="vt-h">
        <div className="wrap">
          <Vault />
        </div>
      </section>

      <section className="h-reach" aria-labelledby="rc-h">
        <div className="wrap">
          <Reach />
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
        <OpenSource />
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
            <a className="btn btn-ghost btn-lg" href="/government">For government</a>
          </div>
          {SMS_IS_PLACEHOLDER ? <p className="note">{PLACEHOLDER_NOTE}</p> : <TextQr />}
        </div>
      </section>
    </div>
  );
}
