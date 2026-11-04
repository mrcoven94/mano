import { FaxExecutor, type FaxSendLog } from "./fax.js";
import { MailExecutor } from "./mail.js";
import { isOutbound, outboundPricing, type OutboundEnv, type OutboundType } from "./outbound.js";
import type { ActionRequest, ActionType, Attempt, CheckOutcome, DocumentFiling, Executor, StoredDocumentFacts } from "./types.js";

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

// Sends faxes and letters to their own executors and everything else to
// inner. Without a provider for one, that action goes to inner too: the
// stand-in simulates it, and the sandbox portal refuses it. Reconcile
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
    return (isOutbound(type) ? this.providers[type] : undefined) ?? this.inner;
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
