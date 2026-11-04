// One call Mano waits on for a person, as a pure state machine. Each input
// gives the next state and the effects to run; hold-calls.ts stores the
// state and runs the effects. Nothing here plays audio: Mano has no speech
// output, so no effect can speak on the line. Text heard on the line is
// reduced to one boolean before it gets here and is never kept.

export type Leg = "office" | "person";

// What is known about one leg, under the same rules for both. none: no dial
// began, or the provider refused it. open: a dial began and the leg may be up.
// down: a webhook or a finished hang up confirmed it is gone.
export type LegStatus = "none" | "open" | "down";

export type EndReason =
  | "completed"
  | "no_human"
  | "person_no_answer"
  | "office_hung_up"
  | "office_no_answer"
  | "listen_failed"
  | "provider_failed"
  | "deleted";

interface Base {
  id: string;
  personId: string;
  officeName: string;
  officeNumber: string;
  menu: string | null;
  generation: number;
  startedAtMs: number;
  // One dial of this call. Its timers carry it, so a timer left by a refused
  // dial never ends the retry.
  attempt: string;
  // Whether a stand-in placed this call, kept for the receipt of a reconcile.
  simulated: boolean;
  // By the provider's own caps, the latest any leg of this call can be up.
  liveUntilMs: number;
  legs: Record<Leg, LegStatus>;
}

export type HoldCall = Base &
  (
    | { state: "dialing"; officeCallId: string | null }
    | { state: "holding"; officeCallId: string; listenFailures: number }
    | { state: "ringing_person"; officeCallId: string; personCallId: string | null }
    | { state: "bridged"; officeCallId: string; personCallId: string }
    | { state: "ended"; reason: EndReason; officeCallId: string | null; personCallId: string | null }
  );

export type HoldInput =
  | { kind: "placed"; leg: Leg; providerCallId: string }
  | { kind: "answered"; leg: Leg; providerCallId: string }
  | { kind: "hung_up"; leg: Leg; providerCallId: string }
  | { kind: "heard"; human: boolean }
  | { kind: "listen_failed" }
  | { kind: "hold_limit" }
  | { kind: "ring_limit" }
  | { kind: "provider_failed" }
  | { kind: "deleted" };

export type HoldEffect =
  | { do: "send_dtmf"; callId: string; digits: string }
  | { do: "listen"; callId: string }
  | { do: "arm_ring_limit" }
  | { do: "dial_person" }
  | { do: "bridge"; officeCallId: string; personCallId: string }
  | { do: "hang_up"; leg: Leg; callId: string }
  | { do: "text"; reason: EndReason };

export const MAX_LISTEN_FAILURES = 3;

export function knownLeg(call: HoldCall, leg: Leg): string | null {
  if (leg === "office") return call.officeCallId;
  return "personCallId" in call ? call.personCallId : null;
}

// Ends the call: hangs up every leg still known to be up and texts the
// person when the reason is worth a text.
function end(call: HoldCall, reason: EndReason, alreadyDown?: Leg): { call: HoldCall; effects: HoldEffect[] } {
  const officeCallId = call.officeCallId;
  const personCallId = knownLeg(call, "person");
  const effects: HoldEffect[] = [];
  if (officeCallId && alreadyDown !== "office") effects.push({ do: "hang_up", leg: "office", callId: officeCallId });
  if (personCallId && alreadyDown !== "person") effects.push({ do: "hang_up", leg: "person", callId: personCallId });
  effects.push({ do: "text", reason });
  const legs = alreadyDown ? { ...call.legs, [alreadyDown]: "down" } : call.legs;
  return { call: { ...base(call), legs, state: "ended", reason, officeCallId, personCallId }, effects };
}

// A dial of this leg is about to begin. The call may now be up until the later
// of its old limit and this leg's own cap.
export function legDialed(call: HoldCall, leg: Leg, capUntilMs: number): HoldCall {
  return { ...call, legs: { ...call.legs, [leg]: "open" }, liveUntilMs: Math.max(call.liveUntilMs, capUntilMs) };
}

