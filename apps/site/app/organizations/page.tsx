import type { Metadata } from "next";
import Today from "@/components/teams/Today";

const title = "Mano and nonprofits";
const description = "Mano is a demo today, on synthetic cases and a practice portal. There is no product for nonprofit teams yet. The code and the case sharing protocol are open source.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/organizations" }, openGraph: { title, description } };

export default function Organizations() {
  return (
    <Today
      title="Mano has no product for nonprofit teams yet."
      lede="Mano today is a text line for one person renewing food benefits. It runs on synthetic cases and files only on a practice portal, never with a real office."
      items={[
        ["Case sharing.", "The code to share one case for one purpose, and to stop sharing, is written. It has run only with a synthetic person."],
        ["The open protocol.", "The format agents use to work a shared case is public, with a written spec in the repository."],
        ["Run your own copy.", "Mano is MIT licensed. The README says what each part needs."],
      ]}
    />
  );
}
