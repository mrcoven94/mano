import type { Metadata } from "next";
import Link from "next/link";
import HeroStage from "@/components/home/HeroStage";
import MedicaidExample from "@/components/home/MedicaidExample";
import TrustDemo from "@/components/home/TrustDemo";
import Needs from "@/components/home/Needs";
import { NeedIcon } from "@/components/home/NeedIcons";
import Faq from "@/components/Faq";
import Mascot from "@/components/Mascot";
import TextMano from "@/components/TextMano";
import TextQr from "@/components/TextQr";
import { SMS_HREF, SMS_NUMBER, SMS_IS_PLACEHOLDER } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Mano: find, apply for and track your benefits" },
  description: "Mano helps you find, apply for and track your benefits across rent, food, health care, child care, bills and transportation. Today it reads your letters, tracks your deadlines and files food benefits renewals after your yes. Mano is free in this demo and files only on a practice portal.",
  alternates: { canonical: "/" },
};

const TODAY: [icon: string, title: string, text: string][] = [
  ["programs", "Find", "Ask what help there is. Mano answers questions about food benefits, health coverage and energy bill help in California, Texas, New York, Florida, Illinois, Washington, Arizona and Ohio, each fact sourced to the official page. It can give a rough income check. The office decides if you qualify."],
  ["clipboard", "Apply", "Today this is one form. Mano fills out the food benefits renewal and files it after your yes, on a practice portal. The portal is made up, so nothing reaches a real office. New applications and other forms are coming soon."],
  ["calendar", "Track", "Mano reads your letter, finds the deadline that matters and quotes the line it came from. After you say so, Mano keeps the date and texts you before it."],
];

const faqs: [string, string][] = [
  ["Is Mano free?", "Yes. Mano is free in this demo. There is no card and no sign up."],
  ["Does Mano file with a real office?", "No. Today Mano files only on a practice portal. If you have a real renewal due, you still need to send it to your office yourself."],
  ["Does Mano decide if I get help?", "No. The office that runs the program decides."],
  ["Who can see what I send?", "Mano uses it to answer you and keeps it in your own private record. Nothing goes out without your yes, and Mano never sells your data."],
  ["Does Mano pretend to be me?", "No. Mano says it is an automated assistant whenever that could be in doubt. Anything it sends for you says \"Prepared with Mano, sent with (your name)'s approval.\" Mano never pretends to be you or to be a person."],
  ["What if a letter tells Mano to do something?", "Mano treats letters, forms and web pages as information, never as orders. It checks every link before opening it and will not open one that fails the check."],
  ["What do I need to start?", `A phone that can text. Text or iMessage Mano at ${SMS_NUMBER}.`],
  ["Is Mano part of the government?", "No. Mano is independent."],
  ["What can Mano help me with?", "Mano is built to help with rent, food, health care, child care, bills and transportation. Today it reads your letters, keeps the date after you say so, fills out food benefits renewals and files them on a practice portal, and answers questions about food benefits, health coverage and energy bill help in eight states. The rest is coming soon."],
];

export default function Home() {
  return (
    <div className="home">
      <HeroStage />
      <MedicaidExample />

      <section className="h-today" aria-labelledby="today-h">
        <div className="wrap">
          <h2 id="today-h">Find, apply for and track your benefits</h2>
          <p className="lede">Here is what each one means today.</p>
          <ul className="h-today-list">
            {TODAY.map(([icon, title, text]) => (
              <li key={title}>
                <NeedIcon k={icon} size={48} />
                <b>{title}</b>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

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

      <Faq items={faqs} />

      <section id="get-mano" className="h-close" aria-labelledby="close-h">
        <div className="wrap">
          <Mascot tile wave tone="orange" size={88} className="close-mascot" />
          <h2 id="close-h">Start with the letter you have been putting off.</h2>
          <p className="lede">Mano will find the date and tell you what happens next.</p>
          <a className="close-num" href={SMS_HREF}>{SMS_NUMBER}</a>
          <div className="btn-row">
            <TextMano className="btn btn-primary btn-lg" />
            <Link className="btn btn-ghost btn-lg" href="/how-it-works">How Mano works</Link>
          </div>
          {!SMS_IS_PLACEHOLDER && <TextQr />}
          <nav className="close-links" aria-label="Mano for teams">
            <Link href="/government">For government</Link>
            <Link href="/organizations">For nonprofits</Link>
            <Link href="/partners">For partners</Link>
            <Link href="/how-it-works#open-source">For developers</Link>
          </nav>
        </div>
      </section>
    </div>
  );
}
