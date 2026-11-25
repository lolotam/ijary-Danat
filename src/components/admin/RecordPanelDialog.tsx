import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LtrText } from "@/components/ui/ltr-text";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import { formatAmount } from "@/lib/money";
import { invoicePeriodLabel } from "@/lib/invoicePeriodLabel";
import { invoiceOptionsForPartialLink } from "@/lib/invoiceBulkSelection";
import type { InvoiceState, PartialPaymentStatus } from "@/integrations/supabase/database.types";

export type SettleableInvoiceOption = {
  balance: number;
  code: string;
  id: string;
  period_month: number;
  period_year: number;
  state: InvoiceState;
  /** Present on settleable rows; the pinned paid invoice may load it separately. */
  total?: number;
};

export type RecordPanelDialogContractOption = {
  label: string;
  tenantId: string;
  value: string;
};

/**
 * يقرأ إجمالي الفاتورة المختارة من القائمة أو الصف المثبت إن وُجد رقماً.
 *
 * The pinned invoice comes from edit-context JSON that historically omitted
 * `total`; a missing number must not be treated as zero.
 */
function knownPickedTotal(
  invoiceId: string,
  invoices: SettleableInvoiceOption[],
  pinnedInvoice?: SettleableInvoiceOption | null,
): number | undefined {
  const match =
    invoices.find((invoice) => invoice.id === invoiceId) ??
    (pinnedInvoice?.id === invoiceId ? pinnedInvoice : undefined);
  return typeof match?.total === "number" ? match.total : undefined;
}

/**
 * يجلب إجمالي الفاتورة عندما تغيب عن قائمة القابلة للتسوية — الفاتورة المثبتة بعد السداد.
 */
function usePickedInvoiceTotal(invoiceId: string | null, knownTotal: number | undefined) {
  return useQuery({
    queryKey: ["invoices", "picked-total", invoiceId],
    enabled: Boolean(invoiceId) && knownTotal === undefined,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("total")
        .eq("id", invoiceId!)
        .single();
      if (error) throw error;
      return data.total;
    },
  });
}

/**
 * قائمة فواتير العقد القابلة للتسوية لربط دفعة جزئية.
 *
 * Filters again in the UI so a stale query cannot offer a paid or cancelled
 * invoice even if the hook's PostgREST filter is later widened. The row's own
 * invoice is pinned even after it became paid — that is the invoice the
 * accountant is editing.
 */
