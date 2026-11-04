"use client";
import HeroThread, { type ThreadScene } from "./HeroThread";
import TextMano from "@/components/TextMano";

/* The hero says one thing: text a photo of your renewal letter. The thread below plays what happens next, with a
   made-up person, office and confirmation number. */

const SPINE: ThreadScene = {
  letter: { from: "Springfield County Food Assistance Office", title: "SNAP renewal, case R-1042", due: "Your renewal is due November 14, 2026.", note: "Late forms stop benefits." },
  me: "Got a letter. My food benefits are ending?",
  read: "Your renewal is due Nov 14. That is the date that matters.",
  ask: "I filled it in. Send it to the practice portal? YES or NO",
  answer: "Filed on the practice portal, not a real office. Confirmation SR‑G6WYKQU8",
};

export default function HeroStage() {
  return (
    <div className="h-hero">
      <div className="wrap h-hero-head">
        <h1 className="h-one">Text a photo of your <mark className="h-phrase">renewal letter.</mark></h1>
        <p className="h-lede">Mano reads it, tracks the deadline and fills out your renewal. It files only after you say yes, and in this demo it files on a practice portal, not a real office.</p>
        <div className="btn-row h-ctas">
          <TextMano className="btn btn-primary btn-lg" />
        </div>
        <p className="h-note">Mano is free in this demo. No card, no sign up.</p>
      </div>

      <div className="wrap h-stage-wrap">
        <div className="h-stage" data-flush>
          <HeroThread scene={SPINE} />
        </div>
      </div>
    </div>
  );
}
