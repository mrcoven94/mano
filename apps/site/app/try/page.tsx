import type { Metadata } from "next";
import TryDemo from "@/components/try/TryDemo";
import "./try.css";

const title = "Live demo for judges";
const description = "Press send and watch Mano handle a synthetic renewal letter for real: every step and every model call, on made-up data, with no login.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/try" }, robots: { index: false }, openGraph: { title, description } };

export default function TryPage() {
  return <TryDemo />;
}
