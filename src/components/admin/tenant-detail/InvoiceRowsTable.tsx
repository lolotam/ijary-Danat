import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { BulkMarkPaidBar } from "@/components/admin/BulkMarkPaidBar";
import { InvoiceDiscountCell } from "@/components/admin/InvoiceDiscountCell";
import { InvoiceRowActions } from "@/components/admin/InvoiceRowActions";
import { InvoicePartialIndicator } from "@/components/shared/InvoicePartialIndicator";
import { KnetLinkDialog, type KnetLinkInfo } from "@/components/admin/invoices/KnetLinkDialog";
import { InvoicePaidToggleDialog } from "@/components/admin/invoices/InvoicePaidToggleDialog";
import { useInvoicePaidToggle } from "@/components/admin/invoices/useInvoicePaidToggle";
import { useInvoiceSend } from "@/components/admin/invoices/useInvoiceSend";
import { PropertiesCell, UnitsCell } from "@/components/admin/LocationCells";
import { TableState } from "@/components/admin/Phase2Ui";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormattedDate } from "@/components/ui/formatted-date";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
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
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";
import { useInvoiceDiscounts } from "@/hooks/useInvoiceDiscounts";
import { invoiceDiscountBadge } from "@/lib/invoiceDiscountColumn";
import { tenantInvoiceSortValue } from "@/lib/adminTableSortValues";
import { bulkSelectionHeaderState, isBulkSettleable } from "@/lib/invoiceBulkSelection";
import { formatAmount } from "@/lib/money";
import { PERMISSIONS } from "@/lib/permissions";
import { invoiceStateTone } from "@/lib/statusTone";

/**
 * An invoice list, rendered the same way whether it covers one contract or all
 * of a tenant's. Callers differ only in which invoices they hand over.
 *
 * Action column mirrors the main Monthly Invoices rules, with Print restricted
 * to paid invoices and Generate-link restricted to unpaid/due/overdue rows.
 * Mark paid/unpaid uses the same `set_invoice_paid` server path as that page.
 */
