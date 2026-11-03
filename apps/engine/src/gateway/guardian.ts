import {
  DEFAULT_CHECK_TIMEOUT_MS,
  GlimmerModelChecker,
  MisconfiguredChecker,
  type KnownEntities,
  type PersonValues,
} from "@mano/guardian";
import type { Profile, Suggestion } from "../profile.js";
import { LocalRulesChecker, type Checker, type CheckInput, type CheckResult } from "./checker.js";
import type { GatewayOptions } from "./gateway.js";

// Guardian (Muse Glimmer on Mano's own GPU) as the gateway's checker.
// Engine's local rules run first, and a rules block never spends a
// Guardian call. Guardian scales to zero and a cold start takes minutes,
// so every Guardian check also sends a warm-up: a check that finds it
// cold blocks with "try again in a few minutes" and leaves it starting,
// and a check that finds it warm keeps it up for the person's yes, when
// the gateway checks again. Before each Guardian call Engine reads the
// person's own names, employers and other details from their profile, so
// Guardian's redactor removes them by value wherever they appear. Only
// what the person said themselves counts as confirmed; a value from a
// document or older notes, or a suggestion, could hold an instruction.

export interface GuardianEnv {
  MANO_GUARDIAN_URL?: string;
  MANO_GUARDIAN_TOKEN?: string;
  MANO_GUARDIAN_KEY_ID?: string;
  MANO_GUARDIAN_KEY_SECRET?: string;
}

export type CheckerSetting =
  | { kind: "local-rules" }
  | { kind: "guardian"; url: string; token: string; proxyAuth?: { keyId: string; secret: string } }
  | { kind: "guardian-misconfigured" };

// None of the four set keeps the local rules. A deployed Guardian needs
// all four: Modal refuses a request without its key pair, so a URL and
// token alone would report healthy while every check failed. Only a
// Guardian on this machine (localhost, for development and tests) may
// leave the key pair out. Anything else is misconfigured: every action
// blocks and /health reports ok:false.
export function checkerSetting(env: GuardianEnv): CheckerSetting {
  const url = env.MANO_GUARDIAN_URL?.trim() ?? "";
  const token = env.MANO_GUARDIAN_TOKEN?.trim() ?? "";
  const keyId = env.MANO_GUARDIAN_KEY_ID?.trim() ?? "";
  const secret = env.MANO_GUARDIAN_KEY_SECRET?.trim() ?? "";
  if (url === "" && token === "" && keyId === "" && secret === "") return { kind: "local-rules" };
  if (!/^https?:\/\//i.test(url) || token === "" || (keyId === "") !== (secret === "")) {
    return { kind: "guardian-misconfigured" };
  }
  if (keyId === "" && !isLocalHost(url)) return { kind: "guardian-misconfigured" };
  return { kind: "guardian", url, token, ...(keyId ? { proxyAuth: { keyId, secret } } : {}) };
}

function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

const SEVERITY: Record<CheckResult["verdict"], number> = { pass: 0, fix: 1, block: 2 };

// Which profile fields hold a detail that identifies the person, by the
// kind Guardian's redactor removes. An entry's id is written as *.
const ENTITY_PATHS: Record<string, keyof KnownEntities> = {
  "person.fullName": "names",
  "household.*.name": "names",
  "income.*.source": "employers",
  "person.address.line1": "addresses",
  "person.address.line2": "addresses",
  "person.address.city": "addresses",
  "person.address.zip": "addresses",
  "person.county": "addresses",
  "person.phone": "phones",
  "person.email": "emails",
  "person.dateOfBirth": "datesOfBirth",
  "household.*.dateOfBirth": "datesOfBirth",
  "programs.*.caseNumber": "caseNumbers",
};

