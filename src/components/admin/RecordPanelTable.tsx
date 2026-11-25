import { Link } from "@tanstack/react-router";

import { EntityLink } from "@/components/admin/EntityLink";
import { RecordPanelRowActions } from "@/components/admin/RecordPanelRowActions";
import { SortableHead, type SortState } from "@/components/admin/SortableTable";
import { CardField, MobileCardList } from "@/components/admin/MobileCardList";
import { Badge } from "@/components/ui/badge";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MoneyRecord } from "@/hooks/useRefunds";
import { useI18n } from "@/i18n/provider";
import { formatAmount } from "@/lib/money";

export type RecordPanelContractEntry = {
  code: string;
  complexName: string | null;
  propertyId: string | null;
  tenantId: string;
  tenantName: string | null;
  unitId: string | null;
  unitName: string | null;
};

type LinkedInvoice = {
  code: string;
  period_month: number;
  period_year: number;
};

/**
 * يقرأ الفاتورة المرتبطة كما أعادها PostgREST من التضمين.
 */
function linkedInvoiceOf(row: MoneyRecord): LinkedInvoice | null {
  const invoice = row.invoice;
  if (!invoice || typeof invoice !== "object") return null;
  const candidate = invoice as Partial<LinkedInvoice>;
  if (typeof candidate.code !== "string") return null;
  if (typeof candidate.period_year !== "number" || typeof candidate.period_month !== "number") {
    return null;
  }
  return {
    code: candidate.code,
    period_year: candidate.period_year,
    period_month: candidate.period_month,
  };
}

/**
 * جدول سجلات الاسترداد / الدفعات الجزئية / التأمين مع أعمدة اختيارية للفاتورة والحالة.
 */
