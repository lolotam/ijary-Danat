import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { useMemo } from "react";

import { ContractSwitcher } from "@/components/portal/ContractSwitcher";
import { PayOnlineUnavailable } from "@/components/portal/PayOnlineUnavailable";
import { PaymentRowActions } from "@/components/portal/PaymentRowActions";
import { PaymentStatusBadge } from "@/components/shared/dashboardCards";
import { SectionCard } from "@/components/shared/SectionCard";
import { Button } from "@/components/ui/button";
import {
  PORTAL_PAYMENT_AVAILABILITY_KEY,
  portalPaymentAvailability,
} from "@/fns/portalPaymentAvailability";
import { usePortalContractSelection } from "@/hooks/usePortalContractSelection";
import { useCompany } from "@/hooks/useCompany";
import {
  usePortalContracts,
  usePortalIdentity,
  usePortalPayments,
  type PortalPayment,
} from "@/hooks/usePortalData";
import { useSuppressedContractIds } from "@/hooks/useSuppressedContracts";
import { useI18n } from "@/i18n/provider";
import { downloadCsv } from "@/lib/csv";
import { formatKwd } from "@/lib/money";
import { formatBillingPeriod, formatPaymentDateTime } from "@/lib/dateDisplay";
import { filterPaymentsByContract, paymentSliceForContract } from "@/lib/portalPaymentContracts";
import { shouldShowTenantBillingActions } from "@/lib/tenantBillingDocuments";

export const Route = createFileRoute("/portal/payments")({ component: PortalPaymentsPage });

/**
 * صفحة مدفوعات بوابة المستأجر: قائمة الدفعات مع تصدير CSV وإيصالات.
 */
