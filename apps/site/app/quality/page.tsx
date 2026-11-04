import { redirect } from "next/navigation";

/* Quality moved under the live demo so judges have one page: withmano.com/try#results. */
export default function QualityPage() {
  redirect("/try#results");
}
