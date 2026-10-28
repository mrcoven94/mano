import type { Metadata } from "next";
import Faq from "@/components/Faq";
import PartnerOffer from "@/components/teams/PartnerOffer";
import PartnerScenes from "@/components/teams/PartnerScenes";
import { TeamHero, Stage, Seat, Close } from "@/components/teams/Parts";
import Image from "next/image";
import { REPO_URL } from "@/lib/site";

const title = "Mano for partners";
const description = "Describe your service in a manifest. Mano offers it only when it fits what a person asked for, shows the terms in plain words, and the person approves it. No ads and no selling data.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/partners" }, openGraph: { title, description } };

const MAIL = "mailto:partners@withmano.com?subject=Offering%20our%20service%20through%20Mano";

const kinds = ["Housing and rent", "Light and water bills", "Food and groceries", "Health and medicine", "Child care", "Credit building", "Jobs and training", "Legal help", "Transportation"];

const faqs: [string, string][] = [
  ["How does a service join Mano?", "You write a manifest: what the service does, the exact data it uses, its tools, who pays and how to stop. We review it, and Mano offers the service when it fits what a person asked for."],
  ["Do people pay for services?", "Only if they choose a paid service and agree to the price first. Most services are paid for by the partner."],
  ["Can we advertise on Mano?", "No. There are no ads and no paid placement. Mano offers a service only when it fits what the person is trying to do."],
  ["What data do we get?", "Only the fields in your manifest, only after the person approves, and only for that use. Mano never sells personal data."],
  ["What happens when someone removes our service?", "Data stops that day. You delete what you have within the time your manifest promised, and confirm it. Mano tells the person when you do."],
];

export default function Partners() {
  return (
    <div className="team">
      <TeamHero
        before="Offered only when it "
        phrase="helps"
        after="."
        lede="Describe your service in a manifest: what it does, the exact data it uses, who pays and how to stop. Mano offers it when it fits what a person asked for, shows those terms in plain words, and the person decides."
        stage={<Stage id="offer" label="Sample rent reporting service" hint="Point at or tap a line of the offer to see where it comes from"><PartnerOffer /></Stage>}
      >
        <a className="btn btn-primary btn-lg" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost btn-lg" href={REPO_URL}>Read the code</a>
      </TeamHero>

      <section className="t-more" aria-labelledby="pt-more-h">
        <div className="wrap">
          <div className="h-head">
            <h2 id="pt-more-h">People stay in charge of every service.</h2>
          </div>
          <PartnerScenes />
        </div>
      </section>

      <section className="t-rules" aria-labelledby="pt-kinds-h">
        <div className="wrap open-grid">
          <div>
            <h2 id="pt-kinds-h">Services people ask Mano about.</h2>
            <p className="lede">People come to Mano to pay rent, keep the lights on, feed their families and get care. A service belongs here if it helps with that, and says plainly what it costs and what it uses.</p>
            <ul className="t-chips">{kinds.map((k) => <li key={k}>{k}</li>)}</ul>
          </div>
          <div>
          <Image className="t-art pt-art" src="/art/plugin.svg" width={320} height={240} alt="Mano snapping a puzzle piece into place" unoptimized />
          <ul className="open-facts">
            <li><b>The person approves</b> each service and each use.</li>
            <li><b>You use only the data you listed,</b> and nothing else.</li>
            <li><b>People never pay</b> unless they choose a paid service and see the price first.</li>
            <li><b>People can stop any time.</b> Sharing stops at once, and you delete their data within the time your manifest states.</li>
            <li><b>Mano never sells personal data</b> and shows no ads.</li>
            <li><b>The manifest format is open</b> and versioned, like the rest of Mano.</li>
          </ul>
          </div>
        </div>
      </section>

      <Seat title="Your manifest says who pays." text="People never pay unless they choose a paid service and agree to the price first." href={MAIL} />

      <Faq id="pt-questions" items={faqs} />

      <Close id="pt-cta" title="Offer your service through Mano." text="Send us what your service does and the data it needs. We will review the manifest with you and get it in front of the people it helps." href={MAIL} />
    </div>
  );
}
