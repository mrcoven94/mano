// Form drafts in progress: the sandbox portal session behind each
// draft, so later steps (documents, review, submit-after-approval)
// continue where the draft started. Durable per-session state.
import { defineState } from "eve/context";

export interface FormDraft {
  draftId: string;
  sessionCookie: string;
  applicantName: string;
  startedAt: string;
}

export const formDrafts = defineState<FormDraft[]>("mano.forms", () => []);

export const MAX_DRAFTS = 20;

export function addDraft(drafts: FormDraft[], draft: FormDraft): FormDraft[] {
  return [...drafts.filter((d) => d.draftId !== draft.draftId), draft].slice(-MAX_DRAFTS);
}
