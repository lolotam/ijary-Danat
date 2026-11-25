import { useMemo } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Printer } from "lucide-react";

import { TableState } from "@/components/admin/Phase2Ui";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { paymentStatusTone } from "@/lib/statusTone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormattedDate } from "@/components/ui/formatted-date";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { useContracts } from "@/hooks/useContracts";
import { useInvoices, useUnitInvoiceIds } from "@/hooks/useInvoices";
import { usePayments, useUnitPaymentIds } from "@/hooks/usePayments";
import { usePermissions } from "@/hooks/usePermissions";
import { useCatalogueLabel } from "@/hooks/useOptionLists";
import { useProperty } from "@/hooks/useProperties";
import { useUnit } from "@/hooks/useUnits";
import { StoreLogoCard } from "@/components/admin/StoreLogoCard";
import { useBrandForUnit } from "@/hooks/useLinkedBrand";
import { useI18n } from "@/i18n/provider";
import {
  unitContractSortValue,
  unitInvoiceSortValue,
  unitPaymentSortValue,
} from "@/lib/adminTableSortValues";
import { formatAmount, formatKwd } from "@/lib/money";
import { PERMISSIONS } from "@/lib/permissions";
import { auditPrint } from "@/lib/exportAudit";

export const Route = createFileRoute("/admin/units/$id")({ component: UnitDetailPage });

