// Entry route: waits for the stored session, then sends signed-in
// people to their agent and everyone else to sign-in.

import { Redirect } from "expo-router";
import { useAuth } from "../lib/auth";
import { LoadingView, Screen } from "../components/ui";

export default function Index() {
  const { status } = useAuth();
  if (status === "loading") {
    return (
      <Screen>
        <LoadingView />
      </Screen>
    );
  }
  if (status === "signed-in") return <Redirect href="/(tabs)" />;
  return <Redirect href="/(auth)/sign-in" />;
}
