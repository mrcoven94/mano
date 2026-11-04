import type { Metadata } from "next";
import TryDemo from "@/components/try/TryDemo";
import QualityResults from "@/components/quality/QualityResults";
import "./try.css";

const title = "Test Mano live";
const description = "Run Mano on a synthetic renewal letter and see every step and every Meta model call, then the nightly test results. No login.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/try" }, openGraph: { title, description } };

export const dynamic = "force-dynamic";

export default function TryPage() {
  return (
    <>
      <TryDemo />
      <QualityResults />
    </>
  );
}
