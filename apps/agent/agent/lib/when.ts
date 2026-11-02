// Parses reminder times ("tomorrow at 9", "Friday", "in 2 hours") into
// an exact unix-ms moment. All day-relative forms resolve in the
// person's timezone (MANO_TIMEZONE, default America/Denver); the model
// passes the person's words through untouched and this decides.
export const DEFAULT_TIMEZONE = "America/Denver";
export const MAX_REMINDER_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

function timeZone(): string {
  return process.env.MANO_TIMEZONE || DEFAULT_TIMEZONE;
}

// Calendar parts of an instant in a timezone, as numbers.
function partsInZone(atMs: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(atMs))) parts[p.type] = p.value;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour) % 24,
    mm: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday ?? "Sun"),
  };
}

// Builds the unix-ms instant for a zoned wall time by round-tripping
// through the timezone offset. Correct across DST for ordinary times.
function zonedTimeToMs(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const probe = partsInZone(guess, tz);
  const asUtc = Date.UTC(probe.y, probe.m - 1, probe.d, probe.hh, probe.mm);
  const offset = asUtc - guess;
  return guess - offset;
}

function addDaysMs(atMs: number, days: number, tz: string): { y: number; m: number; d: number } {
  const probe = partsInZone(atMs + days * 24 * 60 * 60 * 1000, tz);
  return { y: probe.y, m: probe.m, d: probe.d };
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// "9", "9:30", "9am", "9:30pm", "21:15" -> [hour24, minute] or null.
export function parseClock(text: string): [number, number] | null {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?m?\.?)?\s*$/i.exec(text.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = (match[3] ?? "").toLowerCase();
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "p" && hour !== 12) hour += 12;
    if (meridiem === "a" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return [hour, minute];
}

export interface ParsedWhen {
  dueAtMs: number;
}

export function parseWhen(raw: string, nowMs: number, tz: string = timeZone()): ParsedWhen | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  // "in 20 minutes", "in 2 hours", "in 3 days", "in a week"
  const relative = /^in\s+(a|an|\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)\s*$/.exec(text);
  if (relative) {
    const n = relative[1] === "a" || relative[1] === "an" ? 1 : Number(relative[1]);
    const unit = relative[2].startsWith("minute") ? 60_000 : relative[2].startsWith("hour") ? 3_600_000 : relative[2].startsWith("week") ? 7 * 86_400_000 : 86_400_000;
    return { dueAtMs: nowMs + n * unit };
  }

  // Split "tomorrow at 9", "friday 9am", "at 9" into day + clock parts.
  let dayPart = "";
  let clockPart = "";
  const atSplit = /^(.*?)\s+at\s+(.+)$/.exec(text);
  if (atSplit) {
    dayPart = atSplit[1].trim();
    clockPart = atSplit[2].trim();
  } else if (text.startsWith("at ")) {
    dayPart = "";
    clockPart = text.slice(3).trim();
  } else {
    // "tomorrow 9am", "friday 9", "tomorrow morning"
    const chunks = text.split(/\s+/);
    const lastClock = parseClock(chunks[chunks.length - 1]);
    if (lastClock && chunks.length > 1) {
      clockPart = chunks[chunks.length - 1];
      dayPart = chunks.slice(0, -1).join(" ");
    } else if (parseClock(text)) {
      dayPart = "";
      clockPart = text;
    } else {
      dayPart = text;
      clockPart = "";
    }
  }

  // Daytime words without a clock default sensibly: morning 9, afternoon 2, evening 7, night 8.
  const dayWords: Record<string, [number, number]> = { morning: [9, 0], afternoon: [14, 0], evening: [19, 0], night: [20, 0], noon: [12, 0], midnight: [0, 0] };
  for (const [word, clock] of Object.entries(dayWords)) {
    if (dayPart === word || dayPart.endsWith(` ${word}`)) {
      const base = dayPart === word ? "" : dayPart.slice(0, -word.length).trim();
      const day = resolveDay(base, nowMs, tz);
      if (!day) return null;
      return { dueAtMs: zonedTimeToMs(day.y, day.m, day.d, clock[0], clock[1], tz) };
    }
  }

  const clock = clockPart ? parseClock(clockPart) : null;
  if (clockPart && !clock) return null;
  const day = resolveDay(dayPart, nowMs, tz);
  if (!day) return null;
  if (!clock) {
    // Bare "tomorrow" or "friday" means 9am that day.
    return { dueAtMs: zonedTimeToMs(day.y, day.m, day.d, 9, 0, tz) };
  }
  let due = zonedTimeToMs(day.y, day.m, day.d, clock[0], clock[1], tz);
  if (!dayPart && due <= nowMs) {
    // Bare "at 9" that already passed today means tomorrow.
    const next = addDaysMs(nowMs, 1, tz);
    due = zonedTimeToMs(next.y, next.m, next.d, clock[0], clock[1], tz);
  }
  return { dueAtMs: due };
}

function resolveDay(dayPart: string, nowMs: number, tz: string): { y: number; m: number; d: number } | null {
  const now = partsInZone(nowMs, tz);
  if (dayPart === "" || dayPart === "today") return { y: now.y, m: now.m, d: now.d };
  if (dayPart === "tomorrow") return addDaysMs(nowMs, 1, tz);
  const next = dayPart.startsWith("next ");
  const weekday = WEEKDAYS[dayPart] ?? (next ? WEEKDAYS[dayPart.replace(/^next\s+/, "")] : undefined);
  if (weekday !== undefined) {
    let delta = (weekday - now.weekday + 7) % 7;
    if (delta === 0) delta = 7;
    if (next) delta += 7;
    return addDaysMs(nowMs, delta, tz);
  }
  return null;
}

export function validateDue(dueAtMs: number, nowMs: number): string | null {
  if (!Number.isFinite(dueAtMs)) return "That time did not parse. Try something like tomorrow at 9.";
  if (dueAtMs <= nowMs) return "That time already passed. Pick a time in the future.";
  if (dueAtMs - nowMs > MAX_REMINDER_AHEAD_MS) return "That is more than a year out. Pick something sooner.";
  return null;
}
