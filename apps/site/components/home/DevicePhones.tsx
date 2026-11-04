"use client";
import { useEffect, useState } from "react";
import { Stage, Phone, Thread, Bubble, Stamp, Roll, type Act } from "@/components/stageshow";
import Mascot from "@/components/Mascot";
import { LetterPhoto } from "./HeroThread";
import "./spine.css";

/* The phones in "Get help by text": the same Mano on a text thread and in the app, built on the Stageshow kit.
   Text follows the kit's messages example: the reply is typed in the composer and sent. App follows phone-touch: the
   person taps the card that is ready, says yes, and it files on the practice portal. Maria is made up. */

const size = { width: 420, height: 560, compact: { below: 420, width: 354, height: 440 } };

function ArrowUp() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 13V3.5M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Plus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/* The stage measures its width to pick a design, so it mounts on the client; the slot's reserved height holds the page. */
function Slot({ label, children }: { label: string; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="ev-phone">
      <p className="sr-only">{label}</p>
      <div aria-hidden="true">{mounted && children}</div>
    </div>
  );
}

type TextState = { asked: boolean; thinking: boolean; offer: boolean; draft: string; sent: boolean; filling: boolean; filled: boolean };
const textStart: TextState = { asked: false, thinking: false, offer: false, draft: "", sent: false, filling: false, filled: false };
const YES = "Yes please";

async function textScript(a: Act<TextState>) {
  await a.wait(900);
  await a.set({ asked: true });
  await a.wait(900);
  await a.set({ thinking: true });
  await a.wait(1200);
  a.mark("offer");
  await a.set({ thinking: false, offer: true });
  await a.wait(1800);
  await a.click("compose");
  await a.type("draft", YES, { interval: 70 });
  await a.wait(350);
  await a.click("send");
  a.mark("sent");
  await a.set({ sent: true, draft: "" });
  await a.wait(800);
  await a.set({ filling: true });
  await a.wait(1400);
  a.mark("filled");
  await a.set({ filling: false, filled: true });
}

export function TextPhone() {
  return (
    <Slot label="A text thread. Maria sends a photo of a letter and asks what it is. Mano says it is her food benefits renewal, due November 14, and asks if it should fill it out. She says yes please. Mano says it filled it out, it goes only after her yes, and it is in the app too.">
      <Stage<TextState>
        {...size}
        initial={textStart}
        poster={{ ...textStart, asked: true, offer: true, sent: true, filled: true }}
        script={textScript}
        play="once"
        cursor={{ at: "compose", style: "touch" }}
        accent="#1A6FE0"
        tokens={{ "--ss-font": "var(--font-sans), system-ui, sans-serif" }}
        className="sp-stage ev-stage"
      >
        {(s, _rect, layout) => (
          <Phone width={layout === "wide" ? 348 : 322} className="sp-phone ev-device">
            <div className="ev-app">
              <div className="sp-head">
                <Mascot tile wave tone="orange" size={44} />
                <span className="sp-name">Mano</span>
              </div>
              <Thread className="sp-thread">
                <Stamp><b>Oct 28</b> 6:12 PM</Stamp>
                <Bubble from="them">Hi Maria, I&apos;m Mano, an automated assistant.</Bubble>
                <Bubble from="them">Text me a photo of any letter or form.</Bubble>
                <Bubble from="me">Ok, thank you</Bubble>
                <Stamp><b>Today</b> 9:41 PM</Stamp>
                {s.asked && <LetterPhoto />}
                {s.asked && <Bubble from="me">What is this one?</Bubble>}
                {(s.thinking || s.offer) && <Bubble from="them" typing={s.thinking}>Your food benefits renewal. It is due November 14. Want me to fill it out?</Bubble>}
                {s.sent && <Bubble from="me" source="draft">{YES}</Bubble>}
                {(s.filling || s.filled) && <Bubble from="them" typing={s.filling}>Filled out. It goes only after your yes, and it&apos;s in the app too.</Bubble>}
              </Thread>
              <div className="ev-compose">
                <span className="ev-plus"><Plus /></span>
                <span className="ev-field" data-target="compose">
                  <span className="ev-field-text" data-target="draft">{s.draft}{s.draft && <i className="ev-caret" data-snap />}</span>
                  <span className="ev-field-ph" data-hide={s.draft ? "" : undefined}>iMessage</span>
                  <span className="ev-send" data-target="send" data-show={s.draft ? "" : undefined}><ArrowUp /></span>
                </span>
              </div>
            </div>
          </Phone>
        )}
      </Stage>
    </Slot>
  );
}

type AppState = { open: boolean; filed: boolean };
const appStart: AppState = { open: false, filed: false };

async function appScript(a: Act<AppState>) {
  await a.wait(1400);
  await a.click("review");
  a.mark("open");
  await a.set({ open: true });
  await a.wait(1600);
  await a.click("yes");
  a.mark("filed");
  await a.set({ open: false, filed: true });
}

export function AppPhone() {
  return (
    <Slot label="The Mano app. Maria sees her food benefits renewal ready to send, reviews it and says yes. It files on the practice portal with confirmation SR-G6WYKQU8. Below it, health coverage is due January 31 with a reminder on January 17, and 3 letters were read this week with 1 scam blocked.">
      <Stage<AppState>
        {...size}
        initial={appStart}
        poster={{ open: false, filed: true }}
        script={appScript}
        play="once"
        cursor={{ at: "review", style: "touch" }}
        accent="#1A6FE0"
        tokens={{ "--ss-font": "var(--font-sans), system-ui, sans-serif" }}
        className="sp-stage ev-stage"
      >
        {(s, _rect, layout) => (
          <Phone width={layout === "wide" ? 348 : 322} className="sp-phone ev-device">
            <div className="ev-app ev-home">
              <div className="ev-hello"><Mascot tile wave tone="orange" size={40} /><span>Good evening, Maria</span></div>
              <div className="ev-card" data-hot={!s.filed || undefined}>
                <small><Roll variant="fade">{s.filed ? "Filed" : "Ready to send"}</Roll></small>
                <b>Food benefits renewal</b>
                <span className="ev-meta"><Roll variant="fade">{s.filed ? "Practice portal, confirmation SR-G6WYKQU8" : "To the practice portal, not a real office"}</Roll></span>
                <span className="ev-review" data-target="review" data-hide={s.open || s.filed ? "" : undefined}>Review</span>
                <div className="ev-approve" data-open={s.open || undefined}>
                  <div>
                    <span className="ev-yes" data-target="yes">Yes, send it</span>
                    <span className="ev-no">No</span>
                  </div>
                </div>
              </div>
              <div className="ev-card"><small>Due next</small><b>Health coverage, Jan 31</b><span className="ev-meta">Reminder Jan 17</span></div>
              <div className="ev-card"><small>Mail</small><b>3 letters read this week</b><span className="ev-meta">1 scam blocked</span></div>
              <div className="ev-ask">Ask Mano anything</div>
            </div>
          </Phone>
        )}
      </Stage>
    </Slot>
  );
}
