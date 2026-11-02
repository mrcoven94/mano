import { DEFAULT_CHECK_TIMEOUT_MS, GlimmerModelChecker, MisconfiguredChecker } from "@mano/guardian";
import { LocalRulesChecker, type Checker, type CheckInput, type CheckResult } from "./checker.js";
import type { GatewayOptions } from "./gateway.js";
import { boundFetch } from "../fetch.js";

// Guardian (Muse Glimmer on Mano's own GPU) as the gateway's checker.
// Engine's local rules run first, and a rules block never spends a
// Guardian call. Guardian scales to zero and a cold start takes minutes,
// so every Guardian check also sends a warm-up: a check that finds it
// cold blocks with "try again in a few minutes" and leaves it starting,
// and a check that finds it warm keeps it up for the person's yes, when
// the gateway checks again.

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

// None of the four set keeps the local rules. A URL needs its token, and
// the Modal key pair comes as both or neither. Anything else, a token
// with no URL included, is misconfigured: every action blocks and /health
// reports ok:false.
export function checkerSetting(env: GuardianEnv): CheckerSetting {
  const url = env.MANO_GUARDIAN_URL?.trim() ?? "";
  const token = env.MANO_GUARDIAN_TOKEN?.trim() ?? "";
  const keyId = env.MANO_GUARDIAN_KEY_ID?.trim() ?? "";
  const secret = env.MANO_GUARDIAN_KEY_SECRET?.trim() ?? "";
  if (url === "" && token === "" && keyId === "" && secret === "") return { kind: "local-rules" };
  if (!/^https?:\/\//i.test(url) || token === "" || (keyId === "") !== (secret === "")) {
    return { kind: "guardian-misconfigured" };
  }
  return { kind: "guardian", url, token, ...(keyId ? { proxyAuth: { keyId, secret } } : {}) };
}

const SEVERITY: Record<CheckResult["verdict"], number> = { pass: 0, fix: 1, block: 2 };

type GuardianOptions = ConstructorParameters<typeof GlimmerModelChecker>[0];

// Guardian's verdict always arrives in a success response. A block with no
// success response behind it is Guardian being unavailable, not Guardian
// refusing, so it is marked unavailable. Each check gets its own model
// client, so concurrent checks never share what they observed.
export class GuardianChecker implements Checker {
  private readonly warmer: GlimmerModelChecker;

  constructor(
    private readonly rules: Checker,
    private readonly options: GuardianOptions,
  ) {
    this.warmer = new GlimmerModelChecker(options);
  }

  async check(input: CheckInput): Promise<CheckResult> {
    const local = await this.rules.check(input);
    if (local.verdict === "block") return local;
    const send = this.options.fetchImpl ?? boundFetch;
    let answered = false;
    const guardian = new GlimmerModelChecker({
      ...this.options,
      fetchImpl: async (...args) => {
        const response = await send(...args);
        answered = response.ok;
        return response;
      },
    });
    const [model] = await Promise.all([guardian.check(input), this.warmer.warm()]);
    const problems = [...local.problems, ...model.problems];
    if (model.verdict === "block") return answered ? { verdict: "block", problems } : { verdict: "block", problems, unavailable: true };
    return { verdict: SEVERITY[model.verdict] > SEVERITY[local.verdict] ? model.verdict : local.verdict, problems };
  }
}

// The checker and its gateway timeout. The gateway's timeout sits a
// second above Guardian's own, so a slow Guardian blocks with Guardian's
// plain reason, not the gateway's generic one. Warm checks measured 4.1
// to 7.5 seconds, and the agent gives Engine 15 seconds per call.
export function gatewayChecker(
  setting: CheckerSetting,
  opts: { timeoutMs?: number } = {},
): Pick<GatewayOptions, "checker" | "checkerTimeoutMs"> {
  switch (setting.kind) {
    case "local-rules":
      return { checker: new LocalRulesChecker() };
    case "guardian-misconfigured":
      return { checker: new MisconfiguredChecker() };
    case "guardian": {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
      const guardian: GuardianOptions = {
        url: setting.url,
        token: setting.token,
        timeoutMs,
        ...(setting.proxyAuth ? { proxyAuth: setting.proxyAuth } : {}),
      };
      return { checker: new GuardianChecker(new LocalRulesChecker(), guardian), checkerTimeoutMs: timeoutMs + 1000 };
    }
  }
}
