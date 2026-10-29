// One approval in full: everything the executor will use, the exact
// document, and both binding hashes. Approve stays disabled until the
// gate in lib/approve-gate says yes: pending, current, loaded,
// hash-matched, actually rendered and a known request shape. Every
// load clears the last state, and stale loads cannot overwrite it.

import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Badge, Body, Btn, Card, ErrorView, LoadingView, Muted, Screen, Title } from "../../components/ui";
import { DocPreview, currentPlatform } from "../../components/doc";
import { parseActionView, type ParsedAction } from "../../lib/action-view";
import { approvalGate } from "../../lib/approve-gate";
import { approveOutcome } from "../../lib/approve-result";
import type { ActionType, Approval, ApprovalDocument, ApproveResult } from "../../lib/api/types";
import { AuthError, StaleApprovalError } from "../../lib/api/types";
import { useAuth, useClearOnSignOut } from "../../lib/auth";
import { formatDate } from "../../lib/dates";
import { canShowBytes, shortHash } from "../../lib/doc-show";
import { useLanguage, useStrings } from "../../lib/i18n";
import { syncReminders } from "../../lib/notify";
import { colors, type } from "../../lib/theme";

function whatLabel(action: ActionType, s: ReturnType<typeof useStrings>): string {
  if (action === "submit") return s.whatSubmit;
  if (action === "send") return s.whatSend;
  if (action === "share") return s.whatShare;
  if (action === "call") return s.whatCall;
  return s.whatFax;
}

type DocState = "loading" | "ready" | "failed";

