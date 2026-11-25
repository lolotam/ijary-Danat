import { Ban, CreditCard, Printer } from "lucide-react";

import { EntityLink } from "@/components/admin/EntityLink";
import { CardField, MobileCardList } from "@/components/admin/MobileCardList";
import { SortableHead, type useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import type { PaymentWithTenant } from "@/hooks/usePayments";
import { useI18n } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";
import { formatPaymentMethod } from "@/lib/paymentMethodDisplay";
import { paymentStatusTone } from "@/lib/statusTone";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

type TableSort = ReturnType<typeof useTableSort<PaymentWithTenant>>;

export interface PaymentsTableProps {
  /** صفوف الصفحة كما وصلت — تعرضها بطاقات الجوال. */
  items: PaymentWithTenant[];
  /** الصفوف نفسها بعد فرز الأعمدة — يعرضها الجدول المكتبي. */
  sortedItems: PaymentWithTenant[];
  sort: TableSort["sort"];
  toggle: TableSort["toggle"];
  page: number;
  pageSize: number;
  canReverse: boolean;
  onAllocate: (payment: PaymentWithTenant) => void;
  onPrint: (payment: PaymentWithTenant) => void;
  onReverse: (payment: PaymentWithTenant) => void;
}

/**
 * جدول الدفعات الكاملة: بطاقات على الجوال وجدول قابل للفرز على المكتب، مع أزرار الصف.
 *
 * Extracted verbatim from `FullPaymentsPanel` (audit M13, plan row 6.5). The
 * panel keeps the state; this renders it and reports which row action was
 * pressed. The mobile cards read `items` and the desktop table `sortedItems`,
 * exactly as before — column sorting only ever applied to the desktop table.
 */
export function PaymentsTable({
  items,
  sortedItems,
  sort,
  toggle,
  page,
  pageSize,
  canReverse,
  onAllocate,
  onPrint,
  onReverse,
}: PaymentsTableProps) {
  const { locale, t } = useI18n();
  const isMobile = useIsMobile();
  return isMobile ? (
    <div className="p-3">
      <MobileCardList
        items={items}
        keyFor={(x) => x.id}
        renderCard={(payment) => (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold">
                  {payment.tenant ? (
                    <EntityLink kind="tenant" id={payment.tenant_id}>
                      {tenantDisplayName(payment.tenant, locale)}
                    </EntityLink>
                  ) : (
                    "—"
                  )}
                </p>
                <p className="font-mono text-xs text-muted-foreground">{payment.code}</p>
              </div>
              <Badge variant={paymentStatusTone(payment.status)}>
                {t(`paymentStatus.${payment.status}`)}
              </Badge>
            </div>
            <CardField label={t("common.amount")}>
              {formatKwd(payment.amount, locale, payment.currency)}
            </CardField>
            <CardField label={t("payments.method")}>
              {formatPaymentMethod(payment.method, t)}
            </CardField>
            <CardField label={t("payments.date")}>{payment.payment_date}</CardField>
            <CardField label={t("payments.createdTime")}>
              {payment.created_at ? new Date(payment.created_at).toLocaleString("en-GB") : "—"}
            </CardField>
            {payment.status === "confirmed" && (
              <div className="flex justify-end gap-1 border-t pt-2">
                <Button
                  title={t("payments.allocate")}
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    onAllocate(payment);
                  }}
                >
                  <CreditCard className="size-4" />
                  <span className="sr-only">{t("payments.allocate")}</span>
                </Button>
                <Button
                  title={t("payments.printDocument")}
                  variant="ghost"
                  size="icon"
                  onClick={() => onPrint(payment)}
                >
                  <Printer className="size-4" />
                  <span className="sr-only">{t("payments.printDocument")}</span>
                </Button>
                {canReverse && (
                  <Button
                    title={t("payments.reverse")}
                    variant="ghost"
                    size="icon"
                    className="text-destructive"
                    onClick={() => onReverse(payment)}
                  >
                    <Ban className="size-4" />
                    <span className="sr-only">{t("payments.reverse")}</span>
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      />
    </div>
  ) : (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>#</TableHead>
          <SortableHead sortKey="code" sort={sort} toggle={toggle}>
            {t("common.code")}
          </SortableHead>
          <SortableHead sortKey="tenant" sort={sort} toggle={toggle}>
            {t("contracts.tenant")}
          </SortableHead>
          <SortableHead sortKey="method" sort={sort} toggle={toggle}>
            {t("payments.method")}
          </SortableHead>
          <SortableHead sortKey="amount" sort={sort} toggle={toggle}>
            {t("common.amount")}
          </SortableHead>
          <SortableHead sortKey="payment_date" sort={sort} toggle={toggle}>
            {t("payments.date")}
          </SortableHead>
          <SortableHead sortKey="created_at" sort={sort} toggle={toggle}>
            {t("payments.createdTime")}
          </SortableHead>
          <SortableHead sortKey="status" sort={sort} toggle={toggle}>
            {t("common.status")}
          </SortableHead>
          <SortableHead sortKey="reference" sort={sort} toggle={toggle}>
            {t("payments.reference")}
          </SortableHead>
          <TableHead>{t("payments.reversalLink")}</TableHead>
          <TableHead>{t("common.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedItems.map((payment, index) => (
          <TableRow key={payment.id}>
            <TableCell>{(page - 1) * pageSize + index + 1}</TableCell>
            <TableCell className="font-mono font-medium">{payment.code}</TableCell>
            <TableCell>
              {payment.tenant ? (
                <EntityLink kind="tenant" id={payment.tenant_id}>
                  {tenantDisplayName(payment.tenant, locale)}
                </EntityLink>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell>{formatPaymentMethod(payment.method, t)}</TableCell>
            <TableCell>{formatKwd(payment.amount, locale, payment.currency)}</TableCell>
            <TableCell>{payment.payment_date}</TableCell>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
              {payment.created_at ? new Date(payment.created_at).toLocaleString("en-GB") : "—"}
            </TableCell>
            <TableCell>
              <Badge variant={paymentStatusTone(payment.status)}>
                {t(`paymentStatus.${payment.status}`)}
              </Badge>
            </TableCell>
            <TableCell>{payment.reference ?? "—"}</TableCell>
            <TableCell className="max-w-36 truncate font-mono text-xs">
              {payment.reversed_by_payment_id ?? "—"}
            </TableCell>
            <TableCell>
              <div className="flex gap-1">
                {payment.status === "confirmed" && (
                  <>
                    <Button
                      title={t("payments.allocate")}
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        onAllocate(payment);
                      }}
                    >
                      <CreditCard className="size-4" />
                      <span className="sr-only">{t("payments.allocate")}</span>
                    </Button>
                    <Button
                      title={t("payments.printDocument")}
                      variant="ghost"
                      size="icon"
                      onClick={() => onPrint(payment)}
                    >
                      <Printer className="size-4" />
                      <span className="sr-only">{t("payments.printDocument")}</span>
                    </Button>
                    {canReverse && (
                      <Button
                        title={t("payments.reverse")}
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        onClick={() => onReverse(payment)}
                      >
                        <Ban className="size-4" />
                        <span className="sr-only">{t("payments.reverse")}</span>
                      </Button>
                    )}
                  </>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
