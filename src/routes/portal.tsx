import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Building2,
  CreditCard,
  FileText,
  Home,
  LayoutDashboard,
  Power,
  ReceiptText,
  Store,
  UserRound,
} from "lucide-react";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

import { useAuth } from "@/auth/AuthProvider";
import { BrandLogo } from "@/components/BrandLogo";
import { requirePasswordChange } from "@/components/auth/passwordChangeGuard";
import { AnnouncementBanner } from "@/components/portal/AnnouncementBanner";
import { ReminderPopupDialog } from "@/components/portal/ReminderPopupDialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePortalIdentity } from "@/hooks/usePortalData";
import { usePortalTabAccess } from "@/hooks/usePortalTabs";
import { useI18n } from "@/i18n/provider";
import { portalTabForPath, type PortalTabKey } from "@/lib/portalTabs";
import { tenantDisplayName } from "@/lib/tenantDisplayName";
import { cn } from "@/lib/utils";

import { ThemeToggle } from "@/components/ThemeToggle";

export const Route = createFileRoute("/portal")({
  ssr: false,
  // The first sign-in of a portal account carries a temporary password that
  // must be changed (FR-032): the guard sends that account to the
  // change-password screen, and nothing of the portal loads until it is done.
  beforeLoad: async () => {
    await requirePasswordChange("/portal");
  },
  // `?tenant=<id>` lets an admin open any tenant's portal (ignored for
  // non-staff users — see usePortalIdentity).
  // `?tenant=` admin preview; `?contract=` multi-contract filter (Lane A).
  validateSearch: (search: Record<string, unknown>): { tenant?: string; contract?: string } => ({
    ...(typeof search.tenant === "string" ? { tenant: search.tenant } : {}),
    ...(typeof search.contract === "string" ? { contract: search.contract } : {}),
  }),
  component: PortalLayout,
});

/**
 * Icons live here rather than in lib/portalTabs so that module stays free of
 * UI imports and can be unit tested on its own.
 */
const TAB_ICONS: Record<PortalTabKey, typeof Home> = {
  dashboard: Home,
  lease: Building2,
  invoices: FileText,
  payments: CreditCard,
  receipts: ReceiptText,
  profile: UserRound,
  shop: Store,
};

/**
 * تخطيط بوابة المستأجر: الترويسة والتنقّل ومنطقة المحتوى.
 */
