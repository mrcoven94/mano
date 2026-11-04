import { FaxExecutor, type FaxSendLog } from "./fax.js";
import { MailExecutor } from "./mail.js";
import { isOutbound, outboundPricing, type OutboundEnv, type OutboundType } from "./outbound.js";
import type { ActionRequest, ActionType, Attempt, CheckOutcome, DocumentFiling, Executor, StoredDocumentFacts } from "./types.js";
import { DefiniteFailureError } from "./types.js";

export function faxConfigured(env: OutboundEnv): boolean {
  return Boolean(env.TELNYX_API_KEY && env.TELNYX_FAX_CONNECTION_ID && env.MANO_OWN_FAX_NUMBER && env.MANO_FAX_FROM_NUMBER);
}

// Each provider exists only with all of its settings. Mail reads the test
// mode key and no other.
export function outboundProviders(env: OutboundEnv, sendLog: FaxSendLog): Partial<Record<OutboundType, Executor>> {
  const pricing = outboundPricing(env);
  const providers: Partial<Record<OutboundType, Executor>> = {};
  if (env.LOB_TEST_API_KEY) providers.mail = new MailExecutor(env.LOB_TEST_API_KEY, pricing);
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
// setting returns. It never falls through to the portal, whose "no such
// filing" would turn a sent fax into a failed one that a YES sends again.
const NO_PROVIDER = "Faxes and letters are not set up here.";
const UNAVAILABLE: Executor = {
  simulated: false,
  refuse: () => NO_PROVIDER,
  execute: async () => {
    throw new DefiniteFailureError(NO_PROVIDER);
  },
  check: async () => {
    throw new Error(NO_PROVIDER);
  },
};

// Sends faxes and letters to their own executors and everything else to
// inner. With no provider, an explicit stand-in simulates them, so a local
// copy runs with no accounts; any other executor never sees them. Reconcile
// routing reads the persisted attempt, never the key, which the caller
// controls.
export class OutboundRouter implements Executor {
  readonly simulated: boolean;

  constructor(
    private inner: Executor,
    private providers: Partial<Record<OutboundType, Executor>>,
    private actionTypeOf: (idempotencyKey: string) => Attempt["actionType"] | null,
  ) {
    this.simulated = inner.simulated;
  }

  private route(type: ActionType | null): Executor {
    if (!isOutbound(type)) return this.inner;
    return this.providers[type] ?? (this.inner.simulated ? this.inner : UNAVAILABLE);
  }

  execute(req: ActionRequest): Promise<{ externalId: string; simulated?: boolean }> {
    return this.route(req.type).execute(req);
  }

  async refuse(req: ActionRequest): Promise<string | null> {
    return (await this.route(req.type).refuse?.(req)) ?? null;
  }

  documentFiling(doc: StoredDocumentFacts): DocumentFiling {
    return this.inner.documentFiling?.(doc) ?? "fileable";
  }

  check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    return this.route(this.actionTypeOf(idempotencyKey)).check(idempotencyKey, personId);
  }
}
