// Page kinds and data shapes. One page is made for one person and one
// moment: a short text carries the link, the page carries the detail.

export type PageKind = "estimate" | "letter" | "checklist" | "review" | "approve";

export const PAGE_KINDS: PageKind[] = ["estimate", "letter", "checklist", "review", "approve"];

export interface Fact {
  label: string;
  value: string;
}

export interface EstimateData {
  program: string;
  programLine: string;
  rangeLow: number;
  rangeHigh: number;
  period: string;
  factsUsed: Fact[];
  changes: string[];
  nextStep: string;
  nextHref?: string;
}

export interface LetterDeadline {
  label: string;
  date: string;
}

export interface LetterData {
  from: string;
  subject: string;
  summary: string[];
  deadline?: LetterDeadline;
  todo: string[];
  photoUrl?: string;
  photoAlt?: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  detail?: string;
  checked: boolean;
}

export interface ChecklistData {
  title: string;
  intro?: string;
  items: ChecklistItem[];
  nextStep?: string;
  nextHref?: string;
}

export interface ReviewField {
  id: string;
  label: string;
  value: string;
  unsure: boolean;
  note?: string;
}

export interface ReviewData {
  formName: string;
  intro?: string;
  fields: ReviewField[];
  nextStep?: string;
  nextHref?: string;
}

export interface ApprovalDecision {
  choice: "approved" | "declined";
  atMs: number;
  proposalHash: string;
}

export interface ApproveSend {
  label: string;
  detail?: string;
}

export interface ApproveData {
  action: string;
  forWhom: string;
  destination: string;
  sends: ApproveSend[];
  note?: string;
  decision?: ApprovalDecision;
  otpRequired?: boolean;
}

export type PageData = EstimateData | LetterData | ChecklistData | ReviewData | ApproveData;

export type ValidatedPage =
  | ({ kind: "estimate" } & EstimateData)
  | ({ kind: "letter" } & LetterData)
  | ({ kind: "checklist" } & ChecklistData)
  | ({ kind: "review" } & ReviewData)
  | ({ kind: "approve" } & ApproveData);

export interface StoredPage {
  v: 1;
  page: ValidatedPage;
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  clientKey: string | null;
}