// The provider refused this leg's dial, so it was never up.
export function legRefused(call: HoldCall, leg: Leg): HoldCall {
  return { ...call, legs: { ...call.legs, [leg]: "none" } };
}

// Whether a call no longer stands in the way of another: it ended and no leg
// may still be up.
export function settled(call: HoldCall): boolean {
  return call.state === "ended" && call.legs.office !== "open" && call.legs.person !== "open";
}

function base(call: HoldCall): Base {
  const { id, personId, officeName, officeNumber, menu, generation, startedAtMs, attempt, simulated, liveUntilMs, legs } = call;
  return { id, personId, officeName, officeNumber, menu, generation, startedAtMs, attempt, simulated, liveUntilMs, legs };
}

// A retried or late input that no longer applies changes nothing, so a
// duplicate webhook or an old timer can never ring or bridge twice.
export function stepHoldCall(call: HoldCall, input: HoldInput): { call: HoldCall; effects: HoldEffect[] } {
  const same = { call, effects: [] as HoldEffect[] };
  if (call.state === "ended") {
    if (input.kind !== "placed" && input.kind !== "answered" && input.kind !== "hung_up") return same;
    const { leg, providerCallId } = input;
    const known = knownLeg(call, leg);
    const down = input.kind === "hung_up";
    // Another ID than the one on record says nothing about this leg, but it
    // is on a call Mano ended, so unless it is already gone, hang it up.
    if (known && known !== providerCallId) {
      return { call, effects: down ? [] : [{ do: "hang_up", leg, callId: providerCallId }] };
    }
    if (known) return down ? { call: { ...call, legs: { ...call.legs, [leg]: "down" } }, effects: [] } : same;
    // The call ended before this leg's ID was known, so nothing hung it up.
    // The ID is kept as proof the dial happened.
    const key = leg === "office" ? "officeCallId" : "personCallId";
    return {
      call: { ...call, [key]: providerCallId, legs: { ...call.legs, [leg]: down ? "down" : "open" } },
      effects: down ? [] : [{ do: "hang_up", leg, callId: providerCallId }],
    };
  }
  if (input.kind === "deleted" || input.kind === "provider_failed") return end(call, input.kind);
  if (input.kind === "placed" || input.kind === "answered" || input.kind === "hung_up") {
    // An event for a leg this call has already named under another ID is
    // not about this call.
    const known = knownLeg(call, input.leg);
    if (known && known !== input.providerCallId) return same;
  }

  switch (call.state) {
    case "dialing":
      if (input.kind === "placed" && input.leg === "office") return { call: { ...call, officeCallId: input.providerCallId }, effects: [] };
      if (input.kind === "answered" && input.leg === "office") {
        const callId = input.providerCallId;
        const effects: HoldEffect[] = [{ do: "listen", callId }];
        if (call.menu) effects.unshift({ do: "send_dtmf", callId, digits: call.menu });
        return { call: { ...base(call), state: "holding", officeCallId: callId, listenFailures: 0 }, effects };
      }
      if (input.kind === "hung_up" && input.leg === "office") {
        return end({ ...call, officeCallId: input.providerCallId }, "office_no_answer", "office");
      }
      if (input.kind === "hold_limit") return end(call, "office_no_answer");
      return same;

    case "holding":
      if (input.kind === "heard") {
        if (!input.human) return { call: { ...call, listenFailures: 0 }, effects: [] };
        return {
          call: { ...base(call), state: "ringing_person", officeCallId: call.officeCallId, personCallId: null },
          // The limit goes first, so a dial that never returns is still bounded.
          effects: [{ do: "arm_ring_limit" }, { do: "dial_person" }],
        };
      }
      if (input.kind === "listen_failed") {
        const listenFailures = call.listenFailures + 1;
        if (listenFailures >= MAX_LISTEN_FAILURES) return end(call, "listen_failed");
        return { call: { ...call, listenFailures }, effects: [] };
      }
      if (input.kind === "hung_up" && input.leg === "office") return end(call, "office_hung_up", "office");
      if (input.kind === "hold_limit") return end(call, "no_human");
      return same;

    case "ringing_person":
      if (input.kind === "placed" && input.leg === "person") return { call: { ...call, personCallId: input.providerCallId }, effects: [] };
      if (input.kind === "answered" && input.leg === "person") {
        const personCallId = input.providerCallId;
        return {
          call: { ...base(call), state: "bridged", officeCallId: call.officeCallId, personCallId },
          effects: [{ do: "bridge", officeCallId: call.officeCallId, personCallId }],
        };
      }
      if (input.kind === "hung_up" && input.leg === "person") {
        return end({ ...call, personCallId: input.providerCallId }, "person_no_answer", "person");
      }
      if (input.kind === "hung_up" && input.leg === "office") return end(call, "office_hung_up", "office");
      if (input.kind === "ring_limit" || input.kind === "hold_limit") return end(call, "person_no_answer");
      return same;

    case "bridged":
      // The call is theirs now. No limit applies; either side ending it ends both.
      if (input.kind === "hung_up") return end(call, "completed", input.leg);
      return same;
  }
}