function profileLeaves(profile: Profile): { path: string; value: unknown; source: string }[] {
  const leaves: { path: string; value: unknown; source: string }[] = [];
  const walk = (node: object, prefix: string): void => {
    for (const [key, child] of Object.entries(node)) {
      if (key === "id" || typeof child !== "object" || child === null) continue;
      if ("value" in child) leaves.push({ path: `${prefix}${key}`, value: child.value, source: String(child.source) });
      else if (Array.isArray(child)) for (const entry of child as { id: string }[]) walk(entry, `${prefix}${key}.${entry.id}.`);
      else walk(child, `${prefix}${key}.`);
    }
  };
  walk(profile, "");
  return leaves;
}

// The person's own values for Guardian's redactor, from the profile and
// from suggestions still waiting for the person (a lower-trust value can
// be just as real). Names and employers have no shape a pattern catches;
// the other details are listed too, so a value written an unusual way is
// still removed. A profile value the person said is confirmed; one from a
// document or older notes, and every suggestion, is not, and Guardian uses
// it only where it looks like its kind. The renewal form writes the
// address as one line from its parts (apps/agent forms.ts), so when the
// person gave each part, that line is confirmed too.
export function profileEntities(profile: Profile | null, suggestions: readonly Suggestion[] = []): PersonValues {
  const confirmed: KnownEntities = {};
  const unconfirmed: KnownEntities = {};
  const add = (into: KnownEntities, kind: keyof KnownEntities, value: string): void => {
    into[kind] = [...(into[kind] ?? []), value];
  };
  const leaves = profile ? profileLeaves(profile) : [];
  for (const { path, value, source } of [...leaves, ...suggestions.map((s) => ({ ...s, source: "suggestion" }))]) {
    const kind = ENTITY_PATHS[path.replace(/^(household|income|programs)\.[^.]+\./, "$1.*.")];
    if (kind !== undefined && typeof value === "string") add(source === "person" ? confirmed : unconfirmed, kind, value);
  }
  const address = profile?.person.address;
  const parts = [address?.line1, address?.line2, address?.city, address?.state, address?.zip];
  if (address?.line1 && address.city && address.state && address.zip && parts.every((leaf) => !leaf || leaf.source === "person")) {
    const line = [address.line1.value, address.line2?.value, address.city.value, `${address.state.value} ${address.zip.value}`];
    add(confirmed, "addresses", line.filter(Boolean).join(", "));
  }
  return { confirmed, unconfirmed };
}

export class GuardianChecker implements Checker {
  constructor(
    private readonly rules: Checker,
    private readonly guardian: GlimmerModelChecker,
    // Read at check time. A read that throws fails the check, and the
    // gateway blocks.
    private readonly entities: () => Promise<PersonValues> = async () => ({}),
  ) {}

  async check(input: CheckInput): Promise<CheckResult> {
    const local = await this.rules.check(input);
    if (local.verdict === "block") return local;
    const [model] = await Promise.all([
      this.entities().then((values) => this.guardian.check(input, values)),
      this.guardian.warm(),
    ]);
    return {
      verdict: SEVERITY[model.verdict] > SEVERITY[local.verdict] ? model.verdict : local.verdict,
      problems: [...local.problems, ...model.problems],
    };
  }
}

// The checker and its gateway timeout. The gateway's timeout sits a
// second above Guardian's own, so a slow Guardian blocks with Guardian's
// plain reason, not the gateway's generic one. Warm checks measured 4.1
// to 7.5 seconds, and the agent gives Engine 15 seconds per call.
export function gatewayChecker(
  setting: CheckerSetting,
  opts: { timeoutMs?: number; entities?: () => Promise<PersonValues> } = {},
): Pick<GatewayOptions, "checker" | "checkerTimeoutMs"> {
  switch (setting.kind) {
    case "local-rules":
      return { checker: new LocalRulesChecker() };
    case "guardian-misconfigured":
      return { checker: new MisconfiguredChecker() };
    case "guardian": {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
      const guardian = new GlimmerModelChecker({
        url: setting.url,
        token: setting.token,
        timeoutMs,
        ...(setting.proxyAuth ? { proxyAuth: setting.proxyAuth } : {}),
      });
      return {
        checker: new GuardianChecker(new LocalRulesChecker(), guardian, opts.entities),
        checkerTimeoutMs: timeoutMs + 1000,
      };
    }
  }
}
