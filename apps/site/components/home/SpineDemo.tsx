"use client";
import { useEffect, useState } from "react";
import { Stage, Phone, Thread, Bubble, Stamp, type Act } from "@/components/stageshow";
import Mascot from "@/components/Mascot";
import "./spine.css";

/* The spine as one looping text thread: Maria says her food benefits are ending, sends a photo
   of the letter, Mano names the one deadline, asks a plain yes or no, she says yes, and Mano
   confirms the renewal reached the sandbox agency. The letter beside the phone is the paper she
   photographed; its deadline line is marked when Mano names it. Maria, the county and the
   confirmation number are made up. Built on the Stageshow kit in components/stageshow. */

type S = { photo: boolean; thinking: boolean; deadline: boolean; ask: boolean; yes: boolean; filing: boolean; filed: boolean; leaving: boolean };

const initial: S = { photo: false, thinking: false, deadline: false, ask: false, yes: false, filing: false, filed: false, leaving: false };
const poster: S = { ...initial, photo: true, deadline: true, ask: true, yes: true, filed: true };

/* One loop (14.6s) plus a little of the next opening, so the hero carousel moves on during a calm frame. */
export const SPINE_SECONDS = 15.4;

async function script(a: Act<S>) {
  await a.wait(1400);
  a.mark("photo");
  await a.set({ photo: true });
  await a.wait(1100);
  await a.set({ thinking: true });
  await a.wait(1300);
  a.mark("deadline");
  await a.set({ thinking: false, deadline: true });
  await a.wait(2300);
  a.mark("ask");
  await a.set({ ask: true });
  await a.wait(2000);
  a.mark("yes");
  await a.set({ yes: true });
  await a.wait(900);
  await a.set({ filing: true });
  await a.wait(1300);
  a.mark("filed");
  await a.set({ filing: false, filed: true });
  await a.wait(3000);
  a.mark("reset");
  await a.set({ leaving: true });
  await a.wait(320);
  await a.snap({ ...initial, leaving: true });
  await a.wait(60);
  await a.set({ leaving: false });
  await a.wait(900);
}

function Letter({ marked }: { marked: boolean }) {
  return (
    <div className="sp-letter" aria-hidden="true">
      <div className="sp-letter-from">Sample County Human Services</div>
      <div className="sp-letter-title">Your food benefits end November 30</div>
      <span className="sp-line" style={{ width: "92%" }} />
      <span className="sp-line" style={{ width: "84%" }} />
      <span className="sp-line" style={{ width: "70%" }} />
      <p className="sp-letter-due">
        <mark data-on={marked || undefined}>Return your renewal by November 14.</mark>
      </p>
      <span className="sp-line" style={{ width: "88%" }} />
      <span className="sp-line" style={{ width: "62%" }} />
      <p className="sp-letter-note">Phone interview: November 13 at 10:00 AM</p>
      <span className="sp-line" style={{ width: "78%" }} />
      <span className="sp-line" style={{ width: "84%" }} />
      <span className="sp-line" style={{ width: "54%" }} />
    </div>
  );
}

function Photo() {
  return (
    <div className="sp-photo-row">
      <div className="sp-photo">
        <div className="sp-photo-paper">
          <i style={{ width: "54%" }} /><b /><i style={{ width: "88%" }} /><i style={{ width: "76%" }} /><i className="hl" style={{ width: "82%" }} /><i style={{ width: "68%" }} />
        </div>
      </div>
    </div>
  );
}

export default function SpineDemo() {
  /* The stage picks its wide or compact design from its measured width, so it mounts on the client only;
     the reserved height in spine.css keeps the page from shifting while it does. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="sp">
      <p className="sr-only">
        A text thread. Maria writes that her food benefits are ending and sends a photo of the letter. Mano answers that her renewal is due November 14,
        asks whether to send it to the county, she replies yes, and Mano confirms it was filed in the county's sandbox portal.
      </p>
      <div aria-hidden="true">
        {mounted && (
        <Stage<S>
          width={1100}
          height={500}
          compact={{ below: 720, width: 358, height: 420 }}
          initial={initial}
          poster={poster}
          script={script}
          play="loop"
          accent="#1E7BF6"
          tokens={{ "--ss-font": "var(--font-sans), system-ui, sans-serif" }}
          className="sp-stage"
        >
          {(s, _rect, layout) => (
            <>
              {layout === "wide" && <Letter marked={s.deadline && !s.leaving} />}
              <Phone width={layout === "wide" ? 380 : 326} className="sp-phone">
                <div className="sp-app">
                  <div className="sp-head">
                    <Mascot tile wave tone="orange" size={44} />
                    <span className="sp-name">Mano</span>
                  </div>
                  <Thread className={s.leaving ? "sp-thread sp-leaving" : "sp-thread"}>
                    <Stamp><b>Oct 28</b> 6:12 PM</Stamp>
                    <Bubble from="them">Hi Maria, I&apos;m Mano, an automated assistant.</Bubble>
                    <Bubble from="them">Text me a photo of any letter or form.</Bubble>
                    <Bubble from="me">Ok, thank you</Bubble>
                    <Stamp><b>Today</b> 9:41 PM</Stamp>
                    <Bubble from="me">Got a letter. My food benefits are ending?</Bubble>
                    {s.photo && <Photo />}
                    {(s.thinking || s.deadline) && (
                      <Bubble from="them" typing={s.thinking}>
                        Your renewal is due Nov 14. That is the date that matters.
                      </Bubble>
                    )}
                    {s.ask && <Bubble from="them">I filled it in. Send it to Sample County? YES or NO</Bubble>}
                    {s.yes && <Bubble from="me">Yes</Bubble>}
                    {(s.filing || s.filed) && (
                      <Bubble from="them" typing={s.filing}>
                        Filed in the county&apos;s sandbox portal. Confirmation SB-20481
                      </Bubble>
                    )}
                  </Thread>
                </div>
              </Phone>
            </>
          )}
        </Stage>
        )}
      </div>
    </div>
  );
}
