"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TryLogged, TryScenario } from "@mano/protocol";
import { TRY_API, TRY_DEV_RECORDED, nextLeg, readEvents, readRecording, readStatus, startRun, wakeGuardian, type Next, type Refusal } from "@/lib/try-client";

/* One run on the page. Everything shown comes from the run's event log, read live from Engine or played from a
   recording. phase says only which button is open. */
export type Phase = "idle" | "warming" | "running" | "question" | "ended";
export type Source = { kind: "live" } | { kind: "recording"; recordedAt: string } | { kind: "dev" };

const POLL_MS = 1000;
const GUARDIAN_POLL_MS = 10_000;
const BUSY_RETRY_MS = 2000;
// A recording plays quicker than it ran, and says so. The times in the panel are the real ones.
const PLAY_GAP_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sessionId(): string {
  try {
    const saved = sessionStorage.getItem("mano-try-session");
    if (saved) return saved;
    const made = crypto.randomUUID();
    sessionStorage.setItem("mano-try-session", made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
}

export function useTryRun() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [scenario, setScenario] = useState<TryScenario>("maria");
  const [events, setEvents] = useState<TryLogged[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [source, setSource] = useState<Source>({ kind: "live" });
  const [available, setAvailable] = useState<boolean | null>(TRY_DEV_RECORDED ? true : null);
  const seq = useRef(0);
  const alive = useRef(true);
  const played = useRef(false);

  useEffect(() => {
    alive.current = true;
    if (!TRY_DEV_RECORDED && TRY_API) {
      readStatus().then((s) => {
        setAvailable(s.enabled);
        if (s.paused) setRefusal("paused");
      }).catch(() => setAvailable(false));
    } else if (!TRY_DEV_RECORDED) setAvailable(false);
    return () => { alive.current = false; };
  }, []);

  const take = useCallback((fresh: TryLogged[]) => {
    if (fresh.length === 0) return;
    seq.current = fresh[fresh.length - 1]!.seq;
    setEvents((all) => [...all, ...fresh]);
  }, []);

  /* The events arrive on their own clock while a leg runs, so the page shows each step as it happens. */
  useEffect(() => {
    if (!runId || source.kind !== "live" || phase === "ended" || phase === "idle") return;
    const timer = setInterval(() => { readEvents(runId, seq.current).then((r) => take(r.events)).catch(() => undefined); }, POLL_MS);
    return () => clearInterval(timer);
  }, [runId, source.kind, phase, take]);

  /* The countdown runs here between Engine's answers. */
  useEffect(() => {
    if (phase !== "warming") return;
    const timer = setInterval(() => setSecondsLeft((s) => (s === null ? s : Math.max(0, s - 1))), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const play = useCallback(async (list: TryLogged[]) => {
    let previous = list[0]?.at ?? 0;
    for (const event of list) {
      await sleep(Math.min(PLAY_GAP_MS, Math.max(150, event.at - previous)));
      previous = event.at;
      if (!alive.current) return;
      setEvents((all) => [...all, event]);
    }
  }, []);

  const finish = useCallback(async (id: string) => {
    const last = await readEvents(id, seq.current).catch(() => null);
    if (last) take(last.events);
    setPhase("ended");
  }, [take]);

  const drive = useCallback(async (id: string, press?: "yes") => {
    setPhase("running");
    let answer: Next;
    let pressed = press;
    try {
      for (;;) {
        answer = (await nextLeg(id, pressed)).next;
        if (!alive.current) return;
        if (answer === "busy") { await sleep(BUSY_RETRY_MS); continue; }
        pressed = undefined;
        if (answer !== "auto") break;
      }
    } catch {
      setProblem("The connection to the demo dropped, so this run stopped.");
      setPhase("ended");
      return;
    }
    const fresh = await readEvents(id, seq.current).catch(() => null);
    if (fresh) take(fresh.events);
    if (answer === "yes") setPhase("question");
    else await finish(id);
  }, [finish, take]);

  const playRecording = useCallback(async () => {
    const recording = await readRecording();
    if (!recording) { setPhase("idle"); return; }
    setScenario(recording.scenario);
    setSource({ kind: "recording", recordedAt: recording.recordedAt });
    setEvents([]);
    setPhase("running");
    await play(recording.events);
    setPhase("ended");
  }, [play]);

  /* Paused, whether at load or on a press: say so, then play the real run once. */
  useEffect(() => {
    if (refusal !== "paused" || played.current) return;
    played.current = true;
    void playRecording();
  }, [refusal, playRecording]);

  const start = useCallback(async (chosen: TryScenario) => {
    setScenario(chosen);
    setEvents([]);
    setProblem(null);
    setRefusal(null);
    setRunId(null);
    setSecondsLeft(null);
    seq.current = 0;

    if (TRY_DEV_RECORDED) {
      const { devBeforeYes } = await import("./dev-fixture");
      setSource({ kind: "dev" });
      setPhase("running");
      await play(devBeforeYes());
      setPhase("question");
      return;
    }

    setSource({ kind: "live" });
    setPhase("running");
    let started;
    try {
      started = await startRun(chosen, sessionId());
    } catch {
      setProblem("The demo did not answer. Try again in a minute.");
      setPhase("idle");
      return;
    }
    if ("refused" in started) {
      setRefusal(started.refused);
      if (started.refused !== "paused") setPhase("idle");
      return;
    }
    const id = started.runId;
    setRunId(id);
    if (started.needsGuardian) {
      setPhase("warming");
      for (;;) {
        const guardian = await wakeGuardian(id).catch(() => ({ state: "failed" as const, secondsLeft: 0 }));
        if (!alive.current) return;
        if (guardian.state === "ready") break;
        if (guardian.state === "failed") {
          setProblem("Guardian did not answer, so this run cannot check or file anything. Try again in a few minutes.");
          setPhase("ended");
          return;
        }
        setSecondsLeft(guardian.secondsLeft);
        await sleep(GUARDIAN_POLL_MS);
      }
      setSecondsLeft(null);
    }
    await drive(id);
  }, [drive, play]);

  const pressYes = useCallback(async () => {
    if (TRY_DEV_RECORDED) {
      const { devAfterYes } = await import("./dev-fixture");
      setPhase("running");
      await play(devAfterYes());
      setPhase("ended");
      return;
    }
    if (runId) await drive(runId, "yes");
  }, [drive, play, runId]);

  return { phase, scenario, events, runId, secondsLeft, refusal, problem, source, available, start, pressYes };
}
