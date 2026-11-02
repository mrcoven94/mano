"use client";
import { useState } from "react";
import Mascot from "@/components/Mascot";

/* The card Mano shows before it sends a renewal. Both buttons work: one shows the pages, one plays the send and the
   check that it arrived. The office and the pages are made up. */

type View = "ready" | "pages" | "sent";

const PAGES = ["Renewal form, page 1 of 4: household", "Renewal form, page 2 of 4: income", "Renewal form, page 3 of 4: expenses", "Renewal form, page 4 of 4: your signature", "Pay stub, Nov 7", "Pay stub, Nov 21"];
const LABEL: Record<View, string> = { ready: "Ready to send", pages: "Your pages", sent: "Sent" };

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

export default function ApprovalCard() {
  const [view, setView] = useState<View>("ready");

  return (
    <div className="tr-card rw-card" aria-live="polite">
      <div className="tr-card-head">
        <span className="tr-who"><Mascot tile tone="orange" size={26} />Mano</span>
        <span className="sc-label rw-mono">{LABEL[view]}</span>
      </div>

      {view !== "sent" && (
        <>
          <p className="tr-msg">Your food benefits renewal is ready. Here is exactly what will be sent.</p>
          <dl className="tr-dl">
            <div><dt>To</dt><dd>Sample County Human Services</dd></div>
            <div><dt>For</dt><dd>Food benefits renewal</dd></div>
            <div><dt>Pages</dt><dd>Renewal form, 4 pages, 2 pay stubs</dd></div>
          </dl>
          {view === "pages" && (
            <ol className="rw-pages">
              {PAGES.map((p, n) => <li key={p} className="rv" style={d(n * 0.08)}>{p}</li>)}
            </ol>
          )}
          <div className="tr-btns">
            <button className="tr-yes" onClick={() => setView("sent")}>Yes, send it</button>
            <button className="tr-no" onClick={() => setView(view === "pages" ? "ready" : "pages")}>{view === "pages" ? "Hide pages" : "Show me first"}</button>
          </div>
        </>
      )}

      {view === "sent" && (
        <>
          <p className="tr-msg rv" style={d(0)}>Sent with your yes. I checked that it arrived.</p>
          <ol className="tr-steps">
            <li className="rv" style={d(0.3)}><span>8:12 PM</span>Sent to Sample County Human Services</li>
            <li className="rv" style={d(0.8)}><span>8:13 PM</span>Checked the county portal: received</li>
            <li className="rv ok" style={d(1.3)}><span>Result</span>One copy on file. Due Dec 5, sent Nov 24.</li>
          </ol>
          <button className="tr-no rw-again" onClick={() => setView("ready")}>Start over</button>
        </>
      )}
      <p className="rw-example">Example. Sample County is made up.</p>
    </div>
  );
}
