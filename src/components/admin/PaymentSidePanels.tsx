import { useMemo, useState } from "react";
import { FilePlus2 } from "lucide-react";
import { toast } from "sonner";

import { RecordPanelDialog } from "@/components/admin/RecordPanelDialog";
import {
  RecordPanelTable,
  type RecordPanelContractEntry,
} from "@/components/admin/RecordPanelTable";
import { TableState } from "@/components/admin/Phase2Ui";
import { useTableSort } from "@/components/admin/SortableTable";
import { Button } from "@/components/ui/button";
import { useBuildings } from "@/hooks/useBuildings";
import { contractPickerLabel } from "@/hooks/useContractPickerOptions";
import { primaryProperty, primaryUnit, useContracts } from "@/hooks/useContracts";
import { useIsMobile } from "@/hooks/use-mobile";
import { useInsuranceDepositSync } from "@/hooks/useInsuranceDepositSync";
import { useSettleableInvoices } from "@/hooks/useInvoices";
import { usePermissions } from "@/hooks/usePermissions";
import {
  useCreateMoneyRecord,
  useDeleteMoneyRecord,
  useInsuredContractIds,
  useMoneyRecords,
  useUpdateMoneyRecord,
  type MoneyRecord,
  type MoneyRecordScope,
  type MoneyRecordTable,
} from "@/hooks/useRefunds";
import { useEditPartialPayment } from "@/hooks/useEditPartialPayment";
import { usePartialPaymentEditContext } from "@/hooks/usePartialPaymentEditContext";
import { notifyRefundRecorded } from "@/fns/notifyRefundRecorded";
import { useI18n } from "@/i18n/provider";
import type { PartialPaymentStatus } from "@/integrations/supabase/database.types";
import { moneyRecordSortValue } from "@/lib/adminTableSortValues";
import { contractsWithoutRecord } from "@/lib/contractsWithoutRecord";
import { insuranceErrorKey } from "@/lib/insuranceErrors";
import { formatAmount } from "@/lib/money";
import { partialPaymentErrorKey } from "@/lib/partialPaymentErrors";
import { remainingForEdit } from "@/lib/partialPaymentRemaining";
import { PERMISSIONS, type PermissionCode } from "@/lib/permissions";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

/** The fields the three record types share, as the form collects them. */
interface RecordFormValues {
  tenant_id: string;
  contract_id: string;
  unit_id: string | null;
  building_id: string | null;
  amount: number;
  date: string;
  note: string | null;
  invoice_id: string | null;
  status: PartialPaymentStatus;
}

/** One contract, resolved down to the labels these panels display. */
interface ContractEntry extends RecordPanelContractEntry {
  value: string;
  deposit: number;
  buildingId: string | null;
  label: string;
}

/**
 * خيارات العقود للوحات السجلات، مع بحث بالأرشيف عند الحاجة لتبويب مستأجر مؤرشف.
 */
function useContractDirectory(includeArchived: boolean) {
  const { locale } = useI18n();
  const permissions = usePermissions();
  const canReadContracts = permissions.can(PERMISSIONS.CONTRACTS_READ);
  const contracts = useContracts(
    { pageSize: 500, archiveMode: includeArchived ? "all" : "current" },
    canReadContracts,
  );
  const buildings = useBuildings(
    { pageSize: 500 },
    canReadContracts && permissions.can(PERMISSIONS.BUILDINGS_READ),
  );
  return useMemo(() => {
    const buildingById = new Map((buildings.data?.items ?? []).map((row) => [row.id, row]));
    const localized = (row: { name_ar: string; name_en: string | null }) =>
      locale === "ar" ? row.name_ar : (row.name_en ?? row.name_ar);
    const entries: ContractEntry[] = (contracts.data?.items ?? []).map((contract) => {
      const unit = primaryUnit(contract);
      const property = primaryProperty(contract);
      const buildingId = unit?.building_id ?? null;
      const building = buildingId ? buildingById.get(buildingId) : undefined;
      const tenantName = contract.tenant ? tenantDisplayName(contract.tenant, locale) : null;
      const place = [property, building].filter(Boolean).map((row) => localized(row!));
      return {
        value: contract.id,
        tenantId: contract.tenant_id,
        unitId: unit?.id ?? null,
        buildingId,
        deposit: contract.deposit,
        code: contract.code,
        tenantName,
        unitName: unit ? `${unit.code} — ${unit.name}` : null,
        complexName: place.length ? place.join(" — ") : null,
        propertyId: property?.id ?? unit?.property_id ?? null,
        label: contractPickerLabel(contract.code, tenantName),
      };
    });
    return { entries, byId: new Map(entries.map((entry) => [entry.value, entry])) };
  }, [buildings.data?.items, contracts.data?.items, locale]);
}

