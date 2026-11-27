import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePostHog } from "posthog-js/react";
import { toast } from "sonner";

import { ApplePayQrDialog } from "@/components/portal/ApplePayQrDialog";
import { ContractSwitcher } from "@/components/portal/ContractSwitcher";
import { PayNowMenu } from "@/components/portal/PayNowMenu";
import { PayOnlineUnavailable } from "@/components/portal/PayOnlineUnavailable";
import { InvoiceStatusBadge } from "@/components/shared/dashboardCards";
import { InvoicePartialIndicator } from "@/components/shared/InvoicePartialIndicator";
import { SectionCard } from "@/components/shared/SectionCard";
import { Checkbox } from "@/components/ui/checkbox";
import type { HostedPaymentMethod } from "@/fns/createPayment";
import {
  PORTAL_PAYMENT_AVAILABILITY_KEY,
  portalPaymentAvailability,
} from "@/fns/portalPaymentAvailability";
import { useCompany } from "@/hooks/useCompany";
import { useCreatePayment } from "@/hooks/useCreatePayment";
import { useDeviceProfile } from "@/hooks/useDeviceProfile";
import { usePortalContractSelection } from "@/hooks/usePortalContractSelection";
import { usePortalContracts, usePortalIdentity } from "@/hooks/usePortalData";
import { usePortalInvoices } from "@/hooks/usePortalInvoices";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import { fetchInChunks } from "@/lib/idChunks";
import {
  enabledPaymentMethods,
  offeredPaymentMethods,
  paymentHandoffFor,
} from "@/lib/paymentHandoff";
import { invoiceDiscountBadgeText } from "@/lib/invoiceDiscountBadge";
import { formatKwd } from "@/lib/money";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/portal/invoices")({ component: PortalInvoicesPage });

/**
 * صفحة فواتير بوابة المستأجر: اختيار الفواتير والدفع عبر KNET / Google Pay / Apple Pay.
 */
