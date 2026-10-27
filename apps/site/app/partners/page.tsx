import type { Metadata } from "next";
import Faq from "@/components/Faq";
import Closing from "@/components/Closing";
import PartnerDemos from "@/components/PartnerDemos";
import Glyph, { type GlyphName } from "@/components/Glyph";
import { PageHero, Commitments } from "@/components/PageParts";

const title = "Mano for partners";
const description = "Offer your service to families at the moment it helps. Mano suggests it when it fits, shows plain terms and the family approves each use. No ads and no selling data.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/partners" }, openGraph: { title, description } };

const MAIL = "mailto:partners@withmano.com?subject=Offering%20our%20service%20through%20Mano";

const kinds: [GlyphName, string, string][] = [
  ["gauge", "Credit building", "var(--butter)"],
  ["food", "Food and groceries", "var(--sage)"],
  ["stroller", "Child care booking", "var(--lilac)"],
  ["briefcase", "Jobs and training", "#FFD9A8"],
  ["home", "Housing and rent", "var(--peach)"],
  ["heart", "Health and care", "#F7B3C2"],
];

const faqs: [string, string][] = [
  ["How does a service join Mano?", "You describe it in plain words: what it does, the exact data it uses, who pays and how to stop. Mano offers it when it helps with what a family asked for."],
  ["Do families pay for services?", "Only if they choose a paid service and agree to the price first. Most services are paid for by the partner."],
  ["Can we advertise on Mano?", "No. There are no ads. Mano suggests a service only when it fits what the family is trying to do."],
  ["What data do we get?", "Only the fields you listed, only after the family approves, and only for that use. Mano never sells personal data."],
  ["How do we start?", "Write to us with what your service does and the data it uses. We review every service before families can see it."],
];

export default function Partners() {
  return (
    <>
      <PageHero
        pill="For partners"
        title="Reach families when your service helps."
        lede="Mano suggests your service in the moment it fits what a family asked for, with plain terms they approve. No ads, and no selling data."
        art="/art/plugin.svg"
        artAlt="Mano snapping a puzzle piece into place"
      >
        <a className="btn btn-primary btn-lg" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost btn-lg" href="#pt-work-h">See it work</a>
      </PageHero>

      <section aria-labelledby="pt-work-h" className="tint">
        <div className="wrap">
          <h2 id="pt-work-h" className="biz-h2">When your service is offered.</h2>
          <PartnerDemos />
        </div>
      </section>

      <section aria-labelledby="pt-kinds-h">
        <div className="wrap">
          <h2 id="pt-kinds-h" className="biz-h2">Services families ask Mano about.</h2>
          <ul className="pt-kinds" role="list">
            {kinds.map(([g, name, bg]) => (
              <li key={name}><span className="ask-icon" style={{ background: bg }}><Glyph name={g} size={22} /></span>{name}</li>
            ))}
          </ul>
        </div>
      </section>

      <Commitments
        id="pt-rules"
        title="The rules every partner follows."
        items={[
          "The family approves each service and each use.",
          "You list the exact data you use, and use nothing else.",
          "Families never pay unless they choose a paid service.",
          "Families can stop any time, and their data is deleted.",
          "Mano never sells personal data and shows no ads.",
        ]}
      />

      <Faq id="pt-questions" items={faqs} />

      <Closing id="pt-cta" title="Offer your service through Mano." text="Tell us what your service does and the data it needs. We will review it with you and get it in front of the families it helps.">
        <a className="btn btn-primary" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost" href="/">See it from the family side</a>
      </Closing>
    </>
  );
}
