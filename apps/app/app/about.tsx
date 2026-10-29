// About Mano: what the app promises, in plain words.

import { Body, Card, DemoBanner, Screen, Title } from "../components/ui";
import { useAuth } from "../lib/auth";
import { useStrings } from "../lib/i18n";

export default function About() {
  const s = useStrings();
  const { mode } = useAuth();
  return (
    <Screen>
      <Title>{s.aboutTitle}</Title>
      {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
      <Card>
        <Body>{s.aboutBody}</Body>
      </Card>
      {mode === "stand-in" ? (
        <Card>
          <Body>{s.aboutSynthetic}</Body>
        </Card>
      ) : null}
    </Screen>
  );
}