function PortalPaymentsPage() {
  const { locale, dir, t } = useI18n();
  const identity = usePortalIdentity();
  const tenantId = identity.data?.tenant?.id ?? null;
  const { contractId } = usePortalContractSelection(tenantId);
  const payments = usePortalPayments(tenantId);
  const contracts = usePortalContracts(tenantId);
  const company = useCompany();
  // The payments list itself holds no online-payment control, but the note has
  // to agree with the invoices page: no active gateway means pay at the office.
  const gatewayAvailable = useQuery({
    queryKey: PORTAL_PAYMENT_AVAILABILITY_KEY,
    queryFn: (): Promise<boolean> => portalPaymentAvailability(),
  });
  /**
   * معرّفات العقود المكبوتة للمستأجر — استعلام واحد للصفحة كلها.
   *
   * `isLoading` is false once a query FAILS, and `data` is undefined then, so
   * gating on `!isLoading` would hand `PaymentRowActions` an empty suppression
   * set and make the roof paper buildable again — a bundle served before
   * migration 173 reaches PostgREST is exactly that case. Only a successful
   * answer is permission to render.
   */
  const suppressedContractsQuery = useSuppressedContractIds(tenantId);
  const suppressedContractIds = useMemo(
    () => suppressedContractsQuery.data ?? new Set<string>(),
    [suppressedContractsQuery.data],
  );
  const suppressionKnown = suppressedContractsQuery.isSuccess;
  const codeByContractId = useMemo(() => {
    const map = new Map<string, string>();
    for (const contract of contracts.data ?? []) {
      map.set(contract.id, contract.code);
    }
    return map;
  }, [contracts.data]);

  const rows = useMemo(
    () => filterPaymentsByContract(payments.data ?? [], contractId),
    [payments.data, contractId],
  );

  /**
   * يصدّر صفوف المدفوعات الظاهرة (المرشّحة) كملف CSV.
   */
  function exportCsv() {
    if (!rows.length) return;
    downloadCsv(
      "portal-payments.csv",
      rows.map((payment) => paymentToCsvRow(payment, locale, dir, t, codeByContractId, contractId)),
      locale,
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t("portal.payments.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("portal.payments.subtitle")}</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ContractSwitcher tenantId={tenantId} />
          <Button
            variant="outline"
            className="min-h-11"
            disabled={!rows.length}
            onClick={exportCsv}
          >
            <Download className="size-4" />
            {t("export.csv")}
          </Button>
        </div>
      </div>
      {gatewayAvailable.data === false ? <PayOnlineUnavailable /> : null}
      {payments.isLoading ? (
        <SectionCard
          title={t("portal.payments.title")}
          gradient="from-emerald-600 to-emerald-700"
          bodyClassName="p-5"
        >
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        </SectionCard>
      ) : payments.isError ? (
        <p className="text-sm text-destructive">{t("common.error")}</p>
      ) : rows.length ? (
        <SectionCard
          title={t("portal.payments.title")}
          gradient="from-emerald-600 to-emerald-700"
          bodyClassName="divide-y divide-slate-100 dark:divide-slate-800"
        >
          {rows.map((payment) => {
            // Under a selected contract the row shows that contract's allocated
            // share, matching the CSV. Showing the full transaction on screen and
            // the scoped amount in the export would be worse than either alone.
            const { amount: shownAmount, periods: shownPeriods } = paymentSliceForContract(
              payment,
              contractId,
            );
            // Portal render gate: no buttons when every settled invoice is
            // suppressed. Mixed payments keep the buttons — the document itself
            // is filtered down to the ordinary invoices.
            // Resolve against no actions while loading rather than a full set,
            // so buttons never flash into view and then disappear (see
            // `usePortalTabAccess` for the same precedent).
            const settledForGate = payment.contractIds.map((id) => ({ contract_id: id }));
            // A payment that resolves to no contract but DID allocate money has
            // its allocations on a lease this portal will not show — hidden by
            // migration 212, or an invoice an admin flagged invisible. There is
            // no paper to issue for it: `buildDoc` would take the unresolved
            // allocation for no allocation at all and fall back to a generated
            // receipt carrying the very amount being withheld. A genuinely
            // unallocated payment has `allocatedAmount` 0 and keeps its actions.
            const hasWithheldAllocations =
              settledForGate.length === 0 && payment.allocatedAmount > 0;
            const isAllocationlessSuppressed = hasWithheldAllocations
              ? true
              : settledForGate.length === 0 && contractId
                ? suppressedContractIds.has(contractId)
                : null;
            const showActions =
              suppressionKnown &&
              shouldShowTenantBillingActions({
                settledInvoices: settledForGate,
                suppressedContractIds,
                isAllocationlessSuppressed,
              });
            return (
              <div
                key={payment.id}
                className="grid grid-cols-2 gap-x-4 gap-y-3 bg-card p-5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 lg:grid-cols-[1fr_1fr_1fr_1fr_auto_auto] lg:items-center lg:gap-4"
              >
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{t("portal.payments.code")}</p>
                  <p className="mt-1 break-all font-bold">{payment.code}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{t("payments.date")}</p>
                  <p className="mt-1 font-medium" dir="ltr">
                    {formatPaymentDateTime(payment.payment_date, payment.created_at, dir, locale) ||
                      "—"}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{t("portal.payments.period")}</p>
                  <div className="mt-1 space-y-0.5 font-medium">
                    {shownPeriods.length ? (
                      shownPeriods.map((period) => (
                        <p key={`${period.year}-${period.month}`}>
                          {formatBillingPeriod(period.month, period.year, locale)}
                        </p>
                      ))
                    ) : (
                      <p className="text-muted-foreground">—</p>
                    )}
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{t("payments.method")}</p>
                  <p className="mt-1 font-medium">{t(`paymentMethod.${payment.method}`)}</p>
                </div>
                <div className="lg:text-end">
                  <p className="text-xs text-muted-foreground lg:hidden">{t("payments.amount")}</p>
                  <p className="font-black text-emerald-600 dark:text-emerald-400">
                    {formatKwd(shownAmount, locale)}
                  </p>
                  <div className="mt-2 flex lg:justify-end">
                    <PaymentStatusBadge
                      status={payment.status}
                      method={payment.method}
                      locale={locale}
                    />
                  </div>
                </div>
                <div className="lg:contents">
                  <p className="text-xs text-muted-foreground lg:hidden">{t("common.actions")}</p>
                  {/* Receipt actions stay transaction-wide: a receipt documents the
                    payment that was actually made, not one contract's slice of it. */}
                  {showActions ? (
                    <PaymentRowActions
                      payment={payment}
                      company={company.data ?? null}
                      tenant={identity.data?.tenant ?? null}
                      suppressedContractIds={suppressedContractIds}
                      selectedContractId={contractId}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </SectionCard>
      ) : (
        <SectionCard
          title={t("portal.payments.title")}
          gradient="from-emerald-600 to-emerald-700"
          bodyClassName="p-8 text-center text-sm text-muted-foreground"
        >
          {t("portal.payments.empty")}
        </SectionCard>
      )}
    </div>
  );
}

/**
 * يحوّل دفعة بوابة إلى صف CSV مع عمود العقود المرتبطة.
 *
 * When one contract is selected the row reports that contract's *allocated*
 * share and only the periods it covered — not the whole transaction. A payment
 * settling invoices from two contracts appears under both, so exporting
 * `payment.amount` under each would double-count it in any sum the tenant takes
 * of the file, and listing every period under each would credit one contract
 * with the other's months. Under "all contracts" the full transaction is the
 * right answer, and that is what it reports.
 */
function paymentToCsvRow(
  payment: PortalPayment,
  locale: "ar" | "en",
  dir: "ltr" | "rtl",
  t: (key: string) => string,
  codeByContractId: Map<string, string>,
  contractId: string | null,
): Record<string, string> {
  const { amount, periods } = paymentSliceForContract(payment, contractId);
  const period = periods.length
    ? periods.map((entry) => formatBillingPeriod(entry.month, entry.year, locale)).join("; ")
    : "";
  const contract =
    (contractId ? [contractId] : payment.contractIds)
      .map((id) => codeByContractId.get(id) ?? id)
      .filter(Boolean)
      .join("; ") || "";
  return {
    code: payment.code,
    payment_date:
      formatPaymentDateTime(payment.payment_date, payment.created_at, dir, locale) || "",
    period,
    contract,
    method: t(`paymentMethod.${payment.method}`),
    amount: String(amount),
    currency: payment.currency,
    status: t(`paymentStatus.${payment.status}`),
  };
}
