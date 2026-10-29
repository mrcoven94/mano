import { defineTool } from "eve/tools";
import { z } from "zod";

import { addDraft, formDrafts } from "../lib/forms.js";

const inputSchema = z.object({
  fullName: z.string().min(1).max(200),
  dateOfBirth: z.string().min(1).max(40),
  address: z.string().min(1).max(300),
  phone: z.string().min(1).max(40),
  householdSize: z.number().int().min(1).max(30),
  monthlyIncome: z.number().min(0),
});

export function portalBaseUrl(): string {
  const url = process.env.MANO_PORTAL_URL;
  if (!url) throw new Error("The forms system is not configured (MANO_PORTAL_URL). Say so and offer to prepare the answers instead.");
  return url.replace(/\/$/, "");
}

// Starts a renewal draft in the sandbox portal with the household page
// filled in. A draft is preparation, not a submission: nothing leaves
// Mano until the person approves the exact version. A re-run of this
// step can leave a second unsubmitted draft behind; drafts are cheap
// and the tool returns the live one.
export default defineTool({
  description:
    "Start a renewal draft with the person's household details filled in. Call it once you have every field; ask for what is missing first. Starting a draft submits nothing.",
  inputSchema,
  label: {
    start: ({ fullName }) => `Start a draft for ${fullName}`,
  },
  async execute(input) {
    const base = portalBaseUrl();
    const body = new URLSearchParams({
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth,
      address: input.address,
      phone: input.phone,
      householdSize: String(input.householdSize),
      monthlyIncome: String(input.monthlyIncome),
    });
    const res = await fetch(`${base}/apply/household`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
    if (res.status !== 303) {
      throw new Error(`The forms system did not start a draft (status ${res.status}). Say so and offer to try again.`);
    }
    const setCookie = res.headers.get("set-cookie") ?? "";
    const session = /portal_session=([^;]+)/.exec(setCookie)?.[1];
    if (!session) throw new Error("The forms system did not return a draft session. Say so and offer to try again.");
    const draft = {
      draftId: `draft_${Date.now().toString(36)}`,
      sessionCookie: `portal_session=${session}`,
      applicantName: input.fullName,
      startedAt: new Date().toISOString(),
    };
    formDrafts.update((drafts) => addDraft(drafts, draft));
    return { draftId: draft.draftId, applicantName: draft.applicantName, nextStep: "documents" };
  },
});
