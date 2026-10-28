"use client";
import { useEffect, useState } from "react";
import Mascot from "@/components/Mascot";

/* The five hero demos. Each one plays once when it mounts; --d is the delay before a piece appears.
   Everyone and every office here is made up. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

function Check() {
  return (
    <svg className="sc-tick" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.4l2.9 2.8 6-6.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ApplyScene() {
  const apps = [
    ["Emergency rent help", "Sample County. Up to one month of rent."],
    ["Food benefits", "For a family of three."],
    ["Child care help", "Pays part of daycare while you work."],
    ["Power bill help", "Lowers your bill through the winter."],
  ];
  return (
    <div className="sc sc-apply">
      <div className="sc-thread">
        <p className="sc-label">Text message, 9:41 PM</p>
        <p className="bub me rv" style={d(0.2)}>My hours got cut to 20 a week. Rent is due on the 1st and I have two kids. What can I get?</p>
        <div className="bub-row rv" style={d(1.3)}>
          <Mascot tile tone="orange" size={30} className="bub-av" />
          <p className="bub mano">These four look like a fit for your family. I filled out each one from what you told me and your last pay stub.</p>
        </div>
      </div>
      <div className="sc-card">
        <div className="sc-card-head"><span>Applications</span><span className="sc-label">4 ready</span></div>
        <ul className="sc-rows">
          {apps.map(([t, s], n) => (
            <li key={t} className="rv" style={d(2.2 + n * 0.5)}>
              <Check />
              <div><strong>{t}</strong><small>{s}</small></div>
              <span className="sc-tag">Ready to send</span>
            </li>
          ))}
        </ul>
        <p className="sc-foot rv" style={d(4.4)}>One text, four applications.</p>
      </div>
    </div>
  );
}

export function FormScene() {
  const fields = [
    ["Full name", "Maria Lopez", "Your profile"],
    ["People in your home", "3", "Your text, Oct 2"],
    ["Monthly income", "$2,140", "Pay stubs, Oct 10 and 24"],
    ["Employer", "Northside Grocery", "Pay stub, Oct 24"],
    ["Care needed", "Mon to Fri, 7:30 to 4:00", "Your text, Oct 2"],
  ];
  return (
    <div className="sc sc-form">
      <div className="sc-browser">
                <div className="sc-formbody">
          <p className="sc-label">Sample County</p>
          <h3>Child care assistance</h3>
          {fields.map(([l, v], n) => (
            <div key={l} className="sc-field" style={d(0.6 + n * 0.8)}>
              <span>{l}</span>
              <span className="sc-input"><span className="type" style={{ ...d(0.6 + n * 0.8), "--n": v.length } as React.CSSProperties}>{v}</span></span>
            </div>
          ))}
        </div>
      </div>
      <div className="sc-card sc-sources">
        <div className="sc-card-head"><span>Where each answer came from</span></div>
        <ul className="sc-rows tight">
          {fields.map(([l, , s], n) => (
            <li key={l} className="rv" style={d(0.9 + n * 0.8)}>
              <Check />
              <div><strong>{l}</strong><small>{s}</small></div>
            </li>
          ))}
        </ul>
        <p className="sc-foot rv" style={d(5)}>The signature is yours. Mano never signs for you.</p>
      </div>
    </div>
  );
}

export function MailScene() {
  return (
    <div className="sc sc-mail">
      <div className="sc-photo" aria-hidden="true">
        <div className="env e1" /><div className="env e2" />
        <div className="env e3"><span>SAMPLE COUNTY HUMAN SERVICES</span><i /><i /><i /></div>
        <div className="scan" />
        <p className="sc-label sc-photo-cap"><Mascot tile tone="orange" size={16} className="ts-av" />1 photo. 3 letters found.</p>
      </div>
      <ul className="sc-letters">
        <li className="rv" style={d(1.6)}>
          <span className="sc-label">Renewal</span>
          <strong>Food benefits renewal</strong>
          <p><mark>Due November 14.</mark> I filled it out from last year.</p>
        </li>
        <li className="rv" style={d(2.5)}>
          <span className="sc-label">Bill</span>
          <strong>Water bill, $96 past due</strong>
          <p>You qualify for help paying it. I started the application.</p>
        </li>
        <li className="rv is-alert" style={d(3.4)}>
          <span className="sc-label">Warning</span>
          <strong>&ldquo;Verify your benefits&rdquo;</strong>
          <p>It asks for your Social Security number at a link that failed the safety check. I did not open it.</p>
        </li>
      </ul>
    </div>
  );
}

export function RenewScene() {
  const rows: [string, string, string, boolean][] = [
    ["Power bill help", "Renewed Oct 12", "Approved Oct 19", true],
    ["Food benefits", "Due Nov 14", "Ready to send", false],
    ["Water bill help", "Due Jan 31", "Mano starts Jan 6", false],
    ["Child care", "Due Mar 15", "Mano starts Feb 20", false],
  ];
  return (
    <div className="sc sc-renew">
      <div className="sc-card">
        <div className="sc-card-head"><span>Your renewals</span></div>
        <ul className="rn-list">
          {rows.map(([t, due, s, done], n) => (
            <li key={t} className="rv" style={d(0.4 + n * 0.4)}>
              <strong>{t}</strong>
              <span>{due}</span>
              <span className={done ? "rn-done" : n === 1 ? "rn-next" : undefined}>{done && <Check />}{s}</span>
            </li>
          ))}
        </ul>
        <p className="sc-foot rv" style={d(2.2)}>Mano starts every renewal three weeks early, so the help never stops.</p>
      </div>
    </div>
  );
}

export function HoldScene() {
  const end = 47 * 60 + 12;
  const [t, setT] = useState(end - 18);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setT(end); return; }
    const id = setInterval(() => setT((x) => (x >= end ? x : x + 1)), 330);
    return () => clearInterval(id);
  }, [end]);
  const mm = String(Math.floor(t / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  const lines: [string, string, string, number, string?][] = [
    ["00:04", "Mano", "I'm calling for Maria Lopez about her prescription coverage. I'm her automated assistant, and this call is transcribed.", 0.3],
    ["00:09", "Recording", "All of our caseworkers are busy. Please stay on the line.", 1.2, "dim"],
    ["31:40", "Mano", "Texted Maria: still on hold, number 3 in line.", 2.4, "dim"],
    ["47:10", "Caseworker", "Thanks for holding, this is Dana.", 5.0],
    ["47:12", "Mano", "Texted Maria: Dana picked up. Tap to join the call.", 5.8, "hl"],
  ];
  return (
    <div className="sc sc-hold">
      <div className="sc-timer">
        <p className="sc-label">On hold for Maria</p>
        <p className="tm" aria-label={`${mm} minutes ${ss} seconds`}>{mm}:{ss}</p>
        <p className="sub">Sample County health coverage line</p>
        <div className={`wave${t >= end ? " stop" : ""}`} aria-hidden="true">{Array.from({ length: 24 }, (_, n) => <i key={n} style={d(-(n % 7) * 0.13)} />)}</div>
        <p className="note-line">Mano waits so you don&rsquo;t have to. When a person picks up, it texts you and hands over the call.</p>
      </div>
      <div className="sc-card sc-transcript">
        <div className="sc-card-head"><span>Transcript</span><span className="sc-label">Shared with Maria</span></div>
        <ol>
          {lines.map(([ts, who, text, delay, kind]) => (
            <li key={ts} className={`rv ${kind ?? ""}`} style={d(delay)}>
              <span className="ts">{ts}</span>
              <span>{who === "Mano" && <Mascot tile tone="orange" size={18} className="ts-av" />}<b>{who}</b> {kind === "hl" ? <mark>{text}</mark> : text}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
