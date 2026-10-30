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

// An informational date that names no duty, such as a coverage end or
// an interview. Never an action date.
export interface DateToKnow {
  letterId: string;
  program: string | null;
  date: string;
  dateText: string;
  // The letter's sentence, verbatim. Mano presents a date to know only
  // as this quote ("the letter mentions: ..."), never as a restated fact.
  quote: string;
  citation: Citation;
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
  // Every deadline sentence the letter withheld, each cited. No
  // deadline on the letter publishes until the person confirms one.
  candidates?: DeadlineCandidate[];
  // On a confirm_deadline question: the date Mano would hold if the
  // person says yes. Mail never sets a deadline itself: every deadline
  // is a proposal. Absent when the reader picked no deadline sentence
  // and on letters flagged as scams. Nothing is scheduled until the
  // person confirms.
  proposal?: DeadlineProposal;
}

export interface DeadlineProposal {
  letterId: string;
  // The reader's pick from the letter's transcription, normalized for
  // matching (whitespace, trailing punctuation, month abbreviations).
  sentence: string;
  // The same sentence verbatim, as the person sees it on the letter.
  quote: string;
  citation: Citation;
  // The date the sentence parsed to, or the counted result.
  dueDate: string;
  obligation: Obligation;
  // High when the letter gave no reason to doubt it: one deadline
  // sentence in a closed form, cited, no qualifier, no other date.
  // Still a proposal; the person confirms either way.
  confidence: "high" | "low";
  count: { days: number; fromIso: string; resultIso: string } | null;
  // Why it was not set without asking, in plain words.
  reasons: string[];
  // Every other withheld sentence, quoted with its dates.
  others: DeadlineCandidate[];
}

export interface DeadlineCandidate {
  sentence: string;
  // Every full date the sentence names, in reading order (YYYY-MM-DD).
  dates: string[];
  // Null for a deadline-like sentence the reader did not mark on the
  // photo: no box means no citation.
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
  // Informational dates that name no duty (coverage and benefit end
  // dates), cited, never action dates. Deadlines are only ever proposed,
  // on confirm_deadline questions.
  datesToKnow: DateToKnow[];
  warnings: Warning[];
  questions: Question[];
  stats: RunStats;
}

export interface ReadMailOptions {
  personId: string;
  synthetic: boolean;
  model: import("./model.js").ModelClient;
}