/**
 * سطح مشترك للقوائم والإنشاء والتعديل والحذف للاسترداد والدفعات الجزئية والتأمين.
 */
function RecordPanel({
  table,
  dateColumn,
  readPermission,
  createPermission,
  updatePermission,
  deletePermission,
  title,
  description,
  extraFields,
  buildInsert,
  onCreated,
  resetExtras,
  showContractColumns = false,
  invoiceField = false,
  statusField = false,
  showRowNumber = false,
  onePerContract = false,
  scope,
}: {
  table: MoneyRecordTable;
  dateColumn: string;
  readPermission: PermissionCode;
  createPermission: PermissionCode;
  updatePermission?: PermissionCode;
  deletePermission: PermissionCode;
  title: string;
  description: string;
  extraFields?: React.ReactNode;
  buildInsert: (base: RecordFormValues) => Record<string, unknown>;
  onCreated?: (base: RecordFormValues, record: MoneyRecord) => Promise<void>;
  resetExtras?: () => void;
  showContractColumns?: boolean;
  invoiceField?: boolean;
  statusField?: boolean;
  showRowNumber?: boolean;
  /** Hide contracts that already carry a record from the picker (insurance). */
  onePerContract?: boolean;
  scope?: MoneyRecordScope;
}) {
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const permissions = usePermissions();
  const canRead = permissions.can(readPermission);
  const canUpdate = Boolean(updatePermission && permissions.can(updatePermission));
  const records = useMoneyRecords(table, canRead, scope);
  const create = useCreateMoneyRecord(table, createPermission);
  const update = useUpdateMoneyRecord(table, updatePermission ?? createPermission);
  const editPartial = useEditPartialPayment();
  const remove = useDeleteMoneyRecord(table, deletePermission);
  const contracts = useContractDirectory(Boolean(scope));
  const insuredContracts = useInsuredContractIds(onePerContract && canRead);

  const [open, setOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<MoneyRecord | null>(null);
  const [contractId, setContractId] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [status, setStatus] = useState<PartialPaymentStatus>("incomplete");

  const selected = contracts.byId.get(contractId);
  const settleable = useSettleableInvoices(invoiceField ? contractId || null : null);
  const depositSync = useInsuranceDepositSync();
  const editContext = usePartialPaymentEditContext(
    table === "partial_payments" && editingRow ? editingRow.id : null,
    open && table === "partial_payments" && Boolean(editingRow),
  );
  const tenantScope = scope && "tenantId" in scope ? scope.tenantId : null;
  const contractScope = scope && "contractId" in scope ? scope.contractId : null;
  const scopedContracts = tenantScope
    ? contracts.entries.filter((entry) => entry.tenantId === tenantScope)
    : contractScope
      ? contracts.entries.filter((entry) => entry.value === contractScope)
      : contracts.entries;
  // Unfiltered until the full set arrives: an unfinished or failed read must
  // not empty the picker, and the unique constraint still refuses a duplicate.
  // `onePerContract` is checked again because a disabled query still returns
  // the insurance tab's cached set to the refund and partial-payment panels.
  const visibleContracts =
    onePerContract && insuredContracts.data
      ? contractsWithoutRecord(
          scopedContracts,
          insuredContracts.data,
          typeof editingRow?.contract_id === "string" ? editingRow.contract_id : null,
        )
      : scopedContracts;
  // Hidden whenever the scope resolves to no contract, not only for a
  // contract-less tenant. `useContractDirectory` pages at 500, so a
  // contract-scoped panel whose contract falls outside that window would
  // otherwise offer an Add button that cannot succeed — the dialog would open
  // with an empty contract list and the save would fail on "pick a contract"
  // for a contract that plainly exists.
  const hideCreate = Boolean(scope) && visibleContracts.length === 0;

  /**
   * يفرّغ النموذج ويعيد الحالة الاختيارية إلى قيمها الافتراضية.
   */
  function resetForm() {
    setEditingRow(null);
    setContractId(contractScope ?? "");
    setAmount("");
    setDate(new Date().toISOString().slice(0, 10));
    setNote("");
    setInvoiceId("");
    setStatus("incomplete");
    resetExtras?.();
  }

  function openCreate() {
    resetForm();
    setOpen(true);
  }

  function openEdit(row: MoneyRecord) {
    setEditingRow(row);
    setContractId(typeof row.contract_id === "string" ? row.contract_id : "");
    resetExtras?.();
    setAmount(String(row.amount ?? ""));
    setDate(String(row[dateColumn] ?? new Date().toISOString().slice(0, 10)));
    setNote(typeof row.note === "string" ? row.note : "");
    setInvoiceId(typeof row.invoice_id === "string" ? row.invoice_id : "");
    setStatus(row.status === "complete" ? "complete" : "incomplete");
    setOpen(true);
  }

  const rows = records.data ?? [];
  const contractFor = (row: (typeof rows)[number]) =>
    row.contract_id ? contracts.byId.get(row.contract_id) : undefined;
  const {
    sort,
    toggle,
    sorted: sortedRows,
  } = useTableSort(rows, (row, key) =>
    moneyRecordSortValue(row, key, { contract: contractFor(row), dateColumn }),
  );

  if (!canRead) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );
  }

  /**
   * يحفظ السجل ثم يكتب وديعة العقد من التأمين بعد نجاح الإنشاء أو التعديل.
   *
   * Reverse-sync is a follow-up, not a transaction: a failed contract write
   * must not undo the insurance row the admin already stored.
   */
  async function submit() {
    const link = selected
      ? {
          tenant_id: selected.tenantId,
          contract_id: selected.value,
          unit_id: selected.unitId ?? null,
          building_id: selected.buildingId,
        }
      : editingRow && contractId && contractId === editingRow.contract_id
        ? {
            tenant_id: editingRow.tenant_id,
            contract_id: contractId,
            unit_id: (editingRow.unit_id as string | null | undefined) ?? null,
            building_id: (editingRow.building_id as string | null | undefined) ?? null,
          }
        : null;
    if (!link) {
      toast.error(t("payments.pickContract"));
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error(t("payments.invalidAmount"));
      return;
    }
    // Told before the round trip. The real cap is migration 160's
    // `partial_payment_exceeds_balance`: two dialogs open at once both pass this
    // check, and only one of them may win.
    const remaining = invoiceId
      ? table === "partial_payments" && editingRow
        ? remainingForEdit(editContext.data, invoiceId, settleable.data ?? [])
        : ((settleable.data ?? []).find((invoice) => invoice.id === invoiceId)?.balance ?? null)
      : null;
    if (remaining !== null && value > remaining) {
      toast.error(`${t("partialPayments.exceedsBalance")} (${formatAmount(remaining, locale)})`);
      return;
    }
    const base: RecordFormValues = {
      ...link,
      amount: value,
      date,
      note: note.trim() || null,
      invoice_id: invoiceId || null,
      status,
    };
    const payload = buildInsert(base);

    let savedId: string;
    try {
      if (editingRow) {
        savedId = editingRow.id;
        if (table === "partial_payments") {
          // The whole form travels: the contract link and, for an unlinked row,
          // the manual status — dropping them here is how a saved edit lied.
          await editPartial.mutateAsync({
            id: editingRow.id,
            values: {
              ...link,
              amount: value,
              paid_date: date,
              invoice_id: invoiceId || null,
              note: note.trim() || null,
              status,
            },
          });
        } else {
          await update.mutateAsync({ id: editingRow.id, values: payload });
        }
      } else {
        const created = await create.mutateAsync(payload);
        savedId = created.id;
        await onCreated?.(base, created);
      }
    } catch (error) {
      // Migration 160's and 56's refusals arrive as raw Postgres identifiers;
      // anything else keeps the original message, more use than a generic one.
      const dbError = error as { message?: string; code?: string } | null;
      const key = partialPaymentErrorKey(dbError) ?? insuranceErrorKey(dbError);
      toast.error(key ? t(key) : error instanceof Error ? error.message : t("common.error"));
      return;
    }

    if (table === "insurance_payments" && base.contract_id) {
      await depositSync.sync(savedId);
    }

    toast.success(t("phase2.saved"));
    setOpen(false);
    resetForm();
  }

  const editInvoice = editContext.data?.invoice;
  const pinnedInvoice =
    table === "partial_payments" &&
    editingRow &&
    contractId === editingRow.contract_id &&
    editInvoice
      ? {
          ...editInvoice,
          total: (settleable.data ?? []).find((invoice) => invoice.id === editInvoice.id)?.total,
        }
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {permissions.can(createPermission) && !hideCreate && (
          <Button onClick={openCreate}>
            <FilePlus2 className="size-4" />
            {t("common.add")}
          </Button>
        )}
      </div>

      <TableState loading={records.isLoading} error={records.isError} empty={!rows.length}>
        <RecordPanelTable
          sortedRows={sortedRows}
          sort={sort}
          toggle={toggle}
          dateColumn={dateColumn}
          showContractColumns={showContractColumns}
          showInvoiceColumns={invoiceField}
          showRowNumber={showRowNumber}
          contractFor={contractFor}
          canUpdate={canUpdate}
          canDelete={permissions.can(deletePermission)}
          isMobile={isMobile}
          onEdit={openEdit}
          onDelete={(row) => remove.mutate(row.id)}
        />
      </TableState>

      <RecordPanelDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) resetForm();
        }}
        editing={Boolean(editingRow)}
        title={title}
        description={description}
        contractId={contractId}
        contractOptions={visibleContracts}
        lockContract={Boolean(contractScope)}
        onContractChange={(next) => {
          setContractId(next);
          setInvoiceId("");
        }}
        amount={amount}
        onAmountChange={setAmount}
        date={date}
        onDateChange={setDate}
        note={note}
        onNoteChange={setNote}
        extraFields={extraFields}
        invoiceField={invoiceField}
        invoiceId={invoiceId}
        invoices={settleable.data ?? []}
        onInvoiceChange={setInvoiceId}
        statusField={statusField}
        status={status}
        onStatusChange={setStatus}
        pending={create.isPending || update.isPending || editPartial.isPending}
        onSubmit={() => void submit()}
        remaining={
          table === "partial_payments" && editingRow
            ? remainingForEdit(editContext.data, invoiceId, settleable.data ?? [])
            : undefined
        }
        // `isFetching`, not `isLoading`: the second opening has cached context
        // and refetches in the background, and the cap must not be submittable
        // from the previous balance while that round trip is in flight.
        formLocked={
          table === "partial_payments" &&
          Boolean(editingRow) &&
          (editContext.isFetching || editContext.isError)
        }
        loadingHint={
          table === "partial_payments" && editingRow && editContext.isFetching
            ? t("partialPayments.loadingBalance")
            : undefined
        }
        loadError={
          table === "partial_payments" && editingRow && editContext.isError
            ? t("partialPayments.contextFailed")
            : null
        }
        onRetryLoad={
          table === "partial_payments" && editingRow ? () => void editContext.refetch() : undefined
        }
        // Only while the dropdown still shows the row's own contract: after a
        // contract change the pinned invoice would be a visible option the
        // link guard (151) can never accept.
        pinnedInvoice={pinnedInvoice}
      />
    </div>
  );
}

