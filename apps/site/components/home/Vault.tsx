"use client";
import { useState } from "react";
import Mascot from "@/components/Mascot";
import { NeedIcon } from "./NeedIcons";

/* Everything a person has proved sits in one private vault, and every application is filled from it. Pick an
   application to watch the form fill in; each field says where it came from, and that proof lights up as Mano
   uses it. Every person and value here is made up. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;
const STEP = 0.55;

type DocKey = "id" | "pay" | "lease" | "bill" | "ssn" | "home";

const DOCS: { k: DocKey; name: string; icon: string; short: string }[] = [
  { k: "id", name: "Photo ID", icon: "credit", short: "your ID" },
  { k: "pay", name: "Pay stubs", icon: "clipboard", short: "your pay stubs" },
  { k: "lease", name: "Lease", icon: "rent", short: "your lease" },
  { k: "bill", name: "Utility bill", icon: "bills", short: "your power bill" },
  { k: "ssn", name: "SSN or ITIN", icon: "housing", short: "your SSN" },
  { k: "home", name: "Who lives with you", icon: "childcare", short: "your household" },
];
const SHORT = Object.fromEntries(DOCS.map((x) => [x.k, x.short])) as Record<DocKey, string>;

const SSN = "••• •• 4417";
const APPS: { name: string; office: string; fields: [label: string, value: string, from: DocKey][] }[] = [
  { name: "Food benefits", office: "Sample County", fields: [["Name", "Maria Lopez", "id"], ["People at home", "3", "home"], ["Monthly income", "$2,570", "pay"], ["Power bill", "$142 a month", "bill"], ["SSN", SSN, "ssn"]] },
  { name: "Rent help", office: "Sample County", fields: [["Name", "Maria Lopez", "id"], ["Address", "1418 Sample St, Apt 3", "lease"], ["Rent", "$1,150 a month", "lease"], ["Monthly income", "$2,570", "pay"], ["People at home", "3", "home"]] },
  { name: "Light bill help", office: "Sample Power", fields: [["Name", "Maria Lopez", "id"], ["Account", "88-2014", "bill"], ["Monthly income", "$2,570", "pay"], ["People at home", "3", "home"]] },
  { name: "Health coverage", office: "Sample State", fields: [["Name", "Maria Lopez", "id"], ["SSN", SSN, "ssn"], ["Monthly income", "$2,570", "pay"], ["People at home", "3", "home"]] },
  { name: "Child care", office: "Northside Family Center", fields: [["Name", "Maria Lopez", "id"], ["Children", "Leo, 4 and Ana, 7", "home"], ["Employer", "Northside Grocery", "pay"], ["Monthly income", "$2,570", "pay"]] },
];

export default function Vault() {
  const [a, setA] = useState(0);
  const app = APPS[a];
  const order = app.fields.map((f) => f[2]);

  return (
    <div className="vt">
      <div className="h-head">
        <h2 id="vt-h">Everything you have proved, in your private vault.</h2>
        <p className="lede">Your ID, pay stubs, lease, utility bills and your Social Security number or ITIN. No SSN or ITIN? Mano helps you prove who you are, where you live, who is in your household and what you earn another way. Snap a photo, forward an email or let Mano pull the record. Mano uses it for every application, so you never dig for the same paper twice.</p>
      </div>

      <div className="vt-picks" role="group" aria-label="Pick an application">
        {APPS.map((x, n) => <button key={x.name} className="vt-pick" aria-pressed={n === a} onClick={() => setA(n)}>{x.name}</button>)}
      </div>

      <div className="vt-grid">
        <div className="vt-vault">
          <Mascot tile wave tone="orange" size={72} className="vt-mascot" />
          <p className="vt-title">Maria&rsquo;s vault</p>
          <ul key={a}>
            {DOCS.map((x) => {
              const at = order.indexOf(x.k);
              return (
                <li key={x.k} data-used={at >= 0 || undefined} style={at >= 0 ? d(0.3 + at * STEP) : undefined}>
                  <NeedIcon k={x.icon} size={44} />
                  <b>{x.name}</b>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="vt-form" key={a} aria-live="polite">
          <p className="vt-office">{app.office}</p>
          <h3>{app.name} application</h3>
          <dl>
            {app.fields.map(([label, value, from], n) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <b><span className="type" style={{ ...d(0.3 + n * STEP), "--n": value.length } as React.CSSProperties}>{value}</span></b>
                  <span className="vt-from rv" style={d(0.45 + n * STEP)}>From {SHORT[from]}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="vt-done rv" style={d(0.5 + app.fields.length * STEP)}><mark>Filled from your vault.</mark> Nothing typed twice.</p>
        </div>
      </div>
    </div>
  );
}
