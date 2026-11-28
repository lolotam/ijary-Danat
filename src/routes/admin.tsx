import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { Power } from "lucide-react";
import { useEffect } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { useI18n } from "@/i18n/provider";
import { useHostBrandName } from "@/hooks/useHostBrandName";
import { usePermissions } from "@/hooks/usePermissions";
import { requirePasswordChange } from "@/components/auth/passwordChangeGuard";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { InboxBell } from "@/components/admin/InboxBell";
import { NoticesBell } from "@/components/admin/NoticesBell";
import { CompanySubscriptionBanner } from "@/components/admin/SubscriptionBanner";
import { SupportSessionBanner } from "@/components/admin/SupportSessionBanner";
import { WhatsappSessionBanner } from "@/components/admin/WhatsappSessionBanner";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";

import { ThemeToggle } from "@/components/ThemeToggle";

export const Route = createFileRoute("/admin")({
  ssr: false,
  // The first sign-in of a staff account carries a temporary password that
  // must be changed (FR-032): the guard sends that account to the
  // change-password screen, and nothing of the panel loads until it is done.
  beforeLoad: async () => {
    await requirePasswordChange("/admin");
  },
  component: AdminLayout,
});

/**
 * غلاف لوحة الإدارة: الشريط الجانبي والترويسة والمحتوى.
 *
 * أهداف اللمس في الترويسة تُكبَّر على الأجهزة اللمسية (`pointer-coarse`) لتطابق
 * ThemeToggle بعد دمج مسار البوابة، دون تعديل المكوّن المشترك.
 *
 * كل أيقونة `shrink-0`، وتسمية تسجيل الخروج تختفي تحت `sm`.
 * A 44px control in a flex row is only 44px until the row runs out of room:
 * flex items shrink past their declared width, so `size-11` on its own
 * collapses silently on a 320px phone. `shrink-0` pins the icons — but
 * pinning every item would overflow the header instead, which is worse, so
 * the one variable-width item, the sign-out label, is what yields.
 */
function AdminLayout() {
  const { user, loading, signOut } = useAuth();
  const permissions = usePermissions();
  const { t, dir, toggle } = useI18n();
  const brandName = useHostBrandName();
  const navigate = useNavigate();

  // Staff-only shell: any authenticated non-staff (e.g. tenant portal sessions)
  // must not see the admin sidebar or child routes. Unauthenticated → /auth.
  // When roles fail to load, do not treat empty roles as "tenant" and bounce
  // a real admin to /portal — show an error instead.
  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/auth" });
      return;
    }
    if (!permissions.isLoading && !permissions.error && !permissions.isStaff) {
      navigate({ to: "/portal", search: {} });
    }
  }, [loading, user, permissions.isLoading, permissions.error, permissions.isStaff, navigate]);

  const blocking = loading || !user || permissions.isLoading;

  if (blocking) {
    return (
      <div
        className="grid min-h-dvh place-items-center bg-background px-6"
        role="status"
        aria-label={t("common.loading")}
      >
        <div className="w-full max-w-sm space-y-3" aria-hidden="true">
          <div className="h-3 w-24 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="h-12 w-full animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
          <div className="h-12 w-4/5 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        </div>
      </div>
    );
  }

  if (permissions.error) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-6">
        <p className="max-w-sm text-center text-sm text-destructive" role="alert">
          {t("common.error")}
        </p>
      </div>
    );
  }

  // Genuine non-staff: redirect is in flight; keep a quiet loading shell.
  if (!permissions.isStaff) {
    return (
      <div
        className="grid min-h-dvh place-items-center bg-background px-6"
        role="status"
        aria-label={t("common.loading")}
      >
        <div className="w-full max-w-sm space-y-3" aria-hidden="true">
          <div className="h-3 w-24 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="h-12 w-full animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
          <div className="h-12 w-4/5 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <div dir={dir} className="flex min-h-screen w-full bg-background">
        <AdminSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between gap-2 border-b border-border/70 bg-background/90 px-3 shadow-[0_1px_0_rgb(116_88_23_/_0.06)] backdrop-blur-xl pt-[env(safe-area-inset-top)] sm:px-5">
            <div className="flex min-w-0 items-center gap-2">
              <SidebarTrigger className="shrink-0 pointer-coarse:size-11" />
              <BrandLogo name={brandName} className="hidden sm:flex" />
            </div>
            <div className="flex items-center gap-2">
              <InboxBell />
              <NoticesBell />
              <ThemeToggle />
              <button
                type="button"
                onClick={toggle}
                className="min-h-10 shrink-0 pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:border-accent hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("nav.language")}
              </button>
              <span className="hidden text-xs text-muted-foreground xl:inline">
                {t("admin.welcome")}, {user.user_metadata?.username ?? user.email}
              </span>
              <Button
                variant="outline"
                size="sm"
                aria-label={t("admin.signOut")}
                title={t("admin.signOut")}
                className="shrink-0 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                onClick={async () => {
                  await signOut();
                  navigate({ to: "/auth" });
                }}
              >
                <Power className="size-4 sm:hidden" />
                <span className="hidden sm:inline">{t("admin.signOut")}</span>
              </Button>
            </div>
          </header>
          <SupportSessionBanner />
          <CompanySubscriptionBanner />
          <WhatsappSessionBanner />
          <main id="main-content" className="flex-1 bg-muted/20 p-4 sm:p-6 lg:p-8">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
