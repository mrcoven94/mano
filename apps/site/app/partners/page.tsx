import type { Metadata } from "next";
import Faq from "@/components/Faq";
import { TeamHero, Steps, Today, Close } from "@/components/teams/Parts";
import { NeedIcon, NEED_TINT } from "@/components/home/NeedIcons";
import { ISSUES_URL, REPO_URL } from "@/lib/site";

const title = "Mano for partners";
const description = "Mano has no partners today and connects to no outside service. This page says how outside services are planned to work, and what is real today: the open protocol, the action gateway and the open source code.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/partners" }, openGraph: { title, description } };

const kinds: [icon: string, name: string, examples: string, tint: string][] = [
  ["credit", "Credit building", "Rent reporting and credit builder loans", NEED_TINT.credit],
  ["bills", "Bill help", "Utility, phone and internet discounts", NEED_TINT.bills],
  ["food", "Food", "Food banks, meal programs and grocery delivery", NEED_TINT.food],
  ["medicine", "Health", "Clinics, prescriptions and coverage help", NEED_TINT.medicine],
  ["childcare", "Child care", "Providers with open spots and tuition help", NEED_TINT.childcare],
  ["housing", "Housing", "Rentals that take vouchers, repairs and moving help", NEED_TINT.rent],
  ["transport", "Transportation", "Rides to appointments and transit passes", NEED_TINT.transport],
  ["pencil", "Jobs and school", "Job training, apprenticeships and scholarships", "#E4F1E8"],
];

const faqs: [string, string][] = [
  ["Does Mano have partners?", "No. Mano has no partners and connects to no outside service today."],
  ["Can a service join now?", "Not yet. There is no way to join and no code for it. The plan is written down in docs/decisions.md in the repository."],
  ["Would a person have to agree?", "Yes. The plan is that a person approves each service and can remove it."],
  ["Would Mano sell personal data?", "No. We never sell personal data."],
];

export default function Partners() {
  return (
    <div className="team">
      <TeamHero
        before="How outside services "
        phrase="would work"
        after=" with Mano."
        lede="Mano has no partners today and connects to no outside service. This is the plan, written down in the repository so you can check it. No code for it exists yet."
      >
        <a className="btn btn-primary btn-lg" href={`${REPO_URL}/blob/main/docs/decisions.md`}>Read the decision</a>
        <a className="btn btn-ghost btn-lg" href="#pt-join">How it would work</a>
      </TeamHero>

      <section className="pt-who" aria-labelledby="pt-who-h">
        <div className="wrap">
          <div className="h-head">
            <h2 id="pt-who-h">The kinds of service this is meant for</h2>
            <p className="lede">These are examples of the help people ask about. None of them is connected today.</p>
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
        title="How it would work"
        art="/art/plugin.svg"
        artAlt="Mano snapping a puzzle piece into place"
        items={[
          ["A service writes down what it does", (
            <>
              <p className="share-big">Tools, data and who pays</p>
              <p className="share-small">It lists its tools, the exact data it asks for and who pays.</p>
            </>
          ), "pencil"],
          ["Mano offers it only when it helps", (
            <>
              <p className="share-big">Only when it helps</p>
              <p className="share-small">The agent brings up a service only when it helps with what the person is doing.</p>
            </>
          ), "chat"],
          ["The person decides", (
            <>
              <p className="share-big">Approve or remove</p>
              <p className="share-small">The person approves each service and can remove it.</p>
            </>
          ), "check"],
        ]}
      />

      <Today
        id="pt-today"
        title="What is real today"
        today={[
          ["code", "The open protocol", "Version 1 has seven signed message types, with a written spec and a JSON Schema in the repository."],
          ["calendar", "The action gateway", "Every outside action is decided and written down before it happens, and it fails closed."],
          ["laptop", "Run your own copy", "Mano is MIT licensed. pnpm judge runs the renewal on your machine with no key, login or account."],
        ]}
        planned={[
          "One partner extension on a public API.",
          "A file format for extensions that says what a service does and what it uses.",
        ]}
      />

      <Faq id="pt-questions" items={faqs} />

      <Close id="pt-cta" title="Read how it works." text={<>The code, the protocol and the plan are public. Questions go to the project&rsquo;s <a href={ISSUES_URL}>GitHub issues</a>, which anyone can read.</>} />
    </div>
  );
}
