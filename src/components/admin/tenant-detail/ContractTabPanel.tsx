import { useMemo } from "react";
import { Link } from "@tanstack/react-router";

import { ContractDurationBadge } from "@/components/admin/ContractDurationBadge";
import { PartialPaymentsPanel } from "@/components/admin/PaymentSidePanels";
import { TableState } from "@/components/admin/Phase2Ui";
import { InfoField } from "@/components/admin/InfoField";
import { ContractPortalVisibilityCard } from "@/components/admin/tenant-detail/ContractPortalVisibilityCard";
import { InvoiceRowsTable } from "@/components/admin/tenant-detail/InvoiceRowsTable";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { TenantDocumentsManager } from "@/components/admin/TenantDocumentsManager";
import { Badge } from "@/components/ui/badge";
import { FormattedDate } from "@/components/ui/formatted-date";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useConcessions,
  useContractUnits,
  type Concession,
  type Contract,
} from "@/hooks/useContracts";
import { useContractPayments } from "@/hooks/useContractPayments";
import { useInvoices } from "@/hooks/useInvoices";
import { usePermissions } from "@/hooks/usePermissions";
import type { Tenant } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { countActiveFreeMonths } from "@/lib/concessionColumns";
import { formatAmount, formatKwd, formatPercent } from "@/lib/money";
import { dedupeById } from "@/lib/tenantLocations";
import { PERMISSIONS } from "@/lib/permissions";
import { propertyDisplayName } from "@/lib/propertyDisplayName";
import { contractPaymentSortValue } from "@/lib/adminTableSortValues";
import { contractStateTone, paymentStatusTone } from "@/lib/statusTone";

/**
 * One contract: its lease facts, then its own invoices, payments, record and
 * documents.
 *
 * Everything here is scoped to this contract, which is the whole point — the
 * tenant-wide totals live on the Current Lease tab beside it.
 */
