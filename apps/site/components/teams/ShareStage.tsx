"use client";
import { useEffect, useState } from "react";
import { Stage, Phone, Thread, Bubble, Stamp, type Act } from "@/components/stageshow";
import Mascot from "@/components/Mascot";
import "@/components/home/spine.css";
import "./share-stage.css";

/* Sharing one case, as it runs today: a person says yes by text, the caseworker's screen on the sandbox portal shows
   only what she shared, the office asks for a document, and when she stops the case is gone at the next click. The
   screen's words are from apps/sandbox-portal/src/staff.ts and the request text from apps/engine/src/case-sharing.ts.
   Maria and her case are made up, and the office is our own test office. Built on the Stageshow kit, from the same
   gold as HeroThread. */

const OFFICE = "the Sandbox County Human Services test office";
const ASK_SHARE = `Share your name, program, case number and renewal date with ${OFFICE}, for your food benefits renewal? YES or NO`;
const REQUEST = `The Sandbox County Human Services test office asked for your pay stub for your food benefits renewal. Send a photo of it here and I will check with you before it goes to them.`;
const ASK_STOP = `Stop sharing your food benefits renewal with ${OFFICE}? YES or NO`;
const STOPPED = "Stopped. They can't see anything new. They keep what they already have, and I can't pull that back.";

const DETAILS: [string, string][] = [["Name", "Maria Torres"], ["Program", "Food benefits"], ["Case number", "R-1042"], ["Renewal due", "2026-11-14"]];

type View = "none" | "case" | "asked" | "gone";
type S = { ask: boolean; yes: boolean; shared: boolean; request: boolean; stop: boolean; askStop: boolean; yes2: boolean; stopped: boolean; view: View; leaving: boolean };

const initial: S = { ask: false, yes: false, shared: false, request: false, stop: false, askStop: false, yes2: false, stopped: false, view: "none", leaving: false };

async function script(a: Act<S>) {
  await a.wait(1400);
  a.mark("ask");
  await a.set({ ask: true });
  await a.wait(2600);
  a.mark("yes");
  await a.set({ yes: true });
  await a.wait(900);
  a.mark("shared");
  await a.set({ shared: true, view: "case" });
  await a.wait(3200);
  a.mark("request");
  await a.set({ request: true, view: "asked" });
  await a.wait(3600);
  await a.set({ stop: true });
  await a.wait(1000);
  await a.set({ askStop: true });
  await a.wait(1800);
  await a.set({ yes2: true });
  await a.wait(900);
  a.mark("stopped");
  await a.set({ stopped: true, view: "gone" });
  await a.wait(3400);
  a.mark("reset");
  await a.set({ leaving: true });
  await a.wait(320);
  await a.snap({ ...initial, leaving: true });
  await a.wait(60);
  await a.set({ leaving: false });
  await a.wait(600);
}

function Screen({ view, leaving }: { view: View; leaving: boolean }) {
  return (
    <div className={leaving ? "ts-screen ts-leaving" : "ts-screen"}>
      <div className="ts-bar">sandbox.withmano.com/staff</div>
      <div className="ts-body">
        {view === "none" && (
          <>
            <h4>Cases shared with Sandbox County Human Services (test office)</h4>
            <p>No resident is sharing a case with this office right now.</p>
          </>
        )}
        {(view === "case" || view === "asked") && (
          <>
            <h4>Shared case</h4>
            <p>Shared by the resident through Mano, with their approval, for your food benefits renewal. This is all the resident shared.</p>
            <table><tbody>{DETAILS.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
            <h5>What this office asked for</h5>
            <p className="ts-asked">{view === "asked" ? "Pay stub: open" : "Nothing yet."}</p>
          </>
        )}
        {view === "gone" && <p className="ts-error">This case is not shared with this office. The resident may have stopped sharing it.</p>}
      </div>
    </div>
  );
}

export default function ShareStage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="h-stage ts-wrap" data-flush>
      <div className="ts">
        <p className="sr-only">
          A text thread beside the caseworker&rsquo;s screen on the sandbox portal. Mano asks &ldquo;{ASK_SHARE}&rdquo; Maria says yes, and the screen shows her name, program, case number and renewal date, and says that is all she shared. The office asks for a pay stub and Mano texts &ldquo;{REQUEST}&rdquo; Maria stops sharing, and the screen says &ldquo;This case is not shared with this office.&rdquo;
        </p>
        <div aria-hidden="true">
          {mounted && (
            <Stage<S>
              width={1100}
              height={500}
              compact={{ below: 720, width: 358, height: 600 }}
              initial={initial}
              poster={{ ...initial, ask: true, yes: true, shared: true, view: "case" }}
              script={script}
              play="loop"
              accent="#1A6FE0"
              tokens={{ "--ss-font": "var(--font-sans), system-ui, sans-serif" }}
              className="sp-stage ts-stage"
            >
              {(s, _rect, layout) => (
                <>
                  <Screen view={s.view} leaving={s.leaving} />
                  <Phone width={layout === "wide" ? 380 : 326} className="sp-phone ts-phone">
                    <div className="sp-app">
                      <div className="sp-head">
                        <Mascot tile wave tone="orange" size={44} />
                        <span className="sp-name">Mano</span>
                      </div>
                      <Thread className={s.leaving ? "sp-thread sp-leaving" : "sp-thread"}>
                        <Stamp><b>Today</b> 9:41 PM</Stamp>
                        <Bubble from="me">Can my caseworker see my renewal?</Bubble>
                        {s.ask && <Bubble from="them">{ASK_SHARE}</Bubble>}
                        {s.yes && <Bubble from="me">Yes</Bubble>}
                        {s.shared && <Bubble from="them">Shared.</Bubble>}
                        {s.request && <Bubble from="them">{REQUEST}</Bubble>}
                        {s.stop && <Bubble from="me">Stop sharing</Bubble>}
                        {s.askStop && <Bubble from="them">{ASK_STOP}</Bubble>}
                        {s.yes2 && <Bubble from="me">Yes</Bubble>}
                        {s.stopped && <Bubble from="them">{STOPPED}</Bubble>}
                      </Thread>
                    </div>
                  </Phone>
                </>
              )}
            </Stage>
          )}
        </div>
      </div>
    </div>
  );
}
