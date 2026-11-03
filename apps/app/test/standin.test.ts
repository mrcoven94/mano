import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHANGE_REPLY, CHANGE_REPLY_ES, DECLINE_REPLY } from "../lib/api/maria";
import { parseActionView } from "../lib/action-view";
import { StandInClient } from "../lib/api/standin";
import { AuthError, StaleApprovalError, type Session } from "../lib/api/types";
import { b64encode, utf8ToBytes } from "../lib/base64";

async function sha256B64(bytesB64: string): Promise<string> {
  return createHash("sha256").update(Buffer.from(bytesB64, "base64")).digest("hex");
}

function makeClient(): StandInClient {
  return new StandInClient({ sha256B64, latencyMs: 0, now: () => new Date("2026-10-28T12:00:00.000Z") });
}

async function signIn(client: StandInClient): Promise<Session> {
  const { challengeId } = await client.requestCode("maria.torres@example.com");
  return client.verifyCode("maria.torres@example.com", challengeId, "123456");
}

describe("stand-in sign-in", () => {
  it("masks the email on request and accepts any 6-digit code", async () => {
    const client = makeClient();
    const out = await client.requestCode("maria.torres@example.com");
    expect(out.maskedEmail).toBe("m***@example.com");
    const session = await client.verifyCode("maria.torres@example.com", out.challengeId, "654321");
    expect(session.displayName).toBe("Maria Torres");
    expect(session.personId).toBe("maria-001");
  });

  it("rejects short codes", async () => {
    const client = makeClient();
    const { challengeId } = await client.requestCode("maria.torres@example.com");
    await expect(client.verifyCode("maria.torres@example.com", challengeId, "12")).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects forged session tokens", async () => {
    const client = makeClient();
    const session = await signIn(client);
    await expect(client.listMessages({ ...session, token: "forged" })).rejects.toBeInstanceOf(AuthError);
  });
});

