import { useEffect, useMemo, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { LockKeyhole } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { notifyPaymentSuccessFn } from "@/fns/notifyPaymentSuccess";
import { useCompany } from "@/hooks/useCompany";
import { primaryUnit, useContracts } from "@/hooks/useContracts";
import { useInvoices } from "@/hooks/useInvoices";
import { useApplyPaymentAllocation } from "@/hooks/usePaymentAllocations";
import { useCreateManualPayment } from "@/hooks/usePayments";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import {
  buildInvoiceSettlements,
  deselectFrom,
  isContiguousPrefix,
  nextSelectableIndex,
  selectThrough,
  settleableInvoices,
  settlementTotal,
  type InvoiceSettlement,
} from "@/lib/invoiceSettlement";
import { invoicePeriodLabel } from "@/lib/invoicePeriodLabel";
import { formatAmount, formatKwd } from "@/lib/money";
import {
  PAYMENT_ACCOUNT_TYPES,
  emptyPaymentForm,
  paymentSchema,
  type PaymentForm,
} from "@/lib/paymentForm";
import { PERMISSIONS } from "@/lib/permissions";
import { tenantDisplayName } from "@/lib/tenantDisplayName";
import { cn } from "@/lib/utils";

export interface CreatePaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** طرق الدفع كما تعرضها قائمة الخيارات — تشاركها اللوحة مع شريط المرشّحات. */
  methodOptions: Array<{ value: string; label: string }>;
}

/**
 * حوار تسجيل دفعة كاملة: يختار العقد والفواتير الأقدم فالأحدث ويسوّي كل فاتورة بدفعة مستقلة.
 *
 * The one surface that settles money from the full-payments screen, extracted
 * from `FullPaymentsPanel` (audit M13, plan row 6.5) with its state, its
 * queries and `settleInvoices`, so the settlement logic and the form it serves
 * change together and nothing else does. The panel remounts this with a fresh
 * `key` each time it opens, which is what the old `form.reset(...)` before
 * opening did.
 */
