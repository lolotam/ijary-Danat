import { useMemo, useState, type KeyboardEvent } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Download,
  LayoutGrid,
  Plus,
  Table as TableIcon,
  Upload,
  UserCheck,
  Users,
  UserX,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { BulkDeleteBar } from "@/components/admin/BulkDeleteBar";
import { CsvImportDialog } from "@/components/admin/CsvImportDialog";
import { DeleteConfirmation, ModuleHeader } from "@/components/admin/Phase2Ui";
import { useTableSort } from "@/components/admin/SortableTable";
import { SummaryCards } from "@/components/admin/SummaryCards";
import { TenantFiltersBar } from "@/components/admin/tenants/TenantFiltersBar";
import { TenantFormDialog } from "@/components/admin/tenants/TenantFormDialog";
import { TenantsTable } from "@/components/admin/tenants/TenantsTable";
import { VibrantKpiCard } from "@/components/shared/dashboardCards";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCompany } from "@/hooks/useCompany";
import { useIsMobile } from "@/hooks/use-mobile";
import { useCardVisibility } from "@/hooks/useCardVisibility";
import { useListDrivenOptions } from "@/hooks/useOptionLists";
import { usePermissions } from "@/hooks/usePermissions";
import { useProperties } from "@/hooks/useProperties";
import {
  useDeleteTenant,
  useSetTenantBlocked,
  useTenantIdsWithDocuments,
  useTenantExport,
  useTenants,
  type Tenant,
  type TenantWithActiveLocation,
} from "@/hooks/useTenants";
import { useTenantIdsWithPortalAccount } from "@/hooks/useTenantPortalAccounts";
import { useTenantsSummary } from "@/hooks/useTenantsSummary";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import type { TenantLifecycle } from "@/integrations/supabase/database.types";
import { downloadImportTemplate } from "@/lib/bulkImportTemplates";
import { exportRecordsToCsv } from "@/lib/csv";
import { EXPORT_ROW_CEILING } from "@/lib/pagedQuery";
import { formatKwd } from "@/lib/money";
import { PERMISSIONS } from "@/lib/permissions";
import { tenantCsvRows } from "@/lib/tenantCsv";
import { tenantCategories } from "@/lib/tenantForm";
import {
  DEFAULT_TENANT_LIST_VIEW,
  TENANT_LIST_VIEWS,
  type TenantListView,
  effectiveTenantLifecycle,
  resolveTenantListView,
} from "@/lib/tenantListView";
import { emptyTenantTableFilters, filterTenants } from "@/lib/tenantTableFilters";
import { showError } from "@/lib/toastError";
import { TenantDetails } from "@/components/admin/tenants/TenantDetailsDialog";

const listViewSchema = z.enum(TENANT_LIST_VIEWS).catch(DEFAULT_TENANT_LIST_VIEW);

/**
 * بديل فارغ مشترك أثناء تحميل قائمة معرّفات الوثائق — ثابت حتى لا يعيد كل
 * عرض إنشاء مجموعة جديدة ويكسر مقارنات التبعيات.
 */
const EMPTY_TENANT_IDS: Set<string> = new Set();

export const Route = createFileRoute("/admin/tenants/")({
  component: TenantsPage,
  /**
   * يتحقق من معامل `view` في الرابط ويعيده إلى التبويب الافتراضي عند أي قيمة غير معروفة.
   *
   * Optional on the type so existing <Link to="/admin/tenants"> keep compiling;
   * `.catch` also absorbs the legacy `?view=current` links from before this tab.
   */
  validateSearch: (search: Record<string, unknown>): { view?: TenantListView } => ({
    view: listViewSchema.parse(search.view),
  }),
});

function TenantsPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const navigate = useNavigate({ from: Route.fullPath });
  const view = Route.useSearch().view ?? DEFAULT_TENANT_LIST_VIEW;
  const { archiveMode } = resolveTenantListView(view);
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [filters, setFilters] = useState(emptyTenantTableFilters);
  // Cards/table layout is local UI chrome — not the archive list scope (`?view=`).
  const [layoutMode, setLayoutMode] = useState<"cards" | "table">("table");
  const [cardsPerLine, setCardsPerLine] = useState(3);
  const [dialog, setDialog] = useState(false);
  const [editing, setEditing] = useState<TenantWithActiveLocation | Tenant | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Tenant | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [detailTenant, setDetailTenant] = useState<Tenant | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // The Life Cycle select replaces the tab's lifecycle pin rather than ANDing
  // with it — "Contract Ended" on the Active tab must return rows.
  const lifecycle = effectiveTenantLifecycle(view, filters.lifecycle);
  // Pagination removed by request — every tenant is listed on one screen.
  const tenants = useTenants(
    { page: 1, pageSize: 1000, search: debouncedSearch, archiveMode, lifecycle },
    permissions.can(PERMISSIONS.TENANTS_READ),
  );
  // Omit lifecycle: get_tenants_summary's p_lifecycle would shrink Archived (n) to ~0.
  const summary = useTenantsSummary(
    { search: debouncedSearch, archiveMode },
    permissions.can(PERMISSIONS.TENANTS_READ),
  );
  // This page gates its own cards because it owns this file — the shared
  // ownedPageKpis group deliberately leaves it alone.
  const { isCardVisible } = useCardVisibility();
  const tenantExport = useTenantExport(
    { search: debouncedSearch, archiveMode, lifecycle },
    permissions.can(PERMISSIONS.TENANTS_EXPORT),
  );
  const company = useCompany();
  const remove = useDeleteTenant();
  const setBlocked = useSetTenantBlocked();
  // مستأجرون لديهم وثيقة واحدة على الأقل — يُغذّي الحلقة الحمراء على أيقونة الوثائق.
  const documentTenantIds = useTenantIdsWithDocuments(permissions.can(PERMISSIONS.TENANTS_READ));
  // مستأجرون لديهم حساب بوابة فعلي — يفصل "البوابة مفعّلة" عن "يستطيع الدخول".
  // `profiles` is behind `users.read`, so a viewer without it gets no set and
  // the column keeps its plain yes/no rather than claiming nobody has an account.
  const canReadAccounts = permissions.can(PERMISSIONS.USERS_READ);
  const portalAccountTenantIds = useTenantIdsWithPortalAccount(canReadAccounts);
  const properties = useProperties({ page: 1, pageSize: 500 });
  const categoryOptions = useListDrivenOptions(
    "tenant_categories",
    tenantCategories,
    "tenantCategory",
  );
  // Filtered before sorted, so the two compose: sorting a filtered list is the
  // same list in another order, while filtering a sorted one would have to
  // re-sort. `tenants.data` is the memo dependency rather than `.items`, which
  // is a fresh array on every render of the same query result.
  const filteredTenants = useMemo(
    () => filterTenants(tenants.data?.items ?? [], filters),
    [tenants.data, filters],
  );
  const {
    sort,
    toggle,
    sorted: sortedTenants,
  } = useTableSort(filteredTenants, (tenant, key) => {
    switch (key) {
      case "property":
        return tenant.connectedProperty?.name_ar ?? null;
      case "unit":
        return tenant.connectingUnit?.name ?? null;
      case "activeContractStartDate":
        return tenant.activeContractStartDate;
      case "activeContractEndDate":
        return tenant.activeContractEndDate;
      default:
        return (tenant as unknown as Record<string, unknown>)[key];
    }
  });

  /**
   * يغلّف أي تضييق للقائمة بمسح التحديد، حتى لا يبقى صف مخفيّ محدَّداً.
   *
   * Selection survives a re-render, the list does not: a tenant selected and
   * then filtered out of view would still be in `selected`, and the bulk delete
   * bar would delete a row nobody can see. Clearing on every narrowing keeps
   * "selected" meaning "selected among what is on screen".
   */
  function narrowList<T>(apply: (next: T) => void): (next: T) => void {
    return (next) => {
      setSelected([]);
      apply(next);
    };
  }

  /** يبدّل تبويب القائمة عبر معامل البحث حتى يبقى الرابط قابلاً للمشاركة. */
  function setListView(next: TenantListView) {
    // Same reason as `narrowList`: switching tabs replaces the whole list, so a
    // selection made on the other tab points at rows that are no longer here.
    setSelected([]);
    void navigate({ search: (prev) => ({ ...prev, view: next }) });
  }

  // `blocked` is the one lifecycle value an admin still sets by hand — every
  // other value is derived from the tenant's contracts (migration 54). It left
  // the create/edit form in Gate 0 because a manual field fighting a trigger is
  // exactly what T8 removes, so it lives here as a row action instead.
  /**
   * يحظر المستأجر أو يرفع الحظر — القيمة الوحيدة التي ما زال المشرف يكتبها يدوياً.
   */
  function toggleBlocked(tenant: TenantWithActiveLocation) {
    setBlocked.mutate(
      { id: tenant.id, blocked: tenant.lifecycle !== "blocked" },
      {
        onSuccess: ({ lifecycle }) =>
          toast.success(t(`tenantLifecycle.${lifecycle as TenantLifecycle}`)),
        onError: (error) => toast.error(error instanceof Error ? error.message : t("common.error")),
      },
    );
  }

  /**
   * يحذف المستأجر المحدد بعد تأكيد الحوار.
   */
  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      toast.success(t("phase2.deleted"));
      setDeleteTarget(null);
    } catch (error) {
      showError(t("phase2.deleteError"), error);
    }
  }

  /**
   * يفتح صفحة تفاصيل المستأجر.
   */
  function openTenant(tenant: { id: string }) {
    navigate({ to: "/admin/tenants/$id", params: { id: tenant.id } });
  }

  /**
   * يفتح التفاصيل من لوحة المفاتيح على صف قابل للنقر.
   */
  function openTenantOnKeyDown(event: KeyboardEvent, tenant: { id: string }) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTenant(tenant);
    }
  }

  /**
   * يصدّر المستأجرين كملف CSV — صف لكل عقد، مع رؤوس عربية عند اللغة العربية.
   *
   * Row-building lives in `tenantCsvRows` so multi-contract tenants no longer
   * collapse every contract into one semicolon-joined cell. Locale is the third
   * argument — omitting it left Arabic headers forever stuck on English.
   */
  function exportTenants() {
    // The export pages until the data runs out; the ceiling only stops a
    // runaway loop. Say so rather than handing over a silently short CSV.
    if (tenantExport.data?.truncated) {
      toast.warning(t("common.exportTruncated").replace("{ceiling}", String(EXPORT_ROW_CEILING)));
    }
    exportRecordsToCsv(tenantCsvRows(tenantExport.data?.items ?? []), "tenants.csv", locale);
  }

  const listTruncated =
    (tenants.data?.count ?? 0) > (tenants.data?.items.length ?? 0)
      ? t("common.listTruncated")
          .replace("{shown}", String(tenants.data?.items.length ?? 0))
          .replace("{total}", String(tenants.data?.count ?? 0))
      : null;

  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!permissions.can(PERMISSIONS.TENANTS_READ))
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader
        title={t("tenants.title")}
        subtitle={t("tenants.subtitle")}
        actions={
          <>
            <Button variant="outline" onClick={() => downloadImportTemplate("tenants", locale)}>
              <Download className="size-4" />
              {t("import.downloadTemplate")}
            </Button>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.TENANTS_CREATE)}
              onClick={() => setImportOpen(true)}
            >
              <Upload className="size-4" />
              {t("common.import")}
            </Button>
            <Button
              variant="outline"
              disabled={!tenantExport.data?.items.length}
              onClick={exportTenants}
            >
              <Download className="size-4" />
              {t("export.csv")}
            </Button>
            <Button
              disabled={!permissions.can(PERMISSIONS.TENANTS_CREATE)}
              onClick={() => {
                setEditing(null);
                setDialog(true);
              }}
            >
              <Plus className="size-4" />
              {t("tenants.add")}
            </Button>
          </>
        }
      />
      <SummaryCards loading={summary.isLoading} error={summary.error}>
        {isCardVisible("tenants.total") && (
          <VibrantKpiCard
            label={t("summary.tenants.total")}
            value={(summary.data?.total ?? 0).toLocaleString("en-US")}
            icon={<Users className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-slate-500 via-slate-600 to-gray-700 shadow-slate-500/25"
          />
        )}
        {isCardVisible("tenants.active") && (
          <VibrantKpiCard
            label={t("summary.tenants.active")}
            value={(summary.data?.active ?? 0).toLocaleString("en-US")}
            icon={<UserCheck className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-green-600 shadow-emerald-500/25"
          />
        )}
        {isCardVisible("tenants.arrears") && (
          <VibrantKpiCard
            label={t("summary.tenants.arrears")}
            value={<LtrText>{formatKwd(summary.data?.arrears.amount ?? 0, locale)}</LtrText>}
            hint={`${summary.data?.arrears.tenants ?? 0} ${t("summary.tenants.arrearsHint")}`}
            icon={<AlertTriangle className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-rose-500 via-rose-600 to-red-600 shadow-rose-500/25"
          />
        )}
        {isCardVisible("tenants.blocked") && (
          <VibrantKpiCard
            label={t("summary.tenants.blocked")}
            value={(summary.data?.blockedInactive ?? 0).toLocaleString("en-US")}
            icon={<UserX className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 shadow-amber-500/25"
          />
        )}
      </SummaryCards>
      <Tabs
        value={view}
        onValueChange={(value) => setListView(value as TenantListView)}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="active">{t("tenants.view.active")}</TabsTrigger>
          <TabsTrigger value="ended">{t("tenants.view.ended")}</TabsTrigger>
          <TabsTrigger value="archived">
            {t("archive.view.archived")}
            {summary.data
              ? ` ${t("archive.tabCount").replace("{count}", String(summary.data.archivedCount))}`
              : ""}
          </TabsTrigger>
          <TabsTrigger value="all">{t("archive.view.all")}</TabsTrigger>
        </TabsList>
      </Tabs>
      <TenantFiltersBar
        search={search}
        onSearchChange={narrowList(setSearch)}
        value={filters}
        onChange={narrowList(setFilters)}
        properties={properties.data?.items ?? []}
        categoryOptions={categoryOptions}
      />
      {permissions.can(PERMISSIONS.TENANTS_DELETE) && (
        <BulkDeleteBar
          selected={selected}
          clear={() => setSelected([])}
          deleteOne={(id) => remove.mutateAsync(id).then(() => undefined)}
          entityLabel={t("tenants.title")}
        />
      )}
      {!isMobile && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {layoutMode === "cards" && (
            <div className="flex items-center gap-2">
              <Label htmlFor="tenants-cards-per-line" className="text-sm text-muted-foreground">
                {t("tenants.cardsPerLine")}
              </Label>
              <Select
                value={String(cardsPerLine)}
                onValueChange={(v) => setCardsPerLine(Number(v))}
              >
                <SelectTrigger
                  id="tenants-cards-per-line"
                  className="w-20"
                  aria-label={t("tenants.cardsPerLine")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[2, 3, 4, 5, 6].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="inline-flex overflow-hidden rounded-lg border">
            <Button
              type="button"
              size="sm"
              variant={layoutMode === "cards" ? "default" : "ghost"}
              className="rounded-none"
              onClick={() => setLayoutMode("cards")}
            >
              <LayoutGrid className="size-4" />
              {t("tenants.cardView")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={layoutMode === "table" ? "default" : "ghost"}
              className="rounded-none"
              onClick={() => setLayoutMode("table")}
            >
              <TableIcon className="size-4" />
              {t("tenants.tableView")}
            </Button>
          </div>
        </div>
      )}
      {listTruncated && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          {listTruncated}
        </p>
      )}
      <TenantsTable
        items={filteredTenants}
        sortedItems={sortedTenants}
        loading={tenants.isLoading}
        error={Boolean(tenants.error)}
        layoutMode={layoutMode}
        cardsPerLine={cardsPerLine}
        isMobile={isMobile}
        selected={selected}
        onSelectedChange={setSelected}
        sort={sort}
        toggle={toggle}
        onOpen={openTenant}
        onOpenKeyDown={openTenantOnKeyDown}
        onEdit={(tenant) => {
          setEditing(tenant);
          setDialog(true);
        }}
        onDocuments={setDetailTenant}
        onToggleBlocked={toggleBlocked}
        onDelete={setDeleteTarget}
        canUpdate={permissions.can(PERMISSIONS.TENANTS_UPDATE)}
        canDelete={permissions.can(PERMISSIONS.TENANTS_DELETE)}
        blockPending={setBlocked.isPending}
        documentTenantIds={documentTenantIds.data ?? EMPTY_TENANT_IDS}
        portalAccountTenantIds={portalAccountTenantIds.data ?? EMPTY_TENANT_IDS}
        // `isSuccess`, not `!isPending`. Review finding on PR #208: on a
        // transient PostgREST, network or RLS error React Query clears
        // `isPending` and leaves `data` undefined, so the table would receive an
        // empty account set and label every portal-enabled tenant "No account"
        // without having read a single account. A destructive badge is shown
        // only on a query that actually succeeded.
        portalAccountsUnknown={!canReadAccounts || !portalAccountTenantIds.isSuccess}
      />
      <TenantFormDialog open={dialog} onOpenChange={setDialog} editing={editing} />
      <TenantDetails
        tenant={detailTenant}
        companyId={company.data?.id ?? null}
        close={() => setDetailTenant(null)}
      />
      <CsvImportDialog entity="tenants" open={importOpen} onOpenChange={setImportOpen} />
      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={remove.isPending}
        title={t("phase2.deleteTitle")}
        description={t("tenants.deleteDescription")}
        close={() => setDeleteTarget(null)}
        confirm={confirmDelete}
      />
    </div>
  );
}