describe("Maria spine run", () => {
  it("greets a fresh person with no deadlines or approvals", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const messages = await client.listMessages(session);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("agent");
    expect(await client.listDeadlines(session)).toHaveLength(0);
    expect(await client.listApprovals(session)).toHaveLength(0);
  });

  it("turns mail photos into deadlines and a renewal approval", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    const reply = await client.sendMessage(session, "I photographed my mail", [
      { kind: "photo", name: "mail-1.jpg", mimeType: "image/jpeg", bytesB64: photo },
      { kind: "photo", name: "mail-2.jpg", mimeType: "image/jpeg", bytesB64: photo },
    ]);
    expect(reply.text).toContain("2 letters");
    const deadlines = await client.listDeadlines(session);
    expect(deadlines.map((d) => d.title)).toEqual(["Electricity bill, $84.20", "SNAP renewal due"]);
    const approvals = await client.listApprovals(session);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe("pending");
    expect(approvals[0]?.recipientName).toBe("Springfield County SNAP office");
  });

  it("carries the renewal answers and statement the way a live renewal does", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    await client.sendMessage(session, "I photographed my mail", [{ kind: "photo", name: "mail.jpg", mimeType: "image/jpeg", bytesB64: photo }]);
    const [approval] = await client.listApprovals(session);
    const parsed = parseActionView(approval?.requestJson ?? "");
    if (parsed.kind === "unknown") throw new Error(parsed.reason);
    // Every field the agent's food-renewal form fills (apps/agent/agent/lib/forms.ts).
    expect(parsed.answers.map((f) => f.key)).toEqual([
      "caseNumber",
      "fullName",
      "dateOfBirth",
      "householdSize",
      "monthlyIncome",
      "address",
      "phone",
    ]);
    expect(parsed.answers.every((f) => f.label !== null)).toBe(true);
    expect(parsed.declaration).toContain("penalty of perjury");
    expect(parsed.attachment).toBe("SNAP renewal packet");
    // The packet the approval binds says the same thing.
    const doc = await client.getApprovalDocument(session, approval!);
    expect(Buffer.from(doc.bytesB64, "base64").toString("utf8")).toContain(parsed.declaration ?? "missing");
  });

  it("answers a change request in chat and leaves the renewal waiting and unsent", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    await client.sendMessage(session, "I photographed my mail", [{ kind: "photo", name: "mail.jpg", mimeType: "image/jpeg", bytesB64: photo }]);
    const en = await client.sendMessage(session, 'About "File your SNAP renewal for case R-1042": please change my phone number', []);
    expect(en.text).toBe(CHANGE_REPLY);
    const es = await client.sendMessage(session, 'Sobre "File your SNAP renewal for case R-1042": por favor cambie mi teléfono', []);
    expect(es.text).toBe(CHANGE_REPLY_ES);
    const [approval] = await client.listApprovals(session);
    expect(approval?.status).toBe("pending");
    expect(approval?.attempted).toBe(false);
  });

  it("binds the approval to the real hash of the document bytes", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    await client.sendMessage(session, "mail", [{ kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: photo }]);
    const [approval] = await client.listApprovals(session);
    if (!approval) throw new Error("expected an approval");
    const doc = await client.getApprovalDocument(session, approval);
    const independent = createHash("sha256").update(Buffer.from(doc.bytesB64, "base64")).digest("hex");
    expect(doc.hash).toBe(independent);
    expect(approval.documentHash).toBe(independent);
    expect(approval.documentId).toBe(doc.id);
  });

  it("approves with the reviewed hash and refuses anything else", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    await client.sendMessage(session, "mail", [{ kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: photo }]);
    const [approval] = await client.listApprovals(session);
    if (!approval?.documentHash) throw new Error("expected a bound approval");
    const good = { documentHash: approval.documentHash, requestHash: approval.requestHash };
    await expect(client.approve(session, approval.id, { ...good, documentHash: "0".repeat(64) })).rejects.toBeInstanceOf(StaleApprovalError);
    await expect(client.approve(session, approval.id, { ...good, requestHash: "0".repeat(64) })).rejects.toBeInstanceOf(StaleApprovalError);
    const result = await client.approve(session, approval.id, good);
    expect(result.status).toBe("completed");
    expect(result.simulated).toBe(true);
    expect(result.receiptId).toBeTruthy();
    await expect(client.approve(session, approval.id, good)).rejects.toBeInstanceOf(StaleApprovalError);
  });

  it("declines in demo mode: nothing is sent, Mano says so once, and a YES after it is refused", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    await client.sendMessage(session, "mail", [{ kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: photo }]);
    const [approval] = await client.listApprovals(session);
    if (!approval?.documentHash) throw new Error("expected a bound approval");
    expect(await client.decline(session, approval.id)).toEqual({ status: "rejected", notSent: true });
    expect(await client.decline(session, approval.id)).toEqual({ status: "rejected", notSent: true });
    const [after] = await client.listApprovals(session);
    expect(after?.status).toBe("rejected");
    const messages = await client.listMessages(session);
    expect(messages.filter((m) => m.text === DECLINE_REPLY)).toHaveLength(1);
    expect(messages.some((m) => m.text.includes("pay stub"))).toBe(false);
    await expect(
      client.approve(session, approval.id, { documentHash: approval.documentHash, requestHash: approval.requestHash }),
    ).rejects.toBeInstanceOf(StaleApprovalError);
    expect((await client.sendMessage(session, "any approvals?", [])).text).toContain("Nothing is waiting");
  });

  it("lets exactly one of a racing NO and YES win, with chat matching the winner", async () => {
    for (const order of ["no-first", "yes-first"] as const) {
      const client = makeClient();
      const session = await signIn(client);
      const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
      await client.sendMessage(session, "mail", [{ kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: photo }]);
      const [approval] = await client.listApprovals(session);
      if (!approval?.documentHash) throw new Error("expected a bound approval");
      const no = () => client.decline(session, approval.id);
      const yes = () => client.approve(session, approval.id, { documentHash: approval.documentHash, requestHash: approval.requestHash });
      const [first, second] = await Promise.allSettled(order === "no-first" ? [no(), yes()] : [yes(), no()]);
      const [noOutcome, yesOutcome] = order === "no-first" ? [first, second] : [second, first];
      const [after] = await client.listApprovals(session);
      const messages = await client.listMessages(session);
      if (yesOutcome.status === "fulfilled") {
        expect(noOutcome).toEqual({ status: "fulfilled", value: { status: "approved", notSent: false } });
        expect(after?.status).toBe("approved");
        expect(messages.some((m) => m.text === DECLINE_REPLY)).toBe(false);
      } else {
        expect(noOutcome).toEqual({ status: "fulfilled", value: { status: "rejected", notSent: true } });
        expect(yesOutcome.reason).toBeInstanceOf(StaleApprovalError);
        expect(after?.status).toBe("rejected");
        expect(messages.filter((m) => m.text === DECLINE_REPLY)).toHaveLength(1);
      }
    }
  });

  it("posts one acknowledgment for two racing NOs", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    await client.sendMessage(session, "mail", [{ kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: photo }]);
    const [approval] = await client.listApprovals(session);
    if (!approval) throw new Error("expected an approval");
    const answers = await Promise.all([client.decline(session, approval.id), client.decline(session, approval.id)]);
    expect(answers.map((a) => a.status)).toEqual(["rejected", "rejected"]);
    expect((await client.listMessages(session)).filter((m) => m.text === DECLINE_REPLY)).toHaveLength(1);
  });

  it("answers a NO after a YES with the approval's real status", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    await client.sendMessage(session, "mail", [{ kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: photo }]);
    const [approval] = await client.listApprovals(session);
    if (!approval?.documentHash) throw new Error("expected a bound approval");
    await client.approve(session, approval.id, { documentHash: approval.documentHash, requestHash: approval.requestHash });
    expect(await client.decline(session, approval.id)).toEqual({ status: "approved", notSent: false });
    expect((await client.listMessages(session)).some((m) => m.text === DECLINE_REPLY)).toBe(false);
  });

  it("brings the caseworker request after approval and closes on the pay stub", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    await client.sendMessage(session, "mail", [{ kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: photo }]);
    const [approval] = await client.listApprovals(session);
    if (!approval?.documentHash) throw new Error("expected a bound approval");
    await client.approve(session, approval.id, { documentHash: approval.documentHash, requestHash: approval.requestHash });
    const afterApprove = await client.listMessages(session);
    expect(afterApprove.some((m) => m.text.includes("pay stub"))).toBe(true);
    const deadlines = await client.listDeadlines(session);
    expect(deadlines.some((d) => d.id === "ddl-paystub")).toBe(true);
    await client.sendMessage(session, "pay stub", [
      { kind: "photo", name: "paystub.jpg", mimeType: "image/jpeg", bytesB64: photo },
    ]);
    const done = await client.listMessages(session);
    expect(done.some((m) => m.text.includes("approved your renewal"))).toBe(true);
    const paystubReplies = done.filter((m) => m.text.includes("I sent your pay stub"));
    expect(paystubReplies).toHaveLength(1);
    const texts = done.map((m) => m.text);
    expect(texts.indexOf("Good news: the county approved your renewal. Your benefits continue without a gap. I saved their notice in Documents.")).toBeGreaterThan(
      texts.findIndex((t) => t.includes("I sent your pay stub")),
    );
    const docs = await client.listDocuments(session);
    const notice = docs.find((d) => d.id === "doc-approval-notice");
    expect(notice?.name).toBe("County approval notice.pdf");
    expect(notice?.mimeType).toBe("application/pdf");
  });

  it("answers deadline and approval questions from current state", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const before = await client.sendMessage(session, "what are my deadlines?", []);
    expect(before.text).toContain("no deadlines");
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    await client.sendMessage(session, "mail", [{ kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: photo }]);
    const after = await client.sendMessage(session, "what are my deadlines?", []);
    expect(after.text).toContain("2 upcoming");
    const approvals = await client.sendMessage(session, "any approvals?", []);
    expect(approvals.text).toContain("1 thing");
  });

  it("checks links against the recorded verdicts", async () => {
    const client = makeClient();
    const session = await signIn(client);
    expect(await client.checkLink(session, "https://example.com/renew")).toEqual({ allowed: true, reason: null });
    const blocked = await client.checkLink(session, "http://example.com/renew");
    expect(blocked.allowed).toBe(false);
  });

  it("returns the recorded reply when an operation ID repeats", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const photo = b64encode(utf8ToBytes("fake-photo-bytes"));
    const first = await client.sendMessage(session, "mail", [
      { kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: photo },
    ], "op-1");
    const count = (await client.listMessages(session)).length;
    const second = await client.sendMessage(session, "mail", [
      { kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: photo },
    ], "op-1");
    expect(second.id).toBe(first.id);
    expect((await client.listMessages(session)).length).toBe(count);
  });

  it("revokes access to a case", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const grants = await client.listGrants(session);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.orgName).toBe("Springfield County SNAP office");
    const result = await client.revokeGrant(session, "org:springfield-county", "R-1042");
    expect(result.status).toBe("completed");
    expect(await client.listGrants(session)).toHaveLength(0);
  });

  it("uploads and downloads documents with hashes", async () => {
    const client = makeClient();
    const session = await signIn(client);
    const bytesB64 = b64encode(utf8ToBytes("my document"));
    const meta = await client.uploadDocument(session, "note.txt", "text/plain", bytesB64);
    expect(meta.hash).toBe(createHash("sha256").update(Buffer.from(bytesB64, "base64")).digest("hex"));
    const doc = await client.downloadDocument(session, meta.id);
    expect(doc.bytesB64).toBe(bytesB64);
  });
});
