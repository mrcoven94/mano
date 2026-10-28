// Session state for the whole app: the engine client, the signed-in
// session, and the resident's own outbox and store. One resident at a
// time: signing in as someone else wipes the previous resident first,
// and sign-out always wipes cache files, the outbox, the encryption
// key, the session and reminders. Expiry is enforced on launch and on
// every resume; an expired session signs out instead of lingering.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { deleteAsync } from "expo-file-system/legacy";
import * as Notifications from "expo-notifications";
import type { ResolvedClient } from "./client";
import { EncryptedStore } from "./cipher";
import { ExpoCipherFactory } from "./cipher-expo";
import type { EngineMode, ManoClient, Session } from "./api/types";
import { MemoryStore, type KeyValue } from "./kv";
import { Outbox } from "./queue";
import { appStore, expoSecureBackend, scrubLegacyKeys, tokenStore } from "./storage";
import { wipeResidentData } from "./wipe";

const SESSION_KEY = "session";
const cipherFactory = new ExpoCipherFactory(expoSecureBackend);

type AuthStatus = "loading" | "signed-out" | "signed-in";

interface AuthState {
  status: AuthStatus;
  session: Session | null;
  client: ManoClient;
  mode: EngineMode;
  outbox: Outbox | null;
  personStore: KeyValue | null;
  signIn: (session: Session) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function sessionExpired(session: Session, nowMs = Date.now()): boolean {
  return new Date(session.expiresAt).getTime() <= nowMs;
}

function buildPersonStore(session: Session): KeyValue {
  // The web has no secure storage for the data key, so queued mail lives
  // in memory there and never touches the disk. Native persists it
  // encrypted under the resident's key.
  if (Platform.OS === "web") return new MemoryStore();
  return new EncryptedStore(appStore, cipherFactory, session.personId);
}

async function cancelReminders(): Promise<void> {
  if (Platform.OS === "web") return;
  await Notifications.cancelAllScheduledNotificationsAsync();
}

export function AuthProvider({ children, initial }: { children: ReactNode; initial: ResolvedClient }) {
  const { client, mode } = useMemo(() => initial, [initial]);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const [personStore, setPersonStore] = useState<KeyValue | null>(null);
  const stateRef = useRef({ session, outbox, personStore });
  stateRef.current = { session, outbox, personStore };

  const clearToSignedOut = useCallback(() => {
    setSession(null);
    setOutbox(null);
    setPersonStore(null);
    setStatus("signed-out");
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    if (current.session && current.outbox && current.personStore) {
      const errors = await wipeResidentData(current.session.personId, {
        outbox: current.outbox,
        personStore: current.personStore,
        tokenStore,
        forgetPerson: (id) => cipherFactory.forgetPerson(id),
        deleteFile: (uri) => deleteAsync(uri, { idempotent: true }),
        cancelReminders,
      });
      if (errors.length > 0) console.warn(`[mano] sign-out wipe: ${errors.join("; ")}`);
    } else {
      await tokenStore.remove(SESSION_KEY).catch(() => {});
      await cancelReminders().catch(() => {});
    }
    clearToSignedOut();
  }, [clearToSignedOut]);

  const signIn = useCallback(
    async (next: Session): Promise<void> => {
      const current = stateRef.current.session;
      if (current && current.personId !== next.personId) {
        // Never let a new resident inherit the previous one's stores.
        await signOut();
      }
      await tokenStore.set(SESSION_KEY, JSON.stringify(next));
      const store = buildPersonStore(next);
      setPersonStore(store);
      setOutbox(new Outbox(store));
      setSession(next);
      setStatus("signed-in");
    },
    [signOut],
  );

  useEffect(() => {
    let cancelled = false;
    scrubLegacyKeys()
      .catch(() => {})
      .then(() => tokenStore.get(SESSION_KEY))
      .then((raw) => {
        if (cancelled) return;
        if (!raw) {
          setStatus("signed-out");
          return;
        }
        try {
          const saved = JSON.parse(raw) as Session;
          if (saved.token && saved.personId && !sessionExpired(saved)) {
            const store = buildPersonStore(saved);
            setPersonStore(store);
            setOutbox(new Outbox(store));
            setSession(saved);
            setStatus("signed-in");
          } else {
            void signOut();
          }
        } catch {
          void signOut();
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("signed-out");
      });
    return () => {
      cancelled = true;
    };
  }, [signOut]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state !== "active") return;
      const current = stateRef.current.session;
      if (current && sessionExpired(current)) void signOut();
    });
    return () => sub.remove();
  }, [signOut]);

  return (
    <AuthContext.Provider value={{ status, session, client, mode, outbox, personStore, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth needs an AuthProvider.");
  return ctx;
}
