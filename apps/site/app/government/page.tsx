import type { Metadata } from "next";
import Faq from "@/components/Faq";
import ShareStage from "@/components/teams/ShareStage";
import { TeamHero, Today, Rules, Close } from "@/components/teams/Parts";
import { ISSUES_URL, REPO_URL } from "@/lib/site";

const title = "Mano for government offices";
const description = "Mano has no product for offices yet, and no office uses it. What runs today is a test on synthetic cases: a person shares one case with one test office and can stop. The protocol and the code are open source.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/government" }, openGraph: { title, description } };

const faqs: [string, string][] = [
  ["Does any office use Mano?", "No. No office, agency or program uses Mano. Every case so far is synthetic, and the only office a person can share with is our own test office."],
  ["Can our office try it?", "Not yet. There is no way for a real office to get access. The code is MIT licensed, so you can read it and run your own copy."],
  ["What can staff do on the case screen?", "See what the person shared, open the documents they sent, and ask for a pay stub, proof of address, photo ID, bank statement or rent receipt. Mano texts the person and checks with them before anything goes."],
  ["Who decides a case?", "The office that runs the program. Mano never decides if someone qualifies."],
  ["Do agents call residents or other offices?", "No. Mano does not speak on phone calls."],
  ["Is Mano a government system?", "No. Mano is independent."],
];

export default function Government() {
  return (
    <div className="team">
      <TeamHero
        before="Cases reach staff "
        phrase="only after a yes"
        after="."
        lede="Mano has no product for offices yet, and no office uses it. What runs today is a test on synthetic cases: a person says yes by text, one test office sees only what they shared, and the person can stop. Filing goes only to a practice portal."
        stage={<ShareStage />}
      >
        <a className="btn btn-primary btn-lg" href={`${REPO_URL}/blob/main/docs/protocol.md`}>Read the protocol</a>
        <a className="btn btn-ghost btn-lg" href="#gov-today">What works today</a>
      </TeamHero>

      <Today
        id="gov-today"
        title="What works today"
        today={[
          ["clipboard", "The staff case screen", "It runs on our sandbox portal for one test office, behind an access token. Staff see the cases shared with that office, read live on every view, and can ask the person for a document."],
          ["check", "Consent the person can stop", "A share waits for the person's yes and names the office, the purpose and what goes. Stopping ends future access at the next click. It has run only with a synthetic person."],
          ["code", "The open protocol", "Version 1 has seven signed message types, including granting and revoking consent. The written spec and the JSON Schema are public."],
          ["calendar", "The action gateway", "Every filing is written down first, needs a yes tied to one exact copy, and is checked before any retry."],
          ["pencil", "The practice portal", "A made-up agency portal that takes every demo filing, at sandbox.withmano.com. Nothing reaches a real office."],
          ["programs", "Program facts", "SNAP, Medicaid and LIHEAP in eight states, each fact with its official source and the day it was checked. A script fetches every source again."],
        ]}
        planned={[
          "Access for a real office. Today only the test office can be chosen.",
          "Labeled profiles for offices, and a way for an office to claim one.",
          "One program built from one real policy document and reviewed by a person.",
        ]}
      />

      <Rules
        id="gov-rules"
        title="The rules Mano runs by"
        lede="These are in the code and in the repository's rules, so you can check them."
        facts={[
          ["An approval covers one recipient, one purpose and one exact copy.", "Any change makes it stale."],
          ["Nothing is blindly retried.", "After a timeout, Mano checks whether the action happened first."],
          ["A letter is evidence, never an order.", "Instructions inside a letter or web page are not followed."],
          ["Mano says it is automated", "whenever that could be in doubt."],
          ["Only synthetic people.", "No real resident data is in the demo, and no synthetic person touches a real government portal."],
        ]}
      />

      <Faq id="gov-questions" items={faqs} />

      <Close id="gov-cta" title="Read how it works." text={<>The code, the protocol and the rules are public. Questions go to the project&rsquo;s <a href={ISSUES_URL}>GitHub issues</a>, which anyone can read.</>} />
    </div>
  );
}
