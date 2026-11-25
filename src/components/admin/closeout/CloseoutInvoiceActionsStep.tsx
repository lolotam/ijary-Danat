import { Badge } from "@/components/ui/badge";
import { LtrText } from "@/components/ui/ltr-text";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import type { InvoiceActionInput } from "@/lib/closeoutSchemas";
import { formatKwd } from "@/lib/money";
import { closeoutInvoiceActionTone, invoiceStateTone } from "@/lib/statusTone";
import { INVOICE_ACTIONS } from "@/components/admin/closeout/closeoutShared";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";

/**
 * الخطوة 2: إجراء لكل فاتورة غير مسددة — ترك، تسوية من التأمين، شطب، إلغاء، أو نزاع.
 *
 * Every unpaid invoice must carry an action: the close-out RPC refuses
 * otherwise, and the wizard checks it before advancing.
 */
export function CloseoutInvoiceActionsStep({
  error,
  invoices,
  actionFor,
  onPick,
}: {
  error: string | null;
  invoices: InvoiceWithRelations[];
  actionFor: (invoiceId: string) => InvoiceActionInput["action"];
  /** اختيار يدوي — ينجو من كل إعادة تعبئة يسببها تغيير تاريخ الإخلاء. */
  onPick: (invoiceId: string, action: InvoiceActionInput["action"]) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t("closeout.step.2")}</h2>
      <p className="text-sm text-muted-foreground">{t("closeout.invoiceActionsHelp")}</p>
      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!invoices.length ? (
        <p className="text-sm text-muted-foreground">{t("closeout.noOutstandingInvoices")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.code")}</TableHead>
                <TableHead>{t("invoices.balance")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("closeout.invoiceAction")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell className="font-mono text-xs">
                    <LtrText>{invoice.code}</LtrText>
                  </TableCell>
                  <TableCell>
                    <LtrText>{formatKwd(invoice.balance, locale)}</LtrText>
                  </TableCell>
                  <TableCell>
                    <Badge variant={invoiceStateTone(invoice.state)}>
                      {t(`invoiceState.${invoice.state}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <RadioGroup
                      value={actionFor(invoice.id)}
                      onValueChange={(value) =>
                        onPick(invoice.id, value as InvoiceActionInput["action"])
                      }
                      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
                    >
                      {INVOICE_ACTIONS.map((action) => (
                        <label
                          key={action}
                          className="flex cursor-pointer items-center gap-2 text-sm"
                        >
                          <RadioGroupItem value={action} id={`${invoice.id}-${action}`} />
                          <Badge variant={closeoutInvoiceActionTone(action)}>
                            {t(`closeout.invoiceAction.${action}`)}
                          </Badge>
                        </label>
                      ))}
                    </RadioGroup>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
