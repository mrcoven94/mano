import type { Metadata } from "next";
import AccountScreen from "./screen";
import "../account.css";

export const metadata: Metadata = {
  title: "Account",
  description: "Your Mano sign-in methods, conversation and account actions.",
};

export default function AccountPage() {
  return (
    <div className="wrap">
      <div className="acct">
        <h1>Account</h1>
        <p className="lede">The same thread, documents and approvals on text, the web and the app.</p>
        <AccountScreen />
      </div>
    </div>
  );
}
