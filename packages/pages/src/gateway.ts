// The approval seam to the engine gateway. Until the engine merges, the
// record only forwarder keeps the choice on the page and acts on nothing
// outside Mano. The engine session will inject the real forwarder, which
// binds the approval to the exact recipient, purpose and proposal hash.

export interface ApprovalForward {
  pageId: string;
  proposalHash: string;
  choice: "approved" | "declined";
  atMs: number;
}

export interface GatewayForwarder {
  forwardApproval(forward: ApprovalForward): Promise<{ forwarded: boolean; reason: string }>;
}

export const recordOnlyForwarder: GatewayForwarder = {
  async forwardApproval() {
    return { forwarded: false, reason: "the engine gateway is not merged yet, so the choice is recorded only" };
  },
};
