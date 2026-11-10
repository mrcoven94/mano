// Deadlines the agent built from mail and office letters, soonest
// first. Each one links to its approval when one is waiting, or offers
// the photo that would settle it. lib/deadline-view decides what a card says.

import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Badge, Body, Card, DemoBanner, EmptyView, ErrorView, LoadingView, Muted, Screen, Title } from "../../components/ui";
import type { ApprovalStatus, Deadline } from "../../lib/api/types";
import { AuthError, EngineGapError } from "../../lib/api/types";
import { useAuth, useClearOnSignOut } from "../../lib/auth";
import { holdMailAsk } from "../../lib/chat-draft";
import { daysUntil, formatDate } from "../../lib/dates";
import { deadlineCard } from "../../lib/deadline-view";
import { useLanguage, useStrings } from "../../lib/i18n";
import { syncReminders } from "../../lib/notify";
import { colors, type } from "../../lib/theme";

function countdown(s: ReturnType<typeof useStrings>, dueAt: string): { text: string; tone: "hl" | "alert" | "green" | "blue" } {
  const days = daysUntil(dueAt);
  if (days < 0) return { text: s.overdue, tone: "alert" };
  if (days === 0) return { text: s.dueToday, tone: "alert" };
  if (days === 1) return { text: s.dueTomorrow, tone: "hl" };
  return { text: `${days} ${s.dueInDays}`, tone: days <= 7 ? "hl" : "blue" };
}

export default function Deadlines() {
  const s = useStrings();
  const { language } = useLanguage();
  const router = useRouter();
  const { client, session, mode, generation, isCurrentGeneration, signOut } = useAuth();
  const [deadlines, setDeadlines] = useState<Deadline[] | null>(null);
  const [approvalStatus, setApprovalStatus] = useState<ReadonlyMap<string, ApprovalStatus>>(new Map());
  const [gap, setGap] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setFailed(false);
    setGap(false);
    try {
      // An approval's status is context: if it cannot be read, a card claims
      // less rather than the screen failing.
      const [all, approvals] = await Promise.all([client.listDeadlines(session), client.listApprovals(session).catch(() => [])]);
      setDeadlines([...all].sort((a, b) => a.dueAt.localeCompare(b.dueAt)));
      setApprovalStatus(new Map(approvals.map((a) => [a.id, a.status])));
      const gen = generation;
      await syncReminders(language, client, session, () => isCurrentGeneration(gen)).catch(() => {});
    } catch (err) {
      if (err instanceof AuthError) {
        await signOut();
        return;
      }
      if (err instanceof EngineGapError) setGap(true);
      else setFailed(true);
    }
  }, [client, session, signOut, language, generation, isCurrentGeneration]);

  useClearOnSignOut(() => {
    setDeadlines(null);
    setApprovalStatus(new Map());
    setGap(false);
    setFailed(false);
  });

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <Screen>
      <Title>{s.deadlinesTitle}</Title>
      {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
      {gap ? (
        <Card>
          <Text style={[type.cardTitle, styles.title]}>{s.engineGapTitle}</Text>
          <Body>{s.engineGapBody}</Body>
        </Card>
      ) : failed ? (
        <ErrorView title={s.errorTitle} body={s.errorBody} retry={() => void load()} retryTitle={s.retry} />
      ) : deadlines === null ? (
        <LoadingView />
      ) : deadlines.length === 0 ? (
        <EmptyView body={s.deadlinesEmpty} />
      ) : (
        <View>
          {deadlines.map((d) => {
            const c = countdown(s, d.dueAt);
            const card = deadlineCard(d, d.relatedApprovalId ? approvalStatus.get(d.relatedApprovalId) : undefined);
            return (
              <Card key={d.id}>
                {card.state === "approved" ? (
                  <Badge tone="green">{s.deadlineApproved}</Badge>
                ) : card.state === "done" ? (
                  <Badge tone="green">{s.deadlineDone}</Badge>
                ) : (
                  <Badge tone={c.tone}>{c.text}</Badge>
                )}
                <Text style={[type.cardTitle, styles.title]}>{d.title}</Text>
                {d.detail ? <Muted>{d.detail}</Muted> : null}
                <Muted>
                  {s.dueOn}: {formatDate(d.dueAt, language)}
                </Muted>
                {card.state === "open" && card.approvalWaits ? (
                  <Pressable
                    onPress={() => router.push({ pathname: "/approvals/[id]", params: { id: d.relatedApprovalId ?? "" } })}
                    accessibilityRole="button"
                    style={styles.link}
                  >
                    <Text style={styles.linkText}>
                      {s.relatedApproval} · {s.viewApproval}
                    </Text>
                  </Pressable>
                ) : null}
                {card.state === "open" && card.photoOf === "pay-stub" ? (
                  <Pressable
                    onPress={() => {
                      if (!session) return;
                      holdMailAsk(session.token, "pay-stub");
                      router.navigate("/(tabs)");
                    }}
                    accessibilityRole="button"
                    style={styles.link}
                  >
                    <Text style={styles.linkText}>{s.photographPayStub}</Text>
                  </Pressable>
                ) : null}
              </Card>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, marginTop: 8, marginBottom: 4 },
  link: { marginTop: 12, minHeight: 48, justifyContent: "center" },
  linkText: { color: colors.pen, fontSize: 16, fontWeight: "600" },
});
