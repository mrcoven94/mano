import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EngineClient } from "../lib/api/engine";
import { AuthError, EngineGapError, StaleApprovalError, UnreconciledSendError, type Session } from "../lib/api/types";

async function sha256B64(bytesB64: string): Promise<string> {
  return createHash("sha256").update(Buffer.from(bytesB64, "base64")).digest("hex");
}

const session: Session = {
  token: "live-token",
  personId: "maria-001",
  email: "maria@example.com",
  displayName: "Maria",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

const approvalRow = {
  id: "appr-1",
  actionType: "submit",
  recipient: "sandbox:portal",
  purpose: "File renewal",
  documentHash: "abc123",
  documentId: "doc-1",
  requestJson: "{\"type\":\"submit\"}",
  requestHash: "req-1",
  idempotencyKey: "k-1",
  status: "pending",
  problems: [],
  createdAt: "2026-10-28T00:00:00.000Z",
  remindAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-11-10T00:00:00.000Z",
  escalated: false,
  outcome: { attempt: null, receipt: null },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("EngineClient", () => {
  it("sends chat messages and returns the agent reply", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ reply: "Hello." }));
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    const reply = await client.sendMessage(session, "Hi", []);
    expect(reply.role).toBe("agent");
    expect(reply.text).toBe("Hello.");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://engine.test/api/persons/maria-001/chat");
    expect((init.headers as Headers).get("authorization")).toBe("Bearer live-token");
  });

  it("holds an uncertain send for the person instead of failing it", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hangup");
    });
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    const failure = await client.sendMessage(session, "Hi", [], "op-9").then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(UnreconciledSendError);
    expect((failure as UnreconciledSendError).opId).toBe("op-9");
  });

  it("sends the operation ID with chat messages", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ reply: "Hello." }));
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    await client.sendMessage(session, "Hi", [], "op-9");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { clientOpId: string };
    expect(body.clientOpId).toBe("op-9");
  });

  it("uploads attachments before chatting", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/documents")) return jsonResponse({ id: "doc-9", hash: "h" });
      return jsonResponse({ reply: "Got the photo." });
    });
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    const reply = await client.sendMessage(session, "mail", [
      { kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: "aGk=" },
    ]);
    expect(reply.text).toBe("Got the photo.");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses to approve when the reviewed hash moved", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ approvals: [approvalRow] }));
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    await expect(client.approve(session, "appr-1", { documentHash: "moved", requestHash: "req-1" })).rejects.toBeInstanceOf(StaleApprovalError);
    await expect(client.approve(session, "appr-1", { documentHash: "abc123", requestHash: "moved" })).rejects.toBeInstanceOf(StaleApprovalError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    for (const [url] of calls) {
      expect(String(url)).not.toContain("/approve");
    }
  });

  it("approves when the hash matches and maps the receipt", async () => {
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/approve")) {
        expect(init?.method).toBe("POST");
        const sent = JSON.parse(init?.body as string) as Record<string, string>;
        expect(sent).toEqual({ expectedDocumentHash: "abc123", expectedRequestHash: "req-1" });
        return jsonResponse({ status: "completed", receipt: { id: "r-1", externalId: "x-1", simulated: false } });
      }
      return jsonResponse({ approvals: [approvalRow] });
    });
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    const result = await client.approve(session, "appr-1", { documentHash: "abc123", requestHash: "req-1" });
    expect(result.status).toBe("completed");
    expect(result.receiptId).toBe("r-1");
    expect(result.simulated).toBe(false);
  });

  it("refuses expired approvals without calling approve", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ approvals: [{ ...approvalRow, status: "expired" }] }));
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    await expect(client.approve(session, "appr-1", { documentHash: "abc123", requestHash: "req-1" })).rejects.toBeInstanceOf(StaleApprovalError);
  });

  it("declines through the reject route with no body, then reads the key's outcome", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/reject")) return jsonResponse({ status: "rejected", approval: { ...approvalRow, status: "rejected" } });
      return jsonResponse({ approvals: [{ ...approvalRow, status: "rejected" }] });
    });
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    expect(await client.decline(session, "appr-1")).toEqual({ status: "rejected", notSent: true });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit | undefined][];
    expect(calls.map(([url]) => url)).toEqual([
      "https://engine.test/api/persons/maria-001/approvals/appr-1/reject",
      "https://engine.test/api/persons/maria-001/approvals",
    ]);
    expect(calls[0]?.[1]?.method).toBe("POST");
    expect(calls[0]?.[1]?.body).toBeUndefined();
  });

  it("answers a NO on a decided approval with its real status, and claims nothing went only when proven", async () => {
    const cases = [
      { status: "approved", notSent: false },
      { status: "revoked", notSent: false },
      { status: "expired", notSent: true },
      { status: "stale", notSent: true },
      { status: "blocked", notSent: true },
    ] as const;
    for (const expected of cases) {
      const fetchImpl = vi.fn(async (input: unknown) => {
        if (String(input).endsWith("/reject")) return jsonResponse({ status: "blocked", reason: "This approval was already used." });
        return jsonResponse({ approvals: [{ ...approvalRow, status: expected.status }] });
      });
      const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
      expect(await client.decline(session, "appr-1")).toEqual(expected);
    }
  });

  it("does not claim nothing went when a reproposal under the same key was sent", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/reject")) return jsonResponse({ status: "blocked", reason: "Approval expired." });
      return jsonResponse({
        approvals: [
          { ...approvalRow, id: "appr-2", status: "approved", outcome: { attempt: "done", receipt: { externalId: "x-1", simulated: true } } },
          { ...approvalRow, status: "expired", outcome: { attempt: "done", receipt: { externalId: "x-1", simulated: true } } },
          { ...approvalRow, id: "appr-other", idempotencyKey: "k-other", status: "approved" },
        ],
      });
    });
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    expect(await client.decline(session, "appr-1")).toEqual({ status: "expired", notSent: false });
  });

  it("names the recipient in words and never shows its raw ID as the name", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ approvals: [{ ...approvalRow, recipient: "sandbox-agency-portal" }, { ...approvalRow, id: "appr-2" }] }),
    );
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    const [named, unnamed] = await client.listApprovals(session);
    expect(named?.recipientName).toBe("the State Benefits Renewal Office test portal");
    expect(named?.recipient).toBe("sandbox-agency-portal");
    expect(unnamed?.recipientName).toBe("an office Mano has no name for");
  });

  it("treats a row with no outcome on file as possibly sent", async () => {
    const { outcome: _outcome, ...bare } = approvalRow;
    void _outcome;
    const fetchImpl = vi.fn(async () => jsonResponse({ approvals: [{ ...bare, status: "expired" }] }));
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    const [approval] = await client.listApprovals(session);
    expect(approval?.attempted).toBe(true);
  });

  it("fails a NO the engine refused while the approval still waits", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/reject")) return jsonResponse({ status: "blocked", reason: "Approval not found." });
      return jsonResponse({ approvals: [approvalRow] });
    });
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    await expect(client.decline(session, "appr-1")).rejects.toThrow("Approval not found.");
  });

  it("signs out on a NO the engine refuses for the session", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    await expect(client.decline(session, "appr-1")).rejects.toBeInstanceOf(AuthError);
  });

  it("reads the document filename from content-disposition", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([104, 105]), {
      status: 200,
      headers: { "content-disposition": 'attachment; filename="packet.txt"', "content-type": "application/octet-stream" },
    }));
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    const doc = await client.downloadDocument(session, "doc-1");
    expect(doc.name).toBe("packet.txt");
    expect(doc.bytesB64).toBe("aGk=");
    expect(doc.hash).toBe(createHash("sha256").update(Buffer.from("hi")).digest("hex"));
  });

  it("maps revoke outcomes from the action route", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/approvals")) return jsonResponse({ approvals: [] });
      return jsonResponse({ status: "completed", receipt: { id: "r", externalId: "x", simulated: true } });
    });
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    const result = await client.revokeGrant(session, "org:county", "R-1");
    expect(result.status).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      payload: { consent: string; caseId: string };
      idempotencyKey: string;
    };
    expect(body.payload).toEqual({ consent: "revoke", caseId: "R-1" });
    expect(body.idempotencyKey).toBe("consent-revoke:maria-001:org:county:R-1");
  });

  it("reconciles a revoke already on file instead of reposting", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        approvals: [{ ...approvalRow, status: "approved", idempotencyKey: "consent-revoke:maria-001:org:county:R-1" }],
      }),
    );
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    const result = await client.revokeGrant(session, "org:county", "R-1");
    expect(result.status).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("asks the engine whether a link may open", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ allowed: false, reason: "Blocked." }));
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    const verdict = await client.checkLink(session, "https://evil.test/");
    expect(verdict).toEqual({ allowed: false, reason: "Blocked." });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://engine.test/api/check-link");
    const body = JSON.parse(init.body as string) as { url: string };
    expect(body.url).toBe("https://evil.test/");
  });

  it("turns 403 into AuthError", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 403 }));
    const client = new EngineClient({ baseUrl: "https://engine.test", sha256B64, fetchImpl: fetchImpl });
    await expect(client.listApprovals(session)).rejects.toBeInstanceOf(AuthError);
  });

  it("signs in and reads the conversation from the server", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = url;
      if (path.endsWith("/request-code")) return jsonResponse({ challengeId: "c1", maskedEmail: "m***@b.c" });
      if (path.endsWith("/verify-code")) return jsonResponse(session);
      return jsonResponse({ messages: [{ id: "m1", role: "agent", text: "Hi", createdAt: "2026-11-03T12:00:00.000Z" }] });
    });
    const client = new EngineClient({ baseUrl: "https://web.test", sha256B64, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.requestCode("a@b.c")).resolves.toEqual({ challengeId: "c1", maskedEmail: "m***@b.c" });
    await expect(client.verifyCode("a@b.c", "c1", "123456")).resolves.toEqual(session);
    await expect(client.listMessages(session)).resolves.toMatchObject([{ id: "m1", text: "Hi", attachments: [], status: "sent" }]);
  });

  it("shows a server's error in plain words", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "Sign-in email is not turned on yet." }), { status: 503 }));
    const client = new EngineClient({ baseUrl: "https://web.test", sha256B64, fetchImpl: fetchImpl });
    await expect(client.requestCode("a@b.c")).rejects.toThrow("Sign-in email is not turned on yet.");
  });

  it("turns a 501 into a named gap, and names routes with no server", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "not yet" }), { status: 501 }));
    const client = new EngineClient({ baseUrl: "https://web.test", sha256B64, fetchImpl: fetchImpl });
    await expect(client.listApprovals(session)).rejects.toMatchObject({ name: "EngineGapError" });
    fetchImpl.mockClear();
    await expect(client.listDeadlines(session)).rejects.toBeInstanceOf(EngineGapError);
    await expect(client.listDocuments(session)).rejects.toBeInstanceOf(EngineGapError);
    await expect(client.listGrants(session)).rejects.toBeInstanceOf(EngineGapError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