// What the person is told. A connected call or a deleted conversation needs
// no text.
export function endText(reason: EndReason, officeName: string, heldMinutes: number): string | null {
  switch (reason) {
    case "completed":
    case "deleted":
      return null;
    case "no_human":
      return `I waited on hold with ${officeName} for ${heldMinutes} minutes and nobody picked up, so I hung up. Text me if you want me to try again.`;
    case "person_no_answer":
      return `Someone at ${officeName} picked up, but I could not reach you on your phone, so I hung up. Text me if you want me to try again.`;
    case "office_hung_up":
      return `${officeName} ended the call before I could connect you. Text me if you want me to try again.`;
    case "office_no_answer":
      return `I could not get through to ${officeName}. Text me if you want me to try again.`;
    case "listen_failed":
      return `I could not listen to the line at ${officeName}, so I hung up rather than miss someone picking up. Text me if you want me to try again.`;
    case "provider_failed":
      return `Something went wrong on my call to ${officeName}, so I ended it. Text me if you want me to try again.`;
  }
}

// Hold recordings first: they often borrow a greeting's words, and ringing
// the person for a recording costs more than waiting for the next window.
const RECORDED = [
  /\byour call is (very )?important\b/,
  /\b(please )?(stay|remain) on the line\b/,
  /\b(please|continue to) hold\b/,
  /\bnext available\b/,
  /\bin the order\b/,
  /\b(estimated|current) (wait|hold)\b/,
  /\bwait time\b/,
  /\bpress \w+\b/,
  /\bmay be (monitored|recorded)\b/,
  /\boffice hours\b/,
  /\bvisit our website\b/,
  /\bpermanezca en la l[ií]nea\b/,
  /\bsu llamada es importante\b/,
  /\boprima\b/,
];
const HUMAN = [
  /\bhow (can|may) i (help|assist)\b/,
  /\bthis is \w+/,
  /\bmy name is\b/,
  /\bspeaking\b/,
  /\bthanks? (you )?for holding\b/,
  /\bwho am i speaking\b/,
  /\bare you there\b/,
  /\bhello\b/,
  /\ben qu[eé] (puedo|le puedo) ayudar\b/,
  /\bmi nombre es\b/,
  /\bgracias por esperar\b/,
  /\bhola\b/,
];

// Whether one window of hold audio sounds like a person answering. Plain
// code, so words on the line can only ring the person, never steer anything.
export function looksLikeHuman(transcript: string): boolean {
  const heard = transcript.toLowerCase();
  if (RECORDED.some((p) => p.test(heard))) return false;
  return HUMAN.some((p) => p.test(heard));
}
