// One call Mano waits on for a person, as a pure state machine. Each input
// gives the next state and the effects to run; hold-calls.ts stores the
// state and runs the effects. Nothing here plays audio: Mano has no speech
// output, so no effect can speak on the line. Text heard on the line is
// reduced to one boolean before it gets here and is never kept.

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
}

export type HoldCall = Base &
  (
    | { state: "dialing"; officeCallId: string | null }
    | { state: "holding"; officeCallId: string; listenFailures: number }
    | { state: "ringing_person"; officeCallId: string; personCallId: string | null }
    | { state: "bridged"; officeCallId: string; personCallId: string }
    | { state: "ended"; reason: EndReason; officeCallId: string | null; personCallId: string | null }
  );

export type Leg = "office" | "person";

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
  | { do: "hang_up"; callId: string }
  | { do: "text"; reason: EndReason };

export const MAX_LISTEN_FAILURES = 3;

function knownLeg(call: HoldCall, leg: Leg): string | null {
  if (leg === "office") return call.officeCallId;
  return "personCallId" in call ? call.personCallId : null;
}

// Ends the call: hangs up every leg still known to be up and texts the
// person when the reason is worth a text.
function end(call: HoldCall, reason: EndReason, alreadyDown?: Leg): { call: HoldCall; effects: HoldEffect[] } {
  const officeCallId = call.officeCallId;
  const personCallId = knownLeg(call, "person");
  const effects: HoldEffect[] = [];
  if (officeCallId && alreadyDown !== "office") effects.push({ do: "hang_up", callId: officeCallId });
  if (personCallId && alreadyDown !== "person") effects.push({ do: "hang_up", callId: personCallId });
  effects.push({ do: "text", reason });
  return { call: { ...base(call), state: "ended", reason, officeCallId, personCallId }, effects };
}

function base(call: HoldCall): Base {
  const { id, personId, officeName, officeNumber, menu, generation, startedAtMs } = call;
  return { id, personId, officeName, officeNumber, menu, generation, startedAtMs };
}

// A retried or late input that no longer applies changes nothing, so a
// duplicate webhook or an old timer can never ring or bridge twice.
export function stepHoldCall(call: HoldCall, input: HoldInput): { call: HoldCall; effects: HoldEffect[] } {
  const same = { call, effects: [] as HoldEffect[] };
  if (call.state === "ended") {
    // The call ended before this leg's ID was known, so that leg was never
    // hung up. Hang it up now and keep the ID.
    if ((input.kind === "placed" || input.kind === "answered") && knownLeg(call, input.leg) !== input.providerCallId) {
      const key = input.leg === "office" ? "officeCallId" : "personCallId";
      return { call: { ...call, [key]: input.providerCallId }, effects: [{ do: "hang_up", callId: input.providerCallId }] };
    }
    return same;
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
