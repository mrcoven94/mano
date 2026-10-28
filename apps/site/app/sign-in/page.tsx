import type { Metadata } from "next";
import SignInForm from "./form";
import "../account.css";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Mano with your phone or email. Texting Mano already created your account.",
};

export default function SignInPage() {
  return (
    <div className="wrap">
      <div className="acct">
        <h1>Sign in</h1>
        <p className="lede">
          Texting Mano already created your account. Sign in here with the same phone number, or with email.
        </p>
        <SignInForm />
      </div>
    </div>
  );
}
