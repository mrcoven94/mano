// Runs hold calls on the person's Durable Object: stores each call's state
// in that person's SQLite, runs the effects stepHoldCall asks for, and turns
// webhooks, timers and audio windows into inputs. Audio is transcribed in
// memory and dropped; no audio or transcript is ever written anywhere.
//
// State commits before its effects run. A crash between the two strands the
// call until its hold limit, which was armed before the first dial and ends
// any call that has not been bridged. The provider's own cap on each call
// covers a hang up that is lost.
import { DefiniteFailureError, type ActionRequest, type CheckOutcome } from "../gateway/types.js";
import { sha256Hex } from "../hash.js";
import { endText, knownLeg, legDialed, legRefused, looksLikeHuman, settled, stepHoldCall, type HoldCall, type HoldEffect, type HoldInput, type Leg } from "./hold-call.js";
import { isPhoneNumber, type CallEvent, type CallServices } from "./provider.js";

const MENU = /^[0-9*#wW]{1,32}$/;
// Past the hold limit and the ring limit, so the provider's cap never cuts
// a call Mano still means to hold or has just bridged.
const CAP_MARGIN_SECONDS = 2 * 3600;
// Slack on the provider's cap before a call is treated as certainly over.
const CAP_SETTLE_MS = 5 * 60_000;

export type HoldLimit = { id: string; attempt: string; kind: "hold_limit" | "ring_limit" };
export type HoldAudit = `hold_call.${HoldCall["state"]}` | "hold_call.hang_up_failed" | "hold_call.effect_failed";

export interface HoldCallDeps {
  sql: SqlStorage;
  transaction<T>(fn: () => T): T;
  services(): CallServices | null;
  generation(): number;
  schedule(at: Date, limit: HoldLimit): Promise<void>;
  // Queues a text to the person on the durable reminder path, under an ID
  // that makes a repeat the same text.
  text(id: string, text: string, generation: number): Promise<void>;
  audit(event: HoldAudit, id: string): Promise<void>;
}

type Parsed = { ok: true; officeNumber: string; menu: string | null } | { ok: false; problem: string };

function parseCall(req: ActionRequest, services: CallServices): Parsed {
  const { config } = services;
  if (req.personId !== config.personId) return { ok: false, problem: "Mano can only place calls on its own test line for now." };
  const number = req.payload.phoneNumber;
  if (!isPhoneNumber(number) || !config.allowedNumbers.has(number)) {
    return { ok: false, problem: "Mano can only call its own test numbers for now." };
  }
  const menu = req.payload.menu;
  if (menu !== undefined && (typeof menu !== "string" || !MENU.test(menu))) {
    return { ok: false, problem: "Menu steps must be phone keys only." };
  }
  return { ok: true, officeNumber: number, menu: menu ?? null };
}

export class HoldCalls {
  constructor(private deps: HoldCallDeps) {
    deps.sql.exec(`CREATE TABLE IF NOT EXISTS hold_calls(id TEXT PRIMARY KEY, call_json TEXT NOT NULL, blocks_until_ms INTEGER NOT NULL)`);
    deps.sql.exec(`CREATE TABLE IF NOT EXISTS hold_call_events(event_key TEXT PRIMARY KEY, call_id TEXT NOT NULL)`);
  }

  live(): boolean {
    return this.deps.services() !== null;
  }

  simulated(): boolean {
    return this.deps.services()?.provider.simulated ?? true;
  }

  private read(id: string): HoldCall | null {
    const row = this.deps.sql.exec("SELECT call_json FROM hold_calls WHERE id = ?", id).toArray()[0] as { call_json: string } | undefined;
    return row ? (JSON.parse(row.call_json) as HoldCall) : null;
  }

  // A call blocks a replacement until it ended and every leg is confirmed down.
  // A hang up can fail and a leg's end may never be reported, so the block also
  // stops when the last leg's cap has passed.
  private write(call: HoldCall): void {
    this.deps.sql.exec(
      "INSERT INTO hold_calls(id, call_json, blocks_until_ms) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET call_json = excluded.call_json, blocks_until_ms = excluded.blocks_until_ms",
      call.id,
      JSON.stringify(call),
      settled(call) ? 0 : call.liveUntilMs,
    );
  }

  private blocked(now: number): boolean {
    return this.deps.sql.exec("SELECT 1 FROM hold_calls WHERE blocks_until_ms > ? LIMIT 1", now).toArray().length > 0;
  }

  private idFor(idempotencyKey: string, personId: string): Promise<string> {
    return sha256Hex(`${personId}:${idempotencyKey}`).then((hash) => `hold-${hash.slice(0, 40)}`);
  }

  // Why this call cannot go ahead, asked before the approval and again right
  // before dialing.
  refuse(req: ActionRequest): string | null {
    const services = this.deps.services();
    if (!services) return "Mano cannot place calls here.";
    const parsed = parseCall(req, services);
    return parsed.ok ? null : parsed.problem;
  }

  // Places the approved call and returns the office leg's ID. Everything that
  // awaits comes first and stores nothing, so a failure or a delete there
  // leaves nothing to clean up. The checks, the row and the start of the dial
  // then happen with no await between them, so a row always means a dial began.
  async begin(req: ActionRequest): Promise<string> {
    const services = this.deps.services();
    if (!services) throw new DefiniteFailureError("Mano cannot place calls here.");
    const parsed = parseCall(req, services);
    if (!parsed.ok) throw new DefiniteFailureError(parsed.problem);
    // The gateway checked the approval with no await before this line. A
    // delete is what revokes an approval, and it moves the generation.
    const generation = this.deps.generation();
    const id = await this.idFor(req.idempotencyKey, req.personId);
    const attempt = crypto.randomUUID();
    const startedAtMs = Date.now();
    const holdUntilMs = startedAtMs + services.config.holdLimitMs;
    try {
      // A timer left behind by a call that never starts names an attempt no
      // row holds, so it does nothing.
      await this.deps.schedule(new Date(holdUntilMs), { id, attempt, kind: "hold_limit" });
      await this.deps.audit("hold_call.dialing", id);
    } catch {
      throw new DefiniteFailureError("Mano could not set up the call, so nothing was dialed.");
    }

    if (this.deps.generation() !== generation) throw new DefiniteFailureError("The conversation was deleted, so nothing was dialed.");
    // Past this, the timer has already fired on nothing and no limit would end the call.
    const now = Date.now();
    if (now >= holdUntilMs) throw new DefiniteFailureError("The call took too long to set up, so nothing was dialed.");
    const existing = this.read(id);
    if (existing?.officeCallId) return existing.officeCallId;
    if (existing && now < existing.liveUntilMs) throw new Error("The outcome of this dial is not known yet.");
    // Recovery runs this again on its own once check() reads absent, hours
    // after the person was told the call failed. Only a new approval redials.
    if (existing) throw new DefiniteFailureError("That call is over. Mano needs a new yes to try again.");
    if (this.blocked(now)) throw new DefiniteFailureError("Mano is already on a call for this person.");
    this.write({
      id,
      personId: req.personId,
      officeName: req.recipient,
      officeNumber: parsed.officeNumber,
      menu: parsed.menu,
      generation,
      startedAtMs,
      attempt,
      simulated: services.provider.simulated,
      liveUntilMs: 0,
      legs: { office: "none", person: "none" },
      state: "dialing",
      officeCallId: null,
    });
    // A refused first dial leaves no call at all, and a retry starts clean.
    return this.dial(id, "office", parsed.officeNumber, services, () => this.deps.sql.exec("DELETE FROM hold_calls WHERE id = ?", id));
  }

  // Dials one leg. Up to the provider call nothing awaits, so a caller's check
  // of the state still holds when the dial begins, and the leg counts as
  // possibly up from that moment.
  private async dial(id: string, leg: Leg, to: string, services: CallServices, onRefused: () => void): Promise<string> {
    const call = this.read(id)!;
    const maxSeconds = this.capSeconds(services);
    this.write(legDialed(call, leg, Date.now() + maxSeconds * 1000 + CAP_SETTLE_MS));
    let providerCallId: string;
    try {
      ({ providerCallId } = await services.provider.placeCall({
        to,
        holdCallId: id,
        personId: call.personId,
        leg,
        // Per attempt: a provider that remembers its refusal must still take
        // the retry. An unknown outcome never reaches a second dial.
        idempotencyKey: `${id}:${call.attempt}:${leg}`,
        maxSeconds,
      }));
    } catch (err) {
      // A webhook already proved this leg, whatever the dial's answer says.
      const latest = this.read(id);
      const proven = latest && knownLeg(latest, leg);
      if (proven) return proven;
      // A refusal means no leg exists. Any other failure leaves it possibly
      // up, so it blocks until a webhook proves it or its cap has passed.
      if ((err as Error)?.name === "DefiniteFailureError") onRefused();
      throw err;
    }
    // If the call ended during the dial, this hangs up the leg it returned.
    await this.apply(id, { kind: "placed", leg, providerCallId });
    return providerCallId;
  }

  // The gateway's reconcile lookup. A row with no office leg means the dial's
  // outcome is unknown, which is never the same as absent, until the provider's
  // cap has passed: nothing can still be up, and begin() settles the attempt
  // as failed without dialing, so it stops being retried.
  async check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    const call = this.read(await this.idFor(idempotencyKey, personId));
    if (!call) return { found: false };
    if (call.officeCallId) return { found: true, externalId: call.officeCallId, simulated: call.simulated };
    if (Date.now() >= call.liveUntilMs) return { found: false };
    throw new Error("The outcome of this dial is not known yet.");
  }

  onEvent(event: CallEvent): Promise<void> {
    return this.apply(event.holdCallId, { kind: event.kind, leg: event.leg, providerCallId: event.providerCallId }, event.eventId);
  }

  async onLimit(limit: HoldLimit): Promise<void> {
    if (this.read(limit.id)?.attempt !== limit.attempt) return;
    await this.apply(limit.id, { kind: limit.kind });
  }

  // One window of hold audio. The state is read again after the model
  // answers, since the call may have moved on while it was listening.
  async onAudio(id: string, audio: Uint8Array): Promise<void> {
    const services = this.deps.services();
    if (!services || this.read(id)?.state !== "holding") return;
    let input: HoldInput;
    try {
      input = { kind: "heard", human: looksLikeHuman(await services.transcriber.transcribe(audio)) };
    } catch {
      input = { kind: "listen_failed" };
    }
    await this.apply(id, input);
  }

  // The conversation was deleted: end any live call and keep nothing about
  // who was called. The rows stay with only their opaque IDs, because a dial
  // in flight can still name a leg, and that leg has to be hung up.
  async conversationDeleted(): Promise<void> {
    // Every call ends in this one step, so no event can act on one while
    // another's hang up waits. One stuck hang up does not hold up the others.
    const steps = this.deps.transaction(() => {
      this.deps.sql.exec("DELETE FROM hold_call_events");
      return this.deps.sql.exec("SELECT call_json FROM hold_calls").toArray().map((row) => {
        const call = JSON.parse(row.call_json as string) as HoldCall;
        const out = stepHoldCall({ ...call, officeName: "", officeNumber: "", menu: null }, { kind: "deleted" });
        this.write(out.call);
        return { ...out, moved: out.call.state !== call.state };
      });
    });
    await Promise.allSettled(steps.map((step) => this.finish(step)));
  }

  private capSeconds(services: CallServices): number {
    return Math.ceil(services.config.holdLimitMs / 1000) + CAP_MARGIN_SECONDS;
  }

  private async apply(id: string, input: HoldInput, eventId?: string): Promise<void> {
    const step = this.deps.transaction(() => {
      const call = this.read(id);
      if (!call) return null;
      if (eventId !== undefined) {
        const fresh = this.deps.sql.exec("INSERT OR IGNORE INTO hold_call_events(event_key, call_id) VALUES (?, ?)", `${id}:${eventId}`, id).rowsWritten;
        if (fresh === 0) return null;
      }
      const out = stepHoldCall(call, input);
      this.write(out.call);
      return { ...out, moved: out.call.state !== call.state };
    });
    if (step) await this.finish(step);
  }

  private async finish(step: { call: HoldCall; effects: HoldEffect[]; moved: boolean }): Promise<void> {
    if (step.moved) await this.deps.audit(`hold_call.${step.call.state}`, step.call.id);
    await this.run(step.call, step.effects);
  }

  private async run(call: HoldCall, effects: HoldEffect[]): Promise<void> {
    const services = this.deps.services();
    for (const effect of effects) {
      if (!this.stillApplies(call.id, effect)) continue;
      try {
        await this.runOne(call, effect, services);
      } catch {
        // A hang up that fails leaves its leg open, which keeps blocking a
        // replacement until a webhook confirms it or its cap has passed.
        // Anything else leaves the call in a state Mano did not intend, so it
        // ends, unless the call has moved on and the failure no longer matters.
        // Each await here lets events in, so the check comes after it too.
        if (effect.do === "hang_up") {
          await this.deps.audit("hold_call.hang_up_failed", call.id);
          continue;
        }
        if (!this.stillApplies(call.id, effect)) continue;
        await this.deps.audit("hold_call.effect_failed", call.id);
        if (!this.stillApplies(call.id, effect)) continue;
        await this.apply(call.id, { kind: "provider_failed" });
        return;
      }
    }
  }

  // Whether the call is still where this effect belongs. Audits, timers and
  // provider calls let other events in, so a step's effects, and a failure of
  // one, may be out of date. Nothing awaits between this check and what it
  // guards.
  private stillApplies(id: string, effect: HoldEffect): boolean {
    const call = this.read(id);
    switch (effect.do) {
      case "dial_person":
        return call?.state === "ringing_person" && call.personCallId === null;
      case "arm_ring_limit":
        return call?.state === "ringing_person";
      case "bridge":
        return call?.state === "bridged" && call.officeCallId === effect.officeCallId && call.personCallId === effect.personCallId;
      case "send_dtmf":
      case "listen":
        return call?.state === "holding";
      default:
        return true;
    }
  }

  private async runOne(call: HoldCall, effect: HoldEffect, services: CallServices | null): Promise<void> {
    if (effect.do === "text") {
      const minutes = Math.max(1, Math.round((Date.now() - call.startedAtMs) / 60_000));
      const text = endText(effect.reason, call.officeName, minutes);
      if (text) await this.deps.text(`hold-call-${call.id}`, text, call.generation);
      return;
    }
    if (!services) throw new Error("Calls are not set up.");
    switch (effect.do) {
      case "send_dtmf":
        return services.provider.sendDtmf(effect.callId, effect.digits);
      case "listen":
        return services.provider.startListening(effect.callId);
      case "arm_ring_limit":
        return this.deps.schedule(new Date(Date.now() + services.config.ringLimitMs), { id: call.id, attempt: call.attempt, kind: "ring_limit" });
      case "dial_person":
        await this.dial(call.id, "person", services.config.personNumber, services, () => {
          const latest = this.read(call.id);
          if (latest) this.write(legRefused(latest, "person"));
        });
        return;
      case "bridge":
        return services.provider.bridge(effect.officeCallId, effect.personCallId);
      case "hang_up":
        await services.provider.hangUp(effect.callId);
        return this.apply(call.id, { kind: "hung_up", leg: effect.leg, providerCallId: effect.callId });
    }
  }
}
