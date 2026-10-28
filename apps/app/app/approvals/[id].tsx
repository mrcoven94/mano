// One approval in full: what goes out, to whom, why, and the exact
// document. Approving binds the hash the person reviewed; anything
// that moved since makes the approval refuse instead of sending.

import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Badge, Body, Btn, Card, ErrorView, LoadingView, Muted, Screen, Title } from "../../components/ui";
import { DocPreview, shortHash } from "../../components/doc";
import type { ActionType, Approval, ApprovalDocument, ApproveResult } from "../../lib/api/types";
import { StaleApprovalError } from "../../lib/api/types";
import { useAuth } from "../../lib/auth";
import { formatDate } from "../../lib/dates";
import { useLanguage, useStrings } from "../../lib/i18n";
import { refreshReminders } from "../../lib/notify";
import { colors, type } from "../../lib/theme";

function whatLabel(action: ActionType, s: ReturnType<typeof useStrings>): string {
  if (action === "submit") return s.whatSubmit;
  if (action === "send") return s.whatSend;
  if (action === "share") return s.whatShare;
  if (action === "call") return s.whatCall;
  return s.whatFax;
}

export default function ApprovalDetail() {
  const s = useStrings();
  const { language } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { client, session, mode } = useAuth();
  const [approval, setApproval] = useState<Approval | null>(null);
  const [doc, setDoc] = useState<ApprovalDocument | null>(null);
  const [receipt, setReceipt] = useState<ApproveResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setFailed(false);
    try {
      const all = await client.listApprovals(session);
      const found = all.find((a) => a.id === id) ?? null;
      setApproval(found);
      if (found?.documentId) {
        try {
          setDoc(await client.getApprovalDocument(session, found));
        } catch (err) {
          if (err instanceof StaleApprovalError) setStale(true);
          else throw err;
        }
      }
      if (found && found.status !== "pending") setReceipt(null);
    } catch {
      setFailed(true);
    }
  }, [client, session, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const approve = async (): Promise<void> => {
    if (!session || !approval) return;
    setBusy(true);
    try {
      const result = await client.approve(session, approval.id, approval.documentHash);
      setReceipt(result);
      setApproval({ ...approval, status: result.status === "blocked" ? "blocked" : "approved" });
      if (session) {
        const [approvals, deadlines] = await Promise.all([
          client.listApprovals(session).catch(() => []),
          client.listDeadlines(session).catch(() => []),
        ]);
        await refreshReminders(language, approvals, deadlines).catch(() => {});
      }
    } catch (err) {
      if (err instanceof StaleApprovalError) {
        setStale(true);
        await load();
      } else {
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const hashMatches = approval && doc && approval.documentHash === doc.hash;

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

          {doc ? (
            <Card>
              <Text style={[type.cardTitle, styles.previewTitle]}>
                {s.docPreview}: {doc.name}
              </Text>
              <DocPreview doc={doc} />
              <View style={styles.hashRow}>
                <Muted>
                  {s.docHash}: {shortHash(doc.hash)}
                </Muted>
              </View>
              {hashMatches ? <Muted style={styles.match}>{s.docHashMatch}</Muted> : null}
            </Card>
          ) : null}

          {approval.status === "blocked" ? (
            <Card>
              <Body>{s.blockedNote}</Body>
            </Card>
          ) : null}
          {(approval.status === "stale" || stale) && approval.status === "pending" ? (
            <Card>
              <Body>{s.staleNote}</Body>
            </Card>
          ) : null}

          {receipt ? (
            <Card>
              <Text style={[type.cardTitle, styles.line]}>{s.receiptTitle}</Text>
              <Body>{s.receiptBody}</Body>
              {receipt.receiptId ? (
                <Muted>
                  {s.receiptId}: {receipt.receiptId}
                </Muted>
              ) : null}
              {receipt.simulated || mode === "stand-in" ? <Muted style={styles.match}>{s.receiptSimulated}</Muted> : null}
              <View style={styles.back}>
                <Btn title={s.tabsApprovals} onPress={() => router.back()} />
              </View>
            </Card>
          ) : approval.status === "pending" && !stale ? (
            <View>
              <Muted style={styles.note}>{s.approveNote}</Muted>
              <Btn title={busy ? s.approving : s.approve} onPress={() => void approve()} busy={busy} />
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
  note: { marginBottom: 12 },
  back: { marginTop: 16 },
  pad: { height: 24 },
});