function PortalLayout() {
  const { user, loading, signOut } = useAuth();
  const { tenant: viewTenantId, contract: contractId } = Route.useSearch();
  const identity = usePortalIdentity(viewTenantId);
  const { dir, locale, setLocale, t, toggle } = useI18n();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const tenantRecord = identity.data?.tenant ?? null;
  // Shop tab needs to know whether this tenant actually has a linked shop.
  // Loaded via the owner-scoped RPC so it respects the all-contracts rule and
  // includes inactive shops that the `linked-brands` query would hide.
  /**
   * هل يملك المستأجر متجراً مرتبطاً؟ — يقرّر ظهور تبويب «تفاصيل المتجر».
   *
   * Deliberately NOT asked while an admin previews someone else's portal.
   * `shop_details_for_tenant` resolves ownership from the SIGNED-IN profile via
   * `_shop_caller_tenant()`, so during a `?tenant=` preview it answers for the
   * staff member — who normally has no `tenant_id` at all — and never for the
   * tenant being previewed. Asking anyway would show staff a tab whose contents
   * belong to nobody. The shop tab is simply not part of the preview; editing a
   * tenant's shop is what the admin Shops screen is for.
   */
  const isPreviewingOtherTenant = Boolean(identity.data?.viewingAsStaff);
  const hasLinkedShopQuery = useQuery({
    queryKey: ["shop-linked", tenantRecord?.id ?? null],
    enabled: Boolean(tenantRecord?.id) && !isPreviewingOtherTenant,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc("shop_details_for_tenant", {});
      if (error) return false;
      return Array.isArray(data) ? data.length > 0 : false;
    },
    staleTime: 60_000,
  });
  const hasLinkedShop = hasLinkedShopQuery.data;
  const { isLoading: tabsLoadingBase, tabs: visibleTabs } = usePortalTabAccess(tenantRecord, {
    hasLinkedShop: hasLinkedShop ?? false,
  });
  // Keep the shop tab hidden until we know whether the tenant owns a shop,
  // otherwise it would flash or a direct /portal/shop navigation would race
  // before the ownership check settles.
  const shopCheckLoading =
    Boolean(tenantRecord?.id) && !isPreviewingOtherTenant && hasLinkedShopQuery.isLoading;
  const tabsLoading = tabsLoadingBase || shopCheckLoading;

  useEffect(() => {
    if (loading || user) return;
    // Carry where they were trying to go. A tenant following a "Pay Now" link
    // from an overdue reminder arrives here logged out; without this they sign
    // in and land on the portal home, having lost the invoice they came to pay.
    // The auth route only honours a redirect that starts with /portal, so a
    // crafted link cannot bounce them off-site.
    const search = typeof window !== "undefined" ? window.location.search : "";
    navigate({ to: "/portal/auth", search: { redirect: `${pathname}${search}` } });
  }, [loading, navigate, pathname, user]);

  // Hiding a nav link is not enough — a bookmarked or hand-typed URL must not
  // land on a hidden tab. Redirect to the first visible one instead. When every
  // tab is hidden there is nowhere to go, so the empty state below renders and
  // this deliberately does nothing rather than looping.
  const firstVisibleTab = visibleTabs[0]?.to;
  useEffect(() => {
    if (tabsLoading || !tenantRecord || !firstVisibleTab) return;
    const current = portalTabForPath(pathname);
    // Routes outside the six tabs (payment callbacks) are never gated.
    if (!current) return;
    if (visibleTabs.some((tab) => tab.key === current.key)) return;
    navigate({
      to: firstVisibleTab,
      search: viewTenantId ? { tenant: viewTenantId } : {},
      replace: true,
    });
  }, [firstVisibleTab, navigate, pathname, tabsLoading, tenantRecord, viewTenantId, visibleTabs]);

  useEffect(() => {
    if (!identity.data || identity.data.isTenant) return;
    // Staff linked to tenants resolve a default tenant in usePortalIdentity,
    // so they stay here even without an explicit ?tenant target.
    if (identity.data.assignedTenants.length) return;
    // A staff user actively previewing a tenant (?tenant= present) stays here
    // so the not-found state below can render; only bounce staff who landed on
    // /portal without a preview target, and non-staff to the portal sign-in.
    if (identity.data.viewingAsStaff) return;
    navigate({ to: identity.data.isStaff ? "/admin" : "/portal/auth" });
  }, [identity.data, navigate]);

  useEffect(() => {
    // Don't hijack an admin's chosen UI language while they preview a portal.
    if (identity.data?.viewingAsStaff) return;
    if (identity.data?.tenant?.preferred_language) {
      setLocale(identity.data.tenant.preferred_language);
    }
  }, [identity.data?.viewingAsStaff, identity.data?.tenant?.preferred_language, setLocale]);

  if (identity.isError) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 px-4">
        <div className="rounded-xl border bg-card p-6 text-center text-destructive">
          {t("common.error")}
        </div>
      </div>
    );
  }

  // Staff previewing a tenant whose record could not be loaded: show a clear
  // not-found state instead of an infinite loader or a silent /admin bounce.
  if (identity.data?.viewingAsStaff && !identity.data?.tenant) {
    return (
      <div dir={dir} className="grid min-h-screen place-items-center bg-muted/30 px-4">
        <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
          <Building2 className="mx-auto size-12 text-muted-foreground" />
          <h1 className="mt-5 text-2xl font-bold">{t("portal.notFound.title")}</h1>
          <p className="mt-3 text-sm text-muted-foreground">{t("portal.notFound.description")}</p>
          <Button asChild className="mt-6">
            <Link to="/admin">
              <LayoutDashboard className="size-4" />
              {t("portal.backToAdmin")}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (loading || !user || identity.isLoading || !identity.data?.isTenant) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  if (!identity.data.tenant) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 px-4">
        <div className="rounded-xl border bg-card p-6 text-center text-destructive">
          {t("common.error")}
        </div>
      </div>
    );
  }

  // Staff previewing a portal keep access even when the tenant's own portal
  // login is disabled — the screen below is the tenant-facing message.
  if (!identity.data.tenant.tenant_portal_enabled && !identity.data.viewingAsStaff) {
    return (
      <div dir={dir} className="grid min-h-screen place-items-center bg-muted/30 px-4">
        <div className="w-full max-w-lg rounded-[14px] border bg-card p-8 text-center shadow">
          <Building2 className="mx-auto size-12 text-muted-foreground" />
          <h1 className="mt-5 text-2xl font-bold">{t("portal.disabled.title")}</h1>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            {t("portal.disabled.description")}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <ThemeToggle />
            <Button variant="outline" onClick={toggle}>
              {t("nav.language")}
            </Button>
            <Button
              onClick={async () => {
                await signOut();
                navigate({ to: "/portal/auth" });
              }}
            >
              {t("admin.signOut")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Every tab hidden: there is no route to redirect to, so say so plainly
  // instead of rendering an empty nav over whatever the Outlet resolves to.
  // Staff previewing see this too — that is what the tenant would get.
  if (!tabsLoading && visibleTabs.length === 0) {
    return (
      <div dir={dir} className="grid min-h-screen place-items-center bg-muted/30 px-4">
        <div className="w-full max-w-lg rounded-[14px] border bg-card p-8 text-center shadow">
          <Building2 className="mx-auto size-12 text-muted-foreground" />
          <h1 className="mt-5 text-2xl font-bold">{t("portal.noTabs.title")}</h1>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            {t("portal.noTabs.description")}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <ThemeToggle />
            <Button variant="outline" onClick={toggle}>
              {t("nav.language")}
            </Button>
            {identity.data.isStaff ? (
              <Button asChild>
                <Link to="/admin">
                  <LayoutDashboard className="size-4" />
                  {t("portal.backToAdmin")}
                </Link>
              </Button>
            ) : (
              <Button
                onClick={async () => {
                  await signOut();
                  navigate({ to: "/portal/auth" });
                }}
              >
                {t("admin.signOut")}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const linkSearch = {
    ...(viewTenantId ? { tenant: viewTenantId } : {}),
    ...(contractId ? { contract: contractId } : {}),
  };

  return (
    <div dir={dir} className="min-h-screen bg-muted/30">
      {identity.data.isStaff && (
        <div className="flex flex-wrap items-center justify-center gap-3 bg-primary px-4 py-2 text-center text-xs text-primary-foreground">
          <span>
            {identity.data.viewingAsStaff
              ? `${t("portal.staffPreview")} — ${tenantDisplayName(identity.data.tenant, locale)}`
              : t("portal.staffPreview")}
          </span>
          {identity.data.assignedTenants.length > 1 && (
            <Select
              value={identity.data.tenant.id}
              onValueChange={(tenantId) =>
                navigate({ to: "/portal", search: { tenant: tenantId } })
              }
            >
              <SelectTrigger
                className="h-7 w-56 bg-primary-foreground text-foreground"
                aria-label={t("portal.switchTenant")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {identity.data.assignedTenants.map((assigned) => (
                  <SelectItem key={assigned.id} value={assigned.id}>
                    {tenantDisplayName(assigned, locale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button asChild size="sm" variant="secondary" className="h-7">
            <Link to="/admin">
              <LayoutDashboard className="size-3.5" />
              {t("portal.backToAdmin")}
            </Link>
          </Button>
        </div>
      )}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/portal" search={linkSearch} className="min-w-0 shrink-0">
            <BrandLogo
              name={t("brand.name")}
              subName={tenantDisplayName(identity.data.tenant, locale)}
            />
          </Link>
          <AnnouncementBanner />
          <ReminderPopupDialog tenantId={identity.data.tenant.id} />
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <Button
              variant="outline"
              size="sm"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              onClick={toggle}
            >
              {t("nav.language")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              title={t("admin.signOut")}
              aria-label={t("admin.signOut")}
              onClick={async () => {
                await signOut();
                navigate({ to: "/portal/auth" });
              }}
            >
              <Power className="size-4 sm:hidden" />
              <span className="hidden sm:inline">{t("admin.signOut")}</span>
            </Button>
          </div>
        </div>
        <nav
          className="mx-auto flex max-w-7xl flex-wrap gap-1 px-4 pb-3"
          aria-label={t("portal.nav.label")}
        >
          {visibleTabs.map((item) => {
            const Icon = TAB_ICONS[item.key];
            return (
              <Link
                key={item.to}
                to={item.to}
                search={linkSearch}
                activeOptions={{ exact: item.exact }}
                className="flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-xs font-medium pointer-coarse:min-h-11 pointer-coarse:px-4 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                activeProps={{
                  className: cn(
                    "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                  ),
                }}
              >
                <Icon className="size-4" />
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>
      </header>
      <main id="main-content" className="mx-auto max-w-7xl p-4 py-6 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}
