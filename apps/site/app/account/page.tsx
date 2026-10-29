import type { Metadata } from "next";
import AccountScreen from "./screen";
import "../account.css";
import { accountsDemo } from "@/lib/accounts-server";

export const metadata: Metadata = {
  title: "Account",
  description: "Your Mano sign-in methods, conversation and account actions.",
};

export default function AccountPage() {
  const demo = accountsDemo();
  return (
    <div className="wrap">
      <div className="acct">
        <h1>Account</h1>
        {demo ? (
          <div className="acct-demo" role="note">
            Demo mode: sign-in runs on stand-ins, not real accounts.
          </div>
        ) : null}
        <p className="lede">The same thread, documents and approvals on text, the web and the app.</p>
        <AccountScreen />
      </div>
    </div>
  );
}
