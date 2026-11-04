import type { Metadata } from "next";
import Today from "@/components/teams/Today";

const title = "Mano and government offices";
const description = "Mano is a demo today, on synthetic cases and a practice portal. There is no product for offices yet. The code and the case sharing protocol are open source.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/government" }, openGraph: { title, description } };

export default function Government() {
  return (
    <Today
      title="Mano has no product for offices yet."
      lede="Mano today is a text line for one person renewing food benefits. It runs on synthetic cases and files only on a practice portal, never with a real office."
      items={[
        ["The practice portal.", "A made-up agency portal that takes every demo filing, at sandbox.withmano.com."],
        ["The action gateway.", "Every filing is written down first, needs a yes tied to one exact copy, and is checked before any retry."],
        ["The sharing protocol.", "An open format for working a shared case with a person's consent. It has run only with a synthetic person."],
      ]}
    />
  );
}