export function PartialPaymentInvoiceField({
  invoices,
  value,
  onChange,
  pinnedInvoice,
  disabled,
}: {
  invoices: SettleableInvoiceOption[];
  value: string;
  onChange: (invoiceId: string) => void;
  pinnedInvoice?: SettleableInvoiceOption | null;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const options = invoiceOptionsForPartialLink(invoices, pinnedInvoice);

  return (
    <div className="grid gap-1.5">
      <Label>{t("partialPayments.invoice")}</Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger>
          <SelectValue placeholder={t("partialPayments.pickInvoice")} />
        </SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              {t("partialPayments.noUnpaidInvoices")}
            </div>
          ) : (
            options.map((invoice) => (
              <SelectItem key={invoice.id} value={invoice.id}>
                {`${invoice.code} (${invoicePeriodLabel(invoice.period_year, invoice.period_month)})`}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * نافذة إنشاء/تعديل سجل مالي مشترك، مع حقلي الفاتورة والحالة الاختياريين.
 */
export function RecordPanelDialog({
  open,
  onOpenChange,
  editing,
  title,
  description,
  contractId,
  contractOptions,
  lockContract,
  onContractChange,
  amount,
  onAmountChange,
  date,
  onDateChange,
  note,
  onNoteChange,
  extraFields,
  invoiceField,
  invoiceId,
  invoices,
  onInvoiceChange,
  statusField,
  status,
  onStatusChange,
  pending,
  onSubmit,
  remaining: remainingOverride,
  formLocked = false,
  loadingHint,
  loadError,
  onRetryLoad,
  pinnedInvoice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: boolean;
  title: string;
  description: string;
  contractId: string;
  contractOptions: RecordPanelDialogContractOption[];
  lockContract: boolean;
  onContractChange: (contractId: string) => void;
  amount: string;
  onAmountChange: (amount: string) => void;
  date: string;
  onDateChange: (date: string) => void;
  note: string;
  onNoteChange: (note: string) => void;
  extraFields?: React.ReactNode;
  invoiceField: boolean;
  invoiceId: string;
  invoices: SettleableInvoiceOption[];
  onInvoiceChange: (invoiceId: string) => void;
  statusField: boolean;
  status: PartialPaymentStatus;
  onStatusChange: (status: PartialPaymentStatus) => void;
  pending: boolean;
  onSubmit: () => void;
  remaining?: number | null;
  formLocked?: boolean;
  loadingHint?: string;
  loadError?: string | null;
  onRetryLoad?: () => void;
  pinnedInvoice?: SettleableInvoiceOption | null;
}) {
  const { t, locale } = useI18n();
  const invoiceSelected = Boolean(invoiceId);
  const remaining =
    remainingOverride !== undefined
      ? remainingOverride
      : invoiceSelected
        ? (invoices.find((invoice) => invoice.id === invoiceId)?.balance ?? null)
        : null;
  const knownTotal = invoiceId ? knownPickedTotal(invoiceId, invoices, pinnedInvoice) : undefined;
  const fetchedTotal = usePickedInvoiceTotal(invoiceId || null, knownTotal);
  const invoiceTotal = knownTotal ?? fetchedTotal.data ?? null;
  const fieldsDisabled = formLocked || pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? t("common.edit") : title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label required>{t("payments.contract")}</Label>
            <Select value={contractId} onValueChange={onContractChange} disabled={lockContract}>
              <SelectTrigger>
                <SelectValue placeholder={t("payments.pickContract")} />
              </SelectTrigger>
              <SelectContent>
                {contractOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {invoiceField ? (
            <PartialPaymentInvoiceField
              invoices={invoices}
              value={invoiceId}
              onChange={onInvoiceChange}
              pinnedInvoice={pinnedInvoice}
              disabled={fieldsDisabled}
            />
          ) : null}
          {invoiceSelected && (invoiceTotal !== null || remaining !== null) ? (
            <div className="grid gap-1 text-xs text-muted-foreground">
              {invoiceTotal !== null ? (
                <p>
                  {t("invoiceDocument.invoiceTotal")}:{" "}
                  <LtrText>{formatAmount(invoiceTotal, locale)}</LtrText>
                </p>
              ) : null}
              {remaining !== null ? (
                <p>
                  {editing
                    ? t("partialPayments.maxForEdit")
                    : t("partialPayments.remainingBalance")}
                  : <LtrText>{formatAmount(remaining, locale)}</LtrText>
                </p>
              ) : null}
            </div>
          ) : null}
          {statusField ? (
            <div className="grid gap-1.5">
              <Label>{t("partialPayments.status")}</Label>
              <Select
                value={invoiceSelected ? "incomplete" : status}
                onValueChange={(value) => onStatusChange(value as PartialPaymentStatus)}
                disabled={invoiceSelected}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="incomplete">{t("partialPaymentStatus.incomplete")}</SelectItem>
                  <SelectItem value="complete">{t("partialPaymentStatus.complete")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label required>{t("payments.amount")}</Label>
            {/* `min` and `step` travel together: min="0.001" with the default
                step=1 makes the browser reject a whole number like 500, and no
                unit test can see native validation. */}
            <Input
              type="number"
              step="0.001"
              min="0.001"
              max={remaining ?? undefined}
              value={amount}
              onChange={(event) => onAmountChange(event.target.value)}
              disabled={fieldsDisabled}
            />
            {formLocked && loadingHint ? (
              <p className="text-muted-foreground text-xs">{loadingHint}</p>
            ) : null}
            {loadError ? (
              <div className="flex items-center gap-2 text-xs text-destructive">
                <span>{loadError}</span>
                {onRetryLoad ? (
                  <Button type="button" variant="outline" size="sm" onClick={onRetryLoad}>
                    {t("partialPayments.retryLoad")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {remaining !== null ? (
              <p className="text-muted-foreground text-xs">
                {t("partialPayments.amountHint").replace("{max}", formatAmount(remaining, locale))}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label>{t("common.date")}</Label>
            <Input
              type="date"
              value={date}
              onChange={(event) => onDateChange(event.target.value)}
              disabled={fieldsDisabled}
            />
          </div>
          {extraFields}
          <div className="grid gap-1.5">
            <Label>{t("common.notes")}</Label>
            <Input value={note} onChange={(event) => onNoteChange(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={pending || formLocked} onClick={onSubmit}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