export default function ApprovalDetail() {
  const s = useStrings();
  const { language } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { client, session, mode, personStore, generation: sessionGeneration, isCurrentGeneration, signOut } = useAuth();
  const [approval, setApproval] = useState<Approval | null>(null);
  const [action, setAction] = useState<ParsedAction | null>(null);
  const [doc, setDoc] = useState<ApprovalDocument | null>(null);
  const [docState, setDocState] = useState<DocState>("loading");
  const [docShown, setDocShown] = useState(false);
  const [linkBlocked, setLinkBlocked] = useState(false);
  const [receipt, setReceipt] = useState<ApproveResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!session) return;
    const mine = generation.current + 1;
    generation.current = mine;
    setFailed(false);
    setStale(false);
    setApproval(null);
    setAction(null);
    setDoc(null);
    setDocState("loading");
    setDocShown(false);
    setLinkBlocked(false);
    setReceipt(null);
    try {
      const all = await client.listApprovals(session);
      if (generation.current !== mine) return;
      const found = all.find((a) => a.id === id) ?? null;
      setApproval(found);
      if (!found) return;
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
    setAction(null);
    setDoc(null);
    setDocState("loading");
    setDocShown(false);
    setLinkBlocked(false);
    setReceipt(null);
    setStale(false);
    setFailed(false);
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

  const hashMatches = Boolean(
    approval && (!approval.documentHash || (doc && doc.id === approval.documentId && doc.hash === approval.documentHash)),
  );
  const viewable = Boolean(approval && doc && canShowBytes(doc.mimeType, doc.bytesB64, currentPlatform()));
  const actionKnown = Boolean(action && action.kind !== "unknown");
  const gate = approval
    ? approvalGate({
        status: approval.status,
        stale,
        decided: receipt !== null,
        busy,
        docState,
        hasDocument: approval.documentId !== null,
        hashMatches,
        rendered: docShown,
        actionKnown,
      })
    : { canApprove: false as const, reason: "not-pending" as const };
  const canApprove = gate.canApprove;
  const outcome = receipt ? approveOutcome(receipt) : null;

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
    <Screen>
      <Title>{s.approvalsTitle}</Title>
      {failed && !approval ? (
        <ErrorView title={s.errorTitle} body={s.errorBody} retry={() => void load()} retryTitle={s.retry} />
      ) : !approval ? (
        <LoadingView />
      ) : (
        <View>
          <Card>
            <Badge tone={approval.status === "pending" ? "hl" : approval.status === "approved" ? "green" : "alert"}>
              {approval.status === "pending"
                ? s.approvalsPending
                : approval.status === "approved"
                  ? s.approved
                  : approval.status === "expired"
                    ? s.expired
                    : approval.status === "stale"
                      ? s.stale
                      : s.blocked}
            </Badge>
            <Text style={[type.cardTitle, styles.line]}>{approval.purpose}</Text>
            <Labeled label={s.whatLabel} value={whatLabel(approval.actionType, s)} />
            <Labeled label={s.toLabel} value={approval.recipientName} />
            <Labeled label={s.whyLabel} value={approval.purpose} />
            <Labeled label={s.expiresOn} value={formatDate(approval.expiresAt, language)} />
            {approval.problems.map((p) => (
              <Text key={p} style={styles.problem}>
                {p}
              </Text>
            ))}
          </Card>

          <Card>
            <Text style={[type.cardTitle, styles.previewTitle]}>{s.requestTitle}</Text>
            {action && action.kind !== "unknown" ? (
              <View>
                {action.rows.map((row, index) => (
                  <Labeled key={`${row.label}-${index}`} label={row.label} value={row.value} />
                ))}
                <Muted>
                  {s.requestCheck}: {shortHash(approval.requestHash)}
                </Muted>
              </View>
            ) : (
              <Body>{s.requestUnknown}</Body>
            )}
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
                    cacheStore={personStore ?? undefined}
                    onShown={(shown) => setDocShown(shown)}
                    onLink={(url) => void handleLink(url)}
                  />
                  <View style={styles.hashRow}>
                    <Muted>
                      {s.docHash}: {shortHash(doc.hash)}
                    </Muted>
                  </View>
                  {viewable ? (
                    <Muted style={styles.match}>{s.docHashMatch}</Muted>
                  ) : (
                    <Muted style={styles.warn}>{s.docCannotShow}</Muted>
                  )}
                  {linkBlocked ? <Muted style={styles.warn}>{s.linkBlocked}</Muted> : null}
                </View>
              ) : (
                <Body>{s.staleNote}</Body>
              )}
            </Card>
          ) : null}

          {approval.status === "blocked" && !receipt ? (
            <Card>
              <Body>{s.blockedNote}</Body>
            </Card>
          ) : null}
          {stale && approval.status === "pending" ? (
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
                  : outcome === "blocked"
                    ? (receipt.reason ?? s.blockedNote)
                    : outcome === "stale"
                      ? s.staleNote
                      : outcome === "needs-approval"
                        ? s.resultNeedsApproval
                        : s.resultSending}
              </Body>
              {outcome === "sent" && receipt.receiptId ? (
                <Muted>
                  {s.receiptId}: {receipt.receiptId}
                </Muted>
              ) : null}
              {outcome === "sent" && (receipt.simulated || mode === "stand-in") ? (
                <Muted style={styles.match}>{s.receiptSimulated}</Muted>
              ) : null}
              <View style={styles.back}>
                <Btn title={s.tabsApprovals} onPress={() => router.back()} />
              </View>
            </Card>
          ) : approval.status === "pending" && !stale ? (
            <View>
              {gate.reason === "loading-doc" ? <Muted style={styles.note}>{s.loadingDocument}</Muted> : null}
              {gate.reason === "not-shown" && !viewable ? <Muted style={styles.note}>{s.docCannotShow}</Muted> : null}
              {gate.reason === "not-shown" && viewable ? <Muted style={styles.note}>{s.loadingDocument}</Muted> : null}
              {gate.reason === "unknown-action" ? <Muted style={styles.note}>{s.requestUnknown}</Muted> : null}
              {gate.reason === "ready" ? <Muted style={styles.note}>{s.approveNote}</Muted> : null}
              <Btn title={busy ? s.approving : s.approve} onPress={() => void approve()} busy={busy} disabled={!canApprove} />
            </View>
          ) : null}
          <View style={styles.pad} />
        </View>
      )}
    </Screen>
  );
}

function Labeled({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.labeled}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[type.body, styles.value]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { color: colors.text, marginTop: 8, marginBottom: 8 },
  labeled: { marginBottom: 8 },
  label: { fontSize: 12, fontWeight: "600", color: colors.faint, textTransform: "uppercase", letterSpacing: 0.5 },
  value: { color: colors.text },
  problem: { marginTop: 6, fontSize: 14, color: colors.alert },
  previewTitle: { color: colors.text, marginBottom: 12 },
  hashRow: { marginTop: 12 },
  match: { color: colors.green, marginTop: 4 },
  warn: { color: colors.alert, marginTop: 4 },
  note: { marginBottom: 12 },
  back: { marginTop: 16 },
  pad: { height: 24 },
});
