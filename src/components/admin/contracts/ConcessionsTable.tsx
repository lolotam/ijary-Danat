import { InvoiceDiscountCell } from "@/components/admin/InvoiceDiscountCell";
import { TableState } from "@/components/admin/Phase2Ui";
import { TableActionButton } from "@/components/admin/TableActionButton";
import { FormattedDate } from "@/components/ui/formatted-date";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useConcessionInvoiceCoverage } from "@/hooks/useConcessionInvoices";
import { useConcessions, type Concession } from "@/hooks/useContracts";
import { useI18n } from "@/i18n/provider";
import { calendarMonthsInRange } from "@/lib/concessionColumns";
import { invoiceDiscountBadge } from "@/lib/invoiceDiscountColumn";

type ConcessionsTableProps = {
  concessions: ReturnType<typeof useConcessions>;
  coverage: ReturnType<typeof useConcessionInvoiceCoverage>;
  canUpdate: boolean;
  onDelete: (concession: Concession) => void;
};

/**
 * يعرض جدول تنازلات العقد مع فواتيرها المربوطة وعدد أشهرها ومبلغ خصمها.
 *
 * Takes the queries rather than their data so the loading and error branches
 * stay the dialog's queries, not a second fetch of the same rows.
 */
export function ConcessionsTable({
  concessions,
  coverage,
  canUpdate,
  onDelete,
}: ConcessionsTableProps) {
  const { t, locale } = useI18n();

  /**
   * يبني شارة خصم التنازل من مجموع ما خُصم فعلاً على فواتيره.
   *
   * The same `invoiceDiscountBadge` the invoice tables use, given the money the
   * concession actually took off rather than one invoice's share of it — so a
   * percentage reads "10% 45.000" in both places and can never disagree.
   *
   * Free months have no linked invoices and no money, so the cell is empty;
   * their quantity is the Months column, which is what free months mean. A
   * legacy discount whose invoice link the migration-131 backfill could not
   * resolve is empty for the same reason the invoice column leaves it empty —
   * the amount shown here is always applied money, never a configured setting.
   */
  function discountBadgeFor(concession: Concession) {
    return invoiceDiscountBadge(
      coverage.data?.get(concession.id)?.discountTotal,
      concession,
      locale,
    );
  }

  /**
   * يعدّ أشهر التنازل: الفواتير المربوطة إن وُجدت، وإلا نطاق التاريخ.
   */
  function monthsFor(concession: Concession): number {
    const linked = coverage.data?.get(concession.id);
    if (linked && linked.months > 0) return linked.months;
    if (concession.type === "free_months" && concession.free_months) {
      return concession.free_months;
    }
    return calendarMonthsInRange(concession.start_date, concession.end_date).size;
  }

  return (
    <>
      {/*
        The coverage query counts as an error for this table, not just the
        concessions one. Its rows carry the invoice codes, the month count and
        the discount total, and when it fails those cells quietly fall back to
        "—", a date-derived month count and an empty discount — plausible
        financial coverage that is simply wrong. Refusing the table is the
        only honest rendering of a coverage the page could not read.
      */}
      <TableState
        loading={concessions.isLoading || coverage.isLoading}
        error={Boolean(concessions.error || coverage.error)}
        empty={!concessions.data?.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>{t("common.type")}</TableHead>
              <TableHead>{t("invoices.discount")}</TableHead>
              <TableHead>{t("common.from")}</TableHead>
              <TableHead>{t("common.to")}</TableHead>
              <TableHead>{t("concessions.monthsCount")}</TableHead>
              <TableHead>{t("concessions.invoices")}</TableHead>
              <TableHead>{t("common.status")}</TableHead>
              <TableHead>{t("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {concessions.data?.map((concession, index) => (
              <TableRow key={concession.id}>
                <TableCell>{index + 1}</TableCell>
                <TableCell>{t(`concessionType.${concession.type}`)}</TableCell>
                <TableCell>
                  <InvoiceDiscountCell badge={discountBadgeFor(concession)} locale={locale} />
                </TableCell>
                <TableCell>
                  <FormattedDate value={concession.start_date} />
                </TableCell>
                <TableCell>
                  <FormattedDate value={concession.end_date} />
                </TableCell>
                <TableCell>{monthsFor(concession)}</TableCell>
                <TableCell className="font-mono text-xs">
                  {coverage.data?.get(concession.id)?.codes.join(", ") || "—"}
                </TableCell>
                <TableCell>{t(`concessionStatus.${concession.status}`)}</TableCell>
                <TableCell>
                  <TableActionButton
                    action="delete"
                    disabled={!canUpdate}
                    onClick={() => onDelete(concession)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableState>
    </>
  );
}
