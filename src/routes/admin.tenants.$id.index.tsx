import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Ban, CircleCheck, FileText, Pencil, Printer, Send } from "lucide-react";
import { toast } from "sonner";

import { SendManualMessageDialog } from "@/components/admin/SendManualMessageDialog";
import { TenantFormDialog } from "@/components/admin/tenants/TenantFormDialog";

import { InfoField } from "@/components/admin/InfoField";
import { TenantContractTabs } from "@/components/admin/tenant-detail/TenantContractTabs";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { tenantBlockedIconClass, tenantLifecycleTone, tenantCategoryTone } from "@/lib/statusTone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { useContracts } from "@/hooks/useContracts";
import { useCompany } from "@/hooks/useCompany";
import { useInvoices } from "@/hooks/useInvoices";
import { usePayments } from "@/hooks/usePayments";
import { usePermissions } from "@/hooks/usePermissions";
import { useSetTenantBlocked, useTenant } from "@/hooks/useTenants";
import { WhatsAppChatLink } from "@/components/admin/whatsapp/WhatsAppChatLink";
import { StoreLogoCard } from "@/components/admin/StoreLogoCard";
import { cn } from "@/lib/utils";
import { brandForSelectedContract, useBrandsForTenantContracts } from "@/hooks/useLinkedBrand";
import { useI18n } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";
import { nationalityLabel } from "@/lib/nationalities";
import { PERMISSIONS } from "@/lib/permissions";
import { tenantDisplayName } from "@/lib/tenantDisplayName";
import { orderContractsOldestFirst } from "@/lib/tenantLocations";
import type { TenantLifecycle } from "@/integrations/supabase/database.types";
import { auditPrint } from "@/lib/exportAudit";

export const Route = createFileRoute("/admin/tenants/$id/")({ component: TenantDetailPage });

