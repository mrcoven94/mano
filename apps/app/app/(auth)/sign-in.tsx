// Sign-in step one: the email address. The engine sends a 6-digit code;
// the stand-in accepts any 6-digit code and says so.

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Btn, Body, DemoBanner, Field, Muted, Screen, Title } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { useStrings } from "../../lib/i18n";
import { colors } from "../../lib/theme";

export default function SignIn() {
  const s = useStrings();
  const router = useRouter();
  const { client, mode } = useAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      setError(s.invalidEmail);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await client.requestCode(trimmed);
      router.push({ pathname: "/(auth)/verify", params: { email: trimmed, challengeId: out.challengeId } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
      <Title>{s.signInTitle}</Title>
      <Body>{s.signInBody}</Body>
      <View style={styles.form}>
        <Field
          label={s.emailLabel}
          value={email}
          onChangeText={setEmail}
          placeholder={s.emailPlaceholder}
          keyboardType="email-address"
        />
        {error ? <Muted style={styles.error}>{error}</Muted> : null}
        <Btn title={busy ? s.sending : s.sendCode} onPress={() => void submit()} busy={busy} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { marginTop: 24 },
  error: { color: colors.alert, marginBottom: 12 },
});