export function CreatePaymentDialog({
  open,
  onOpenChange,
  methodOptions,
}: CreatePaymentDialogProps) {
  const { locale, t } = useI18n();
  const permissions = usePermissions();
  const [attachment, setAttachment] = useState<File | null>(null);
  const [settling, setSettling] = useState(false);
  // Ended contracts still carry unpaid invoices; an active-only list cannot
  // collect real outstanding debt.
  const contracts = useContracts({ pageSize: 500 }, permissions.can(PERMISSIONS.CONTRACTS_READ));
  const company = useCompany();
  const createPayment = useCreateManualPayment();
  const applyAllocation = useApplyPaymentAllocation();
  const form = useForm<PaymentForm>({
    resolver: zodResolver(paymentSchema),
    defaultValues: emptyPaymentForm(),
  });
  const contractId = form.watch("contractId");
  const invoiceIds = form.watch("invoiceIds");
  const selectedContract = useMemo(
    () => (contracts.data?.items ?? []).find((contract) => contract.id === contractId) ?? null,
    [contracts.data?.items, contractId],
  );
  // `useInvoices` sorts newest-first, so any page size is a window on the *newest*
  // invoices while this picker settles the *oldest*. There is no cap to set that
  // does not eventually hide the very months that should be paid first, so the
  // picker takes the whole contract.
  const contractInvoices = useInvoices({ contractId, fetchAll: true }, Boolean(contractId));
  const settleable = useMemo(
    () =>
      settleableInvoices(
        (contractInvoices.data?.items ?? []).map((invoice) => ({
          id: invoice.id,
          balance: invoice.balance,
          code: invoice.code,
          period_month: invoice.period_month,
          period_year: invoice.period_year,
          state: invoice.state,
        })),
      ),
    [contractInvoices.data?.items],
  );
  /**
   * Seed the oldest unpaid invoice **once per contract**, not on every refetch.
   *
   * The shared `QueryClient` now defaults to a 30s `staleTime` with
   * `refetchOnWindowFocus` off, but background refetches still happen on
   * remount and on every `invalidateQueries` after a payment. Re-seeding
   * whenever the invoice query
   * resolved would mean an admin who ticked three months, alt-tabbed to check a
   * bank statement, and came back would silently find only the oldest month
   * still selected — and would then settle one month believing they settled
   * three. The ref records which contract has already been seeded so a refetch
   * that returns identical rows leaves the admin's selection alone.
   */
  const seededContractId = useRef<string | null>(null);
  useEffect(() => {
    if (!contractId) {
      seededContractId.current = null;
      return;
    }
    if (!contractInvoices.isSuccess || seededContractId.current === contractId) return;
    seededContractId.current = contractId;
    form.setValue("invoiceIds", settleable[0] ? [settleable[0].id] : []);
  }, [contractId, contractInvoices.isSuccess, settleable, form]);
  const currentSettlements = useMemo(
    () => buildInvoiceSettlements(settleable, invoiceIds ?? []),
    [settleable, invoiceIds],
  );
  const amountDisplay = currentSettlements.length
    ? settlementTotal(currentSettlements)
    : (selectedContract?.monthly_amount ?? 0);
  const saveDisabled =
    settling ||
    createPayment.isPending ||
    applyAllocation.isPending ||
    !contractId ||
    settleable.length === 0 ||
    !invoiceIds?.length;

  /**
   * يسوّي كل فاتورة بدفعة مستقلة من الأقدم للأحدث، ويعيد ما سُوّي قبل أي إخفاق.
   *
   * Settle each invoice as its own payment row, oldest first, and report how
   * far the batch got.
   *
   * No transaction spans these rows — each pair is a separate create + allocate
   * round trip — so a failure halfway leaves the earlier months genuinely paid.
   * The error is returned alongside the ids rather than thrown so the caller
   * can say *which* months settled; an admin told only "failed" would either
   * re-enter money already taken or leave real payments unrecorded.
   */
  const settleInvoices = async (
    values: PaymentForm,
    settlements: InvoiceSettlement[],
    contract: NonNullable<typeof selectedContract>,
  ) => {
    const createdIds: string[] = [];
    for (const [index, settlement] of settlements.entries()) {
      try {
        const payment = await createPayment.mutateAsync({
          accountType: values.accountType,
          method: values.method,
          paymentDate: values.paymentDate,
          reference: values.reference,
          note: values.note,
          companyId: company.data?.id ?? null,
          tenantId: contract.tenant_id,
          // Units live on contract_units now (migration 110), not
          // contracts.unit_id (dropped in migration 118) — the primary
          // (lowest line_order, numbered from 1) unit stands in for the contract, matching the
          // display just below in this form.
          unitId: primaryUnit(contract)?.id ?? null,
          amount: settlement.amount,
          // One evidence file for the batch; later rows stay attachment-free.
          attachment: index === 0 ? attachment : null,
          // The batch notifies once at the end — per-payment would send a
          // tenant one receipt per month settled.
          notify: false,
        });
        await applyAllocation.mutateAsync({
          paymentId: payment.id,
          allocations: [{ invoice_id: settlement.invoiceId, amount: settlement.amount }],
        });
        createdIds.push(payment.id);
      } catch (error) {
        return { createdIds, error };
      }
    }
    return { createdIds, error: null };
  };

  /**
   * يتحقق من تسلسل الفواتير المختارة ثم يسوّيها ويرسل إشعاراً واحداً للدفعة كلها.
   *
   * The selection is re-checked here because a refetch can reorder the
   * settleable list under a choice made before it arrived — and the server
   * now refuses an out-of-order allocation too, so catching it here saves the
   * admin a half-settled batch.
   */
  const submitPayment = form.handleSubmit(async (values) => {
    // `selectedContract` is a lookup into a list that can still be loading, and
    // the selection can name an invoice that was settled elsewhere since the
    // dialog opened. Both are why Save stays disabled until they resolve.
    if (!selectedContract) return;
    // A refetch can reorder `settleable` under a selection made before it
    // arrived, so re-assert before any money moves.
    //
    // This check is load-bearing, not just courtesy. `apply_payment_allocation`
    // — the function this path actually reaches — rejects an over-allocation but
    // has NO chronological check; only `set_invoice_paid` (159:118) and the
    // deposit/partial settlement functions do. So on the full-payment path the
    // ordering rule lives here. That gap is deliberate: making
    // `apply_payment_allocation` raise would strand gateway money mid-webhook,
    // since the MyFatoorah callback and paymentReconcileJob call it too.
    if (!isContiguousPrefix(settleable, values.invoiceIds)) {
      toast.error(t("payments.selectionMustBeChronological"));
      return;
    }
    const settlements = buildInvoiceSettlements(settleable, values.invoiceIds);
    if (!settlements.length) return;

    setSettling(true);
    const { createdIds, error } = await settleInvoices(values, settlements, selectedContract);
    setSettling(false);

    // Money moved for every id in `createdIds`, including on a partial failure,
    // so the receipt goes out for what actually settled rather than only for a
    // clean run. Notification failure must never fail a settled payment.
    if (createdIds.length) {
      try {
        await notifyPaymentSuccessFn({ data: { paymentIds: createdIds } });
      } catch (notifyError) {
        console.error("Payment notifications failed", notifyError);
      }
    }

    if (error) {
      const detail = error instanceof Error ? error.message : t("common.error");
      toast.error(
        `${t("payments.partialSettleFailed")} ${createdIds.length}/${settlements.length}. ${detail}`,
      );
      return;
    }

    toast.success(t("payments.settled"));
    onOpenChange(false);
    setAttachment(null);
    form.reset(emptyPaymentForm());
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("payments.add")}</DialogTitle>
          <DialogDescription>{t("payments.createDescription")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submitPayment}>
            <FormField
              control={form.control}
              name="contractId"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel required>{t("payments.contract")}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      form.setValue("invoiceIds", []);
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t("payments.pickContract")} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(contracts.data?.items ?? []).map((contract) => {
                        const tenantName = contract.tenant
                          ? tenantDisplayName(contract.tenant, locale)
                          : "—";
                        return (
                          <SelectItem key={contract.id} value={contract.id}>
                            {contract.code} — {tenantName}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <Label>{t("contracts.tenant")}</Label>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                {selectedContract?.tenant
                  ? tenantDisplayName(selectedContract.tenant, locale)
                  : "—"}
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("contracts.unit")}</Label>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                {selectedContract
                  ? (() => {
                      const unit = primaryUnit(selectedContract);
                      return unit ? `${unit.code} — ${unit.name}` : "—";
                    })()
                  : "—"}
              </div>
            </div>
            <FormField
              control={form.control}
              name="accountType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("payments.accountType")}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PAYMENT_ACCOUNT_TYPES.map((item) => (
                        <SelectItem key={item} value={item}>
                          {t(`paymentAccountType.${item}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("payments.method")}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {methodOptions.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <Label>{t("common.amount")}</Label>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm font-medium">
                <LtrText>{formatKwd(amountDisplay, locale)}</LtrText>
              </div>
              {currentSettlements.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("payments.selectedInvoices")}: {currentSettlements.length}
                </p>
              )}
            </div>
            <FormField
              control={form.control}
              name="paymentDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("payments.date")}</FormLabel>
                  <FormControl>
                    <DateInput
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={String(field.value ?? "")}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="invoiceIds"
              render={({ field }) => {
                // The one row the admin may tick next, and the invoice whose
                // being unpaid is the reason every later row is locked.
                const nextIndex = nextSelectableIndex(settleable, field.value);
                const blockingInvoice = settleable[nextIndex];
                return (
                  <FormItem className="sm:col-span-2">
                    <FormLabel required>{t("payments.unpaidInvoices")}</FormLabel>
                    {!contractId ? (
                      <p className="text-sm text-muted-foreground">{t("payments.pickContract")}</p>
                    ) : contractInvoices.isLoading ? (
                      <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                    ) : settleable.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t("payments.noUnpaidInvoices")}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {settleable.map((invoice, index) => {
                          const checked = field.value.includes(invoice.id);
                          // Only the next row in the oldest-first sequence may be
                          // ticked, mirroring the portal (portal.invoices.tsx:131).
                          // The database refuses out-of-order settlement anyway —
                          // set_invoice_paid (159:118) and migration 160 both raise —
                          // but the admin should not learn that from a Postgres error.
                          const locked = !checked && index !== nextIndex;
                          return (
                            <div
                              key={invoice.id}
                              className={cn(
                                "grid grid-cols-[auto_1fr] items-center gap-3 rounded-lg border p-3",
                                locked && "opacity-75",
                              )}
                            >
                              <Checkbox
                                checked={checked}
                                disabled={locked}
                                aria-label={invoice.code}
                                onCheckedChange={(next) =>
                                  field.onChange(
                                    next === true
                                      ? selectThrough(settleable, index)
                                      : deselectFrom(settleable, index),
                                  )
                                }
                              />
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{invoice.code}</span>
                                <Badge variant="secondary" className="rounded-full font-normal">
                                  {invoicePeriodLabel(invoice.period_year, invoice.period_month)}
                                </Badge>
                                <span className="text-muted-foreground ms-auto text-xs">
                                  {t("invoices.balance")}:{" "}
                                  <LtrText>{formatAmount(invoice.balance, locale)}</LtrText>
                                </span>
                              </div>
                              {locked && blockingInvoice ? (
                                <p className="text-muted-foreground col-start-2 flex items-center gap-1 text-xs">
                                  <LockKeyhole className="size-3 shrink-0" aria-hidden />
                                  {t("payments.payEarlierInvoiceFirst").replace(
                                    "{period}",
                                    invoicePeriodLabel(
                                      blockingInvoice.period_year,
                                      blockingInvoice.period_month,
                                    ),
                                  )}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <FormMessage />
                  </FormItem>
                );
              }}
            />
            <FormField
              control={form.control}
              name="reference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("payments.reference")}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <Label>{t("payments.attachment")}</Label>
              <Input
                type="file"
                accept="application/pdf,image/*"
                onChange={(event) => setAttachment(event.target.files?.[0] ?? null)}
              />
            </div>
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>{t("common.notes")}</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={saveDisabled}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
