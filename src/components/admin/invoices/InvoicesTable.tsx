import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { BulkMarkPaidBar } from "@/components/admin/BulkMarkPaidBar";
import { EntityLink } from "@/components/admin/EntityLink";
import { copyToClipboard } from "@/components/admin/invoices/copyToClipboard";
import { InvoiceDialogs } from "@/components/admin/invoices/InvoiceDialogs";
import type { KnetLinkInfo } from "@/components/admin/invoices/KnetLinkDialog";
import { InvoiceMonthRowActions } from "@/components/admin/invoices/InvoiceMonthRowActions";
import { InvoicePartialIndicator } from "@/components/shared/InvoicePartialIndicator";
import { InvoicePaidToggleDialog } from "@/components/admin/invoices/InvoicePaidToggleDialog";
import { useInvoicePaidToggle } from "@/components/admin/invoices/useInvoicePaidToggle";
import { useInvoiceSend } from "@/components/admin/invoices/useInvoiceSend";
import {
  groupInvoicesByProperty,
  invoiceMonthStateClass,
} from "@/components/admin/invoices/invoiceMonthGroups";
import { UnitsCell } from "@/components/admin/LocationCells";
import { CardField, MobileCardList } from "@/components/admin/MobileCardList";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createPayment } from "@/fns/createPayment";
import { useCompany } from "@/hooks/useCompany";
import {
  useInvoiceDetails,
  useUpdateInvoiceVisibility,
  type InvoiceWithRelations,
} from "@/hooks/useInvoices";
import { useI18n } from "@/i18n/provider";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";
import { formatPaymentMethod } from "@/lib/paymentMethodDisplay";
import { bulkSelectionHeaderState, isBulkSettleable } from "@/lib/invoiceBulkSelection";
import { knetToastKey } from "@/lib/paymentErrors";
import { formatAmount } from "@/lib/money";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

/**
 * جدول فواتير الشهر مع إجراءات الصف والتعليم الجماعي كمدفوع.
 *
 * Owns row-action dialogs and selection so the route can stay a filter/KPI
 * shell. Mark-paid still goes through `set_invoice_paid` one invoice at a time.
 */
