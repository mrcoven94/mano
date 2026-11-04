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
import { endText, looksLikeHuman, stepHoldCall, type HoldCall, type HoldEffect, type HoldInput } from "./hold-call.js";
import { isPhoneNumber, type CallEvent, type CallServices } from "./provider.js";

const MENU = /^[0-9*#wW]{1,32}$/;
// Past the hold limit and the ring limit, so the provider's cap never cuts
// a call Mano still means to hold or has just bridged.
const CAP_MARGIN_SECONDS = 2 * 3600;

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
    deps.sql.exec(`CREATE TABLE IF NOT EXISTS hold_calls(id TEXT PRIMARY KEY, call_json TEXT NOT NULL, active INTEGER NOT NULL)`);
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

  private write(call: HoldCall): void {
    this.deps.sql.exec(
      "INSERT INTO hold_calls(id, call_json, active) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET call_json = excluded.call_json, active = excluded.active",
      call.id,
      JSON.stringify(call),
      call.state === "ended" ? 0 : 1,
    );
  }

  private activeId(): string | null {
    const row = this.deps.sql.exec("SELECT id FROM hold_calls WHERE active = 1 LIMIT 1").toArray()[0] as { id: string } | undefined;
    return row?.id ?? null;
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

  // Places the approved call and returns the office leg's ID.
  async begin(req: ActionRequest): Promise<string> {
    const services = this.deps.services();
    if (!services) throw new DefiniteFailureError("Mano cannot place calls here.");
    const parsed = parseCall(req, services);
    if (!parsed.ok) throw new DefiniteFailureError(parsed.problem);
    const id = await this.idFor(req.idempotencyKey, req.personId);
    const existing = this.read(id);
    if (existing) {
      if (existing.officeCallId) return existing.officeCallId;
      throw new Error("The outcome of this dial is not known yet.");
    }
    const active = this.activeId();
    if (active) throw new DefiniteFailureError("Mano is already on a call for this person.");

    const now = Date.now();
    const attempt = crypto.randomUUID();
    this.write({
      id,
      personId: req.personId,
      officeName: req.recipient,
      officeNumber: parsed.officeNumber,
      menu: parsed.menu,
      generation: this.deps.generation(),
      startedAtMs: now,
      attempt,
      simulated: services.provider.simulated,
      state: "dialing",
      officeCallId: null,
    });
    await this.deps.schedule(new Date(now + services.config.holdLimitMs), { id, attempt, kind: "hold_limit" });
    await this.deps.audit("hold_call.dialing", id);
    try {
      const { providerCallId } = await services.provider.placeCall({
        to: parsed.officeNumber,
        holdCallId: id,
        personId: req.personId,
        leg: "office",
        // Per attempt: a provider that remembers its refusal must still take
        // the retry. An unknown outcome never reaches a second dial.
        idempotencyKey: `${id}:${attempt}:office`,
        maxSeconds: this.capSeconds(services),
      });
      await this.apply(id, { kind: "placed", leg: "office", providerCallId });
      return providerCallId;
    } catch (err) {
      // The provider refused, so no call exists and a retry starts clean.
      // Any other failure leaves the row: a webhook may still prove the call
      // happened, and check() stays unknown until then.
      if ((err as Error)?.name === "DefiniteFailureError") this.deps.sql.exec("DELETE FROM hold_calls WHERE id = ?", id);
      throw err;
    }
  }

  // The gateway's reconcile lookup. A row with no office leg means the dial's
  // outcome is unknown, which is never the same as absent.
  async check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    const call = this.read(await this.idFor(idempotencyKey, personId));
    if (!call) return { found: false };
    if (call.officeCallId) return { found: true, externalId: call.officeCallId, simulated: call.simulated };
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
    const active = this.activeId();
    this.deps.transaction(() => {
      for (const row of this.deps.sql.exec("SELECT call_json FROM hold_calls").toArray() as { call_json: string }[]) {
        this.write({ ...(JSON.parse(row.call_json) as HoldCall), officeName: "", officeNumber: "", menu: null });
      }
      this.deps.sql.exec("DELETE FROM hold_call_events");
    });
    if (active) await this.apply(active, { kind: "deleted" });
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
    if (!step) return;
    if (step.moved) await this.deps.audit(`hold_call.${step.call.state}`, id);
    await this.run(step.call, step.effects);
  }

  private async run(call: HoldCall, effects: HoldEffect[]): Promise<void> {
    const services = this.deps.services();
    for (const effect of effects) {
      if (!this.stillApplies(call.id, effect)) continue;
      try {
        await this.runOne(call, effect, services);
      } catch {
        // A hang up that fails is covered by the provider's cap. Anything
        // else leaves the call in a state Mano did not intend, so it ends.
        if (effect.do === "hang_up") {
          await this.deps.audit("hold_call.hang_up_failed", call.id);
          continue;
        }
        await this.deps.audit("hold_call.effect_failed", call.id);
        await this.apply(call.id, { kind: "provider_failed" });
        return;
      }
    }
  }

  // Audits and timers before an effect let other events in, so a step's
  // effects may be out of date by the time they run. Nothing awaits between
  // this check and the provider call.
  private stillApplies(id: string, effect: HoldEffect): boolean {
    const call = this.read(id);
    switch (effect.do) {
      case "dial_person":
        return call?.state === "ringing_person" && call.personCallId === null;
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
      case "dial_person": {
        const { providerCallId } = await services.provider.placeCall({
          to: services.config.personNumber,
          holdCallId: call.id,
          personId: call.personId,
          leg: "person",
          idempotencyKey: `${call.id}:${call.attempt}:person`,
          maxSeconds: this.capSeconds(services),
        });
        return this.apply(call.id, { kind: "placed", leg: "person", providerCallId });
      }
      case "bridge":
        return services.provider.bridge(effect.officeCallId, effect.personCallId);
      case "hang_up":
        return services.provider.hangUp(effect.callId);
    }
  }
}
