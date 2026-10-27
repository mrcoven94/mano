// Public types for @mano/mail. Every extracted field carries a citation:
// the file it came from, the page within its letter, and a box on that
// page in 0-1000 coordinates (top-left origin).

export interface InputFile {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}

// Box on a page image. Coordinates are 0-1000 relative to the cropped
// page image, top-left origin: [ymin, xmin, ymax, xmax] order in JSON.
export interface Box {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface Citation {
  file: string;
  page: number;
  box: Box;
}

export interface Cited<T> {
  value: T;
  citation: Citation;
}

export interface LetterPage {
  // 1-based page number within the letter.
  page: number;
  file: string;
  // Box of this page inside the source photo or video frame (0-1000).
  crop: Box;
  width: number;
  height: number;
}

export type ContactKind = "phone" | "link" | "address";

export interface Contact {
  kind: ContactKind;
  value: string;
  citation: Citation;
}

export interface LetterFields {
  sender: Cited<string> | null;
  program: Cited<string> | null;
  subject: Cited<string> | null;
  asked: Cited<string>[];
  deadlineText: Cited<string> | null;
  // ISO date (YYYY-MM-DD) parsed from the written-out deadline, or null
  // when the letter states no deadline or it could not be parsed.
  deadlineIso: Cited<string> | null;
  consequence: Cited<string> | null;
  referenceNo: Cited<string> | null;
  noticeDate: Cited<string> | null;
  contacts: Contact[];
  // Short excerpt of the transcribed page text (first page, truncated).
  excerpt: string;
}

export interface Letter {
  id: string;
  pages: LetterPage[];
  fields: LetterFields;
}

export interface Deadline {
  letterId: string;
  program: string | null;
  dueDate: string;
  dateText: string;
  citation: Citation;
}

export type WarningKind =
  | "instruction_in_content"
  | "link_unchecked"
  | "phone_unchecked"
  | "scam_suspect"
  | "conflicting_dates"
  | "segmentation_fallback"
  | "model_error";

export interface Warning {
  kind: WarningKind;
  message: string;
  letterId: string | null;
  citation: Citation | null;
  detail?: string;
}

export type QuestionKind =
  | "unreadable_page"
  | "missing_page"
  | "confirm_deadline"
  | "unsupported_media"
  | "read_failed";

export interface Question {
  id: string;
  kind: QuestionKind;
  letterId: string | null;
  prompt: string;
  citation: Citation | null;
}

export interface ModelCallStat {
  model: string;
  purpose: "segment" | "read" | "group";
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

export interface RunStats {
  files: number;
  frames: number;
  pages: number;
  modelCalls: ModelCallStat[];
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  // False when the stand-in client answered instead of live models.
  live: boolean;
}

export interface MailReading {
  letters: Letter[];
  deadlines: Deadline[];
  warnings: Warning[];
  questions: Question[];
  stats: RunStats;
}

export interface ReadMailOptions {
  personId: string;
  synthetic: boolean;
  model: import("./model.js").ModelClient;
}

export function fullPageBox(): Box {
  return { ymin: 0, xmin: 0, ymax: 1000, xmax: 1000 };
}