function TenantDetailPage() {
  const { id } = Route.useParams();
  const { t, locale } = useI18n();
  const [manualOpen, setManualOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const permissions = usePermissions();
  const tenant = useTenant(id);
  const setBlocked = useSetTenantBlocked();
  const company = useCompany();
  const brands = useBrandsForTenantContracts(id);
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
  // Filtered by tenant server-side. Asking for the newest 50 contracts globally
  // and filtering in the browser was survivable while only one of them was ever
  // read; now that each one becomes a tab, a tenant outside that window would
  // silently lose tabs.
  const contracts = useContracts(
    { tenantId: id, pageSize: 200, archiveMode: "all" },
    permissions.can(PERMISSIONS.CONTRACTS_READ),
  );
  // Not a page: `outstandingTotal` below sums this list, and a tenant with more
  // invoices than the cap was shown a total short by the difference — a wrong
  // money figure presented as a right one. TenantWideTabs renders the same list
  // with no page control.
  const invoices = useInvoices(
    { tenantId: id, fetchAll: true },
    permissions.can(PERMISSIONS.INVOICES_READ),
  );
  const payments = usePayments(
    { tenantId: id, pageSize: 100 },
    permissions.can(PERMISSIONS.PAYMENTS_READ),
  );

  const tenantContracts = useMemo(() => contracts.data?.items ?? [], [contracts.data]);
  const activeContract = useMemo(
    () => tenantContracts.find((c) => c.state === "active") ?? tenantContracts[0] ?? null,
    [tenantContracts],
  );
  const orderedContractIds = useMemo(
    () => orderContractsOldestFirst(tenantContracts).map((contract) => contract.id),
    [tenantContracts],
  );
  const selectedTabContractId =
    selectedContractId && orderedContractIds.includes(selectedContractId)
      ? selectedContractId
      : (orderedContractIds[0] ?? null);
  const linkedBrand = brandForSelectedContract(brands.data, selectedTabContractId);

  if (!permissions.can(PERMISSIONS.TENANTS_READ)) {
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  }
  if (tenant.isLoading) return <p>{t("common.loading")}</p>;
  if (!tenant.data) return <p>{t("common.notFound")}</p>;

  const outstandingTotal = (invoices.data?.items ?? [])
    .filter((inv) => inv.state !== "paid" && inv.state !== "cancelled")
    .reduce((sum, inv) => sum + Number(inv.balance ?? 0), 0);
  const paidTotal = (payments.data?.items ?? [])
    .filter((p) => p.status === "confirmed")
    .reduce((sum, p) => sum + Number(p.amount ?? 0), 0);

  // `blocked` is the one lifecycle value an admin sets by hand; every other
  // value is derived from the tenant's contracts (migration 54), so this page
  // offers the toggle and nothing else. Until now the badge below stated
  // "Blocked" with no way to see that it was a manual override or to lift it —
  // the block could only be released from the tenants list.
  const isBlocked = tenant.data.lifecycle === "blocked";
  const canToggleBlocked = permissions.can(PERMISSIONS.TENANTS_UPDATE) && !setBlocked.isPending;
  const canEdit = permissions.can(PERMISSIONS.TENANTS_UPDATE);
  const blockLabel = isBlocked ? t("tenants.unblock") : t("tenants.block");
  const toggleBlocked = () => {
    setBlocked.mutate(
      { id, blocked: !isBlocked },
      {
        onSuccess: ({ lifecycle }) =>
          toast.success(t(`tenantLifecycle.${lifecycle as TenantLifecycle}`)),
        onError: (error) => toast.error(error instanceof Error ? error.message : t("common.error")),
      },
    );
  };

  return (
    <div className="space-y-6 print:space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/tenants">
              <ArrowLeft className="size-4" />
              {t("common.back")}
            </Link>
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              auditPrint("tenant", id);
              window.print();
            }}
          >
            <Printer className="size-4" />
            {t("common.print")}
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/tenants/$id/documents" params={{ id }}>
              <FileText className="size-4" />
              {t("tenants.documents")}
            </Link>
          </Button>
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              {t("tenants.edit")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setManualOpen(true)}>
            <Send className="size-4" />
            {t("notifications.send")}
          </Button>
          <Button variant="outline" size="sm" disabled={!canToggleBlocked} onClick={toggleBlocked}>
            {isBlocked ? (
              <CircleCheck className={cn("size-4", tenantBlockedIconClass.blocked)} />
            ) : (
              <Ban className={cn("size-4", tenantBlockedIconClass.unblocked)} />
            )}
            {blockLabel}
          </Button>
        </div>
      </div>

      {/* The tenant's name led the page as a small heading inside the actions
          row, which put the one thing identifying the record at the same weight
          as a Print button — and inside `print:hidden`, so a printed tenant
          sheet carried no name at all. It gets the banner treatment the invoice
          month header uses, and prints as plain text: white-on-nothing is what
          a gradient becomes when the browser drops backgrounds. */}
      <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-700 via-indigo-800 to-slate-950 p-6 text-center text-white shadow-lg print:bg-none print:p-0 print:text-black print:shadow-none">
        {/* The WhatsApp number sits three cards down the page, and reaching a
            tenant's thread meant reading it off, opening the inbox and
            searching for it. One click from the name it belongs to. */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
            {tenantDisplayName(tenant.data, locale)}
          </h1>
          <WhatsAppChatLink
            phone={tenant.data.whatsapp ?? tenant.data.mobile}
            className="rounded-full bg-white/15 p-2 text-white transition-colors hover:bg-white/25 print:hidden"
          />
        </div>
        {/* A fixed neutral rather than `text-muted-foreground`: that token is
            theme-dependent, and printing from dark mode would put its pale tan
            on white paper. The code stays subordinate to the name without
            depending on which theme the browser happened to be in. */}
        <p className="mt-1 font-mono text-sm text-white/70 print:text-neutral-600">
          {tenant.data.code}
        </p>
      </div>

      <StoreLogoCard brand={linkedBrand} tenantName={tenant.data.name} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t("tenants.category")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Badge variant={tenantCategoryTone(tenant.data.category)}>
                {t(`tenantCategory.${tenant.data.category}`)}
              </Badge>
              {/* The lifecycle badge doubles as the toggle, because it is the
                  thing an admin is looking at when they ask why a tenant reads
                  Blocked. Non-blocked values are still clickable — they block —
                  which matches the tenants list, where the same one click with
                  no confirmation is already the behaviour.

                  A <button> wearing badgeVariants rather than a <Badge> wrapped
                  in one: `Badge` renders a div, and a div inside a button is
                  invalid markup. */}
              <button
                type="button"
                disabled={!canToggleBlocked}
                onClick={toggleBlocked}
                // `title` and not `aria-label`: the badge text is the button's
                // content, so it is already the accessible name. An aria-label
                // of "Unblock" over visible text reading "Blocked" would make
                // the two disagree; the tooltip is what a sighted user needs.
                title={blockLabel}
                className={cn(
                  badgeVariants({ variant: tenantLifecycleTone(tenant.data.lifecycle) }),
                  "disabled:cursor-default",
                )}
              >
                {t(`tenantLifecycle.${tenant.data.lifecycle}`)}
              </button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              {t("tenants.outstanding")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatKwd(outstandingTotal, locale)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              {t("tenants.paidTotal")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatKwd(paidTotal, locale)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("tenants.profile")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 text-sm">
          <InfoField label={t("tenants.mobile")} value={tenant.data.mobile} ltr />
          <InfoField label={t("tenants.whatsapp")} value={tenant.data.whatsapp} ltr />
          <InfoField label={t("tenants.email")} value={tenant.data.email} ltr />
          <InfoField
            label={t("tenants.nationality")}
            value={nationalityLabel(tenant.data.nationality, locale) || null}
          />
          <InfoField
            label={t("tenants.language")}
            value={
              tenant.data.preferred_language === "ar"
                ? t("tenants.languageName.ar")
                : t("tenants.languageName.en")
            }
          />
          <InfoField
            label={t("tenants.commercialNameAr")}
            value={tenant.data.commercial_name_ar ?? tenant.data.commercial_name}
          />
          <InfoField label={t("tenants.commercialNameEn")} value={tenant.data.commercial_name_en} />
          <InfoField
            label={t("tenants.authorizedManager")}
            value={tenant.data.authorized_manager}
          />
          <InfoField
            label={t("tenants.authorizedManagerCivilId")}
            value={tenant.data.authorized_manager_civil_id}
          />
          <InfoField label={t("tenants.ownerCivilId")} value={tenant.data.owner_civil_id} />
          <InfoField
            label={t("tenants.commercialAddress")}
            value={tenant.data.commercial_address}
          />
          <InfoField
            label={t("tenants.portal")}
            value={tenant.data.tenant_portal_enabled ? t("common.yes") : t("common.no")}
          />
          <InfoField label={t("tenants.startDate")} value={activeContract?.start_date ?? null} />
          <InfoField label={t("tenants.endDate")} value={activeContract?.end_date ?? null} />
        </CardContent>
      </Card>

      {/* The "Current lease" card stood here. It duplicated the contract panel
          below field for field — code, state, properties, units, start, end,
          rent — and got two of them wrong: it rendered `primaryUnit` /
          `primaryProperty`, which are literally `units[0]`, so a tenant on a
          three-unit contract spanning two buildings saw one of each presented
          as the whole lease. The contract tabs show every unit and building,
          for every contract rather than only the active one. */}
      <TenantContractTabs
        tenantId={id}
        tenant={tenant.data}
        companyId={company.data?.id ?? null}
        contracts={contracts}
        tenantContracts={tenantContracts}
        invoices={invoices}
        payments={payments}
        selectedContractId={selectedTabContractId}
        onSelectedContractIdChange={setSelectedContractId}
      />

      <SendManualMessageDialog open={manualOpen} onOpenChange={setManualOpen} presetTenantId={id} />
      <TenantFormDialog open={editOpen} onOpenChange={setEditOpen} editing={tenant.data ?? null} />
      {/* This page had no <Toaster />, so the block/unblock result would have
          been raised into nothing — the same defect admin.invoices.tsx carried. */}
      <Toaster richColors position="top-center" />
    </div>
  );
}
