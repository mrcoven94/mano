// One approval, read in the order the person decides: what Mano will
// send (the form and its answers), to which office, the attached
// document, by when, and the statement she signs. The exact document
// follows in full, then Approve and No; the ids and binding hashes sit
// last, under "Details for checking". Approve stays disabled until the
// gate in lib/approve-gate says yes: pending, current, loaded,
// hash-matched, actually rendered and a known request shape. No needs
// none of that: declining sends nothing, so it stays open whenever the
// approval waits, a stale document included. "Ask Mano to change
// something" sends nothing either: it opens the chat with the approval
// quoted for the person to finish. Every load clears the last state, and
// stale loads cannot overwrite it. An ID that is not on the list, as with an
// old reminder's tap, says so and offers the list.

import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Body, Btn, Card, ErrorView, GhostBtn, LinkBtn, LoadingView, Muted, Screen, Title, useGoBack } from "../../components/ui";
import { DocPreview, currentPlatform } from "../../components/doc";
import { parseActionView, type ParsedAction } from "../../lib/action-view";
import { declarationIntro, fieldValue, leadLine, officeName, sentInEnglishNote, whatLabel } from "../../lib/approval-text";
import { changeDraft, holdChatDraft } from "../../lib/chat-draft";
import { approvalGate } from "../../lib/approve-gate";
import { approveOutcome } from "../../lib/approve-result";
import type { Approval, ApprovalStatus, ApprovalDocument, ApproveResult, DeclineAnswer } from "../../lib/api/types";
import { provenNotSent } from "../../lib/sent-proof";
import { AuthError, StaleApprovalError } from "../../lib/api/types";
import { useAuth, useClearOnSignOut } from "../../lib/auth";
import { formatDate } from "../../lib/dates";
import { canShowBytes } from "../../lib/doc-show";
import { useLanguage, useStrings } from "../../lib/i18n";
import { syncReminders } from "../../lib/notify";
import type { Strings } from "../../lib/strings";
import { colors, radius, tapTarget, type } from "../../lib/theme";

const UP_TO_EIGHT_CHARS = /.{1,8}/g;

// A full hash in groups of eight, so it wraps on a phone and is easy
// to compare piece by piece.
function grouped(hash: string): string {
  return hash.match(UP_TO_EIGHT_CHARS)?.join(" ") ?? hash;
}

// Shown above the lead line once the request is no longer waiting; while
// it waits, the lead line and the actions already say so.
function statusLabel(status: Exclude<ApprovalStatus, "pending">, s: Strings): string {
  if (status === "approved") return s.approved;
  if (status === "rejected") return s.declined;
  if (status === "revoked") return s.approvalRevoked;
  if (status === "expired") return s.expired;
  if (status === "stale") return s.stale;
  return s.blocked;
}

type DocState = "loading" | "ready" | "failed";

// A NO: in flight, failed (safe to repeat), or answered with the
// approval's status on file afterward.
type NoState = { phase: "idle" } | { phase: "sending" } | { phase: "failed" } | { phase: "answered"; answer: DeclineAnswer };
const NO_IDLE: NoState = { phase: "idle" };

// "Nothing was sent" only when proven for the whole idempotency key
// (lib/sent-proof.ts); otherwise the honest line is that it may have gone.
function noLine(answer: DeclineAnswer): "declinedNote" | "declineTooLate" | "unconfirmedSend" | "declineClosed" {
  if (answer.status === "approved") return "declineTooLate";
  if (!answer.notSent) return "unconfirmedSend";
  return answer.status === "rejected" ? "declinedNote" : "declineClosed";
}

