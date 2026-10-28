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
  // Position of the source frame in the video, 0 for photos. Together
  // with the crop and rotation, a viewer can map a cited box on the
  // straightened crop back to the original frame.
  frameTimeMs: number;
  // In-plane rotation corrected when straightening, in degrees.
  rotationDegrees: number;
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

// The duty a deadline puts on the resident: respond, appeal, renew,
// pay, or other when the sentence names no duty.
export type Obligation = "respond" | "appeal" | "renew" | "pay" | "other";

export interface Deadline {
  letterId: string;
  program: string | null;
  dueDate: string;
  dateText: string;
  obligation: Obligation;
  citation: Citation;
  // Relative deadlines ("60 days from the date of this notice") cite
  // the rule above and the anchor here, plus the count rule used.
  anchor: Cited<string> | null;
  countRule: string | null;
}

export type WarningKind =
  | "instruction_in_content"
  | "link_unchecked"
  | "phone_unchecked"
  | "address_unchecked"
  | "scam_suspect"
  | "conflicting_dates"
  | "segmentation_fallback"
  | "video_truncated"
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
  | "read_failed"
  | "video_truncated"
  | "budget_exceeded"
  | "unverified_field";

export interface Question {
  id: string;
  kind: QuestionKind;
  letterId: string | null;
  prompt: string;
  citation: Citation | null;
  // Conflicting deadline candidates, each with its own citation. The
  // deadline stays unpublished until the person confirms one.
  candidates?: Cited<string>[];
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
  // Informational dates that name no duty (coverage and benefit end
  // dates), cited the same way as deadlines but never action dates.
  datesToKnow: Deadline[];
  warnings: Warning[];
  questions: Question[];
  stats: RunStats;
}

export interface ReadMailOptions {
  personId: string;
  synthetic: boolean;
  model: import("./model.js").ModelClient;
}

