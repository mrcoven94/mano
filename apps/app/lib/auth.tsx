// Session state for the whole app: the engine client, the signed-in
// session and the offline outbox. The token is stored securely; the
// outbox survives restarts so queued messages are never lost.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { resolveClient } from "./client";
import type { EngineMode, ManoClient, Session } from "./api/types";
import { Outbox } from "./queue";
import { appStore, tokenStore } from "./storage";

const SESSION_KEY = "session";

type AuthStatus = "loading" | "signed-out" | "signed-in";

interface AuthState {
  status: AuthStatus;
  session: Session | null;
  client: ManoClient;
  mode: EngineMode;
  outbox: Outbox;
  signIn: (session: Session) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function expired(session: Session): boolean {
  return new Date(session.expiresAt).getTime() <= Date.now();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { client, mode } = useMemo(() => resolveClient(), []);
  const outbox = useMemo(() => new Outbox(appStore), []);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    tokenStore
      .get(SESSION_KEY)
      .then((raw) => {
        if (!raw) {
          setStatus("signed-out");
          return;
        }
        try {
          const saved = JSON.parse(raw) as Session;
          if (saved.token && !expired(saved)) {
            setSession(saved);
            setStatus("signed-in");
          } else {
            setStatus("signed-out");
          }
        } catch {
          setStatus("signed-out");
        }
      })
      .catch(() => setStatus("signed-out"));
  }, []);

  const signIn = async (next: Session): Promise<void> => {
    await tokenStore.set(SESSION_KEY, JSON.stringify(next));
    setSession(next);
    setStatus("signed-in");
  };

  const signOut = async (): Promise<void> => {
    await tokenStore.remove(SESSION_KEY);
    setSession(null);
    setStatus("signed-out");
  };

  return (
    <AuthContext.Provider value={{ status, session, client, mode, outbox, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth needs an AuthProvider.");
  return ctx;
}