export default function ApprovalDetail() {
  const s = useStrings();
  const { language } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const goBack = useGoBack("/(tabs)/approvals");
  const { client, session, mode, personStore, generation: sessionGeneration, isCurrentGeneration, signOut } = useAuth();
  const [approval, setApproval] = useState<Approval | null>(null);
  // Other approvals under the same idempotency key, as of the last load.
  const [keyMates, setKeyMates] = useState<Approval[]>([]);
  const [action, setAction] = useState<ParsedAction | null>(null);
  const [doc, setDoc] = useState<ApprovalDocument | null>(null);
  const [docState, setDocState] = useState<DocState>("loading");
  const [docShown, setDocShown] = useState(false);
  const [linkBlocked, setLinkBlocked] = useState(false);
  const [receipt, setReceipt] = useState<ApproveResult | null>(null);
  const [failed, setFailed] = useState(false);
  // The list loaded and this ID is not in it, as with an old reminder's tap.
  const [missing, setMissing] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [no, setNo] = useState<NoState>(NO_IDLE);
  // The office's due date from the deadline this approval serves, if any.
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const router = useRouter();
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!session) return;
    const mine = generation.current + 1;
    generation.current = mine;
    setFailed(false);
    setMissing(false);
    setStale(false);
    setApproval(null);
    setKeyMates([]);
    setAction(null);
    setDoc(null);
    setDocState("loading");
    setDocShown(false);
    setLinkBlocked(false);
    setReceipt(null);
    setNo(NO_IDLE);
    setDueAt(null);
    try {
      const all = await client.listApprovals(session);
      if (generation.current !== mine) return;
      const found = all.find((a) => a.id === id) ?? null;
      setApproval(found);
      if (!found) {
        setMissing(true);
        return;
      }
      // The due date is context, never a condition: if deadlines cannot
      // load, the card simply leaves it out.
      void client
        .listDeadlines(session)
        .then((deadlines) => {
          if (generation.current !== mine) return;
          setDueAt(deadlines.find((d) => d.relatedApprovalId === found.id && !d.done)?.dueAt ?? null);
        })
        .catch(() => undefined);
      setKeyMates(all.filter((a) => a.idempotencyKey === found.idempotencyKey && a.id !== found.id));
      setAction(parseActionView(found.requestJson));
      if (!found.documentId) {
        setDocState("ready");
        return;
      }
      try {
        const current = await client.getApprovalDocument(session, found);
        if (generation.current !== mine) return;
        setDoc(current);
        setDocState("ready");
      } catch (err) {
        if (generation.current !== mine) return;
        if (err instanceof StaleApprovalError) setStale(true);
        setDocState("failed");
      }
    } catch (err) {
      if (generation.current !== mine) return;
      if (err instanceof AuthError) {
        await signOut();
        return;
      }
      setFailed(true);
    }
  }, [client, session, id, signOut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // The approval and its document belong to the session. When it ends
  // the screen forgets them at once, even before the route gate moves
  // away.
  useClearOnSignOut(() => {
    generation.current += 1;
    setApproval(null);
    setKeyMates([]);
    setAction(null);
    setDoc(null);
    setDocState("loading");
    setDocShown(false);
    setLinkBlocked(false);
    setReceipt(null);
    setNo(NO_IDLE);
    setDueAt(null);
    setStale(false);
    setFailed(false);
    setMissing(false);
  });

  const approve = async (): Promise<void> => {
    if (!session || !approval) return;
    setBusy(true);
    try {
      const result = await client.approve(session, approval.id, {
        documentHash: approval.documentHash,
        requestHash: approval.requestHash,
      });
      setReceipt(result);
      const outcome = approveOutcome(result);
      if (outcome === "sent") {
        setApproval({ ...approval, status: "approved" });
      } else if (outcome === "blocked") {
        setApproval({ ...approval, status: "blocked" });
      } else if (outcome === "stale") {
        setStale(true);
        await load();
        return;
      }
      const gen = sessionGeneration;
      await syncReminders(language, client, session, () => isCurrentGeneration(gen)).catch(() => {});
    } catch (err) {
      if (err instanceof StaleApprovalError) {
        setStale(true);
        await load();
      } else if (err instanceof AuthError) {
        await signOut();
      } else {
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const decline = async (): Promise<void> => {
    if (!session || !approval) return;
    setNo({ phase: "sending" });
    try {
      const answer = await client.decline(session, approval.id);
      setApproval({ ...approval, status: answer.status });
      setNo({ phase: "answered", answer });
      const gen = sessionGeneration;
      await syncReminders(language, client, session, () => isCurrentGeneration(gen)).catch(() => {});
    } catch (err) {
      if (err instanceof AuthError) {
        await signOut();
        return;
      }
      setNo({ phase: "failed" });
    }
  };

  // Sends nothing and decides nothing: the approval stays waiting while
  // the person tells Mano in chat what to change.
  const askChange = (): void => {
    if (!session || !approval) return;
    const purpose = action && action.kind !== "unknown" ? action.purpose : approval.purpose;
    holdChatDraft(session.token, changeDraft(s.changeAbout, purpose, s.changeAsk));
    // Back to the chat tab under this screen, not a second copy on top.
    router.dismissTo("/(tabs)");
  };

  const hashMatches = Boolean(
    approval && (!approval.documentHash || (doc && doc.id === approval.documentId && doc.hash === approval.documentHash)),
  );
  const viewable = Boolean(approval && doc && canShowBytes(doc.mimeType, doc.bytesB64, currentPlatform()));
  const actionKnown = Boolean(action && action.kind !== "unknown");
  const gate = approval
    ? approvalGate({
        status: approval.status,
        stale,
        decided: receipt !== null || no.phase === "answered",
        busy: busy || no.phase === "sending",
        docState,
        hasDocument: approval.documentId !== null,
        hashMatches,
        rendered: docShown,
        actionKnown,
      })
    : { canApprove: false as const, reason: "not-pending" as const };
  const canApprove = gate.canApprove;
  // Every "nothing was sent" on this screen hangs on this. A NO's answer
  // is the freshest read of the key; before one, the last load's.
  const nothingSent = approval
    ? no.phase === "answered"
      ? no.answer.notSent
      : provenNotSent([approval, ...keyMates])
    : false;
  const outcome = receipt ? approveOutcome(receipt) : null;
  const englishNote = action && action.kind !== "unknown" ? sentInEnglishNote(action, language, s) : null;

  const handleLink = useCallback(
    async (url: string) => {
      if (!session) return;
      try {
        const verdict = await client.checkLink(session, url);
        if (!verdict.allowed) {
          setLinkBlocked(true);
          return;
        }
        await Linking.openURL(url);
      } catch {
        // If the safety check itself fails, the link stays shut.
        setLinkBlocked(true);
      }
    },
    [client, session],
  );

  return (
    <Screen back="/(tabs)/approvals">
      <Title>{s.approvalsTitle}</Title>
      {failed && !approval ? (
        <ErrorView title={s.errorTitle} body={s.errorBody} retry={() => void load()} retryTitle={s.retry} />
      ) : missing ? (
        <Card>
          <Body>{s.approvalMissing}</Body>
          <View style={styles.back}>
            <Btn title={s.approvalsTitle} onPress={() => router.replace("/(tabs)/approvals")} />
          </View>
        </Card>
      ) : !approval ? (
        <LoadingView />
      ) : (
        <View>
          <Card>
            {approval.status !== "pending" ? <Muted style={styles.status}>{statusLabel(approval.status, s)}</Muted> : null}
            <Text style={[type.section, styles.lead]}>
              {action && action.kind !== "unknown" && approval.status === "pending" && !receipt && no.phase !== "answered"
                ? leadLine(action, s)
                : whatLabel(approval.actionType, s)}
            </Text>
            <Body style={styles.purpose}>{action && action.kind !== "unknown" ? action.purpose : approval.purpose}</Body>
            {englishNote ? <Muted style={styles.englishNote}>{englishNote}</Muted> : null}
            {approval.problems.map((p) => (
              <Text key={p} style={styles.problem}>
                {p}
              </Text>
            ))}
            {action && action.kind !== "unknown" ? (
              <View style={styles.says}>
                <Text style={[type.cardTitle, styles.saysTitle]}>
                  {action.kind === "submit" || action.kind === "fax" || action.kind === "mail" ? s.saysForm : s.saysOther}
                </Text>
                {action.answers.map((field, index) => (
                  <Row
                    key={`${field.key}-${index}`}
                    label={field.label ? s[field.label] : field.key}
                    value={fieldValue(field, s, language)}
                  />
                ))}
              </View>
            ) : (
              <Body style={styles.purpose}>{s.requestUnknown}</Body>
            )}
            <View style={styles.dates}>
              <Row label={s.toLabel} value={officeName(approval.recipientName, s)} />
              {action && action.kind !== "unknown" && action.attachment ? <Row label={s.attached} value={action.attachment} /> : null}
              {dueAt ? <Row label={s.dueAtOffice} value={formatDate(dueAt, language)} /> : null}
              {approval.status === "pending" && !receipt && no.phase !== "answered" ? (
                <View>
                  <Row label={s.answerBy} value={formatDate(approval.expiresAt, language)} />
                  <Muted>{s.answerByNote}</Muted>
                </View>
              ) : null}
            </View>
            {action && action.kind !== "unknown" && action.declaration ? (
              <View style={styles.declaration}>
                <Text style={styles.declarationLabel}>{declarationIntro(action.declaration, s)}</Text>
                <Text style={[type.body, styles.declarationText]}>{action.declaration}</Text>
              </View>
            ) : null}
          </Card>

          {approval.documentId ? (
            <Card>
              <Text style={[type.cardTitle, styles.previewTitle]}>
                {s.docPreview}
                {doc ? `: ${doc.name}` : ""}
              </Text>
              {docState === "loading" ? (
                <Muted>{s.loadingDocument}</Muted>
              ) : doc && hashMatches ? (
                <View>
                  <DocPreview
                    doc={doc}
                    full
                    cacheStore={personStore ?? undefined}
                    onShown={(shown) => setDocShown(shown)}
                    onLink={(url) => void handleLink(url)}
                  />
                  {viewable ? (
                    <Muted style={styles.match}>{s.docHashMatch}</Muted>
                  ) : (
                    <Muted style={styles.warn}>{s.docCannotShow}</Muted>
                  )}
                  {linkBlocked ? <Muted style={styles.warn}>{s.linkBlocked}</Muted> : null}
                </View>
              ) : (
                // A failed load says nothing about whether it was sent.
                <Body>{s.docUnavailable}</Body>
              )}
            </Card>
          ) : null}

          {approval.status === "blocked" && !receipt && nothingSent ? (
            <Card>
              <Body>{s.blockedNote}</Body>
            </Card>
          ) : null}
          {stale && approval.status === "pending" && nothingSent ? (
            <Card>
              <Body>{s.staleNote}</Body>
            </Card>
          ) : null}

          {receipt && outcome ? (
            <Card>
              <Text style={[type.cardTitle, styles.line]}>
                {outcome === "sent" ? s.receiptTitle : outcome === "blocked" ? s.blocked : outcome === "stale" ? s.stale : s.resultTitleProgress}
              </Text>
              <Body>
                {outcome === "sent"
                  ? s.receiptBody
                  : outcome !== "sending" && !nothingSent
                    ? s.unconfirmedSend
                    : outcome === "blocked"
                      ? (receipt.reason ?? s.blockedNote)
                      : outcome === "stale"
                        ? s.staleNote
                        : outcome === "needs-approval"
                          ? s.resultNeedsApproval
                          : s.resultSending}
              </Body>
              {outcome === "sent" ? <Body style={styles.next}>{s.receiptNext}</Body> : null}
              {outcome === "sent" && (receipt.simulated || mode === "stand-in") ? (
                <Muted style={styles.match}>{s.receiptSimulated}</Muted>
              ) : null}
              <View style={[styles.back, styles.actions]}>
                <Btn title={s.approvalsTitle} onPress={goBack} />
                {outcome === "sent" ? <LinkBtn title={s.backToAgent} onPress={() => router.dismissTo("/(tabs)")} /> : null}
              </View>
            </Card>
          ) : no.phase === "answered" ? (
            <Card>
              <Body>{s[noLine(no.answer)]}</Body>
              <View style={styles.back}>
                <Btn title={s.approvalsTitle} onPress={goBack} />
              </View>
            </Card>
          ) : approval.status === "pending" ? (
            <View>
              {gate.reason === "loading-doc" ? <Muted style={styles.note}>{s.loadingDocument}</Muted> : null}
              {gate.reason === "not-shown" && !viewable ? <Muted style={styles.note}>{s.docCannotShow}</Muted> : null}
              {gate.reason === "not-shown" && viewable ? <Muted style={styles.note}>{s.loadingDocument}</Muted> : null}
              {gate.reason === "unknown-action" ? <Muted style={styles.note}>{s.requestUnknown}</Muted> : null}
              {gate.reason === "ready" ? <Muted style={styles.note}>{s.approveNote}</Muted> : null}
              {no.phase === "failed" ? <Muted style={[styles.warn, styles.note]}>{s.declineFailed}</Muted> : null}
              <View style={styles.actions}>
                {stale ? null : (
                  <Btn title={busy ? s.approving : s.approve} onPress={() => void approve()} busy={busy} disabled={!canApprove} />
                )}
                <GhostBtn
                  title={no.phase === "sending" ? s.declining : s.decline}
                  onPress={() => void decline()}
                  busy={no.phase === "sending"}
                  disabled={busy}
                />
                <LinkBtn title={s.askChange} onPress={askChange} disabled={busy || no.phase === "sending"} />
              </View>
            </View>
          ) : null}
          <View style={styles.details}>
            <Pressable
              onPress={() => setDetailsOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel={s.detailsTitle}
              accessibilityState={{ expanded: detailsOpen }}
              aria-expanded={detailsOpen}
              style={({ pressed }) => [styles.detailsToggle, pressed && styles.pressed]}
            >
              <Text style={[type.body, styles.detailsTitle]}>{s.detailsTitle}</Text>
              <Ionicons name={detailsOpen ? "chevron-up" : "chevron-down"} size={20} color={colors.text} />
            </Pressable>
            {detailsOpen ? (
              <View style={styles.detailsBody}>
                <Row label={s.whatLabel} value={whatLabel(approval.actionType, s)} />
                {action && action.kind !== "unknown" ? (
                  <View>
                    <Row label={s.detailsRecipient} value={action.recipient} mono />
                    <Row label={s.detailsReference} value={action.reference} mono />
                    {action.documentId ? <Row label={s.detailsDocument} value={action.documentId} mono /> : null}
                  </View>
                ) : null}
                {doc && hashMatches ? <Row label={s.docHash} value={grouped(doc.hash)} mono /> : null}
                <Row label={s.requestCheck} value={grouped(approval.requestHash)} mono />
                {receipt && outcome === "sent" && receipt.receiptId ? <Row label={s.receiptId} value={receipt.receiptId} mono /> : null}
              </View>
            ) : null}
          </View>

          <View style={styles.pad} />
        </View>
      )}
    </Screen>
  );
}

// One label and its value on a line, wrapping under each other when the
// value is long. mono is for ids and hashes, which read better fixed-width.
function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text selectable style={[type.body, styles.rowValue, mono && styles.mono]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { color: colors.text, marginTop: 8, marginBottom: 8 },
  status: { marginBottom: 8 },
  lead: { color: colors.text },
  purpose: { color: colors.muted, marginTop: 4 },
  englishNote: { marginTop: 4 },
  says: { marginTop: 20 },
  saysTitle: { color: colors.text, marginBottom: 8 },
  dates: { marginTop: 16 },
  row: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, paddingVertical: 4 },
  rowLabel: { fontFamily: type.small.fontFamily, fontSize: 14, lineHeight: 20, paddingTop: 2, color: colors.muted, flexBasis: 140, flexGrow: 1 },
  rowValue: { color: colors.text, flexBasis: 160, flexGrow: 2, flexShrink: 1 },
  mono: { fontFamily: "Menlo, Consolas, monospace", fontSize: 13, lineHeight: 20 },
  declaration: { marginTop: 12, backgroundColor: colors.bg2, borderRadius: radius.sm, padding: 12 },
  declarationLabel: { fontFamily: type.small.fontFamily, fontSize: 14, lineHeight: 20, color: colors.muted },
  declarationText: { color: colors.text, marginTop: 4 },
  problem: { marginTop: 6, fontSize: 14, color: colors.alert },
  previewTitle: { color: colors.text, marginBottom: 12 },
  match: { color: colors.green, marginTop: 8 },
  warn: { color: colors.alert, marginTop: 4 },
  details: { marginTop: 8 },
  detailsToggle: { minHeight: tapTarget, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 },
  detailsTitle: { color: colors.text, fontFamily: type.cardTitle.fontFamily },
  detailsBody: { paddingHorizontal: 4, paddingTop: 4 },
  pressed: { opacity: 0.85 },
  note: { marginBottom: 12 },
  actions: { gap: 8 },
  back: { marginTop: 16 },
  next: { marginTop: 8 },
  pad: { height: 24 },
});
