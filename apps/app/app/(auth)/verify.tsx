// Sign-in step two: the 6-digit code. A verified code becomes a stored
// session and the person meets their agent.

import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Btn, Body, DemoBanner, Field, Screen, Title } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { useStrings } from "../../lib/i18n";
import { colors } from "../../lib/theme";

export default function Verify() {
  const s = useStrings();
  const router = useRouter();
  const { email, challengeId } = useLocalSearchParams<{ email: string; challengeId: string }>();
  const { client, mode, signIn } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!/^\d{6}$/.test(code.trim())) {
      setError(s.invalidCode);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await client.verifyCode(email ?? "", challengeId ?? "", code.trim());
      await signIn(session);
      router.replace("/(tabs)");
    } catch {
      setError(s.signInFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
      <Title>{s.codeTitle}</Title>
      <Body>
        {s.codeBody} {email}.
      </Body>
      {mode === "stand-in" ? <Text style={styles.hint}>{s.demoCodeHint}</Text> : null}
      <View style={styles.form}>
        <Field
          label={s.codeLabel}
          value={code}
          onChangeText={(v) => setCode(v.replace(/[^\d]/g, "").slice(0, 6))}
          placeholder={s.codePlaceholder}
          keyboardType="number-pad"
          maxLength={6}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Btn title={busy ? s.verifying : s.verify} onPress={() => void submit()} busy={busy} />
        <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.link}>
          <Text style={styles.linkText}>{s.backToEmail}</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { marginTop: 24 },
  hint: { marginTop: 12, fontSize: 13, fontWeight: "600", color: colors.text, backgroundColor: colors.hl, padding: 8, borderRadius: 8, overflow: "hidden" },
  error: { color: colors.alert, fontSize: 14, marginBottom: 12 },
  link: { marginTop: 16, minHeight: 48, alignItems: "center", justifyContent: "center" },
  linkText: { color: colors.pen, fontSize: 16 },
});
