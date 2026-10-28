import { describe, expect, test, vi } from "vitest";
import { Executor, type HouseholdFields } from "../src/executor";
import { FakeModelClient } from "../src/model";
import { assistantMessage, computerCall, FakeComputer } from "./fake-computer";

const HOUSEHOLD: HouseholdFields = {
  fullName: "Maria Santos",
  dateOfBirth: "1988-04-12",
  address: "42 Test Street, Fresno, CA 93701",
  phone: "555-010-2030",
  householdSize: "3",
  monthlyIncome: "2400",
};

const DIGEST = "b".repeat(64);

function receivedFetch(confirmation: string, digest = DIGEST) {
  const spy = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => {
    void _url;
    void _init;
    return new Response(JSON.stringify({ key: "k", scope: "web", status: "received", confirmationNumber: confirmation, digest }), { status: 200 });
  });
  return { spy, fetchImpl: spy as unknown as typeof fetch };
}

describe("executor", () => {
  test("stages files, opens the portal, drives, and reconciles", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([
      [computerCall("call-1", [{ type: "click", button: "left", x: 5, y: 5 }])],
      [assistantMessage(`KEY=key-1 CONFIRMATION=SR-FILED11 DIGEST=${DIGEST}`)],
    ]);
    const { spy, fetchImpl } = receivedFetch("SR-FILED11");
    const executor = new Executor(computer, model, { model: "test-model", portalToken: "token", fetchImpl });
    const result = await executor.execute({
      portalUrl: "https://portal.test",
      household: HOUSEHOLD,
      files: [{ name: "paystub.pdf", type: "application/pdf", data: new TextEncoder().encode("%PDF-bytes") }],
    });
    expect(result).toMatchObject({ outcome: "filed", key: "key-1", confirmationNumber: "SR-FILED11", digest: DIGEST, steps: 2 });
    expect(computer.urls).toEqual(["https://portal.test/apply"]);
    expect(computer.staged.map((f) => f.name)).toEqual(["paystub.pdf"]);
    expect(computer.closes).toBe(1);
    const firstInput = JSON.stringify(model.requests[0]?.input);
    expect(firstInput).toContain("test picker hint");
    expect(firstInput).toContain("/staged/paystub.pdf");
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://portal.test/submissions/key-1");
    expect(init.headers["authorization"]).toBe("Bearer token");
  });

  test("a DUPLICATE report reconciles to duplicate", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([[assistantMessage(`DUPLICATE KEY=key-1 CONFIRMATION=SR-OLD11111 DIGEST=${DIGEST}`)]]);
    const executor = new Executor(computer, model, { model: "test-model", fetchImpl: receivedFetch("SR-OLD11111").fetchImpl });
    const result = await executor.execute({ portalUrl: "https://portal.test", household: HOUSEHOLD, files: [] });
    expect(result.outcome).toBe("duplicate");
    expect(result.confirmationNumber).toBe("SR-OLD11111");
  });

  test("a report without a digest still files, taking the digest from reconcile", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([[assistantMessage("KEY=key-1 CONFIRMATION=SR-FILED11")]]);
    const executor = new Executor(computer, model, { model: "test-model", fetchImpl: receivedFetch("SR-FILED11").fetchImpl });
    const result = await executor.execute({ portalUrl: "https://portal.test", household: HOUSEHOLD, files: [] });
    expect(result).toMatchObject({ outcome: "filed", digest: DIGEST });
  });

  test("a mismatched digest fails instead of claiming a filing", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([[assistantMessage(`KEY=key-1 CONFIRMATION=SR-FILED11 DIGEST=${"c".repeat(64)}`)]]);
    const executor = new Executor(computer, model, { model: "test-model", fetchImpl: receivedFetch("SR-FILED11").fetchImpl });
    const result = await executor.execute({ portalUrl: "https://portal.test", household: HOUSEHOLD, files: [] });
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("reconcile mismatch");
  });

  test("a reconcile mismatch fails instead of claiming a filing", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([[assistantMessage(`KEY=key-1 CONFIRMATION=SR-WRONG111 DIGEST=${DIGEST}`)]]);
    const executor = new Executor(computer, model, { model: "test-model", fetchImpl: receivedFetch("SR-RIGHT1111").fetchImpl });
    const result = await executor.execute({ portalUrl: "https://portal.test", household: HOUSEHOLD, files: [] });
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("reconcile mismatch");
  });

  test("an unreadable report fails without reconciling", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([[assistantMessage("All done, I think.")]]);
    const { spy, fetchImpl } = receivedFetch("SR-X");
    const executor = new Executor(computer, model, { model: "test-model", fetchImpl });
    const result = await executor.execute({ portalUrl: "https://portal.test", household: HOUSEHOLD, files: [] });
    expect(result.outcome).toBe("failed");
    expect(spy).not.toHaveBeenCalled();
  });

  test("the blanket confirmation is acknowledged, anything else stops the run", async () => {
    const computer = new FakeComputer();
    const call = computerCall("call-1", [{ type: "click", button: "left", x: 1, y: 1 }]);
    call["pending_safety_checks"] = [{ id: "csc-1", code: "computer_action_requires_confirmation", message: "Confirm." }];
    const model = new FakeModelClient([[call], [assistantMessage(`KEY=key-1 CONFIRMATION=SR-FILED11 DIGEST=${DIGEST}`)]]);
    const executor = new Executor(computer, model, { model: "test-model", fetchImpl: receivedFetch("SR-FILED11").fetchImpl });
    const result = await executor.execute({ portalUrl: "https://portal.test", household: HOUSEHOLD, files: [] });
    expect(result.outcome).toBe("filed");

    const computer2 = new FakeComputer();
    const flagged = computerCall("call-1", [{ type: "click", button: "left", x: 1, y: 1 }]);
    flagged["pending_safety_checks"] = [{ id: "csc-2", code: "malicious_instructions", message: "Unsafe." }];
    const model2 = new FakeModelClient([[flagged]]);
    const executor2 = new Executor(computer2, model2, { model: "test-model" });
    const blocked = await executor2.execute({ portalUrl: "https://portal.test", household: HOUSEHOLD, files: [] });
    expect(blocked.outcome).toBe("failed");
    expect(blocked.message).toContain("safety check was declined");
    expect(computer2.actions).toEqual([]);
  });

  function caseworkerPage(key: string, applicant: string, receivedAt: string): string {
    return (
      `<span class="conf">SR-WEB11111</span><span class="key">${key}</span>` +
      `<tr><td class="label">Applicant</td><td>${applicant}</td></tr>` +
      `<tr><td class="label">Received</td><td>${receivedAt} via web</td></tr>`
    );
  }

  function browserFetch(page: string) {
    return (async (url: string) => {
      if (url.endsWith("/caseworker/SR-WEB11111")) return new Response(page, { status: 200 });
      return new Response(JSON.stringify({ status: "not_found" }), { status: 404 });
    }) as unknown as typeof fetch;
  }

  async function runBrowser(page: string): Promise<{ outcome: string; message: string }> {
    const computer = new FakeComputer();
    const model = new FakeModelClient([[assistantMessage("KEY=key-1 CONFIRMATION=SR-WEB11111")]]);
    const executor = new Executor(computer, model, { model: "test-model", fetchImpl: browserFetch(page) });
    return executor.execute({ portalUrl: "https://portal.test", household: HOUSEHOLD, files: [] });
  }

  test("a browser filing reconciles through the caseworker record", async () => {
    const result = await runBrowser(caseworkerPage("key-1", "Maria Santos", new Date().toUTCString()));
    expect(result).toMatchObject({ outcome: "filed", key: "key-1", confirmationNumber: "SR-WEB11111" });
  });

  test("a misread key still files when the record is fresh and names the applicant", async () => {
    const result = await runBrowser(caseworkerPage("key-2", "Maria Santos", new Date().toUTCString()));
    expect(result).toMatchObject({ outcome: "filed", key: "key-2", confirmationNumber: "SR-WEB11111" });
  });

  test("a stale record naming another key fails", async () => {
    const result = await runBrowser(caseworkerPage("key-2", "Maria Santos", "Wed, 01 Jan 2020 00:00:00 GMT"));
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("reconcile mismatch");
  });

  test("a fresh record naming another applicant fails", async () => {
    const result = await runBrowser(caseworkerPage("key-2", "Someone Else", new Date().toUTCString()));
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("reconcile mismatch");
  });

  test("checkConfirmation returns null on 404 and throws on a changed page", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient();
    const missing = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
    expect(await new Executor(computer, model, { model: "t", fetchImpl: missing }).checkConfirmation("https://p.test", "SR-X")).toBeNull();
    const changed = (async () => new Response("<p>redesigned</p>", { status: 200 })) as unknown as typeof fetch;
    await expect(new Executor(computer, model, { model: "t", fetchImpl: changed }).checkConfirmation("https://p.test", "SR-X")).rejects.toThrow("changed shape");
  });

  test("the computer always stops, even when the model throws", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient();
    const executor = new Executor(computer, model, { model: "test-model" });
    await expect(executor.execute({ portalUrl: "https://portal.test", household: HOUSEHOLD, files: [] })).rejects.toThrow("ran out of queued outputs");
    expect(computer.closes).toBe(1);
  });

  test("check maps the portal answers", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient();
    const notFound = (async () => new Response(JSON.stringify({ key: "k", status: "not_found" }), { status: 404 })) as unknown as typeof fetch;
    const executor = new Executor(computer, model, { model: "test-model", fetchImpl: notFound });
    expect(await executor.check("https://portal.test", "missing")).toEqual({ status: "not_found" });
    const retired = (async () =>
      new Response(JSON.stringify({ status: "received", confirmationNumber: "SR-R", digest: DIGEST, retired: true }), { status: 200 })) as unknown as typeof fetch;
    const executor2 = new Executor(computer, model, { model: "test-model", fetchImpl: retired });
    expect(await executor2.check("https://portal.test", "old")).toEqual({ status: "retired", confirmationNumber: "SR-R", digest: DIGEST });
  });
});
