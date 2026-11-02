import { describe, expect, it } from "vitest";
import { HANDLE_DAILY_LIMIT, HANDLE_HOURLY_LIMIT, dayKeyFor, hourKeyFor } from "@mano/channels";
import { CRISIS_LINE } from "@mano/persona";
import { BUSY_BUBBLE } from "../src/text.js";
import { inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

const MESSAGES = [
  "I am in immediate danger. My landlord is outside.",
  "I am not safe in my apartment",
  "things at home got really bad tonight",
];

const LIMITS: Array<{ name: string; make: () => Harness }> = [
  { name: "spend exhausted", make: () => makeHarness({ budgetUsd: 0 }) },
  {
    name: "hourly limit",
    make: () => {
      const h = makeHarness();
      const meta = h.store.meta();
      meta.hourKey = hourKeyFor(h.now);
      meta.hourCount = HANDLE_HOURLY_LIMIT;
      h.store.saveMeta(meta);
      return h;
    },
  },
  {
    name: "daily limit",
    make: () => {
      const h = makeHarness();
      const meta = h.store.meta();
      meta.dayKey = dayKeyFor(h.now);
      meta.dayCount = HANDLE_DAILY_LIMIT;
      h.store.saveMeta(meta);
      return h;
    },
  },
];

describe("no crisis silence after the busy notice (review round 4, blocker 1)", () => {
  for (const limit of LIMITS) {
    for (const message of MESSAGES) {
      it(`${limit.name}: "${message}" gets the crisis line after "hello" used the busy notice`, async () => {
        const h = limit.make();
        await h.runner.handleEvent(inboundEvent({ id: "evt_hello", text: "hello", occurredAtMs: h.now }), "webhook");
        await runTurnAfterBatch(h);
        expect(h.channel.sends.map((s) => s.text)).toContain(BUSY_BUBBLE);
        const before = h.channel.sends.length;
        await h.runner.handleEvent(inboundEvent({ id: "evt_crisis", text: message, occurredAtMs: h.now }), "webhook");
        await runTurnAfterBatch(h);
        expect(h.channel.sends.slice(before).map((s) => s.text)).toContain(CRISIS_LINE);
      });
    }
  }
});
