"use client";
import { useEffect, useRef, useState } from "react";
import { Stage, Phone, Thread, Bubble, Stamp, type Act } from "@/components/stageshow";
import Mascot from "@/components/Mascot";
import "./spine.css";

/* The hero demo as one looping text thread: a person sends a photo of a letter, Mano names the one date, asks a plain
   yes or no, she says yes, and Mano does what it does today. The letter beside the phone is the paper she photographed;
   its date line is marked when Mano names it. Only the food benefits renewal is filed, on the practice portal; the
   others hold the date and say what is coming. Every person, office and confirmation number is made up.
   Built on the Stageshow kit in components/stageshow. */

export type ThreadScene = {
  letter: { from: string; title: string; due: string; note: string };
  me: string;
  read: string;
  ask: string;
  answer: string;
  /* One more message after the answer: a stamp marks it as a later text. */
  last?: { text: string; stamp?: [day: string, time: string] };
};

type S = { photo: boolean; thinking: boolean; deadline: boolean; ask: boolean; yes: boolean; filing: boolean; filed: boolean; last: boolean; leaving: boolean };

const initial: S = { photo: false, thinking: false, deadline: false, ask: false, yes: false, filing: false, filed: false, last: false, leaving: false };

/* One loop, for the hero tab's progress bar. The carousel itself moves on when the loop reports its end. */
export const threadSeconds = (scene: ThreadScene) => (scene.last ? 16.2 : 14.6);

async function script(a: Act<S>, scene: ThreadScene, onLoop: () => void) {
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
  if (scene.last) {
    await a.wait(1600);
    a.mark("last");
    await a.set({ last: true });
  }
  await a.wait(3000);
  a.mark("reset");
  await a.set({ leaving: true });
  await a.wait(320);
  await a.snap({ ...initial, leaving: true });
  await a.wait(60);
  await a.set({ leaving: false });
  await a.wait(900);
  onLoop();
}

function Letter({ letter, marked }: { letter: ThreadScene["letter"]; marked: boolean }) {
  return (
    <div className="sp-letter" aria-hidden="true">
      <div className="sp-letter-from">{letter.from}</div>
      <div className="sp-letter-title">{letter.title}</div>
      <span className="sp-line" style={{ width: "92%" }} />
      <span className="sp-line" style={{ width: "84%" }} />
      <span className="sp-line" style={{ width: "70%" }} />
      <p className="sp-letter-due">
        <mark data-on={marked || undefined}>{letter.due}</mark>
      </p>
      <span className="sp-line" style={{ width: "88%" }} />
      <span className="sp-line" style={{ width: "62%" }} />
      <p className="sp-letter-note">{letter.note}</p>
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

export default function HeroThread({ scene, onLoop }: { scene: ThreadScene; onLoop?: () => void }) {
  const loopRef = useRef(onLoop);
  loopRef.current = onLoop;
  const [play] = useState(() => (a: Act<S>) => script(a, scene, () => loopRef.current?.()));
  /* The stage picks its wide or compact design from its measured width, so it mounts on the client only;
     the reserved height in spine.css keeps the page from shifting while it does. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="sp">
      <p className="sr-only">
        A text thread. Maria writes &ldquo;{scene.me}&rdquo; and sends a photo of the letter. Mano answers &ldquo;{scene.read}&rdquo; and asks &ldquo;{scene.ask}&rdquo; She replies yes, and Mano answers &ldquo;{scene.answer}&rdquo;{scene.last && <> Then Mano writes &ldquo;{scene.last.text}&rdquo;</>}
      </p>
      <div aria-hidden="true">
        {mounted && (
        <Stage<S>
          width={1100}
          height={500}
          compact={{ below: 720, width: 358, height: 420 }}
          initial={initial}
          poster={{ ...initial, photo: true, deadline: true, ask: true, yes: true, filed: true, last: !!scene.last }}
          script={play}
          play="loop"
          accent="#1E7BF6"
          tokens={{ "--ss-font": "var(--font-sans), system-ui, sans-serif" }}
          className="sp-stage"
        >
          {(s, _rect, layout) => (
            <>
              {layout === "wide" && <Letter letter={scene.letter} marked={s.deadline && !s.leaving} />}
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
                    <Bubble from="me" tail={!s.photo}>{scene.me}</Bubble>
                    {s.photo && <Photo />}
                    {(s.thinking || s.deadline) && <Bubble from="them" typing={s.thinking}>{scene.read}</Bubble>}
                    {s.ask && <Bubble from="them">{scene.ask}</Bubble>}
                    {s.yes && <Bubble from="me">Yes</Bubble>}
                    {(s.filing || s.filed) && <Bubble from="them" typing={s.filing}>{scene.answer}</Bubble>}
                    {s.last && scene.last?.stamp && <Stamp><b>{scene.last.stamp[0]}</b> {scene.last.stamp[1]}</Stamp>}
                    {s.last && scene.last && <Bubble from="them">{scene.last.text}</Bubble>}
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
