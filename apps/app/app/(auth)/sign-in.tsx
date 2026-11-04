// Sign-in step one: the email address. The engine sends a 6-digit code;
// the stand-in accepts any 6-digit code and says so.

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Btn, Body, Card, DemoBanner, Field, LanguageSwitch, LiveRegion, Muted, Screen, Title } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { crisisLineForSignIn } from "../../lib/crisis-help";
import { useStrings } from "../../lib/i18n";
import { setPendingSignIn } from "../../lib/sign-in-flow";
import type { StringKey } from "../../lib/strings";
import { colors } from "../../lib/theme";

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function SignIn() {
  const s = useStrings();
  const router = useRouter();
  const { client, mode } = useAuth();
  const [crisisLine] = useState(() => crisisLineForSignIn(Date.now()));
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  // A key, not its words, so the line follows the language switch.
  const [error, setError] = useState<StringKey | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = email.trim();
    if (!EMAIL_SHAPE.test(trimmed)) {
      setError("invalidEmail");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await client.requestCode(trimmed);
      setPendingSignIn({ email: trimmed, challengeId: out.challengeId });
      router.push("/(auth)/verify");
    } catch {
      // A failure's own text is English and written for developers.
      setError("codeNotSent");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <LanguageSwitch />
      {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
      {crisisLine ? (
        <Card>
          <Body>{crisisLine}</Body>
        </Card>
      ) : null}
      <Title>{s.signInTitle}</Title>
      <Body>{s.signInBody}</Body>
      {mode === "live" ? <Muted style={styles.live}>{s.signInLive}</Muted> : null}
      <View style={styles.form}>
        <Field
          label={s.emailLabel}
          value={email}
          onChangeText={setEmail}
          placeholder={s.emailPlaceholder}
          keyboardType="email-address"
        />
        <LiveRegion urgent message={error ? s[error] : null}>
          <Muted style={styles.error}>{error ? s[error] : null}</Muted>
        </LiveRegion>
        <Btn title={busy ? s.sending : s.sendCode} onPress={() => void submit()} busy={busy} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { marginTop: 24 },
  live: { marginTop: 12 },
  error: { color: colors.alert, marginBottom: 12 },
});