export function RefundsPanel() {
  const { t } = useI18n();

  return (
    <RecordPanel
      table="refunds"
      dateColumn="refund_date"
      readPermission={PERMISSIONS.REFUNDS_READ}
      createPermission={PERMISSIONS.REFUNDS_CREATE}
      deletePermission={PERMISSIONS.REFUNDS_DELETE}
      title={t("refunds.title")}
      description={t("refunds.subtitle")}
      showContractColumns
      buildInsert={(base) => ({
        tenant_id: base.tenant_id,
        contract_id: base.contract_id,
        unit_id: base.unit_id,
        amount: base.amount,
        refund_date: base.date,
        note: base.note,
        post_action: "store" as const,
      })}
      onCreated={async (_base, refund) => {
        try {
          await notifyRefundRecorded({ data: { refundId: refund.id } });
        } catch (notificationError) {
          console.error("notifyRefundRecorded failed:", notificationError);
        }
      }}
    />
  );
}

export function PartialPaymentsPanel({ scope }: { scope?: MoneyRecordScope } = {}) {
  const { t } = useI18n();
  return (
    <RecordPanel
      table="partial_payments"
      dateColumn="paid_date"
      readPermission={PERMISSIONS.PARTIAL_PAYMENTS_READ}
      createPermission={PERMISSIONS.PARTIAL_PAYMENTS_CREATE}
      updatePermission={PERMISSIONS.PARTIAL_PAYMENTS_UPDATE}
      deletePermission={PERMISSIONS.PARTIAL_PAYMENTS_DELETE}
      title={t("partialPayments.title")}
      description={t("partialPayments.subtitle")}
      showContractColumns
      invoiceField
      statusField
      showRowNumber
      scope={scope}
      buildInsert={(base) => ({
        tenant_id: base.tenant_id,
        contract_id: base.contract_id,
        unit_id: base.unit_id,
        building_id: base.building_id,
        amount: base.amount,
        paid_date: base.date,
        note: base.note,
        invoice_id: base.invoice_id,
        ...(base.invoice_id ? {} : { status: base.status }),
      })}
    />
  );
}

/**
 * لوحة مدفوعات التأمين؛ التعديل يفعّل مزامنة الوديعة إلى العقد بعد الحفظ.
 */
export function InsurancePanel() {
  const { t } = useI18n();
  return (
    <RecordPanel
      table="insurance_payments"
      dateColumn="collected_date"
      readPermission={PERMISSIONS.INSURANCE_READ}
      createPermission={PERMISSIONS.INSURANCE_CREATE}
      updatePermission={PERMISSIONS.INSURANCE_UPDATE}
      deletePermission={PERMISSIONS.INSURANCE_DELETE}
      title={t("insurance.title")}
      description={t("insurance.subtitle")}
      showContractColumns
      showRowNumber
      onePerContract
      buildInsert={(base) => ({
        tenant_id: base.tenant_id,
        contract_id: base.contract_id,
        unit_id: base.unit_id,
        building_id: base.building_id,
        amount: base.amount,
        collected_date: base.date,
        note: base.note,
      })}
    />
  );
}
