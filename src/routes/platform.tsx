import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Power } from "lucide-react";
import { useEffect, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { PlatformSidebar } from "@/components/platform/PlatformSidebar";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";

/** حالة بوابة لوحة المشرف العام قبل عرض أي بيانات. */
export type PlatformAccess = "loading" | "login" | "mfa" | "ready" | "denied";

/** المدخلات المطلوبة لحسم بوابة المنصة. */
export interface PlatformAccessInput {
  loading: boolean;
  hasUser: boolean;
  aal2: boolean;
  isAdmin: boolean;
}

/**
 * يحسم حالة بوابة لوحة المشرف العام من الجلسة وعامل التحقق الثاني.
 *
 * `is_platform_admin()` requires `aal2`, so before the second factor it answers
 * false even for a real admin: the roster check is only meaningful afterwards.
 * An aal1 session therefore goes to MFA, and the roster decides access only
 * once the session carries the claim. No platform data renders before both.
 */
export function resolvePlatformAccess(input: PlatformAccessInput): PlatformAccess {
  if (input.loading) return "loading";
  if (!input.hasUser) return "login";
  if (!input.aal2) return "mfa";
  if (!input.isAdmin) return "denied";
  return "ready";
}

export const Route = createFileRoute("/platform")({
  ssr: false,
  component: PlatformLayout,
});

/**
 * غلاف لوحة المشرف العام: يمنع عرض أي بيانات قبل صف مشرف نشط وعامل ثانٍ.
 *
 * The server's host middleware already returns 404 for `/platform/*` outside
 * the admin host. This guard is the session half: the browser session must
 * carry `aal2` and `is_platform_admin()` must answer true for the same JWT.
 */
export function PlatformLayout() {
  const { user, loading, signOut } = useAuth();
  const { t, dir, toggle } = useI18n();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [access, setAccess] = useState<PlatformAccess>("loading");
  const [failed, setFailed] = useState(false);

  // Only the identity matters here; a token refresh must not re-run the guard.
  const userId = user?.id;

  const isSignInPage = pathname === "/platform/login";
  const isMfaPage = pathname === "/platform/mfa";

  useEffect(() => {
    if (loading) {
      setAccess("loading");
      return;
    }
    if (!userId) {
      setAccess("login");
      if (!isSignInPage) void navigate({ to: "/platform/login" });
      return;
    }
    if (isSignInPage) {
      void navigate({ to: "/platform" });
      return;
    }

    let active = true;

    /**
     * يتحقق من ادعاء العامل الثاني وصف المشرف العام في الطلب الحالي.
     */
    async function checkAccess() {
      try {
        const [{ data: level, error: levelError }, { data: isAdmin, error: adminError }] =
          await Promise.all([
            supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
            supabase.rpc("is_platform_admin"),
          ]);
        if (!active) return;
        if (levelError || adminError) {
          setFailed(true);
          setAccess("denied");
          return;
        }

        const next = resolvePlatformAccess({
          loading: false,
          hasUser: true,
          aal2: level?.currentLevel === "aal2",
          isAdmin: isAdmin === true,
        });
        setAccess(next);

        if (next === "denied") {
          await signOut();
          if (active) void navigate({ to: "/platform/login" });
        } else if (next === "mfa" && !isMfaPage) {
          void navigate({ to: "/platform/mfa" });
        } else if (next === "ready" && isMfaPage) {
          void navigate({ to: "/platform" });
        }
      } catch (error) {
        if (!active) return;
        console.warn("[platform] access check failed", error);
        setFailed(true);
        setAccess("denied");
      }
    }

    void checkAccess();
    return () => {
      active = false;
    };
  }, [isMfaPage, isSignInPage, loading, navigate, signOut, userId]);

  // The sign-in form must render even with no session; the guard above would
  // otherwise redirect to itself forever.
  // The second-factor step renders bare too: the panel's sidebar and header
  // belong to an aal2 session only.
  if (isSignInPage || (access === "mfa" && isMfaPage)) {
    return <Outlet />;
  }

  if (access === "loading" || (access === "mfa" && !isMfaPage)) {
    return (
      <div
        dir={dir}
        className="grid min-h-dvh place-items-center bg-background px-6"
        role="status"
        aria-label={t("platform.loading")}
      >
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          {t("platform.loading")}
        </p>
      </div>
    );
  }

  if (access === "denied" || access === "login") {
    return (
      <div dir={dir} className="grid min-h-dvh place-items-center bg-background px-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <p className="text-sm text-destructive" role="alert">
            {failed ? t("platform.error") : t("platform.login.error.forbidden")}
          </p>
          <Button
            variant="outline"
            onClick={async () => {
              await signOut();
              void navigate({ to: "/platform/login" });
            }}
          >
            {t("platform.login.submit")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <div dir={dir} className="flex min-h-screen w-full bg-background">
        <PlatformSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between gap-2 border-b border-border/70 bg-background/90 px-3 shadow-[0_1px_0_rgb(116_88_23_/_0.06)] backdrop-blur-xl pt-[env(safe-area-inset-top)] sm:px-5">
            <div className="flex min-w-0 items-center gap-2">
              <SidebarTrigger className="shrink-0 pointer-coarse:size-11" />
              <BrandLogo name={t("platform.title")} className="hidden sm:flex" />
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <button
                type="button"
                onClick={toggle}
                className="min-h-10 shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:border-accent hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("platform.language")}
              </button>
              <span className="hidden text-xs text-muted-foreground xl:inline">{user?.email}</span>
              <Button
                variant="outline"
                size="sm"
                aria-label={t("platform.signOut")}
                className="shrink-0 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                onClick={async () => {
                  await signOut();
                  void navigate({ to: "/platform/login" });
                }}
              >
                <Power className="size-4 sm:hidden" />
                <span className="hidden sm:inline">{t("platform.signOut")}</span>
              </Button>
            </div>
          </header>
          <main id="main-content" className="flex-1 bg-muted/20 p-4 sm:p-6 lg:p-8">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
