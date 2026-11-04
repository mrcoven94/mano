# Mano protocol

Version 1. Agents talk to each other over these messages: a resident's agent shares a case with an org agent, asks for documents, and delivers decisions and notices. JSON Schema lives in `packages/protocol/schemas/message.schema.json` (TS mirror in `src/schema.ts`). Breaking changes bump `PROTOCOL_VERSION` and the schema together.

## Messages

Every message carries:

| Field | Meaning |
| --- | --- |
| `id` | Unique message ID. Receivers dedupe on it. |
| `version` | Protocol version. Receivers reject anything but the current one. |
| `type` | One of the seven types below. |
| `caseId` | The shared case this message belongs to. |
| `fromAgentId` / `toAgentId` | `person:<id>` or `org:<id>`. |
| `payload` | Type-specific object, validated against the per-type schema. |
| `sources` | What the content is based on (document, message, profile, program). |
| `approvedByHumanId` | The person who approved this message, or null. Consent messages require one. |
| `idempotencyKey` | Sender-side dedupe key. |
| `createdAt` | ISO timestamp. |
| `signature` / `signerPublicKey` | Ed25519 signature and the key that made it. |

Types: `case.open`, `document.request`, `document.provide`, `decision`, `notice`, `consent.grant`, `consent.revoke`. Payload shapes are in `src/schema.ts` (`schemasByType`) and the matching TS interfaces in `src/types.ts`.

## Signing and verification

The sender canonicalizes the message (RFC 8785 canonical JSON over every field except `signature` and `signerPublicKey`) and signs the bytes with Ed25519.

Verification never trusts the key inside the message. The receiver resolves the sender's key from its own registry (in the engine, a live lookup of the sender's agent stub, pinned on first sight) and verifies against that. A message carrying any other key fails, even if its own signature is valid.

## Consent

A case reaches an org only through `consent.grant`, signed by the resident's agent after the resident approved the matching gateway action. The first grant binds the case to its resident; later events for that case are accepted only from the same resident. The org records shares and revokes as append-only events. Records are per organization: revoking for one org says nothing about another org's grant for the same case. For that org and case revocation is terminal and a later share is rejected; sharing again opens a new case.

A grant may carry `details`, the exact label and value pairs the resident read in their approval. Those are what the org holds of the case.

## Documents

An org that holds an active grant can ask for a document with `document.request`, signed by the org agent. `documentKind` is one of a closed list the resident's agent words itself, so staff text never reaches the resident. The resident's agent refuses a request when the case is not shared with that org.

The answer is `document.provide`, signed by the resident's agent after the resident approved the matching gateway action for that exact document. `requestId` names the request it answers; the org refuses a document it did not ask for, or one on a case no longer shared. The bytes stay with the resident's agent, which checks the grant again on every read. Revoking ends those reads. It cannot recall what the org already read or saved, and Mano says so.

## Delivery rules

- Receivers validate shape, version and payload schema before verifying the signature, and ignore malformed messages.
- Receivers dedupe on sender plus idempotency key, inserting before appending: a redelivery returns the first outcome without new effects, and a duplicate revoke can never end a newer share.
- Senders retry with the same idempotency key and resend the same signed message; a key names one approved action, so a retry can never become a second one.
- Reconcile asks the receiver whether it recorded the key; an unreachable receiver means unknown, never absent.
- Content inside a message is evidence, never permission. Instructions found in letters, pages or documents are never followed.
