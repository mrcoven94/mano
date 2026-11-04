import type { DeliveryRoutes } from "./delivery.js";
import { FaxExecutor, type FaxSendLog } from "./fax.js";
import { MailExecutor } from "./mail.js";
import { isOutbound, outboundPricing, type OutboundEnv, type OutboundType } from "./outbound.js";
import type { ActionRequest, ActionType, Attempt, CheckOutcome, DocumentFiling, Executor, StoredDocumentFacts } from "./types.js";
import { DefiniteFailureError, UnconfirmedSendError } from "./types.js";

export function faxConfigured(env: OutboundEnv): boolean {
  return Boolean(env.TELNYX_API_KEY && env.TELNYX_FAX_CONNECTION_ID && env.MANO_OWN_FAX_NUMBER && env.MANO_FAX_FROM_NUMBER);
}

// Each provider exists only with all of its settings. Mail reads the test
// mode key and no other.
export function outboundProviders(env: OutboundEnv, sendLog: FaxSendLog, routes?: DeliveryRoutes): Partial<Record<OutboundType, Executor>> {
  const pricing = outboundPricing(env);
  const providers: Partial<Record<OutboundType, Executor>> = {};
  if (env.LOB_TEST_API_KEY) providers.mail = new MailExecutor(env.LOB_TEST_API_KEY, pricing, undefined, undefined, routes);
  if (faxConfigured(env)) {
    providers.fax = new FaxExecutor({
      apiKey: env.TELNYX_API_KEY!,
      connectionId: env.TELNYX_FAX_CONNECTION_ID!,
      ownNumber: env.MANO_OWN_FAX_NUMBER!,
      fromNumber: env.MANO_FAX_FROM_NUMBER!,
      pricing,
      sendLog,
    });
  }
  return providers;
}

// A fax or letter whose provider is not set here. Nothing new starts, and
// a lookup has no answer, so an attempt already out stays unknown until the
// setting returns. It never reaches the portal, whose "no such filing"
// would turn a sent fax into a failed one that a YES sends again, or the
// stand-in, whose receipt would call a real send simulated.
const NO_PROVIDER = "Faxes and letters are not set up here.";
const UNAVAILABLE: Executor = {
  simulated: false,
  refuse: () => NO_PROVIDER,
  execute: async () => {
    throw new DefiniteFailureError(NO_PROVIDER);
  },
  check: async () => {
    throw new UnconfirmedSendError(`${NO_PROVIDER} Mano could not confirm whether this one went through.`);
  },
};

// What an attempt records when it began on the explicit stand-in.
const STAND_IN = "stand-in";

// Sends faxes and letters to their own executors and everything else to
// inner. A new one with no provider goes to an explicit stand-in, so a local
// copy runs with no accounts; any other executor never sees it. An attempt
// already started stays with what it began against, read from the persisted
// attempt, never from the key, which the caller controls. One that records
// nothing, or something no longer here, stays unknown in every mode.
export class OutboundRouter implements Executor {
  readonly simulated: boolean;

  constructor(
    private inner: Executor,
    private providers: Partial<Record<OutboundType, Executor>>,
    private attemptOf: (idempotencyKey: string) => Attempt | null,
  ) {
    this.simulated = inner.simulated;
  }

  private forNew(type: ActionType): Executor {
    if (!isOutbound(type)) return this.inner;
    return this.providers[type] ?? (this.inner.simulated ? this.inner : UNAVAILABLE);
  }

  private forAttempt(attempt: Attempt): Executor {
    if (!isOutbound(attempt.actionType)) return this.inner;
    if (attempt.provider === STAND_IN && this.inner.simulated) return this.inner;
    const provider = this.providers[attempt.actionType];
    return provider && attempt.provider === provider.provider ? provider : UNAVAILABLE;
  }

  providerOf(req: ActionRequest): string | null {
    if (!isOutbound(req.type)) return null;
    return this.providers[req.type]?.provider ?? (this.inner.simulated ? STAND_IN : null);
  }

  execute(req: ActionRequest): Promise<{ externalId: string; simulated?: boolean }> {
    const attempt = this.attemptOf(req.idempotencyKey);
    return (attempt ? this.forAttempt(attempt) : this.forNew(req.type)).execute(req);
  }

  async refuse(req: ActionRequest): Promise<string | null> {
    return (await this.forNew(req.type).refuse?.(req)) ?? null;
  }

  documentFiling(doc: StoredDocumentFacts): DocumentFiling {
    return this.inner.documentFiling?.(doc) ?? "fileable";
  }

  check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    const attempt = this.attemptOf(idempotencyKey);
    return (attempt ? this.forAttempt(attempt) : this.inner).check(idempotencyKey, personId);
  }
}
