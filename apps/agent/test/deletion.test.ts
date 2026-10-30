import { describe, expect, it } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { handleDeleted } from "../agent/lib/deletion.js";

const SECRET = "deletion-test-secret";
const HANDLE = "d".repeat(64);

function signed(body: unknown, secret = SECRET): Request {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  return new Request("http://agent.test/channels/mano/deleted", {
    method: "POST",
    headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(secret, ts, raw) },
    body: raw,
  });
}

describe("deleting a conversation", () => {
  it("retires the handle's Eve session", async () => {
    const resets: string[] = [];
    const res = await handleDeleted(signed({ handleHash: HANDLE, generation: 1 }), {
      secret: SECRET,
      resetSession: async (h) => {
        resets.push(h);
      },
    });
    expect(res.status).toBe(200);
    expect(resets).toEqual([HANDLE]);
  });

  it("rejects an unsigned notice", async () => {
    const resets: string[] = [];
    const res = await handleDeleted(signed({ handleHash: HANDLE, generation: 1 }, "wrong"), {
      secret: SECRET,
      resetSession: async (h) => {
        resets.push(h);
      },
    });
    expect(res.status).toBe(401);
    expect(resets).toEqual([]);
  });
});
