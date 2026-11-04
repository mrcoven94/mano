// A document Channels stored from an email carries this ID prefix. Anyone who
// has the address can write to it, so such a document is evidence to read and
// never something to send: the person did not choose it (AGENTS.md rule 4).
const EMAIL_DOCUMENT_PREFIX = "email-";

export function emailDocumentId(generation: number, key: string, index: number): string {
  return `${EMAIL_DOCUMENT_PREFIX}g${generation}-${key.slice(0, 24)}-${index}`;
}

export function isEmailDocument(documentId: string): boolean {
  return documentId.startsWith(EMAIL_DOCUMENT_PREFIX);
}
