// Prints the replay page and the caseworker page as their own code renders
// them for Maria's filing. Those modules need tsx, so a test runs this file
// and reads the JSON.
import { renderReplayPage } from "../../../../apps/engine/src/fill-replay.ts";
import { caseworkerDetailPage } from "../../../../apps/sandbox-portal/src/pages.ts";
import type { Submission } from "../../../../apps/sandbox-portal/src/store.ts";

const replayPage = renderReplayPage({
  state: "current",
  purpose: "Food benefits renewal",
  recipient: "Sandbox County Human Services",
  steps: [{ caption: "Mano opened the form.", width: 1280, height: 800, focus: null, png: new Uint8Array([1, 2, 3]) }],
  fields: [{ label: "Case number", value: "R-1042" }],
  attached: true,
});
const portalPage = caseworkerDetailPage({
  key: "k",
  scope: "api-x",
  confirmationNumber: process.argv[2]!,
  household: {
    caseNumber: "R-1042",
    fullName: "Maria Torres",
    dateOfBirth: "1988-04-12",
    address: "418 Alder St Apt 3, Springfield, IL 62701",
    phone: "(555) 010-0187",
    householdSize: "2",
    monthlyIncome: "1940",
  },
  declaration: { statement: "I declare under penalty of perjury." },
  files: [{ name: "letter.jpeg", type: "image/jpeg", size: 10, r2key: "r" }],
  digest: "d",
  status: "received",
  receivedAt: 0,
  slowMs: 0,
} as unknown as Submission);
console.log(JSON.stringify({ replayPage, portalPage }));
