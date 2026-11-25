import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { usePostHog } from "posthog-js/react";

import { supabase } from "@/integrations/supabase/client";
import { signInWithIdentifier } from "@/fns/signInWithIdentifier";
import { loginIdentifierToEmail } from "./loginIdentity";

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signInWithPassword: (username: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const posthog = usePostHog();

  useEffect(() => {
    let mounted = true;

    // Register listener FIRST so we don't miss the initial session event.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!mounted) return;
      setSession(next);
    });

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // The Supabase UUID is stable across email and profile changes. Identifying
  // here covers both a successful login and a restored session after refresh,
  // so every browser event and exception inherits the same distinct ID. The ID
  // goes alone: tenants are real people and PostHog is a third party, so no
  // email or name travels with it. Every sign-out (this tab, another tab, an
  // expired refresh token) arrives here as a null session, so this effect is
  // the single place the identity is dropped.
  //
  // PostHog's own persisted identity is compared, not a per-mount ref: a
  // session that expired while the tab was closed leaves the old user's ID in
  // PostHog's storage, and a fresh mount would otherwise keep attributing
  // events to them (or identify the next account on top of it). Waiting for
  // `loading` keeps the initial unresolved null from wiping a live identity.
  useEffect(() => {
    if (loading) return;
    const userId = session?.user.id ?? null;
    const identifiedId = posthog._isIdentified() ? posthog.get_distinct_id() : null;
    if (identifiedId === userId) return;

    if (identifiedId) posthog.reset();
    if (userId) posthog.identify(userId);
  }, [posthog, loading, session?.user.id]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      /**
       * Accepts a username, an email address, or a mobile number.
       *
       * Resolution happens server-side because `profiles` is behind RLS and
       * unreadable to someone who has not signed in yet. The server function
       * takes the password in the same call, so an identifier alone can never
       * be exchanged for an account's email address.
       *
       * The direct client-side path is kept as a fallback rather than removed.
       * It is what every login uses today, and routing authentication through a
       * new server function introduces failure modes — a cold start, a network
       * blip — that must not be able to lock anyone out. If the resolver cannot
       * answer, behaviour is exactly what it was before.
       */
      async signInWithPassword(identifier, password) {
        try {
          const result = await signInWithIdentifier({ data: { identifier, password } });
          if (result.ok) {
            const { error } = await supabase.auth.setSession({
              access_token: result.accessToken,
              refresh_token: result.refreshToken,
            });
            return { error: error?.message ?? null };
          }

          // The only non-ok result that must NOT fall through. Everything else keeps the
          // documented resilience: if the resolver cannot answer, the direct path below
          // still produces the real outcome. But a deactivated account that fell through
          // would authenticate against `<username>@users.local` and be let straight in,
          // which would make the whole check cosmetic.
          if (result.error === "ACCOUNT_DEACTIVATED") {
            return { error: "ACCOUNT_DEACTIVATED" };
          }
        } catch (error) {
          // Not surfaced: the fallback below produces the real outcome, and a
          // transport failure here is not something the person can act on.
          console.warn("[auth] identifier resolution unavailable; using direct sign-in", error);
        }

        const { error } = await supabase.auth.signInWithPassword({
          email: loginIdentifierToEmail(identifier),
          password,
        });
        return { error: error?.message ?? null };
      },
      async signOut() {
        await supabase.auth.signOut();
      },
    }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
