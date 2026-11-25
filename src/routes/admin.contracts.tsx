import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Banknote,
  CalendarClock,
  Download,
  FileCheck,
  FileText,
  FileX,
  Plus,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { ConcessionsDialog } from "@/components/admin/contracts/ConcessionsDialog";
import { ContractFiltersBar } from "@/components/admin/contracts/ContractFiltersBar";
import { ContractFormDialog } from "@/components/admin/contracts/ContractFormDialog";
import { ContractRestoreDialog } from "@/components/admin/contracts/ContractRestoreDialog";
import { ContractsTable } from "@/components/admin/contracts/ContractsTable";
import { CsvImportDialog } from "@/components/admin/CsvImportDialog";
import { DeleteConfirmation, ModuleHeader } from "@/components/admin/Phase2Ui";
import { TenantOptionLabel } from "@/components/admin/TenantOptionLabel";
import { useTableSort } from "@/components/admin/SortableTable";
import { SummaryCards } from "@/components/admin/SummaryCards";
import { VibrantKpiCard } from "@/components/shared/dashboardCards";
import { Button } from "@/components/ui/button";
import { LtrText } from "@/components/ui/ltr-text";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ArchiveMode } from "@/hooks/archiveMode";
import { useCardVisibility } from "@/hooks/useCardVisibility";
import { useRestoreContract } from "@/hooks/useContractCloseouts";
import {
  primaryProperty,
  primaryUnit,
  useContractExport,
  useContracts,
  useDeleteContract,
  type Contract,
  type ContractWithRelations,
} from "@/hooks/useContracts";
import { useContractsSummary } from "@/hooks/useContractsSummary";
import { useDebounce } from "@/hooks/useDebounce";
import { useListDrivenOptions } from "@/hooks/useOptionLists";
import { usePermissions } from "@/hooks/usePermissions";
import { useProperties } from "@/hooks/useProperties";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import type { ContractState } from "@/integrations/supabase/database.types";
import { downloadImportTemplate } from "@/lib/bulkImportTemplates";
import { contractCsvRows } from "@/lib/contractCsv";
import { contractStates } from "@/lib/contractForm";
import { DEFAULT_RESTORE_TARGET_STATE } from "@/lib/contractLifecycle";
import {
  contractTenantOptions,
  emptyContractTableFilters,
  filterContracts,
} from "@/lib/contractTableFilters";
import { exportRecordsToCsv } from "@/lib/csv";
import { EXPORT_ROW_CEILING } from "@/lib/pagedQuery";
import { fetchInChunks } from "@/lib/idChunks";
import { formatKwd } from "@/lib/money";
import { PERMISSIONS } from "@/lib/permissions";
import { propertyDisplayName } from "@/lib/propertyDisplayName";
import { isContractEnded, tenantDisplayName } from "@/lib/tenantDisplayName";
import { showError } from "@/lib/toastError";

const archiveViewSchema = z.enum(["current", "archived", "all"]).catch("current");

/**
 * سقف الجلب بعد إزالة ترقيم الصفحات — كل العقود على شاشة واحدة.
 *
 * The list is fetched whole so the browser-side filters below see every
 * contract rather than one page of ten; `listTruncated` says so out loud if a
 * portfolio ever grows past this.
 */
const LIST_LIMIT = 1000;

export const Route = createFileRoute("/admin/contracts")({
  component: ContractsPage,
  // `view` is optional on the type so existing <Link to="/admin/contracts"> keep
  // compiling; .catch("current") still supplies the runtime default.
  // `q` seeds the search box so other pages (the WhatsApp contact chips) can
  // deep-link to one contract by its code.
  validateSearch: (search: Record<string, unknown>): { view?: ArchiveMode; q?: string } => ({
    view: archiveViewSchema.parse(search.view),
    ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
  }),
});

function ContractsPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const { isCardVisible } = useCardVisibility();
  const navigate = useNavigate({ from: Route.fullPath });
  const archiveMode: ArchiveMode = Route.useSearch().view ?? "current";
  const [search, setSearch] = useState(Route.useSearch().q ?? "");
  // البحث المُمهَل هو وحده الذي يغذّي مفاتيح الاستعلامات والتصدير — ضغطة واحدة
  // لكل توقف عن الكتابة بدل استعلام لكل حرف.
  //
  // The raw `search` stays live in the input so typing feels instant; only
  // the queries and the export wait for it to settle.
  const debouncedSearch = useDebounce(search);
  const [stateFilter, setStateFilter] = useState("all");
  const [filters, setFilters] = useState(emptyContractTableFilters);
  const [dialog, setDialog] = useState(false);
  const [editing, setEditing] = useState<ContractWithRelations | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Contract | null>(null);
  const [concessionContract, setConcessionContract] = useState<Contract | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ContractWithRelations | null>(null);
  const [restoreReason, setRestoreReason] = useState("");
  const [restoreState, setRestoreState] = useState<ContractState>(DEFAULT_RESTORE_TARGET_STATE);
  const restore = useRestoreContract();
  // Pagination removed by request — every contract is listed on one screen.
  const contracts = useContracts(
    {
      page: 1,
      pageSize: LIST_LIMIT,
      search: debouncedSearch,
      state: stateFilter === "all" ? undefined : (stateFilter as ContractState),
      archiveMode,
    },
    permissions.can(PERMISSIONS.CONTRACTS_READ),
  );
  // بطاقات المؤشرات ثابتة عبر التبويبات: تُستدعى دائماً بـ archiveMode "all"
  // حتى لا يتغير مفتاح استعلامها ولا قيمها عند التنقل بين «الحالية»
  // و«المؤرشفة» و«الكل». عدّادا التبويبين (archived_count/current_count)
  // يحسبهما الـ RPC مستقلَين عن الوضع أصلاً (ترحيل 91).
  const summary = useContractsSummary(
    { search: debouncedSearch, state: stateFilter, archiveMode: "all" },
    permissions.can(PERMISSIONS.CONTRACTS_READ),
  );
  const listedIds = (contracts.data?.items ?? []).map((c) => c.id);
  const balancesQuery = useQuery({
    queryKey: ["contracts", "outstanding-balances", listedIds],
    enabled: listedIds.length > 0 && archiveMode !== "current",
    queryFn: async () => {
      // Chunked: without pagination this list can hold every contract, and the
      // ids travel in the query string — see `fetchInChunks`.
      const rows = await fetchInChunks(listedIds, (chunk) =>
        supabase
          .from("invoices")
          .select("contract_id, balance")
          .in("contract_id", chunk)
          .gt("balance", 0),
      );
      const map = new Map<string, number>();
      for (const row of rows) {
        map.set(row.contract_id, (map.get(row.contract_id) ?? 0) + Number(row.balance));
      }
      return map;
    },
  });
  const contractExport = useContractExport(
    { search: debouncedSearch, archiveMode },
    permissions.can(PERMISSIONS.CONTRACTS_EXPORT),
  );
  const properties = useProperties({ page: 1, pageSize: 500 });
  // Built from the loaded contracts, not from `filteredContracts`: a dropdown
  // whose options vanish as you use it can never be un-narrowed.
  const tenantOptions = useMemo(() => {
    const endedByTenantId = new Map<string, boolean>();
    for (const contract of contracts.data?.items ?? []) {
      if (contract.tenant && !endedByTenantId.has(contract.tenant_id)) {
        endedByTenantId.set(contract.tenant_id, isContractEnded(contract.tenant));
      }
    }
    return contractTenantOptions(contracts.data?.items ?? [], (contract) =>
      contract.tenant ? tenantDisplayName(contract.tenant, locale) : null,
    ).map((option, index) => ({
      value: option.value,
      label: (
        <TenantOptionLabel index={index} ended={endedByTenantId.get(option.value) ?? false}>
          {option.label}
        </TenantOptionLabel>
      ),
    }));
  }, [contracts.data, locale]);
  // Filtered before sorted, so the two compose. `contracts.data` is the memo
  // dependency rather than `.items`, which is a fresh array on every render of
  // the same query result.
  const filteredContracts = useMemo(
    () => filterContracts(contracts.data?.items ?? [], filters),
    [contracts.data, filters],
  );
  const {
    sort,
    toggle,
    sorted: sortedContracts,
  } = useTableSort(filteredContracts, (contract, key) => {
    switch (key) {
      case "tenant":
        return contract.tenant ? tenantDisplayName(contract.tenant, locale) : null;
      case "unit":
        return primaryUnit(contract)?.name ?? null;
      case "property": {
        const property = primaryProperty(contract);
        return property ? propertyDisplayName(property, locale) : null;
      }
      case "freeMonths":
        return contract.freeMonths > 0 ? contract.freeMonths : null;
      case "percentDiscount":
        return contract.percentDiscount?.months ?? null;
      case "fixedDiscount":
        return contract.fixedDiscount?.months ?? null;
      default:
        return (contract as unknown as Record<string, unknown>)[key];
    }
  });
  const remove = useDeleteContract();
  const contractStateOptions = useListDrivenOptions(
    "contract_states",
    contractStates,
    "contractState",
  );

  /**
   * يبدّل تبويب الأرشيف عبر معامل البحث حتى يبقى الرابط قابلاً للمشاركة.
   */
  function setArchiveView(next: ArchiveMode) {
    void navigate({ search: (prev) => ({ ...prev, view: next }) });
  }

  /**
   * يستعيد عقداً مؤرشفاً دون إعادة تفعيل الفوترة، إلى الحالة التي اختارها المستخدم.
   *
   * The target state used to be `restoreTarget.state` — the contract's own —
   * which since migration 211 meant restoring a `terminated` contract left it
   * in the Archived tab while the toast reported success.
   */
  async function confirmRestore() {
    if (!restoreTarget || !restoreReason.trim()) return;
    try {
      const restoreResult = await restore.mutateAsync({
        contractId: restoreTarget.id,
        targetState: restoreState,
        restoreTenant: false,
        reason: restoreReason.trim(),
      });
      toast.success(t("archive.restoreSuccess"));
      if (restoreResult?.notificationWarning) {
        toast.warning(t("archive.notifyWarning"));
      }
      closeRestoreDialog();
    } catch (error) {
      showError(t("archive.restoreError"), error);
    }
  }

  /** يغلق حوار الإعادة ويعيد حقوله إلى قيمها الافتراضية. */
  function closeRestoreDialog() {
    setRestoreTarget(null);
    setRestoreReason("");
    setRestoreState(DEFAULT_RESTORE_TARGET_STATE);
  }

  /**
   * يحذف العقد المحدد بعد تأكيد الحوار.
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
   * يصدّر العقود كملف CSV — صف لكل وحدة، مع رؤوس عربية عند اللغة العربية.
   *
   * Row-building lives in `contractCsvRows` so multi-unit contracts export
   * every unit (the old primaryUnit path dropped the rest). Locale is the
   * third argument — omitting it left Arabic headers forever stuck on English.
   */
  function exportContracts() {
    // The export pages until the data runs out; the ceiling only stops a
    // runaway loop. Say so rather than handing over a silently short CSV.
    if (contractExport.data?.truncated) {
      toast.warning(t("common.exportTruncated").replace("{ceiling}", String(EXPORT_ROW_CEILING)));
    }
    exportRecordsToCsv(contractCsvRows(contractExport.data?.items ?? []), "contracts.csv", locale);
  }

  const listTruncated =
    (contracts.data?.count ?? 0) > (contracts.data?.items.length ?? 0)
      ? t("common.listTruncated")
          .replace("{shown}", String(contracts.data?.items.length ?? 0))
          .replace("{total}", String(contracts.data?.count ?? 0))
      : null;

  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!permissions.can(PERMISSIONS.CONTRACTS_READ))
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader
        title={t("contracts.title")}
        subtitle={t("contracts.subtitle")}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/admin/contracts/builder">{t("contractBuilder.open")}</Link>
            </Button>
            <Button variant="outline" onClick={() => downloadImportTemplate("contracts", locale)}>
              <Download className="size-4" />
              {t("import.downloadTemplate")}
            </Button>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.CONTRACTS_CREATE)}
              onClick={() => setImportOpen(true)}
            >
              <Upload className="size-4" />
              {t("common.import")}
            </Button>
            <Button
              variant="outline"
              disabled={!contractExport.data?.items.length || search !== debouncedSearch}
              onClick={exportContracts}
            >
              <Download className="size-4" />
              {t("export.csv")}
            </Button>
            <Button
              disabled={!permissions.can(PERMISSIONS.CONTRACTS_CREATE)}
              onClick={() => {
                setEditing(null);
                setDialog(true);
              }}
            >
              <Plus className="size-4" />
              {t("contracts.add")}
            </Button>
          </>
        }
      />
      <SummaryCards loading={summary.isLoading} error={summary.error}>
        {isCardVisible("contracts.total") ? (
          <VibrantKpiCard
            label={t("summary.contracts.total")}
            value={(summary.data?.total ?? 0).toLocaleString("en-US")}
            icon={<FileText className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-slate-500 via-slate-600 to-gray-700 shadow-slate-500/25"
          />
        ) : null}
        {isCardVisible("contracts.active") ? (
          <VibrantKpiCard
            label={t("summary.contracts.active")}
            value={(summary.data?.active ?? 0).toLocaleString("en-US")}
            icon={<FileCheck className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-green-600 shadow-emerald-500/25"
            progressBar={{
              current: summary.data?.active ?? 0,
              total: summary.data?.total ?? 0,
            }}
          />
        ) : null}
        {isCardVisible("contracts.expiring60") ? (
          <VibrantKpiCard
            label={t("summary.contracts.expiring60")}
            value={(summary.data?.expiring60d ?? 0).toLocaleString("en-US")}
            hint={summary.data?.nextExpiry ?? ""}
            icon={<CalendarClock className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 shadow-amber-500/25"
          />
        ) : null}
        {isCardVisible("contracts.ended") ? (
          <VibrantKpiCard
            label={t("summary.contracts.ended")}
            value={(summary.data?.ended ?? 0).toLocaleString("en-US")}
            icon={<FileX className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-rose-500 via-rose-600 to-red-600 shadow-rose-500/25"
          />
        ) : null}
        {isCardVisible("contracts.annualValue") ? (
          <VibrantKpiCard
            label={t("summary.contracts.annualValue")}
            value={<LtrText>{formatKwd(summary.data?.annualAmount ?? 0, locale)}</LtrText>}
            hint={`${formatKwd(summary.data?.monthlyAmount ?? 0, locale)} ${t("summary.contracts.monthlyHint")}`}
            icon={<Banknote className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-violet-500 via-violet-600 to-purple-600 shadow-violet-500/25"
          />
        ) : null}
      </SummaryCards>
      <Tabs
        value={archiveMode}
        onValueChange={(value) => setArchiveView(value as ArchiveMode)}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="current">{t("archive.view.current")}</TabsTrigger>
          <TabsTrigger value="archived">
            {t("archive.view.archived")}
            {summary.data
              ? ` ${t("archive.tabCount").replace("{count}", String(summary.data.archivedCount))}`
              : ""}
          </TabsTrigger>
          <TabsTrigger value="all">{t("archive.view.all")}</TabsTrigger>
        </TabsList>
      </Tabs>
      <ContractFiltersBar
        search={search}
        onSearchChange={setSearch}
        value={filters}
        onChange={setFilters}
        stateFilter={stateFilter}
        onStateFilterChange={setStateFilter}
        properties={properties.data?.items ?? []}
        stateOptions={contractStateOptions}
        tenantOptions={tenantOptions}
      />
      {listTruncated && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          {listTruncated}
        </p>
      )}
      <ContractsTable
        items={filteredContracts}
        sortedItems={sortedContracts}
        loading={contracts.isLoading}
        error={Boolean(contracts.error)}
        archiveMode={archiveMode}
        outstandingBalances={balancesQuery.data}
        sort={sort}
        toggle={toggle}
        canUpdate={permissions.can(PERMISSIONS.CONTRACTS_UPDATE)}
        canDelete={permissions.can(PERMISSIONS.CONTRACTS_DELETE)}
        canCloseOut={permissions.can(PERMISSIONS.CONTRACTS_CLOSE_OUT)}
        canRestore={permissions.can(PERMISSIONS.CONTRACTS_RESTORE)}
        onEdit={(contract) => {
          setEditing(contract);
          setDialog(true);
        }}
        onConcessions={setConcessionContract}
        onRestore={(contract) => {
          setRestoreTarget(contract);
          setRestoreReason("");
        }}
        onDelete={setDeleteTarget}
      />
      <ContractFormDialog open={dialog} onOpenChange={setDialog} editing={editing} />
      <ConcessionsDialog contract={concessionContract} close={() => setConcessionContract(null)} />
      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={remove.isPending}
        title={t("phase2.deleteTitle")}
        description={t("contracts.deleteDescription")}
        close={() => setDeleteTarget(null)}
        confirm={confirmDelete}
      />
      <CsvImportDialog entity="contracts" open={importOpen} onOpenChange={setImportOpen} />
      <ContractRestoreDialog
        contractEndDate={restoreTarget?.end_date ?? null}
        open={Boolean(restoreTarget)}
        pending={restore.isPending}
        reason={restoreReason}
        targetState={restoreState}
        onOpenChange={(open) => {
          if (!open) closeRestoreDialog();
        }}
        onReasonChange={setRestoreReason}
        onTargetStateChange={setRestoreState}
        onConfirm={() => void confirmRestore()}
      />
    </div>
  );
}