function PortalInvoicesPage() {
  const { locale, t } = useI18n();
  const posthog = usePostHog();
  const identity = usePortalIdentity();
  const tenant = identity.data?.tenant ?? null;
  const { contractId } = usePortalContractSelection(tenant?.id ?? null);
  const contracts = usePortalContracts(tenant?.id ?? null);
  const invoices = usePortalInvoices(tenant?.id ?? null, contractId);
  const createPayment = useCreatePayment();
  const device = useDeviceProfile();
  const company = useCompany();
  // Online payment is offered only after the server confirms the company has
  // an active gateway. While the answer is unknown the controls stay hidden,
  // so a deactivated gateway cannot leave a payable-looking button behind.
  const gatewayAvailable = useQuery({
    queryKey: PORTAL_PAYMENT_AVAILABILITY_KEY,
    queryFn: (): Promise<boolean> => portalPaymentAvailability(),
  });
  const canPayOnline = gatewayAvailable.data === true;
  // KNET is unconditional; the company row only says whether the two extras are
  // offered on top of it. Intersecting with the device here — not inside
  // PayNowMenu — is what lets `paySelected` refuse a method the menu never drew.
  //
  // Falling back to `false` degrades a failed settings read to KNET-only rather
  // than to nothing: the tenant can still pay by the one rail that always works,
  // and the server re-reads the real answer anyway.
  const enabledMethods = enabledPaymentMethods({
    applePay: company.data?.portal_apple_pay_enabled ?? false,
    googlePay: company.data?.portal_google_pay_enabled ?? false,
  });
  const offeredMethods = offeredPaymentMethods({ device, enabled: enabledMethods });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Which button was pressed, not merely "a payment is in flight": the mutation's
  // own isPending is shared by all three, so it would put "redirecting…" on every
  // button at once and leave the tenant unsure which one they actually pressed.
  const [pendingMethod, setPendingMethod] = useState<HostedPaymentMethod | null>(null);
  const [applePayHandoff, setApplePayHandoff] = useState<{
    paymentRequestCode: string;
    paymentUrl: string;
  } | null>(null);

  // A selection made under one contract must not survive into another, or the
  // tenant pays invoices they can no longer see.
  useEffect(() => {
    setSelectedIds([]);
  }, [contractId]);

  const rows = useMemo(() => invoices.data ?? [], [invoices.data]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const total = rows
    .filter((row) => selectedSet.has(row.invoice_id))
    .reduce((sum, row) => sum + row.balance, 0);

  const codeByContractId = useMemo(() => {
    const map = new Map<string, string>();
    for (const contract of contracts.data ?? []) {
      map.set(contract.id, contract.code);
    }
    return map;
  }, [contracts.data]);

  /**
   * يبني خريطة رمز العقد لكل فاتورة من معرفات العقود في القائمة.
   *
   * The payable RPC deliberately omits contract_id from its row type; we map
   * through usePortalContracts when filtering, and fall back to a secondary
   * lookup only when showing "all contracts" if needed via invoice ids.
   */
  const [invoiceContractCode, setInvoiceContractCode] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!rows.length) {
      setInvoiceContractCode({});
      return;
    }
    if (contractId && codeByContractId.has(contractId)) {
      const code = codeByContractId.get(contractId)!;
      const next: Record<string, string> = {};
      for (const row of rows) next[row.invoice_id] = code;
      setInvoiceContractCode(next);
      return;
    }
    let cancelled = false;
    void (async () => {
      // Chunked: hundreds of payable invoices exceed what one `in()` filter can
      // carry in the URL.
      //
      // A failure is deliberately swallowed, as it was before: this only labels
      // each row with its contract code and the cell already falls back to "—".
      // Letting it reject would surface an unhandled rejection from this
      // fire-and-forget effect without telling the tenant anything useful.
      const data = await fetchInChunks(
        rows.map((row) => row.invoice_id),
        (chunk) => supabase.from("invoices").select("id, contract_id").in("id", chunk),
      ).catch(() => null);
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      for (const row of data) {
        next[row.id] = codeByContractId.get(row.contract_id) ?? "—";
      }
      setInvoiceContractCode(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, contractId, codeByContractId]);

  /**
   * يتحقق من أن الصف في بادئة الاختيار (أقدم فاتورة أولاً).
   */
  function canSelect(index: number) {
    if (index === 0) return rows[0]?.is_selectable === true;
    return rows.slice(0, index).every((row) => selectedSet.has(row.invoice_id));
  }

  /**
   * يحدّث مجموعة الفواتير المحددة مع احترام قاعدة البادئة.
   */
  function setInvoiceSelected(index: number, checked: boolean) {
    if (checked) {
      if (!canSelect(index)) return;
      setSelectedIds(rows.slice(0, index + 1).map((row) => row.invoice_id));
      return;
    }
    setSelectedIds(rows.slice(0, index).map((row) => row.invoice_id));
  }

  /**
   * يبدأ طلب دفع للفاتورات المحددة عبر الوسيلة المختارة.
   *
   * The handoff is decided *before* the request so an unusable rail never
   * creates an orphan payment request that no one will ever pay.
   */
  async function paySelected(paymentMethod: HostedPaymentMethod) {
    if (!selectedIds.length) return;
    const handoff = paymentHandoffFor({ method: paymentMethod, device });
    // Two ways a method can be refused here, and PayNowMenu already hides both,
    // so reaching either means a direct call. Refuse rather than create a
    // payment request: one for a page the tenant cannot pay on, the other for a
    // rail the admin has switched off. `createPayment` enforces the second one
    // again server-side — this check is only for the wasted round trip.
    if (handoff === "unavailable") return;
    if (!offeredMethods.includes(paymentMethod)) return;

    setPendingMethod(paymentMethod);
    try {
      const result = await createPayment.mutateAsync({
        invoiceIds: selectedIds,
        paymentMethod,
        ...(contractId ? { contractId } : {}),
      });
      posthog.capture("payment_checkout_started", {
        payment_method: paymentMethod,
        invoice_count: selectedIds.length,
      });

      // A desktop that cannot open the Apple Pay sheet: hand the payment to the
      // tenant's phone rather than opening a page with a dead button.
      if (handoff === "show-qr") {
        setApplePayHandoff({
          paymentUrl: result.paymentUrl,
          paymentRequestCode: result.paymentRequestCode,
        });
        return;
      }

      // On a phone, navigate rather than open: iOS Safari has already spent the
      // user gesture on the request above.
      if (handoff === "open-same-tab") {
        window.location.assign(result.paymentUrl);
        return;
      }

      // Desktop: a new tab keeps the portal visible behind the gateway.
      //
      // Careful with the check below. Per the HTML standard `window.open`
      // returns null whenever `noopener` is set, even on success — so this may
      // be showing a spurious "popup blocked" toast on every desktop payment.
      // That reading is unconfirmed in a real browser, and the obvious fix
      // (pre-open a blank tab inside the click, navigate it after) cannot keep
      // the `noopener` protection: assigning `opener = null` does not survive
      // the cross-origin navigation. Left as-is until someone confirms the
      // symptom on a desktop; do not trade the security property for a guess.
      const opened = window.open(result.paymentUrl, "_blank", "noopener,noreferrer");
      if (!opened) {
        toast.error(t("common.popupBlocked"), {
          action: {
            label: t("portal.invoices.payNow"),
            onClick: () => window.open(result.paymentUrl, "_blank", "noopener,noreferrer"),
          },
        });
      }
    } catch (error) {
      console.error("Failed to create a portal payment request.", error);
    } finally {
      setPendingMethod(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t("portal.invoices.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("portal.invoices.subtitle")}</p>
        </div>
        <ContractSwitcher tenantId={tenant?.id ?? null} />
      </div>

      {gatewayAvailable.data === false ? <PayOnlineUnavailable /> : null}

      {invoices.isLoading ? (
        <SectionCard
          title={t("portal.invoices.title")}
          gradient="from-blue-600 to-blue-700"
          bodyClassName="p-5"
        >
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        </SectionCard>
      ) : invoices.isError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {t("common.error")}
        </p>
      ) : rows.length === 0 ? (
        <SectionCard
          title={t("portal.invoices.title")}
          gradient="from-blue-600 to-blue-700"
          bodyClassName="p-8 text-center text-sm text-muted-foreground"
        >
          {t("portal.invoices.empty")}
        </SectionCard>
      ) : (
        <SectionCard
          title={t("portal.invoices.title")}
          gradient="from-blue-600 to-blue-700"
          bodyClassName="divide-y divide-slate-100 dark:divide-slate-800"
        >
          {rows.map((invoice, index) => {
            const enabled = canSelect(index);
            const checked = selectedSet.has(invoice.invoice_id);
            const rowNumber = index + 1;
            const contractCode = invoiceContractCode[invoice.invoice_id] ?? "—";
            const discountBadge = invoiceDiscountBadgeText(
              invoice.discount,
              t("portal.invoice.discountBadge"),
              locale,
            );
            return (
              <div
                key={invoice.invoice_id}
                className={cn(
                  "grid grid-cols-[auto_auto_1fr] items-center gap-x-3 gap-y-2 bg-card p-4 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 sm:grid-cols-[auto_auto_1fr_auto] sm:gap-4",
                  invoice.is_overdue && "bg-red-50/70 dark:bg-red-950/20",
                  !enabled && "opacity-75",
                )}
              >
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  aria-label={`#${rowNumber}`}
                >
                  {rowNumber}
                </span>
                <Checkbox
                  checked={checked}
                  disabled={!enabled || pendingMethod !== null}
                  onCheckedChange={(value) => setInvoiceSelected(index, value === true)}
                  aria-label={`${t("portal.invoices.selectPeriod")} ${invoice.period_month}/${invoice.period_year}`}
                  className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                />
                <div className="col-span-3 row-start-2 min-w-0 sm:col-span-1 sm:row-start-auto">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold">
                      {t("portal.invoices.period")} {invoice.period_month}/{invoice.period_year}
                    </p>
                    <InvoiceStatusBadge state={invoice.state} locale={locale} />
                    <InvoicePartialIndicator
                      state={invoice.state}
                      paid={invoice.paid}
                      total={invoice.total}
                    />
                    {discountBadge ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                        {discountBadge}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("portal.invoices.contractCode")}:{" "}
                    <span className="font-medium" dir="ltr">
                      {contractCode}
                    </span>
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {t("portal.invoices.amount")}: {formatKwd(invoice.total, locale)}
                    </span>
                    <span>
                      {t("portal.invoices.balance")}: {formatKwd(invoice.balance, locale)}
                    </span>
                  </div>
                  {!enabled && (
                    <p className="mt-3 flex items-start gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                      <LockKeyhole className="mt-0.5 size-3.5 shrink-0" />
                      {invoice.lock_reason}
                    </p>
                  )}
                </div>
                <div className="col-start-3 row-start-1 flex items-center justify-end gap-3 sm:col-start-auto sm:row-start-auto sm:flex-col sm:items-end">
                  <span className="text-sm font-black text-blue-600 dark:text-blue-400">
                    {formatKwd(invoice.balance, locale)}
                  </span>
                </div>
              </div>
            );
          })}
        </SectionCard>
      )}

      {createPayment.isError && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {createPayment.error.message || t("portal.gateway.error")}
        </p>
      )}

      {/* Centred, not end-aligned: this block is the page's one call to action,
        and `dir` flips which edge "end" is — so an aligned version sits under
        the tenant's thumb in Arabic and away from it in English. Mounted only
        when a selection exists so an empty bar does not sit over the list;
        transparent (no card chrome) and pointer-events-none so invoice rows
        behind it stay scrollable/tappable until the Pay control itself. */}
      {selectedIds.length > 0 && canPayOnline && (
        <div className="pointer-events-none sticky bottom-[calc(1rem+env(safe-area-inset-bottom))] flex flex-col items-center gap-3 p-4 text-center">
          <div>
            <p className="text-xs text-muted-foreground">{t("portal.invoices.selectedTotal")}</p>
            <p className="text-xl font-black">{formatKwd(total, locale)}</p>
          </div>
          <div className="pointer-events-auto flex w-full flex-col items-center">
            <PayNowMenu
              device={device}
              enabled={enabledMethods}
              isLoadingMethods={company.isLoading}
              pendingMethod={pendingMethod}
              onSelect={(method) => void paySelected(method)}
            />
          </div>
        </div>
      )}

      {applePayHandoff && (
        <ApplePayQrDialog
          onClose={() => setApplePayHandoff(null)}
          amountLabel={formatKwd(total, locale)}
          paymentUrl={applePayHandoff.paymentUrl}
          paymentRequestCode={applePayHandoff.paymentRequestCode}
        />
      )}
    </div>
  );
}