export function InvoiceRowsTable({
  invoices,
  loading,
  error,
}: {
  invoices: InvoiceWithRelations[];
  loading: boolean;
  error: boolean;
}) {
  const { t, locale } = useI18n();
  // Keyed by the ids on screen, so a paginated table does not fetch links for
  // invoices it is not showing.
  const discounts = useInvoiceDiscounts(invoices.map((invoice) => invoice.id));
  const permissions = usePermissions();
  const company = useCompany();
  const queryClient = useQueryClient();
  const createKnetPayment = useServerFn(createPayment);

  const paidToggle = useInvoicePaidToggle();
  const { paidPending } = paidToggle;
  const { sendInvoice, sendChannels, setSendChannels, sendPending, openSend, closeSend, runSend } =
    useInvoiceSend();
  const [knetPending, setKnetPending] = useState<string | null>(null);
  const [knetLink, setKnetLink] = useState<KnetLinkInfo | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const canTogglePaid = permissions.can(PERMISSIONS.INVOICES_UPDATE);

  // Sorts the loaded page in place; the table is paginated by its callers and
  // the primitive's documented behaviour is page-local sort (no order param).
  // Oldest due date first so the numbering column starts at the invoice that
  // should be settled first (T10).
  const {
    sort,
    toggle,
    sorted: sortedInvoices,
  } = useTableSort(invoices, tenantInvoiceSortValue, {
    key: "due_date",
    direction: "asc",
  });

  const invoiceIdKey = invoices.map((row) => row.id).join(",");
  useEffect(() => {
    setSelectedIds(new Set());
  }, [invoiceIdKey]);

  const selectableInvoices = sortedInvoices.filter(isBulkSettleable);
  const headerChecked = bulkSelectionHeaderState(
    selectableInvoices.map((row) => row.id),
    selectedIds,
  );
  const selectedInvoices = sortedInvoices.filter((row) => selectedIds.has(row.id));

  /**
   * يبدّل تحديد صف واحد من الصفوف القابلة للتسوية فقط.
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
   * يحدّد كل الصفوف القابلة للتسوية في الصفحة الحالية أو يفرّغها.
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
      // Show the link before trying to copy — a gateway request already exists.
      setKnetLink({
        code: invoice.code,
        url,
        tenantId: invoice.tenant_id,
        tenantEmail: invoice.tenant?.email ?? null,
        tenantWhatsapp: invoice.tenant?.whatsapp ?? invoice.tenant?.mobile ?? null,
      });
      await copyToClipboard(url);
    } catch (err) {
      toast.error(
        isChronologicalOrderRefusal(err)
          ? t("invoices.knetLinkOutOfOrder")
          : knetErrorMessage(err) || t("invoices.knetLinkFailed"),
      );
    } finally {
      setKnetPending(null);
    }
  };

  return (
    <div className="space-y-3">
      {canTogglePaid ? (
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
      <div className="overflow-hidden rounded-xl border bg-card">
        <TableState loading={loading} error={error} empty={!invoices.length}>
          <Table>
            <TableHeader>
              <TableRow>
                {canTogglePaid ? (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={headerChecked}
                      disabled={selectableInvoices.length === 0}
                      onCheckedChange={toggleAllSelectable}
                      aria-label={t("common.selectAll")}
                    />
                  </TableHead>
                ) : null}
                <TableHead className="w-10 text-muted-foreground">
                  {t("common.rowNumber")}
                </TableHead>
                <SortableHead sortKey="code" sort={sort} toggle={toggle}>
                  {t("common.code")}
                </SortableHead>
                <SortableHead sortKey="properties" sort={sort} toggle={toggle}>
                  {t("properties.title")}
                </SortableHead>
                <SortableHead sortKey="units" sort={sort} toggle={toggle}>
                  {t("units.title")}
                </SortableHead>
                <SortableHead sortKey="period" sort={sort} toggle={toggle}>
                  {t("invoices.period")}
                </SortableHead>
                <SortableHead sortKey="due_date" sort={sort} toggle={toggle}>
                  {t("invoices.dueDate")}
                </SortableHead>
                <SortableHead sortKey="state" sort={sort} toggle={toggle}>
                  {t("common.state")}
                </SortableHead>
                <SortableHead sortKey="discount" sort={sort} toggle={toggle}>
                  {t("invoices.discount")}
                </SortableHead>
                <SortableHead sortKey="total" sort={sort} toggle={toggle}>
                  {t("invoices.total")}
                </SortableHead>
                <SortableHead sortKey="balance" sort={sort} toggle={toggle}>
                  {t("invoices.balance")}
                </SortableHead>
                {/* Actions: per-row buttons, no defined order. */}
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedInvoices.map((invoice, index) => (
                <TableRow key={invoice.id}>
                  {canTogglePaid ? (
                    <TableCell className="w-10">
                      {isBulkSettleable(invoice) ? (
                        <Checkbox
                          checked={selectedIds.has(invoice.id)}
                          onCheckedChange={(checked) => toggleSelected(invoice.id, checked)}
                          aria-label={invoice.code}
                        />
                      ) : null}
                    </TableCell>
                  ) : null}
                  <TableCell className="w-10 text-muted-foreground">{index + 1}</TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link
                      to="/admin/invoices"
                      search={{ year: invoice.period_year, month: invoice.period_month }}
                      className="text-primary underline underline-offset-2 hover:text-primary/80"
                    >
                      {invoice.code}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <PropertiesCell properties={invoice.properties} />
                  </TableCell>
                  <TableCell>
                    <UnitsCell units={invoice.units} />
                  </TableCell>
                  <TableCell>
                    {invoice.period_year}-{String(invoice.period_month).padStart(2, "0")}
                  </TableCell>
                  <TableCell>
                    <FormattedDate value={invoice.due_date} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={invoiceStateTone(invoice.state)}>
                        {t(`invoiceState.${invoice.state}`)}
                      </Badge>
                      <InvoicePartialIndicator
                        state={invoice.state}
                        paid={invoice.paid}
                        total={invoice.total}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <InvoiceDiscountCell
                      locale={locale}
                      badge={invoiceDiscountBadge(
                        invoice.discount,
                        discounts.data?.get(invoice.id) ?? null,
                        locale,
                      )}
                    />
                  </TableCell>
                  <TableCell>{formatAmount(invoice.total ?? 0, locale)}</TableCell>
                  <TableCell>{formatAmount(invoice.balance ?? 0, locale)}</TableCell>
                  <TableCell>
                    <InvoiceRowActions
                      invoice={invoice}
                      company={company.data ?? null}
                      handlers={{
                        canSend: permissions.can(PERMISSIONS.INVOICES_UPDATE),
                        canGenerateLink: permissions.can(PERMISSIONS.PAYMENTS_CREATE),
                        canTogglePaid: permissions.can(PERMISSIONS.INVOICES_UPDATE),
                        knetPending: knetPending === invoice.id,
                        paidPending: paidPending === invoice.id,
                        onSend: openSend,
                        onGenerateLink: (row) => void runKnetLink(row),
                        onTogglePaid: (row, nextPaid) =>
                          paidToggle.requestTogglePaid(row, nextPaid),
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableState>
      </div>

      {/*
        Mounted beside the other dialogs, never inside one: `DialogContent`
        renders through a Radix portal that unmounts with its root, so a dialog
        nested in another dialog's content only exists while that outer one is
        open.
      */}
      <InvoicePaidToggleDialog toggle={paidToggle} />

      <Dialog open={Boolean(sendInvoice)} onOpenChange={(open) => !open && closeSend()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("invoices.sendTitle").replace("{code}", sendInvoice?.code ?? "")}
            </DialogTitle>
            <DialogDescription>{t("invoices.sendDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex items-center gap-3 rounded-lg border p-3">
              <Checkbox
                checked={sendChannels.email}
                disabled={!sendInvoice?.tenant?.email}
                onCheckedChange={(checked) =>
                  setSendChannels((prev) => ({ ...prev, email: checked === true }))
                }
              />
              <div className="min-w-0">
                <Label className="font-medium">{t("invoices.channelEmail")}</Label>
                <p className="truncate text-xs text-muted-foreground">
                  {sendInvoice?.tenant?.email ?? t("invoices.noEmail")}
                </p>
              </div>
            </label>
            <label className="flex items-center gap-3 rounded-lg border p-3">
              <Checkbox
                checked={sendChannels.whatsapp}
                disabled={!(sendInvoice?.tenant?.whatsapp ?? sendInvoice?.tenant?.mobile)}
                onCheckedChange={(checked) =>
                  setSendChannels((prev) => ({ ...prev, whatsapp: checked === true }))
                }
              />
              <div className="min-w-0">
                <Label className="font-medium">{t("invoices.channelWhatsapp")}</Label>
                <LtrText as="p" className="truncate text-xs text-muted-foreground">
                  {sendInvoice?.tenant?.whatsapp ??
                    sendInvoice?.tenant?.mobile ??
                    t("invoices.noWhatsapp")}
                </LtrText>
              </div>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => closeSend()}>
              {t("common.cancel")}
            </Button>
            <Button disabled={sendPending} onClick={() => void runSend()}>
              {sendPending ? <RefreshCw className="size-4 animate-spin" /> : t("invoices.send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <KnetLinkDialog link={knetLink} onClose={() => setKnetLink(null)} />
    </div>
  );
}

/**
 * `navigator.clipboard.writeText` can hang forever when the document is
 * unfocused — race it so the spinner always clears.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), 2000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

function knetErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      data?: unknown;
      body?: unknown;
      response?: { status?: number; data?: unknown };
    };
    for (const value of [
      candidate.message,
      candidate.data,
      candidate.body,
      candidate.response?.data,
    ]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return String(error ?? "");
}

function isChronologicalOrderRefusal(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    response?: { status?: number };
  } | null;
  if (candidate?.status === 409 || candidate?.response?.status === 409) return true;
  return knetErrorMessage(error).toLowerCase().includes("chronological");
}
