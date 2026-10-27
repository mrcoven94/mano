"use client";
import { useState } from "react";

/* Plus price with a monthly or yearly switch. */
export default function PlusPrice() {
  const [yearly, setYearly] = useState(false);
  return (
    <>
      <div className="pp-switch" role="radiogroup" aria-label="Billing">
        <button role="radio" aria-checked={!yearly} onClick={() => setYearly(false)}>Monthly</button>
        <button role="radio" aria-checked={yearly} onClick={() => setYearly(true)}>Yearly</button>
      </div>
      <p className="amt" key={String(yearly)}>
        {yearly ? "$60" : "$8"}<small>{yearly ? " a year, about $5 a month" : " a month"}</small>
      </p>
    </>
  );
}
