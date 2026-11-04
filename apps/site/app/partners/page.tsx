import type { Metadata } from "next";
import Today from "@/components/teams/Today";

const title = "Mano and outside services";
const description = "Mano is a demo today, on synthetic cases and a practice portal. It does not offer outside services. The code is open source.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/partners" }, openGraph: { title, description } };

export default function Partners() {
  return (
    <Today
      title="Mano does not offer outside services."
      lede="Mano today is a text line for one person renewing food benefits. It runs on synthetic cases and files only on a practice portal, never with a real office."
      items={[
        ["Read how it works.", "The code is public and MIT licensed, so you can see what Mano does with every message."],
        ["Run your own copy.", "Every part runs locally with stand-ins when keys are missing."],
      ]}
    />
  );
}
