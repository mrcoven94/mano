// Approvals inbox: everything waiting for the person's decision. Each
// card names what will be sent, to whom and why; the detail screen
// shows the exact document before the Approve button.

import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Badge, Body, Card, DemoBanner, EmptyView, ErrorView, LoadingView, Muted, Screen, SectionTitle, Title } from "../../components/ui";
import type { Approval } from "../../lib/api/types";
import { EngineGapError } from "../../lib/api/types";
import { useAuth } from "../../lib/auth";
import { formatDate } from "../../lib/dates";
import { useLanguage, useStrings } from "../../lib/i18n";
import { colors, tapTarget, type } from "../../lib/theme";

function statusTone(status: Approval["status"]): "hl" | "alert" | "green" | "blue" {
  if (status === "pending") return "hl";
  if (status === "approved") return "green";
  return "alert";
}

function statusLabel(status: Approval["status"], s: ReturnType<typeof useStrings>): string {
  if (status === "pending") return s.approvalsPending;
  if (status === "approved") return s.approved;
  if (status === "expired") return s.expired;
  if (status === "stale") return s.stale;
  return s.blocked;
}

export default function Approvals() {
  const s = useStrings();
  const { language } = useLanguage();
  const router = useRouter();
  const { client, session, mode } = useAuth();
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [gap, setGap] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setFailed(false);
    setGap(false);
    try {
      setApprovals(await client.listApprovals(session));
    } catch (err) {
      if (err instanceof EngineGapError) setGap(true);
      else setFailed(true);
    }
  }, [client, session]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const pending = (approvals ?? []).filter((a) => a.status === "pending");
  const done = (approvals ?? []).filter((a) => a.status !== "pending");

  const renderCard = (approval: Approval) => (
    <Pressable
      key={approval.id}
      onPress={() => router.push({ pathname: "/approvals/[id]", params: { id: approval.id } })}
      accessibilityRole="button"
      style={styles.press}
    >
      <Card>
        <Badge tone={statusTone(approval.status)}>{statusLabel(approval.status, s)}</Badge>
        <Text style={[type.cardTitle, styles.purpose]}>{approval.purpose}</Text>
        <Muted>
          {s.toLabel}: {approval.recipientName}
        </Muted>
        {approval.documentName ? <Muted>{approval.documentName}</Muted> : null}
        <Muted>
          {s.expiresOn}: {formatDate(approval.expiresAt, language)}
        </Muted>
      </Card>
    </Pressable>
  );

  return (
    <Screen>
      <Title>{s.approvalsTitle}</Title>
      {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
      {gap ? (
        <Card>
          <Text style={[type.cardTitle, styles.purpose]}>{s.engineGapTitle}</Text>
          <Body>{s.engineGapBody}</Body>
        </Card>
      ) : failed ? (
        <ErrorView title={s.errorTitle} body={s.errorBody} retry={() => void load()} retryTitle={s.retry} />
      ) : approvals === null ? (
        <LoadingView />
      ) : approvals.length === 0 ? (
        <EmptyView body={s.approvalsEmpty} />
      ) : (
        <View>
          {pending.length > 0 ? (
            <View>
              <SectionTitle>{s.approvalsPending}</SectionTitle>
              {pending.map(renderCard)}
            </View>
          ) : null}
          {done.length > 0 ? (
            <View>
              <SectionTitle>{s.approvalsDone}</SectionTitle>
              {done.map(renderCard)}
            </View>
          ) : null}
        </View>
      )}
      <View style={styles.pad} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  press: { minHeight: tapTarget },
  purpose: { color: colors.text, marginTop: 8, marginBottom: 4 },
  pad: { height: 24 },
});
