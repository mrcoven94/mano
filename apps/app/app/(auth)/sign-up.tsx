// An address for creating an account. Nothing links here today. Signing
// in with a new email is how an account starts, so this lands on the
// sign-in screen.

import { Redirect } from "expo-router";

export default function SignUp() {
  return <Redirect href="/(auth)/sign-in" />;
}
