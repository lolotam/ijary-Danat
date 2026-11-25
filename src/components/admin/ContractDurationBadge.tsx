import { Badge } from "@/components/ui/badge";
import { contractDurationTone } from "@/lib/statusTone";

/**
 * يعرض مدة العقد بالأشهر كشارة ملوّنة، لكل مدة لون خاص بها.
 *
 * A lease term is a category an operator scans for — "the five-year ones" —
 * not a magnitude they compare. Colour does that work far faster than a bare
 * number in a column of numbers, and the colour is a function of the term
 * itself, so the same duration looks the same in the contracts table and on
 * the tenant's contract details.
 *
 * A contract with no recorded duration renders the em dash the surrounding
 * tables already use for an absent value, not a zero badge.
 */
export function ContractDurationBadge({ months }: { months: number | null | undefined }) {
  if (months == null) return <span className="text-muted-foreground">—</span>;
  return <Badge variant={contractDurationTone(months)}>{months}</Badge>;
}
