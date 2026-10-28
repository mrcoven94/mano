import type { Metadata } from "next";
import Faq from "@/components/Faq";
import PartnerOffer from "@/components/teams/PartnerOffer";
import PartnerScenes from "@/components/teams/PartnerScenes";
import { TeamHero, Stage, Steps, Rules, Seat, Close } from "@/components/teams/Parts";
import { NeedIcon, NEED_TINT } from "@/components/home/NeedIcons";

const title = "Mano for partners";
const description = "For services that help people with rent, bills, credit, food, care or work. When someone asks Mano for that kind of help, Mano offers your service in plain words and the person decides. No ads and no paid placement.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/partners" }, openGraph: { title, description } };

const MAIL = "mailto:partners@withmano.com?subject=Offering%20our%20service%20through%20Mano";

const kinds: [icon: string, name: string, examples: string, tint: string][] = [
  ["credit", "Credit building", "Rent reporting and credit builder loans", NEED_TINT.credit],
  ["bills", "Bill help", "Utility, phone and internet discounts", NEED_TINT.bills],
  ["food", "Food", "Food banks, meal programs and grocery delivery", NEED_TINT.food],
  ["medicine", "Health", "Clinics, prescriptions and coverage help", NEED_TINT.medicine],
  ["childcare", "Child care", "Providers with open spots and tuition help", NEED_TINT.childcare],
  ["housing", "Housing", "Rentals that take vouchers, repairs and moving help", NEED_TINT.rent],
  ["pencil", "Jobs and school", "Job training, apprenticeships and scholarships", "#E4F1E8"],
  ["programs", "Legal help", "Eviction defense, appeals and immigration help", NEED_TINT.programs],
];

const faqs: [string, string][] = [
  ["Who can partner with Mano?", "Companies, nonprofits and public programs whose service helps people with rent, bills, credit, food, health, child care, housing, work or legal problems, and that say plainly what it costs and what it uses."],
  ["How does a service join?", "You send us a short file, called a manifest, that says what the service does, who it helps, the exact data it uses, who pays and how people stop. We review it with you, and then Mano offers the service when it fits what someone asked for."],
  ["Can we pay to be shown more?", "No. There are no ads and no paid placement. Mano offers a service only when it fits what the person is trying to do, and paying more does not move it up."],
  ["Do people pay for services?", "Only if they choose a paid service and agree to the price first. Most services are paid for by the partner."],
  ["What data do we get?", "Only the fields you listed, only after the person turns your service on, and only for that use. Mano never sells personal data."],
  ["What happens when someone turns our service off?", "Their data stops that day. You delete what you have within the time you promised, and confirm it. Mano tells the person when you do."],
];

export default function Partners() {
  return (
    <div className="team">
      <TeamHero
        before="Reach the people your service was "
        phrase="made for"
        after="."
        lede="You help people with rent, bills, credit, food, care or work. When someone asks Mano for that kind of help, Mano offers your service, explains it in plain words and they decide. No ads, and no paying to rank higher."
        stage={<Stage id="offer" label="Sample rent reporting service" hint="Point at a line of the offer to see where it comes from"><PartnerOffer /></Stage>}
      >
        <a className="btn btn-primary btn-lg" href={MAIL}>Offer your service</a>
        <a className="btn btn-ghost btn-lg" href="#pt-join">How to join</a>
      </TeamHero>

      <section className="pt-who" aria-labelledby="pt-who-h">
        <div className="wrap">
          <div className="h-head">
            <h2 id="pt-who-h">For anyone who helps people get by.</h2>
            <p className="lede">Companies, nonprofits and programs that help with what people come to Mano for. If your service helps with one of these and says plainly what it costs and what it uses, it belongs here.</p>
          </div>
          <ul className="pt-kinds">
            {kinds.map(([icon, name, ex, tint]) => (
              <li key={name} style={{ background: tint }}>
                <NeedIcon k={icon} size={48} />
                <b>{name}</b>
                <span>{ex}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Steps
        id="pt-join"
        title="Join in three steps."
        art="/art/plugin.svg"
        artAlt="Mano snapping a puzzle piece into place"
        items={[
          ["Tell us about your service", (
            <>
              <p className="share-big">Reports on-time rent to credit bureaus</p>
              <p className="share-small">What it does, who it helps, the data it needs, who pays and how people stop. One short file in an open format.</p>
            </>
          ), "pencil"],
          ["We review it with you", (
            <>
              <p className="share-big">5 of 5 checks passed</p>
              <p className="share-small">The least data it needs, a clear price, stops in one step, safe links and tools that do only what they say. Any change is reviewed again.</p>
            </>
          ), "check"],
          ["Mano offers it when it fits", (
            <>
              <p className="share-big">&ldquo;How do I build my credit?&rdquo;</p>
              <p className="share-small">Mano explains your service in plain words. The person turns it on or says not now.</p>
            </>
          ), "chat"],
        ]}
      />

      <section className="t-more" aria-labelledby="pt-more-h">
        <div className="wrap">
          <div className="h-head">
            <h2 id="pt-more-h">People stay in charge of every service.</h2>
          </div>
          <PartnerScenes />
        </div>
      </section>

      <Rules
        id="pt-rules"
        title="What every partner agrees to."
        lede="The same terms for every service, large or small. The file format is open and versioned, like the rest of Mano."
        facts={[
          ["The person turns it on.", "Each service, and each new use of their data."],
          ["You use only the data you listed,", "and nothing else."],
          ["People never pay", "unless they choose a paid service and see the price first."],
          ["People can stop any time.", "Sharing stops at once, and you delete their data within the time you promised."],
          ["No ads and no selling data.", "Not by Mano, not by you."],
        ]}
      />

      <Seat title="You pay, not the people you serve." text="Most services are paid for by the partner. People pay only if they choose a paid service and agree to the price first." href={MAIL} />

      <Faq id="pt-questions" items={faqs} />

      <Close id="pt-cta" title="Offer your service through Mano." text="Send us what your service does, who it helps and the data it needs. We will review it with you and get it in front of the people it is for." href={MAIL} />
    </div>
  );
}