export function InvoicesTable({
  invoices,
  page,
  pageSize,
  canUpdate,
  canCreatePayment,
  isMobile,
}: {
  invoices: InvoiceWithRelations[];
  page: number;
  pageSize: number;
  canUpdate: boolean;
  canCreatePayment: boolean;
  isMobile: boolean;
}) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const company = useCompany();
  const visibility = useUpdateInvoiceVisibility();
  const createKnetPayment = useServerFn(createPayment);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [detailInvoice, setDetailInvoice] = useState<InvoiceWithRelations | null>(null);
  const [printInvoice, setPrintInvoice] = useState<InvoiceWithRelations | null>(null);
  const paidToggle = useInvoicePaidToggle();
  const { paidPending } = paidToggle;
  const send = useInvoiceSend();
  const [knetPending, setKnetPending] = useState<string | null>(null);
  const [knetLink, setKnetLink] = useState<KnetLinkInfo | null>(null);
  const detail = useInvoiceDetails(detailInvoice?.id ?? null);

  const invoiceIdKey = invoices.map((row) => row.id).join(",");
  useEffect(() => {
    setSelectedIds(new Set());
  }, [invoiceIdKey]);

  const {
    sort,
    toggle,
    sorted: sortedInvoices,
  } = useTableSort(invoices, (invoice, key) =>
    key === "tenant"
      ? invoice.tenant
        ? tenantDisplayName(invoice.tenant, locale)
        : null
      : key === "unit"
        ? (invoice.units[0]?.code ?? null)
        : key === "contract"
          ? (invoice.contract?.code ?? null)
          : (invoice as unknown as Record<string, unknown>)[key],
  );

  const grouped = useMemo(
    () => groupInvoicesByProperty(sortedInvoices, locale, t("invoices.noBuilding")),
    [sortedInvoices, t, locale],
  );

  const selectableInvoices = sortedInvoices.filter(isBulkSettleable);
  const headerChecked = bulkSelectionHeaderState(
    selectableInvoices.map((row) => row.id),
    selectedIds,
  );
  const selectedInvoices = sortedInvoices.filter((row) => selectedIds.has(row.id));
  const columnCount = 13 + (canUpdate ? 1 : 0);

  /**
   * يبدّل تحديد صف واحد من الصفوف القابلة للتسوية.
   */
  function toggleSelected(invoiceId: string, checked: boolean | "indeterminate") {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked === true) next.add(invoiceId);
      else next.delete(invoiceId);
      return next;
    });
  }

  /**
   * يحدّد كل الصفوف القابلة للتسوية في الصفحة أو يفرّغها.
   */
  function toggleAllSelectable(checked: boolean | "indeterminate") {
    setSelectedIds(checked === true ? new Set(selectableInvoices.map((row) => row.id)) : new Set());
  }

  const runKnetLink = async (invoice: InvoiceWithRelations) => {
    setKnetPending(invoice.id);
    try {
      const result = await createKnetPayment({
        data: { invoiceIds: [invoice.id], paymentMethod: "KNET" as const },
      });
      const url = (result as { paymentUrl?: string } | null)?.paymentUrl;
      if (!url) throw new Error(t("invoices.knetLinkFailed"));
      // Show the link before trying to copy it. A real payment request exists
      // at the gateway, so the admin must end up with the URL whatever the
      // clipboard does.
      setKnetLink({
        code: invoice.code,
        url,
        tenantId: invoice.tenant_id,
        tenantEmail: invoice.tenant?.email ?? null,
        tenantWhatsapp: invoice.tenant?.whatsapp ?? invoice.tenant?.mobile ?? null,
      });
      await copyToClipboard(url);
    } catch (error) {
      toast.error(t(knetToastKey(error)));
    } finally {
      setKnetPending(null);
    }
  };

  /**
   * يبدّل ظهور الفاتورة للمستأجر من صف الجدول.
   */
  async function toggleVisibility(invoice: InvoiceWithRelations, visible: boolean) {
    try {
      await visibility.mutateAsync({ id: invoice.id, visible });
      toast.success(t("common.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  const invoiceActions = (invoice: InvoiceWithRelations) => (
    <InvoiceMonthRowActions
      invoice={invoice}
      canUpdate={canUpdate}
      canCreatePayment={canCreatePayment}
      paidPending={paidPending === invoice.id}
      knetPending={knetPending === invoice.id}
      onDetails={() => setDetailInvoice(invoice)}
      onTogglePaid={(paid) => paidToggle.requestTogglePaid(invoice, paid)}
      onPrint={() => setPrintInvoice(invoice)}
      onKnet={() => void runKnetLink(invoice)}
      onSend={() => send.openSend(invoice)}
    />
  );

  const selectionCell = (invoice: InvoiceWithRelations) =>
    canUpdate ? (
      <TableCell className="w-10">
        {isBulkSettleable(invoice) ? (
          <Checkbox
            checked={selectedIds.has(invoice.id)}
            onCheckedChange={(checked) => toggleSelected(invoice.id, checked)}
            aria-label={invoice.code}
          />
        ) : null}
      </TableCell>
    ) : null;

  return (
    <div className="space-y-3">
      {canUpdate ? (
        <BulkMarkPaidBar
          selected={selectedInvoices}
          markOne={paidToggle.markOneSelected}
          clear={() => setSelectedIds(new Set())}
          onFinished={() => {
            void queryClient.invalidateQueries({ queryKey: ["invoices"] });
            // Bulk mark-paid settles invoices a staff portal preview may show.
            void invalidatePortalViews(queryClient);
          }}
          disabled={paidPending !== null}
        />
      ) : null}

      {isMobile ? (
        <div className="space-y-4 p-3">
          {canUpdate && selectableInvoices.length > 0 ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={headerChecked}
                onCheckedChange={toggleAllSelectable}
                aria-label={t("common.selectAll")}
              />
              {t("common.selectAll")}
            </label>
          ) : null}
          {grouped.map((group) => (
            <div key={group.propertyId ?? group.label} className="space-y-3">
              <div className="flex justify-center">
                {group.propertyId ? (
                  <EntityLink
                    kind="property"
                    id={group.propertyId}
                    className="rounded-lg bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 px-4 py-1.5 text-center text-sm font-bold text-white no-underline shadow-md hover:text-white hover:opacity-90"
                  >
                    {group.label}
                  </EntityLink>
                ) : (
                  <span className="rounded-lg bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 px-4 py-1.5 text-center text-sm font-bold text-white shadow-md">
                    {group.label}
                  </span>
                )}
              </div>
              <MobileCardList
                items={group.rows}
                keyFor={(row) => row.id}
                renderCard={(invoice) => (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2">
                        {canUpdate && isBulkSettleable(invoice) ? (
                          <Checkbox
                            checked={selectedIds.has(invoice.id)}
                            onCheckedChange={(checked) => toggleSelected(invoice.id, checked)}
                            aria-label={invoice.code}
                          />
                        ) : null}
                        <div className="min-w-0">
                          <p className="truncate font-semibold">
                            {invoice.tenant ? (
                              <EntityLink kind="tenant" id={invoice.tenant_id}>
                                {tenantDisplayName(invoice.tenant, locale)}
                              </EntityLink>
                            ) : (
                              "—"
                            )}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground">{invoice.code}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap justify-end gap-1">
                        <Badge variant="outline" className={invoiceMonthStateClass(invoice.state)}>
                          {t(`invoiceState.${invoice.state}`)}
                        </Badge>
                        <InvoicePartialIndicator
                          state={invoice.state}
                          paid={invoice.paid}
                          total={invoice.total}
                        />
                        {invoice.disputed_at ? (
                          <Badge variant="warning">{t("invoice.disputed")}</Badge>
                        ) : null}
                        {invoice.contract?.archived_at ? (
                          <Badge variant="violet">{t("archive.archivedContract")}</Badge>
                        ) : null}
                      </div>
                    </div>
                    <CardField label={t("invoices.contractCode")}>
                      {invoice.contract?.code ?? "—"}
                    </CardField>
                    <CardField label={t("contracts.unit")}>
                      <UnitsCell units={invoice.units} />
                    </CardField>
                    <CardField label={t("common.total")}>
                      {formatAmount(invoice.total, locale)}
                    </CardField>
                    <CardField label={t("invoices.balance")}>
                      {formatAmount(invoice.balance, locale)}
                    </CardField>
                    <CardField label={t("invoices.dueDate")}>{invoice.due_date}</CardField>
                    <div className="flex items-center justify-between border-t pt-2">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        {t("invoices.visible")}
                        <Switch
                          checked={invoice.is_visible_to_tenant}
                          disabled={!canUpdate || visibility.isPending}
                          onCheckedChange={(visible) => void toggleVisibility(invoice, visible)}
                        />
                      </label>
                      {invoiceActions(invoice)}
                    </div>
                  </>
                )}
              />
            </div>
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {canUpdate ? (
                <TableHead className="w-10">
                  <Checkbox
                    checked={headerChecked}
                    disabled={selectableInvoices.length === 0}
                    onCheckedChange={toggleAllSelectable}
                    aria-label={t("common.selectAll")}
                  />
                </TableHead>
              ) : null}
              <TableHead>{t("common.rowNumber")}</TableHead>
              <SortableHead sortKey="code" sort={sort} toggle={toggle}>
                {t("common.code")}
              </SortableHead>
              <SortableHead sortKey="contract" sort={sort} toggle={toggle}>
                {t("invoices.contractCode")}
              </SortableHead>
              <SortableHead sortKey="tenant" sort={sort} toggle={toggle}>
                {t("contracts.tenant")}
              </SortableHead>
              <SortableHead sortKey="unit" sort={sort} toggle={toggle}>
                {t("contracts.unit")}
              </SortableHead>
              <SortableHead sortKey="total" sort={sort} toggle={toggle}>
                {t("common.total")}
              </SortableHead>
              <SortableHead sortKey="paid" sort={sort} toggle={toggle}>
                {t("invoices.paid")}
              </SortableHead>
              <SortableHead sortKey="balance" sort={sort} toggle={toggle}>
                {t("invoices.balance")}
              </SortableHead>
              <SortableHead sortKey="state" sort={sort} toggle={toggle}>
                {t("invoices.state")}
              </SortableHead>
              <TableHead>{t("invoices.paymentMethod")}</TableHead>
              <SortableHead sortKey="due_date" sort={sort} toggle={toggle}>
                {t("invoices.dueDate")}
              </SortableHead>
              <TableHead>{t("invoices.visible")}</TableHead>
              <TableHead>{t("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grouped.map((group) => (
              <>
                <TableRow key={`header-${group.propertyId ?? group.label}`} className="border-b-0">
                  <TableCell colSpan={columnCount} className="bg-transparent py-3">
                    <div className="flex justify-center">
                      {group.propertyId ? (
                        <EntityLink
                          kind="property"
                          id={group.propertyId}
                          className="rounded-lg bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 px-6 py-1.5 text-center text-sm font-bold text-white no-underline shadow-md hover:text-white hover:opacity-90"
                        >
                          {group.label}
                        </EntityLink>
                      ) : (
                        <span className="rounded-lg bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 px-6 py-1.5 text-center text-sm font-bold text-white shadow-md">
                          {group.label}
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                {group.rows.map((invoice) => {
                  const index = invoices.findIndex((row) => row.id === invoice.id);
                  return (
                    <TableRow key={invoice.id}>
                      {selectionCell(invoice)}
                      <TableCell>{(page - 1) * pageSize + index + 1}</TableCell>
                      <TableCell className="font-mono font-medium">{invoice.code}</TableCell>
                      <TableCell className="font-mono">{invoice.contract?.code ?? "—"}</TableCell>
                      <TableCell>
                        {invoice.tenant ? (
                          <EntityLink kind="tenant" id={invoice.tenant_id}>
                            {tenantDisplayName(invoice.tenant, locale)}
                          </EntityLink>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <UnitsCell units={invoice.units} />
                      </TableCell>
                      <TableCell>{formatAmount(invoice.total, locale)}</TableCell>
                      <TableCell>{formatAmount(invoice.paid, locale)}</TableCell>
                      <TableCell>{formatAmount(invoice.balance, locale)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge
                            variant="outline"
                            className={invoiceMonthStateClass(invoice.state)}
                          >
                            {t(`invoiceState.${invoice.state}`)}
                          </Badge>
                          <InvoicePartialIndicator
                            state={invoice.state}
                            paid={invoice.paid}
                            total={invoice.total}
                          />
                          {invoice.disputed_at ? (
                            <Badge variant="warning">{t("invoice.disputed")}</Badge>
                          ) : null}
                          {invoice.contract?.archived_at ? (
                            <Badge variant="violet">{t("archive.archivedContract")}</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        {invoice.payment_method
                          ? formatPaymentMethod(invoice.payment_method, t)
                          : null}
                      </TableCell>
                      <TableCell>{invoice.due_date}</TableCell>
                      <TableCell>
                        <Switch
                          checked={invoice.is_visible_to_tenant}
                          disabled={!canUpdate || visibility.isPending}
                          onCheckedChange={(visible) => void toggleVisibility(invoice, visible)}
                        />
                      </TableCell>
                      <TableCell>{invoiceActions(invoice)}</TableCell>
                    </TableRow>
                  );
                })}
              </>
            ))}
          </TableBody>
        </Table>
      )}

      <InvoicePaidToggleDialog toggle={paidToggle} />

      <InvoiceDialogs
        sendInvoice={send.sendInvoice}
        sendChannels={send.sendChannels}
        sendPending={send.sendPending}
        onSendChannelsChange={send.setSendChannels}
        onSend={() => void send.runSend()}
        onCloseSend={send.closeSend}
        knetLink={knetLink}
        onCloseKnet={() => setKnetLink(null)}
        printInvoice={printInvoice}
        company={company.data ?? null}
        onClosePrint={() => setPrintInvoice(null)}
        detailInvoice={detailInvoice}
        detail={detail}
        onCloseDetail={() => setDetailInvoice(null)}
      />
    </div>
  );
}
