import type { ActionRequest, CheckOutcome, DocumentFiling, Executor, StoredDocumentFacts } from "../gateway/types.js";
import type { HoldCalls } from "./hold-calls.js";

// Sends call actions to HoldCalls once a provider is set up, and every other
// action to the inner executor. With no provider it changes nothing: a call
// goes to the inner executor, as it always has.
export class HoldCallExecutor implements Executor {
  readonly simulated: boolean;

  constructor(
    private inner: Executor,
    private calls: HoldCalls,
    // The persisted attempt's action type for a key. Reconcile routing reads
    // this, never the key, whose shape the caller controls.
    private actionTypeOf: (idempotencyKey: string) => string | null,
  ) {
    this.simulated = inner.simulated;
  }

  refuse(req: ActionRequest): string | null {
    if (req.type === "call" && this.calls.live()) return this.calls.refuse(req);
    return this.inner.refuse?.(req) ?? null;
  }

  async execute(req: ActionRequest): Promise<{ externalId: string; simulated?: boolean }> {
    if (req.type === "call" && this.calls.live()) {
      return { externalId: await this.calls.begin(req), simulated: this.calls.simulated() };
    }
    return this.inner.execute(req);
  }

  async check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    if (this.actionTypeOf(idempotencyKey) === "call" && this.calls.live()) return this.calls.check(idempotencyKey, personId);
    return this.inner.check(idempotencyKey, personId);
  }

  documentFiling(doc: StoredDocumentFacts): DocumentFiling {
    return this.inner.documentFiling?.(doc) ?? "fileable";
  }
}
