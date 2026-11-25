import { Badge } from "@/components/ui/badge";
import { LtrText } from "@/components/ui/ltr-text";
import type { InvoiceDiscountBadge } from "@/lib/invoiceDiscountColumn";
import { formatPercent } from "@/lib/money";

/**
 * يعرض الخصم: النسبة إن وُجدت، ثم المبلغ.
 *
 * Renders nothing when there is no discount, so an undiscounted row keeps the
 * table's existing empty treatment rather than gaining a stray dash.
 *
 * Financial figures only. The free-month / covered-invoice count that used to
 * lead this cell described the concession, not this invoice, and repeating it
 * on every row read as a per-invoice quantity it never was.
 *
 * Shared by the invoice tables and the concessions dialog so the two cannot
 * disagree about how a discount looks — the dialog is where an admin sets one
 * up, and the invoice row is where they check it landed.
 */
export function InvoiceDiscountCell({
  badge,
  locale,
}: {
  badge: InvoiceDiscountBadge | null;
  locale: string;
}) {
  if (!badge) return null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {badge.kind === "percentage" ? (
        <Badge variant="secondary" className="font-normal">
          {formatPercent(badge.percent, locale)}
        </Badge>
      ) : null}
      <LtrText>{badge.amount}</LtrText>
    </span>
  );
}
