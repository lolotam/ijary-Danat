import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { ActiveContractOption } from "@/hooks/useLandingSettings";

export interface BrandContractsFieldProps {
  options: ActiveContractOption[] | undefined;
  /** معرّفات العقود المختارة حالياً — المجموعة الكاملة، لا فرقاً. */
  selectedIds: string[];
  onChange: (contractIds: string[]) => void;
  labels: {
    heading: string;
    empty: string;
    selectedCount: (count: number) => string;
    /** عدد العقود المرتبطة غير المعروضة لأنها لم تعد نشطة. */
    hiddenCount: (count: number) => string;
  };
}

/**
 * يربط محلًّا بعدة عقود بدل عقد واحد.
 *
 * This replaced a single `Select`, which could only ever express one contract
 * per shop — so a tenant renting two units under two leases had to choose which
 * one carried the storefront logo, and the other showed nothing.
 *
 * A checkbox list rather than a combobox with tags: it is the pattern
 * `ContractUnitsField` already uses for properties and units on the contract
 * form, so the two multi-selects in this application behave the same way and
 * neither needs a primitive the codebase does not have.
 */
export function BrandContractsField({
  options,
  selectedIds,
  onChange,
  labels,
}: BrandContractsFieldProps) {
  const selected = new Set(selectedIds);
  const offered = new Set((options ?? []).map((option) => option.id));
  // Links this list cannot show. `useActiveContractOptions` offers ACTIVE
  // contracts only, so a shop still linked to an expired or renewed lease has
  // ids here with no checkbox — and rebuilding the set from the options alone
  // would drop them the moment the operator ticked anything. The saved array is
  // the complete desired set, so that drop is permanent and, because the shops
  // table also omits unlabelled ids, invisible.
  const hiddenIds = selectedIds.filter((id) => !offered.has(id));

  function toggle(contractId: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(contractId);
    else next.delete(contractId);
    // Offered ids in the options' own order, so saving the same set twice
    // produces the same array and no spurious dirty state; then the hidden
    // ones, carried through untouched.
    onChange([
      ...(options ?? []).map((option) => option.id).filter((id) => next.has(id)),
      ...hiddenIds,
    ]);
  }

  return (
    <div className="space-y-2">
      <Label>{labels.heading}</Label>
      {/* No height cap and no scroll of its own: the dialog already scrolls, and
          a second scrollbar inside it left this field a 12rem window with empty
          space below it. The list runs the full length of the form instead, so
          every active contract is reachable by scrolling the dialog once. */}
      <div className="rounded-lg border">
        {!options?.length ? (
          <p className="p-3 text-sm text-muted-foreground">{labels.empty}</p>
        ) : (
          options.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-center gap-3 border-b p-2 text-sm last:border-b-0 hover:bg-muted/50"
            >
              <Checkbox
                checked={selected.has(option.id)}
                onCheckedChange={(checked) => toggle(option.id, checked === true)}
              />
              <span>
                {option.code} — {option.tenantName} ({option.unitName})
              </span>
            </label>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {labels.selectedCount(selectedIds.length)}
        {hiddenIds.length ? ` — ${labels.hiddenCount(hiddenIds.length)}` : ""}
      </p>
    </div>
  );
}