function UnitDetailPage() {
  const { id } = Route.useParams();
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const unit = useUnit(id);
  const unitTypeLabel = useCatalogueLabel("unit_types", "unitType");
  const property = useProperty(unit.data?.property_id ?? null);
  const contracts = useContracts({ pageSize: 200 }, permissions.can(PERMISSIONS.CONTRACTS_READ));
  const invoices = useInvoices({ pageSize: 200 }, permissions.can(PERMISSIONS.INVOICES_READ));
  const unitInvoiceIds = useUnitInvoiceIds(id, permissions.can(PERMISSIONS.INVOICES_READ));
  const payments = usePayments({ pageSize: 200 }, permissions.can(PERMISSIONS.PAYMENTS_READ));
  const unitPaymentIds = useUnitPaymentIds(id, permissions.can(PERMISSIONS.PAYMENTS_READ));
  const linkedBrand = useBrandForUnit(id);

  const unitContracts = useMemo(
    () =>
      (contracts.data?.items ?? []).filter((c) => c.units.some((detail) => detail.unit.id === id)),
    [contracts.data, id],
  );
  const active = useMemo(
    () => unitContracts.find((c) => c.state === "active") ?? null,
    [unitContracts],
  );
  // Resolved through invoice_items.unit_id, not invoices.unit_id (NULL for a
  // consolidated multi-unit invoice, migration 112) — otherwise a
  // multi-unit contract's rent has no unit tab it appears under.
  const unitInvoices = useMemo(
    () => (invoices.data?.items ?? []).filter((inv) => unitInvoiceIds.data?.has(inv.id)),
    [invoices.data, unitInvoiceIds.data],
  );
  // Same shape as the invoices tab above, and for the same reason:
  // `payments.unit_id` is copied from `invoices.unit_id`, which is NULL for a
  // consolidated multi-unit invoice — so a multi-unit contract's payments
  // appeared under no unit tab at all. The direct-column check stays for
  // payments that never allocated to an invoice.
  const unitPayments = useMemo(
    () =>
      (payments.data?.items ?? []).filter(
        (p) => p.unit_id === id || unitPaymentIds.data?.has(p.id),
      ),
    [payments.data, id, unitPaymentIds.data],
  );
  const {
    sort: contractSort,
    toggle: toggleContract,
    sorted: sortedContracts,
  } = useTableSort(unitContracts, unitContractSortValue);
  const {
    sort: invoiceSort,
    toggle: toggleInvoice,
    sorted: sortedInvoices,
  } = useTableSort(unitInvoices, unitInvoiceSortValue);
  const {
    sort: paymentSort,
    toggle: togglePayment,
    sorted: sortedPayments,
  } = useTableSort(unitPayments, unitPaymentSortValue);

  if (!permissions.can(PERMISSIONS.UNITS_READ)) {
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  }
  if (unit.isLoading) return <p>{t("common.loading")}</p>;
  if (!unit.data) return <p>{t("common.notFound")}</p>;

  const u = unit.data;
  const propertyName = property.data
    ? locale === "ar"
      ? property.data.name_ar
      : (property.data.name_en ?? property.data.name_ar)
    : "";

  return (
    <div className="space-y-6 print:space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/units">
              <ArrowLeft className="size-4" />
              {t("common.back")}
            </Link>
          </Button>
          <h1 className="mt-1 text-2xl font-semibold">{u.name}</h1>
          <p className="text-sm text-muted-foreground font-mono">{u.code}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            auditPrint("unit", id);
            window.print();
          }}
        >
          <Printer className="size-4" />
          {t("common.print")}
        </Button>
      </div>

      {/* Storefront linked to this unit's contract, with its current tenant. */}
      <StoreLogoCard brand={linkedBrand.data} tenantName={active?.tenant?.name ?? null} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>{u.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{unitTypeLabel(u.type)}</Badge>
              <Badge variant={u.status === "vacant" ? "default" : "secondary"}>{u.status}</Badge>
              {u.area ? <Badge variant="outline">{u.area} m²</Badge> : null}
              <Badge variant="outline">
                {t("units.meterOwnership")}: {u.electricity_meter_ownership}
              </Badge>
            </div>
            {u.paci_no ? (
              <p>
                <span className="text-muted-foreground">{t("units.paciNo")}: </span>
                <span className="font-mono text-xs">{u.paci_no}</span>
              </p>
            ) : null}
            <p>
              <span className="text-muted-foreground">{t("properties.title")}: </span>
              {property.data ? (
                <Link
                  to="/admin/properties/$id"
                  params={{ id: property.data.id }}
                  className="text-primary underline"
                >
                  {propertyName}
                </Link>
              ) : (
                "—"
              )}
            </p>
            <p>
              <span className="text-muted-foreground">{t("units.rent")}: </span>
              {u.default_rent ? formatKwd(u.default_rent, locale) : "—"}
            </p>
            {u.description_ar || u.description_en ? (
              <p className="text-muted-foreground">
                {locale === "ar" ? u.description_ar : (u.description_en ?? u.description_ar)}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("contracts.active")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {active ? (
              <>
                <p className="font-mono text-xs">{active.code}</p>
                <p>
                  <span className="text-muted-foreground">{t("tenants.title")}: </span>
                  {active.tenant ? (
                    <Link
                      to="/admin/tenants/$id"
                      params={{ id: active.tenant.id }}
                      className="text-primary underline"
                    >
                      {active.tenant.name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </p>
                <p>
                  <span className="text-muted-foreground">{t("contracts.period")}: </span>
                  <FormattedDate value={active.start_date} empty="" /> →{" "}
                  <FormattedDate value={active.end_date} />
                </p>
                <p>
                  <span className="text-muted-foreground">{t("contracts.monthly")}: </span>
                  {formatKwd(active.monthly_amount ?? 0, locale)}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">{t("units.noActiveContract")}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="contracts">
        <TabsList>
          <TabsTrigger value="contracts">{t("contracts.title")}</TabsTrigger>
          <TabsTrigger value="invoices">{t("invoices.title")}</TabsTrigger>
          <TabsTrigger value="payments">{t("payments.title")}</TabsTrigger>
        </TabsList>

        <TabsContent value="contracts">
          <TableState
            loading={contracts.isLoading}
            error={Boolean(contracts.error)}
            empty={unitContracts.length === 0}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="code" sort={contractSort} toggle={toggleContract}>
                    {t("common.code")}
                  </SortableHead>
                  <SortableHead sortKey="tenant" sort={contractSort} toggle={toggleContract}>
                    {t("tenants.title")}
                  </SortableHead>
                  <SortableHead sortKey="state" sort={contractSort} toggle={toggleContract}>
                    {t("common.status")}
                  </SortableHead>
                  <SortableHead sortKey="start_date" sort={contractSort} toggle={toggleContract}>
                    {t("contracts.start")}
                  </SortableHead>
                  <SortableHead sortKey="end_date" sort={contractSort} toggle={toggleContract}>
                    {t("contracts.end")}
                  </SortableHead>
                  <SortableHead
                    sortKey="monthly_amount"
                    sort={contractSort}
                    toggle={toggleContract}
                  >
                    {t("contracts.monthly")}
                  </SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedContracts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.code}</TableCell>
                    <TableCell>{c.tenant?.name ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{c.state}</Badge>
                    </TableCell>
                    <TableCell>
                      <FormattedDate value={c.start_date} />
                    </TableCell>
                    <TableCell>
                      <FormattedDate value={c.end_date} />
                    </TableCell>
                    <TableCell>{formatAmount(c.monthly_amount ?? 0, locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableState>
        </TabsContent>

        <TabsContent value="invoices">
          <TableState
            loading={invoices.isLoading || unitInvoiceIds.isLoading}
            error={Boolean(invoices.error) || Boolean(unitInvoiceIds.error)}
            empty={unitInvoices.length === 0}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="code" sort={invoiceSort} toggle={toggleInvoice}>
                    {t("common.code")}
                  </SortableHead>
                  <SortableHead sortKey="period" sort={invoiceSort} toggle={toggleInvoice}>
                    {t("invoices.period")}
                  </SortableHead>
                  <SortableHead sortKey="state" sort={invoiceSort} toggle={toggleInvoice}>
                    {t("common.status")}
                  </SortableHead>
                  <SortableHead sortKey="total" sort={invoiceSort} toggle={toggleInvoice}>
                    {t("invoices.total")}
                  </SortableHead>
                  <SortableHead sortKey="balance" sort={invoiceSort} toggle={toggleInvoice}>
                    {t("invoices.balance")}
                  </SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedInvoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-mono text-xs">{inv.code}</TableCell>
                    <TableCell>
                      {inv.period_year}-{String(inv.period_month).padStart(2, "0")}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{inv.state}</Badge>
                    </TableCell>
                    <TableCell>{formatAmount(inv.total ?? 0, locale)}</TableCell>
                    <TableCell>{formatAmount(inv.balance ?? 0, locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableState>
        </TabsContent>

        <TabsContent value="payments">
          <TableState
            loading={payments.isLoading}
            error={Boolean(payments.error)}
            empty={unitPayments.length === 0}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="code" sort={paymentSort} toggle={togglePayment}>
                    {t("common.code")}
                  </SortableHead>
                  <SortableHead sortKey="method" sort={paymentSort} toggle={togglePayment}>
                    {t("payments.method")}
                  </SortableHead>
                  <SortableHead sortKey="status" sort={paymentSort} toggle={togglePayment}>
                    {t("common.status")}
                  </SortableHead>
                  <SortableHead sortKey="amount" sort={paymentSort} toggle={togglePayment}>
                    {t("payments.amount")}
                  </SortableHead>
                  <SortableHead sortKey="payment_date" sort={paymentSort} toggle={togglePayment}>
                    {t("payments.date")}
                  </SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedPayments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.code}</TableCell>
                    <TableCell>{t(`paymentMethod.${p.method}`)}</TableCell>
                    <TableCell>
                      <Badge variant={paymentStatusTone(p.status)}>
                        {t(`paymentStatus.${p.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatAmount(p.amount ?? 0, locale)}</TableCell>
                    <TableCell>
                      <FormattedDate value={p.payment_date} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableState>
        </TabsContent>
      </Tabs>
    </div>
  );
}
