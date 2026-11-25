import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { FilePlus2, PieChart, ShieldCheck, TrendingUp, Undo2, Wallet } from "lucide-react";

import { ModuleHeader, Pager, TableState } from "@/components/admin/Phase2Ui";
import { SummaryCards } from "@/components/admin/SummaryCards";
import { VibrantKpiCard } from "@/components/shared/dashboardCards";
import {
  InsurancePanel,
  PartialPaymentsPanel,
  RefundsPanel,
} from "@/components/admin/PaymentSidePanels";
import { AllocationDialog } from "@/components/admin/payments/AllocationDialog";
import { CreatePaymentDialog } from "@/components/admin/payments/CreatePaymentDialog";
import { PaymentsTable } from "@/components/admin/payments/PaymentsTable";
import { ReversalDialog } from "@/components/admin/payments/ReversalDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PaymentDocumentPrint } from "@/components/admin/PaymentDocumentPrint";
import { useTableSort } from "@/components/admin/SortableTable";
import { LtrText } from "@/components/ui/ltr-text";
import { PaymentFiltersBar } from "@/components/admin/PaymentFiltersBar";
import { useTenants } from "@/hooks/useTenants";
import {
  emptyPaymentFilters,
  toPaymentQueryParams,
  type PaymentFilters,
} from "@/lib/paymentFilters";
import { PAYMENT_METHODS } from "@/lib/paymentForm";
import { tenantDisplayName } from "@/lib/tenantDisplayName";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCardVisibility } from "@/hooks/useCardVisibility";
import { useCompany } from "@/hooks/useCompany";
import { usePaymentsSummary } from "@/hooks/usePaymentsSummary";
import { formatKwd } from "@/lib/money";
import { usePaymentAllocations } from "@/hooks/usePaymentAllocations";
import { usePermissions } from "@/hooks/usePermissions";
import { useListDrivenOptions } from "@/hooks/useOptionLists";
import { usePayments, type PaymentWithTenant } from "@/hooks/usePayments";
import { useReceipts } from "@/hooks/useReceipts";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import { PERMISSIONS } from "@/lib/permissions";

export const Route = createFileRoute("/admin/payments")({ component: PaymentsPage });

/**
 * Full payments — the original screen, now one section of Payment and Refund.
 *
 * Kept intact rather than merged into the new panels: this is the only surface
 * that settles money (allocations, receipts, reversal), and the T13 additions
 * are deliberately much simpler records.
 *
 * Holds the list state and which row a dialog is open for; the table and the
 * three money dialogs live in `components/admin/payments/` (audit M13, plan
 * row 6.5), so a change to settlement no longer means editing a 924-line
 * component that also renders the list.
 */
