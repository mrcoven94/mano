// Who has access: one row per case shared with one organization.
// Revoking stops future access and says plainly what it cannot recall.

import { useCallback, useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Body, Btn, Card, DemoBanner, EmptyView, ErrorView, GhostBtn, LoadingView, Muted, Screen, Title } from "../components/ui";
import { formatDate } from "../lib/dates";
import type { Grant, RevokeResult } from "../lib/api/types";
import { AuthError, EngineGapError } from "../lib/api/types";
import { useAuth } from "../lib/auth";
import { useLanguage, useStrings } from "../lib/i18n";
import { colors, radius, type } from "../lib/theme";

export default function Access() {
  const s = useStrings();
  const { language } = useLanguage();
  const { client, session, mode, signOut } = useAuth();
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [gap, setGap] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<Grant | null>(null);
  const [revokeResult, setRevokeResult] = useState<RevokeResult | null>(null);
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setFailed(false);
    setGap(false);
    try {
      setGrants(await client.listGrants(session));
    } catch (err) {
      if (err instanceof AuthError) {
        await signOut();
        return;
      }
      if (err instanceof EngineGapError) setGap(true);
      else setFailed(true);
    }
  }, [client, session, signOut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const revoke = async (): Promise<void> => {
    if (!session || !confirming) return;
    setBusy(true);
    try {
      const result = await client.revokeGrant(session, confirming.recipient, confirming.caseId);
      if (result.status === "completed") {
        setConfirming(null);
        setNotice(true);
        await load();
      } else {
        setRevokeResult(result);
      }
    } catch {
      setFailed(true);
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  const closeSheet = (): void => {
    setConfirming(null);
    setRevokeResult(null);
  };

  return (
    <Screen>
      <Title>{s.accessTitle}</Title>
      {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
      <Body>{s.accessBody}</Body>
      <View style={styles.list}>
        {gap ? (
          <Card>
            <Text style={[type.cardTitle, styles.org]}>{s.engineGapTitle}</Text>
            <Body>{s.engineGapBody}</Body>
          </Card>
        ) : failed ? (
          <ErrorView title={s.errorTitle} body={s.errorBody} retry={() => void load()} retryTitle={s.retry} />
        ) : grants === null ? (
          <LoadingView />
        ) : grants.length === 0 ? (
          <EmptyView body={s.accessEmpty} />
        ) : (
          grants.map((g) => (
            <Card key={`${g.recipient}:${g.caseId}`}>
              <Text style={[type.cardTitle, styles.org]}>{g.orgName}</Text>
              <Muted>
                {s.caseLabel}: {g.caseId}
              </Muted>
              <Muted>
                {s.purposeLabel}: {g.purpose}
              </Muted>
              <Muted>
                {s.sharedOn}: {formatDate(g.grantedAt, language)}
              </Muted>
              <View style={styles.revoke}>
                <GhostBtn
                  title={s.revoke}
                  onPress={() => {
                    setNotice(false);
                    setRevokeResult(null);
                    setConfirming(g);
                  }}
                />
              </View>
            </Card>
          ))
        )}
      </View>

      {notice ? (
        <Card>
          <Body>{s.revoked}</Body>
        </Card>
      ) : null}

      <Modal visible={confirming !== null} transparent animationType="fade" onRequestClose={closeSheet}>
        <View style={styles.sheet}>
          <View style={styles.sheetCard}>
            {revokeResult ? (
              <View>
                <Text style={[type.cardTitle, styles.org]}>{s.revokeTitle}</Text>
                <Body>{revokeResult.status === "needs_approval" ? s.revokeNeedsApproval : s.revokeBlocked}</Body>
                {revokeResult.reason ? <Muted>{revokeResult.reason}</Muted> : null}
                <View style={styles.sheetBtns}>
                  <GhostBtn title={s.close} onPress={closeSheet} />
                </View>
              </View>
            ) : (
              <View>
                <Text style={[type.cardTitle, styles.org]}>{s.revokeTitle}</Text>
                <Body>{confirming?.orgName}</Body>
                <Text style={styles.warn}>{s.revokeWarn}</Text>
                <View style={styles.sheetBtns}>
                  <Btn title={busy ? s.revoking : s.revokeConfirm} onPress={() => void revoke()} busy={busy} />
                  <GhostBtn title={s.revokeKeep} onPress={closeSheet} />
                </View>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 16 },
  org: { color: colors.text, marginBottom: 4 },
  revoke: { marginTop: 12 },
  sheet: { flex: 1, backgroundColor: "rgba(18,18,18,.4)", alignItems: "center", justifyContent: "center", padding: 24 },
  sheetCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 20, width: "100%", maxWidth: 420 },
  warn: { marginTop: 12, fontSize: 15, lineHeight: 22, color: colors.text, backgroundColor: colors.hl, borderRadius: radius.sm, padding: 10, overflow: "hidden" },
  sheetBtns: { marginTop: 16, gap: 8 },
});
