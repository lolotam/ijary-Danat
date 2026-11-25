import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";

import { PartialPaymentsPanel } from "@/components/admin/PaymentSidePanels";
import { TableState } from "@/components/admin/Phase2Ui";
import { InvoiceRowsTable } from "@/components/admin/tenant-detail/InvoiceRowsTable";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { TenantDocumentsManager } from "@/components/admin/TenantDocumentsManager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { Contract } from "@/hooks/useContracts";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import type { Tenant } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import { formatAmount } from "@/lib/money";
import { contractStateTone, paymentStatusTone } from "@/lib/statusTone";
import { tenantWidePaymentSortValue } from "@/lib/adminTableSortValues";

interface PagedResult<T> {
  items: T[];
  count: number;
}

/**
 * Everything the tenant detail page needs to show a tenant's position, whether
 * combined or split by contract. Shared with `TenantContractTabs`, which
 * forwards the lot unchanged.
 */
export interface TenantDetailTabsProps {
  tenantId: string;
  tenant: Tenant;
  companyId: string | null;
  contracts: Pick<UseQueryResult, "isLoading" | "error">;
  tenantContracts: Contract[];
  invoices: UseQueryResult<PagedResult<InvoiceWithRelations>>;
  payments: UseQueryResult<PagedResult<Tables<"payments">>>;
}

/**
 * The tenant's whole position in one place — every invoice, payment, contract
 * and document across all of their contracts combined.
 *
 * This is what the page showed before contracts got their own tabs, kept
 * intact: the per-contract tabs answer "what happened on this lease", and this
 * one answers "what does this tenant owe us in total", which no single contract
 * tab can.
 */
export function TenantWideTabs({
  tenantId,
  tenant,
  companyId,
  contracts,
  tenantContracts,
  invoices,
  payments,
}: TenantDetailTabsProps) {
  const { t, locale } = useI18n();

  // Sorts the loaded page; the tab is paginated by the caller and the
  // primitive sorts the page it has rather than pushing an order param.
  const paymentRows = payments.data?.items ?? [];
  const {
    sort,
    toggle,
    sorted: sortedPayments,
  } = useTableSort(paymentRows, tenantWidePaymentSortValue);

  return (
    <Tabs defaultValue="invoices">
      <TabsList>
        <TabsTrigger value="invoices">{t("invoices.title")}</TabsTrigger>
        <TabsTrigger value="payments">{t("payments.title")}</TabsTrigger>
        <TabsTrigger value="partial-payments">{t("partialPayments.title")}</TabsTrigger>
        <TabsTrigger value="contracts">{t("contracts.title")}</TabsTrigger>
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
            empty={!payments.data?.items.length}
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
                  <SortableHead sortKey="amount" sort={sort} toggle={toggle}>
                    {t("payments.amount")}
                  </SortableHead>
                  <SortableHead sortKey="state" sort={sort} toggle={toggle}>
                    {t("common.state")}
                  </SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedPayments.map((p, index) => (
                  <TableRow key={p.id}>
                    <TableCell className="w-10 text-muted-foreground">{index + 1}</TableCell>
                    <TableCell className="font-mono text-xs">{p.code}</TableCell>
                    <TableCell>
                      <FormattedDate value={p.payment_date} />
                    </TableCell>
                    <TableCell>{t(`paymentMethod.${p.method}`)}</TableCell>
                    <TableCell>{formatAmount(p.amount ?? 0, locale)}</TableCell>
                    <TableCell>
                      <Badge variant={paymentStatusTone(p.status)}>
                        {t(`paymentStatus.${p.status}`)}
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
        <PartialPaymentsPanel scope={{ tenantId }} />
      </TabsContent>
      <TabsContent value="contracts">
        <div className="overflow-hidden rounded-xl border bg-card">
          <TableState
            loading={contracts.isLoading}
            error={Boolean(contracts.error)}
            empty={!tenantContracts.length}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.code")}</TableHead>
                  <TableHead>{t("common.state")}</TableHead>
                  <TableHead>{t("contracts.start")}</TableHead>
                  <TableHead>{t("contracts.end")}</TableHead>
                  <TableHead>{t("contracts.rent")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenantContracts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.code}</TableCell>
                    <TableCell>
                      <Badge variant={contractStateTone(c.state)}>
                        {t(`contractState.${c.state}`)}
                      </Badge>
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
        </div>
      </TabsContent>
      <TabsContent value="documents" className="space-y-3">
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/tenants/$id/documents" params={{ id: tenantId }}>
              <ExternalLink className="size-4" />
              {t("tenants.openDocumentsPage")}
            </Link>
          </Button>
        </div>
        <TenantDocumentsManager
          tenantId={tenantId}
          companyId={companyId}
          tenant={tenant}
          enableShare
        />
      </TabsContent>
    </Tabs>
  );
}