export function ContractTabPanel({
  contract,
  tenant,
  companyId,
}: {
  contract: Contract;
  tenant: Tenant;
  companyId: string | null;
}) {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  // A contract may hold several units now (migration 110) — every one is
  // rendered below, not just the first.
  const contractUnits = useContractUnits(contract.id);
  const properties = useMemo(
    () => dedupeById((contractUnits.data ?? []).map((detail) => detail.property)),
    [contractUnits.data],
  );
  const concessions = useConcessions(contract.id);
  // Every invoice the contract ever raised, not a page of them. This table has
  // no page control, so a capped fetch is a silently short list: a twenty-year
  // lease raises ~240 invoices and the old cap of 200, ordered newest-created
  // first, hid every period before late 2027.
  const invoices = useInvoices(
    { contractId: contract.id, fetchAll: true },
    permissions.can(PERMISSIONS.INVOICES_READ),
  );
  const payments = useContractPayments(contract.id, permissions.can(PERMISSIONS.PAYMENTS_READ));

  // The contract payments tab is intentionally not paginated (see
  // useContractPayments): every allocation must stay in view so a derived
  // balance cannot be understated. Sort that full list in place.
  const {
    sort,
    toggle,
    sorted: sortedPayments,
  } = useTableSort(payments.data ?? [], contractPaymentSortValue);

  return (
    <div className="space-y-4">
      <ContractPortalVisibilityCard contract={contract} units={contractUnits.data ?? []} />
      <div className="grid gap-3 rounded-xl border bg-card p-4 text-sm md:grid-cols-2 lg:grid-cols-4">
        <InfoField label={t("common.code")} value={contract.code} />
        <InfoField
          label={t("contracts.state")}
          value={
            <Badge variant={contractStateTone(contract.state)}>
              {t(`contractState.${contract.state}`)}
            </Badge>
          }
        />
        <InfoField
          label={t("properties.title")}
          value={
            properties.length ? (
              <ul className="space-y-1">
                {properties.map((property) => (
                  <li key={property.id}>
                    <Link
                      to="/admin/properties/$id"
                      params={{ id: property.id }}
                      className="text-primary hover:underline"
                    >
                      {propertyDisplayName(property, locale)}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              "—"
            )
          }
        />
        <InfoField
          label={t("units.title")}
          value={
            contractUnits.data?.length ? (
              <ul className="space-y-1">
                {contractUnits.data.map((detail) => (
                  <li key={detail.unit.id}>
                    <Link
                      to="/admin/units/$id"
                      params={{ id: detail.unit.id }}
                      className="text-primary hover:underline"
                    >
                      {detail.unit.code} — {detail.unit.name ?? detail.unit.type}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              "—"
            )
          }
        />
        <InfoField
          label={t("contracts.freeMonths")}
          value={countActiveFreeMonths(concessions.data ?? [])}
        />
        <InfoField
          label={t("contracts.start")}
          value={<FormattedDate value={contract.start_date} />}
        />
        <InfoField label={t("contracts.end")} value={<FormattedDate value={contract.end_date} />} />
        <InfoField
          label={t("contracts.rent")}
          value={formatKwd(contract.monthly_amount ?? 0, locale)}
        />
      </div>

      <Tabs defaultValue="invoices">
        <TabsList>
          <TabsTrigger value="invoices">{t("contracts.monthlyInvoices")}</TabsTrigger>
          <TabsTrigger value="payments">{t("contracts.monthlyPayments")}</TabsTrigger>
          <TabsTrigger value="partial-payments">{t("partialPayments.title")}</TabsTrigger>
          <TabsTrigger value="contract">{t("contracts.details")}</TabsTrigger>
          <TabsTrigger value="documents">{t("tenants.documents")}</TabsTrigger>
        </TabsList>

        <TabsContent value="invoices">
          <InvoiceRowsTable
            invoices={invoices.data?.items ?? []}
            loading={invoices.isLoading}
            error={Boolean(invoices.error)}
          />
        </TabsContent>

        <TabsContent value="payments">
          <div className="overflow-hidden rounded-xl border bg-card">
            <TableState
              loading={payments.isLoading}
              error={Boolean(payments.error)}
              empty={!payments.data?.length}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 text-muted-foreground">
                      {t("common.rowNumber")}
                    </TableHead>
                    <SortableHead sortKey="code" sort={sort} toggle={toggle}>
                      {t("common.code")}
                    </SortableHead>
                    <SortableHead sortKey="date" sort={sort} toggle={toggle}>
                      {t("payments.date")}
                    </SortableHead>
                    <SortableHead sortKey="method" sort={sort} toggle={toggle}>
                      {t("payments.method")}
                    </SortableHead>
                    {/* Both columns, because they differ whenever a payment was
                        split across two contracts. Showing only the total would
                        have each contract claim the whole payment. */}
                    <SortableHead sortKey="amount" sort={sort} toggle={toggle}>
                      {t("payments.amount")}
                    </SortableHead>
                    <SortableHead sortKey="allocated" sort={sort} toggle={toggle}>
                      {t("payments.allocatedToContract")}
                    </SortableHead>
                    <SortableHead sortKey="state" sort={sort} toggle={toggle}>
                      {t("common.state")}
                    </SortableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedPayments.map((payment, index) => (
                    <TableRow key={payment.id}>
                      <TableCell className="w-10 text-muted-foreground">{index + 1}</TableCell>
                      <TableCell className="font-mono text-xs">{payment.code}</TableCell>
                      <TableCell>
                        <FormattedDate value={payment.payment_date} />
                      </TableCell>
                      <TableCell>{t(`paymentMethod.${payment.method}`)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatAmount(payment.amount ?? 0, locale)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {formatAmount(payment.allocated, locale)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={paymentStatusTone(payment.status)}>
                          {t(`paymentStatus.${payment.status}`)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableState>
          </div>
        </TabsContent>

        <TabsContent value="partial-payments">
          <PartialPaymentsPanel scope={{ contractId: contract.id }} />
        </TabsContent>

        <TabsContent value="contract">
          <div className="grid gap-3 rounded-xl border bg-card p-4 text-sm md:grid-cols-2 lg:grid-cols-4">
            <InfoField label={t("contracts.code")} value={contract.code} ltr />
            <InfoField label={t("common.type")} value={t(`contractType.${contract.type}`)} />
            <InfoField
              label={t("contracts.deposit")}
              value={formatAmount(contract.deposit ?? 0, locale)}
            />
            <InfoField label={t("contracts.dueDay")} value={contract.due_day} />
            <InfoField label={t("contracts.graceDays")} value={contract.grace_days} />
            <InfoField
              label={t("contracts.durationMonths")}
              value={<ContractDurationBadge months={contract.duration_months} />}
            />
            <InfoField
              label={t("contracts.entryDate")}
              value={contract.entry_date ? <FormattedDate value={contract.entry_date} /> : null}
            />
            <div className="md:col-span-2 lg:col-span-2">
              <InfoField
                label={t("concessions.title")}
                value={
                  concessions.isLoading ? (
                    t("common.loading")
                  ) : concessions.data?.length ? (
                    <ul className="space-y-1">
                      {concessions.data.map((concession) => (
                        <li key={concession.id}>
                          {formatConcessionSummary(concession, t, locale)}
                          <span className="text-muted-foreground">
                            {" "}
                            (
                            <FormattedDate value={concession.start_date} empty="" /> —{" "}
                            <FormattedDate value={concession.end_date} empty="" />)
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    t("common.none")
                  )
                }
              />
            </div>
            <div className="md:col-span-2 lg:col-span-4">
              <InfoField label={t("common.notes")} value={contract.notes} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="documents">
          <TenantDocumentsManager
            tenantId={contract.tenant_id}
            companyId={companyId}
            tenant={tenant}
            contractId={contract.id}
            enableShare
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * يلخّص نوع الامتياز وقيمته في سطر واحد لبطاقة تفاصيل العقد.
 */
function formatConcessionSummary(
  concession: Concession,
  t: (key: string) => string,
  locale: string,
): string {
  const typeLabel = t(`concessionType.${concession.type}`);
  if (concession.type === "free_months") {
    return `${typeLabel} (${concession.free_months})`;
  }
  if (concession.type === "percentage_discount" && concession.discount_percent != null) {
    return `${typeLabel} ${formatPercent(concession.discount_percent, locale)}`;
  }
  if (concession.type === "fixed_discount" && concession.discount_amount != null) {
    return `${typeLabel} ${formatKwd(concession.discount_amount, locale)}`;
  }
  return typeLabel;
}
