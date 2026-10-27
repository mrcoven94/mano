import type { ActionRequest, Executor } from "../gateway/index.js";

// An executor that delivers share actions as signed consent messages to
// the target org agent and delegates every other action to an inner
// executor. The delivery callback is owned by the person agent, which
// holds the signing key and the approval record.
export class ConsentDeliveringExecutor implements Executor {
  calls: ActionRequest[] = [];

  constructor(
    private inner: Executor,
    private deliverShare: (req: ActionRequest) => Promise<{ externalId: string }>,
  ) {}

  async execute(req: ActionRequest): Promise<{ externalId: string }> {
    this.calls.push(req);
    if (req.type === "share") return this.deliverShare(req);
    return this.inner.execute(req);
  }

  async check(idempotencyKey: string): Promise<{ externalId: string } | null> {
    return this.inner.check(idempotencyKey);
  }
}
