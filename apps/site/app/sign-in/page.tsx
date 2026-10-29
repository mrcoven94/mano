import type { Metadata } from "next";
import SignInForm from "./form";
import "../account.css";
import { accountsDemo } from "@/lib/accounts-server";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Mano with your phone or email. Texting Mano already created your account.",
};

export default function SignInPage() {
  const demo = accountsDemo();
  return (
    <div className="wrap">
      <div className="acct">
        <h1>Sign in</h1>
        {demo ? (
          <div className="acct-demo" role="note">
            Demo mode: sign-in runs on stand-ins, not real accounts.
          </div>
        ) : null}
        <p className="lede">
          Texting Mano already created your account. Sign in here with the same phone number, or with email.
        </p>
        <SignInForm />
      </div>
    </div>
  );
}
