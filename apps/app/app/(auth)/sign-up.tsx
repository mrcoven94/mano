// The website links here to create an account. Signing in with a new
// email is how an account starts, so both land on the same screen.

import { Redirect } from "expo-router";

export default function SignUp() {
  return <Redirect href="/(auth)/sign-in" />;
}
