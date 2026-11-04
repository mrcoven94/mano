// Sign-in step two: the 6-digit code. A verified code becomes a stored
// session and the person meets their agent.

import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { Btn, Body, DemoBanner, Field, LanguageSwitch, LiveRegion, Screen, Title } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { useStrings } from "../../lib/i18n";
import { pendingSignIn, setPendingSignIn } from "../../lib/sign-in-flow";
import type { StringKey } from "../../lib/strings";
import { colors } from "../../lib/theme";

const SIX_DIGITS = /^\d{6}$/;
const NON_DIGITS = /[^\d]/g;

export default function Verify() {
  const s = useStrings();
  const router = useRouter();
  // Read once: clearing it after sign-in must not redirect this screen back.
  const [pending] = useState(pendingSignIn);
  const { client, mode, signIn } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // A key, not its words, so the line follows the language switch.
  const [error, setError] = useState<StringKey | null>(null);

  if (!pending) return <Redirect href="/(auth)/sign-in" />;
  const { email, challengeId } = pending;

  const submit = async (): Promise<void> => {
    if (!SIX_DIGITS.test(code.trim())) {
      setError("invalidCode");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await client.verifyCode(email, challengeId, code.trim());
      await signIn(session);
      setPendingSignIn(null);
      router.replace("/(tabs)");
    } catch {
      setError("signInFailed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <LanguageSwitch />
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
          onChangeText={(v) => setCode(v.replace(NON_DIGITS, "").slice(0, 6))}
          placeholder={s.codePlaceholder}
          keyboardType="number-pad"
          maxLength={6}
        />
        <LiveRegion urgent message={error ? s[error] : null}>
          <Text style={styles.error}>{error ? s[error] : null}</Text>
        </LiveRegion>
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
