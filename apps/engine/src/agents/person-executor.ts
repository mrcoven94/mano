import type { ActionRequest, CheckOutcome, Executor } from "../gateway/index.js";

// An executor that delivers share actions as signed consent messages to
// the target org agent and delegates every other action to an inner
// executor. The delivery and reconcile callbacks are owned by the person
// agent, which holds the signing key, the approval record and the stored
// outbound messages.
export class ConsentDeliveringExecutor implements Executor {
  readonly simulated: boolean;
  calls: ActionRequest[] = [];

  constructor(
    private inner: Executor,
    private deliverShare: (req: ActionRequest) => Promise<{ externalId: string }>,
    private checkShare: (idempotencyKey: string) => Promise<CheckOutcome>,
    // The persisted attempt's action type for a key. Reconcile routing
    // reads this, never the key itself: key prefixes are
    // caller-controlled and can point a submit at the consent store.
    private actionTypeOf: (idempotencyKey: string) => string | null,
  ) {
    // Share delivery is Mano-internal protocol; the flag tracks whether
    // outside systems are simulated, which the inner executor decides.
    // Share receipts override the label per action (see execute).
    this.simulated = inner.simulated;
  }

  async execute(req: ActionRequest): Promise<{ externalId: string; simulated?: boolean }> {
    this.calls.push(req);
    if (req.type === "share") {
      // The org really receives the case, even when every other action
      // runs simulated: label the receipt per action, not per executor.
      const out = await this.deliverShare(req);
      return { externalId: out.externalId, simulated: false };
    }
    return this.inner.execute(req);
  }

  async check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    // Shares never touch the inner executor, so they reconcile by asking
    // the org whether it recorded the key, not by asking the inner check.
    // The attempt row decides: a key the caller shaped like a consent
    // key still reconciles as whatever action actually ran under it.
    if (this.actionTypeOf(idempotencyKey) === "share") {
      return this.checkShare(idempotencyKey);
    }
    return this.inner.check(idempotencyKey, personId);
  }
}
