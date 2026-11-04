import type { Metadata } from "next";
import Link from "next/link";
import HeroStage from "@/components/home/HeroStage";
import TrustDemo from "@/components/home/TrustDemo";
import { NeedIcon } from "@/components/home/NeedIcons";
import Faq from "@/components/Faq";
import Mascot from "@/components/Mascot";
import TextMano from "@/components/TextMano";
import TextQr from "@/components/TextQr";
import { SMS_HREF, SMS_NUMBER, SMS_IS_PLACEHOLDER } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Mano: text a photo of your renewal letter" },
  description: "Text Mano a photo of your renewal letter. It reads the letter, tracks the deadline and files the renewal after your yes. Mano is free in this demo and files only on a practice portal.",
  alternates: { canonical: "/" },
};

const TODAY: [icon: string, title: string, text: string][] = [
  ["pencil", "Reads your letter", "Mano finds the deadline that matters and quotes the line it came from. If a page is too blurry, it asks for a new photo."],
  ["calendar", "Tracks the deadline", "After you say so, Mano keeps the date and texts you before it."],
  ["clipboard", "Files your renewal on a practice portal", "Mano fills out the food benefits renewal and files it after your yes. The portal is made up, so nothing reaches a real office."],
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
  ["What else can I ask Mano?", "Questions about food benefits, health coverage and energy bill help in eight states, each fact sourced to the official page."],
];

export default function Home() {
  return (
    <div className="home">
      <HeroStage />

      <section className="h-today" aria-labelledby="today-h">
        <div className="wrap">
          <h2 id="today-h">What Mano does today</h2>
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

      <section className="h-trust" aria-labelledby="trust-h">
        <div className="wrap">
          <TrustDemo />
        </div>
      </section>

      <Faq items={faqs} />

      <section id="get-mano" className="h-close" aria-labelledby="close-h">
        <div className="wrap">
          <Mascot tile wave tone="orange" size={88} className="close-mascot" />
          <h2 id="close-h">Text a photo of your renewal letter.</h2>
          <p className="lede">Mano will find the date and tell you what happens next.</p>
          <a className="close-num" href={SMS_HREF}>{SMS_NUMBER}</a>
          <div className="btn-row">
            <TextMano className="btn btn-primary btn-lg" />
            <Link className="btn btn-ghost btn-lg" href="/how-it-works">How Mano works</Link>
          </div>
          {!SMS_IS_PLACEHOLDER && <TextQr />}
        </div>
      </section>
    </div>
  );
}