function FullPaymentsPanel() {
  const { locale, t } = useI18n();
  const permissions = usePermissions();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [createOpen, setCreateOpen] = useState(false);
  // Bumped on every open so the create dialog mounts fresh — the equivalent of
  // the `form.reset(...)` and cleared attachment the header button used to do.
  const [createKey, setCreateKey] = useState(0);
  const [allocationPayment, setAllocationPayment] = useState<PaymentWithTenant | null>(null);
  const [reverseTarget, setReverseTarget] = useState<PaymentWithTenant | null>(null);
  const [receiptPayment, setReceiptPayment] = useState<PaymentWithTenant | null>(null);
  const [pageSize, setPageSize] = useState(10);
  const [filters, setFilters] = useState<PaymentFilters>(emptyPaymentFilters);
  const canRead = permissions.can(PERMISSIONS.PAYMENTS_READ);
  const payments = usePayments(
    { page, pageSize, search: debouncedSearch, ...toPaymentQueryParams(filters) },
    canRead,
  );
  const {
    sort,
    toggle,
    sorted: sortedPayments,
  } = useTableSort(payments.data?.items ?? [], (payment, key) =>
    key === "tenant"
      ? payment.tenant
        ? tenantDisplayName(payment.tenant, locale)
        : null
      : (payment as unknown as Record<string, unknown>)[key],
  );
  // Only for the filter dropdown. Kept off the summary path deliberately: the
  // KPI cards above stay module-wide, see PaymentFiltersBar's header comment.
  //
  // One page, and the cap is real: a tenant past the 500th would not be
  // selectable here. Production holds 45, so this is an order of magnitude of
  // headroom rather than a limit anyone can reach — but it is a cap, and a
  // filter that silently cannot see part of the data is worth naming. Swap this
  // for a searchable async selector before the tenant list approaches it.
  const filterTenants = useTenants({ pageSize: 500 }, permissions.can(PERMISSIONS.TENANTS_READ));
  const company = useCompany();
  const receiptAllocations = usePaymentAllocations(receiptPayment?.id ?? null);
  const receipts = useReceipts(receiptPayment?.id ?? null);
  const methodOptions = useListDrivenOptions("payment_methods", PAYMENT_METHODS, "paymentMethod");

  if (!canRead)
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );

  return (
    <div className="space-y-6">
      <ModuleHeader
        title={t("payments.title")}
        subtitle={t("payments.subtitle")}
        actions={
          permissions.can(PERMISSIONS.PAYMENTS_CREATE) && (
            <Button
              onClick={() => {
                setCreateKey((current) => current + 1);
                setCreateOpen(true);
              }}
            >
              <FilePlus2 className="size-4" />
              {t("payments.add")}
            </Button>
          )
        }
      />

      <Card>
        <CardHeader>
          <PaymentFiltersBar
            search={search}
            onSearchChange={(next) => {
              setSearch(next);
              setPage(1);
            }}
            value={filters}
            onChange={(next) => {
              setFilters(next);
              // A filtered list is shorter; staying on page 6 shows nothing.
              setPage(1);
            }}
            methodOptions={methodOptions}
            tenants={filterTenants.data?.items ?? []}
          />
        </CardHeader>
        <CardContent className="p-0">
          <TableState
            loading={payments.isLoading}
            error={payments.isError}
            empty={!payments.data?.items.length}
          >
            <PaymentsTable
              items={payments.data?.items ?? []}
              sortedItems={sortedPayments}
              sort={sort}
              toggle={toggle}
              page={page}
              pageSize={pageSize}
              canReverse={permissions.can(PERMISSIONS.PAYMENTS_REVERSE)}
              onAllocate={setAllocationPayment}
              onPrint={setReceiptPayment}
              onReverse={setReverseTarget}
            />
          </TableState>
          <Pager
            page={page}
            pageSize={pageSize}
            count={payments.data?.count ?? 0}
            setPage={setPage}
            setPageSize={setPageSize}
          />
        </CardContent>
      </Card>

      <CreatePaymentDialog
        key={createKey}
        open={createOpen}
        onOpenChange={setCreateOpen}
        methodOptions={methodOptions}
      />

      <AllocationDialog
        key={allocationPayment?.id ?? "closed"}
        payment={allocationPayment}
        onClose={() => setAllocationPayment(null)}
      />

      <ReversalDialog payment={reverseTarget} onClose={() => setReverseTarget(null)} />

      <Dialog
        open={Boolean(receiptPayment)}
        onOpenChange={(open) => !open && setReceiptPayment(null)}
      >
        <DialogContent className="max-h-[95vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("payments.documentTitle")}</DialogTitle>
            <DialogDescription>{receiptPayment?.code}</DialogDescription>
          </DialogHeader>
          {receiptPayment && (
            <PaymentDocumentPrint
              allocations={receiptAllocations.data ?? []}
              company={company.data ?? null}
              payment={receiptPayment}
              receipt={receipts.data?.[0] ?? null}
              tenant={receiptPayment.tenant}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * T13 — Payment and Refund.
 *
 * Payment splits into Full (settles money), Partial (inert records) and
 * Insurance (deposits held). Refund is its own top-level tab because a refund
 * moves money the other way and carries an after-action on the tenant.
 */
function PaymentsPage() {
  const { locale, t } = useI18n();
  const permissions = usePermissions();
  const { isCardVisible } = useCardVisibility();
  // Module-wide: Payments has no page-level filter. The Full-tab search stays
  // local so it cannot drive Refunds/Partial/Insurance totals (those ledgers
  // have no code/status columns). See the design doc.
  const summary = usePaymentsSummary({}, permissions.can(PERMISSIONS.PAYMENTS_READ));
  const data = summary.data;
  const records = (n: number) => `${n} ${t("summary.records")}`;

  return (
    <div className="space-y-4">
      <SummaryCards loading={summary.isLoading} error={summary.error}>
        {isCardVisible("payments.full") && (
          <VibrantKpiCard
            label={t("summary.payments.full")}
            value={<LtrText>{formatKwd(data?.full.total ?? 0, locale)}</LtrText>}
            hint={records(data?.full.count ?? 0)}
            icon={<Wallet className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-green-600 shadow-emerald-500/25"
          />
        )}
        {isCardVisible("payments.partial") && (
          <VibrantKpiCard
            label={t("summary.payments.partial")}
            value={<LtrText>{formatKwd(data?.partial.total ?? 0, locale)}</LtrText>}
            hint={records(data?.partial.count ?? 0)}
            icon={<PieChart className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-sky-500 via-sky-600 to-blue-600 shadow-sky-500/25"
          />
        )}
        {isCardVisible("payments.insurance") && (
          <VibrantKpiCard
            label={t("summary.payments.insurance")}
            value={<LtrText>{formatKwd(data?.insurance.total ?? 0, locale)}</LtrText>}
            hint={records(data?.insurance.count ?? 0)}
            icon={<ShieldCheck className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-cyan-500 via-cyan-600 to-teal-600 shadow-cyan-500/25"
          />
        )}
        {isCardVisible("payments.refunds") && (
          <VibrantKpiCard
            label={t("summary.payments.refunds")}
            value={<LtrText>{formatKwd(data?.refunds.total ?? 0, locale)}</LtrText>}
            hint={records(data?.refunds.count ?? 0)}
            icon={<Undo2 className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-rose-500 via-rose-600 to-red-600 shadow-rose-500/25"
          />
        )}
        {isCardVisible("payments.net") && (
          <VibrantKpiCard
            label={t("summary.payments.net")}
            value={<LtrText>{formatKwd(data?.net ?? 0, locale)}</LtrText>}
            icon={<TrendingUp className="size-6 text-white" />}
            bgClass="bg-gradient-to-br from-violet-500 via-violet-600 to-purple-600 shadow-violet-500/25"
          />
        )}
      </SummaryCards>
      <Tabs defaultValue="payment" className="space-y-4">
        <TabsList>
          <TabsTrigger value="payment">{t("payments.tab.payment")}</TabsTrigger>
          <TabsTrigger value="refund">{t("payments.tab.refund")}</TabsTrigger>
        </TabsList>
        <TabsContent value="payment" className="space-y-4">
          <Tabs defaultValue="full" className="space-y-4">
            <TabsList>
              <TabsTrigger value="full">{t("payments.tab.full")}</TabsTrigger>
              <TabsTrigger value="partial">{t("payments.tab.partial")}</TabsTrigger>
              <TabsTrigger value="insurance">{t("payments.tab.insurance")}</TabsTrigger>
            </TabsList>
            <TabsContent value="full">
              <FullPaymentsPanel />
            </TabsContent>
            <TabsContent value="partial">
              <PartialPaymentsPanel />
            </TabsContent>
            <TabsContent value="insurance">
              <InsurancePanel />
            </TabsContent>
          </Tabs>
        </TabsContent>
        <TabsContent value="refund">
          <RefundsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