export function RecordPanelTable({
  sortedRows,
  sort,
  toggle,
  dateColumn,
  showContractColumns,
  showInvoiceColumns,
  showRowNumber,
  contractFor,
  canUpdate,
  canDelete,
  isMobile,
  onEdit,
  onDelete,
}: {
  sortedRows: MoneyRecord[];
  sort: SortState;
  toggle: (key: string) => void;
  dateColumn: string;
  showContractColumns: boolean;
  showInvoiceColumns: boolean;
  showRowNumber: boolean;
  contractFor: (row: MoneyRecord) => RecordPanelContractEntry | undefined;
  canUpdate: boolean;
  canDelete: boolean;
  isMobile: boolean;
  onEdit: (row: MoneyRecord) => void;
  onDelete: (row: MoneyRecord) => void;
}) {
  const { t, locale } = useI18n();

  /**
   * أزرار الصف. تعديل الدفعة الجزئية المسدَّدة مسموح بعد القرار D3′.
   */
  function actionsFor(row: MoneyRecord) {
    return (
      <RecordPanelRowActions
        locked={false}
        canUpdate={canUpdate}
        canDelete={canDelete}
        isMobile={isMobile}
        onEdit={() => onEdit(row)}
        onDelete={() => onDelete(row)}
        deleteWarning={
          showInvoiceColumns && linkedInvoiceOf(row)
            ? t("partialPayments.deleteUnsettles")
            : undefined
        }
      />
    );
  }

  if (isMobile) {
    return (
      <MobileCardList
        items={sortedRows}
        keyFor={(row) => row.id}
        renderCard={(row) => {
          const index = sortedRows.findIndex((item) => item.id === row.id);
          const contractEntry = contractFor(row);
          const invoice = linkedInvoiceOf(row);
          return (
            <div className="space-y-2">
              {showRowNumber ? (
                <CardField label={t("common.rowNumber")}>{index + 1}</CardField>
              ) : null}
              {showContractColumns && (
                <>
                  <CardField label={t("payments.contract")}>{contractEntry?.code ?? "—"}</CardField>
                  <CardField label={t("contracts.tenant")}>
                    {contractEntry?.tenantName ? (
                      <EntityLink kind="tenant" id={contractEntry.tenantId}>
                        {contractEntry.tenantName}
                      </EntityLink>
                    ) : (
                      "—"
                    )}
                  </CardField>
                  <CardField label={t("contracts.unit")}>
                    {contractEntry?.unitName ? (
                      <EntityLink kind="unit" id={contractEntry.unitId}>
                        {contractEntry.unitName}
                      </EntityLink>
                    ) : (
                      "—"
                    )}
                  </CardField>
                  <CardField label={t("insurance.complex")}>
                    {contractEntry?.complexName ? (
                      <EntityLink kind="property" id={contractEntry.propertyId}>
                        {contractEntry.complexName}
                      </EntityLink>
                    ) : (
                      "—"
                    )}
                  </CardField>
                </>
              )}
              {showInvoiceColumns ? (
                <>
                  <CardField label={t("partialPayments.invoice")}>
                    {invoice ? (
                      <Link
                        to="/admin/invoices"
                        search={{ year: invoice.period_year, month: invoice.period_month }}
                        className="text-primary underline underline-offset-2 hover:text-primary/80"
                      >
                        {invoice.code}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </CardField>
                  <CardField label={t("partialPayments.status")}>
                    {typeof row.status === "string" ? t(`partialPaymentStatus.${row.status}`) : "—"}
                  </CardField>
                </>
              ) : null}
              <CardField label={t("payments.amount")}>
                <LtrText>{formatAmount(Number(row.amount), locale)}</LtrText>
              </CardField>
              <CardField label={t("common.date")}>
                <LtrText>{String(row[dateColumn] ?? "")}</LtrText>
              </CardField>
              {row.note ? <CardField label={t("common.notes")}>{row.note}</CardField> : null}
              {actionsFor(row)}
            </div>
          );
        }}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {showRowNumber ? (
            <TableHead className="w-10 text-muted-foreground">{t("common.rowNumber")}</TableHead>
          ) : null}
          <SortableHead sortKey="date" sort={sort} toggle={toggle}>
            {t("common.date")}
          </SortableHead>
          {showContractColumns && (
            <>
              <SortableHead sortKey="contract" sort={sort} toggle={toggle}>
                {t("payments.contract")}
              </SortableHead>
              <SortableHead sortKey="tenant" sort={sort} toggle={toggle}>
                {t("contracts.tenant")}
              </SortableHead>
              <SortableHead sortKey="unit" sort={sort} toggle={toggle}>
                {t("contracts.unit")}
              </SortableHead>
              <SortableHead sortKey="complex" sort={sort} toggle={toggle}>
                {t("insurance.complex")}
              </SortableHead>
            </>
          )}
          {showInvoiceColumns ? (
            <>
              <SortableHead sortKey="invoice" sort={sort} toggle={toggle}>
                {t("partialPayments.invoice")}
              </SortableHead>
              <SortableHead sortKey="status" sort={sort} toggle={toggle}>
                {t("partialPayments.status")}
              </SortableHead>
            </>
          ) : null}
          <SortableHead sortKey="amount" sort={sort} toggle={toggle}>
            {t("payments.amount")}
          </SortableHead>
          <SortableHead sortKey="note" sort={sort} toggle={toggle}>
            {t("common.notes")}
          </SortableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedRows.map((row, index) => {
          const contractEntry = contractFor(row);
          const invoice = linkedInvoiceOf(row);
          return (
            <TableRow key={row.id}>
              {showRowNumber ? (
                <TableCell className="w-10 text-muted-foreground">{index + 1}</TableCell>
              ) : null}
              <TableCell>
                <LtrText>{String(row[dateColumn] ?? "")}</LtrText>
              </TableCell>
              {showContractColumns && (
                <>
                  <TableCell>
                    <LtrText>{contractEntry?.code ?? "—"}</LtrText>
                  </TableCell>
                  <TableCell>
                    {contractEntry?.tenantName ? (
                      <EntityLink kind="tenant" id={contractEntry.tenantId}>
                        {contractEntry.tenantName}
                      </EntityLink>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {contractEntry?.unitName ? (
                      <EntityLink kind="unit" id={contractEntry.unitId}>
                        {contractEntry.unitName}
                      </EntityLink>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {contractEntry?.complexName ? (
                      <EntityLink kind="property" id={contractEntry.propertyId}>
                        {contractEntry.complexName}
                      </EntityLink>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </>
              )}
              {showInvoiceColumns ? (
                <>
                  <TableCell>
                    {invoice ? (
                      <Link
                        to="/admin/invoices"
                        search={{ year: invoice.period_year, month: invoice.period_month }}
                        className="text-primary underline underline-offset-2 hover:text-primary/80"
                      >
                        {invoice.code}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {typeof row.status === "string" ? (
                      <Badge variant={row.status === "complete" ? "secondary" : "outline"}>
                        {t(`partialPaymentStatus.${row.status}`)}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </>
              ) : null}
              <TableCell>
                <LtrText>{formatAmount(Number(row.amount), locale)}</LtrText>
              </TableCell>
              <TableCell>{row.note ?? "—"}</TableCell>
              <TableCell>{actionsFor(row)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
